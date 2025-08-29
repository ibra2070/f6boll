// server.js (ESM)
import express from "express";
import { spawn } from "child_process";
import os from "os";
import fs from "fs";
import path from "path";

const app = express();

/* Env (Render → Environment Variables)
   BASE        required (e.g. https://fision-videos-worker.myfisionupload.workers.dev)
   PLAYLIST    optional (default: stream_0.m3u8)
   UA          optional (default: desktop Chrome UA used for origin fetch)
   REFERER     optional (set if origin requires it)
   TIMEOUT_MS  optional (default: 20000) — watchdog for first byte
   SOLID_MP4   optional (default: "") — set "1" to always write solid MP4 to temp and then send
*/
const BASE        = process.env.BASE;
const PLAYLIST    = process.env.PLAYLIST || "stream_0.m3u8";
const UA          = process.env.UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const REFERER     = process.env.REFERER || "";
const TIMEOUT_MS  = Number(process.env.TIMEOUT_MS || 20000);
const FORCE_SOLID = process.env.SOLID_MP4 === "1";

// health & root
app.get("/health", (_req, res) => res.type("text").send("OK"));
app.get("/", (_req, res) => res.type("text").send("Fision clipper is running."));

// probe helper
app.get("/probe", async (req, res) => {
  try {
    const code = String(req.query.code || "").trim();
    if (!code) return res.status(400).json({ error: "code is required" });
    const url = `${BASE}/videos/${encodeURIComponent(code)}/${PLAYLIST}`;
    const r = await fetch(url, { headers: { "user-agent": UA, ...(REFERER ? { referer: REFERER } : {}) } });
    const text = await r.text();
    res.json({ url, status: r.status, ok: r.ok, contentType: r.headers.get("content-type"), sample: text.slice(0, 300) });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* Parse VOD playlist to cumulative boundaries [0, t1, t2, ... total] */
function parseBoundaries(m3u8Text) {
  const lines = m3u8Text.split(/\r?\n/);
  const b = [0];
  let acc = 0;
  for (const line of lines) {
    const m = line.match(/^#EXTINF:([\d.]+)/);
    if (m) {
      const dur = parseFloat(m[1]);
      acc += isFinite(dur) ? dur : 0;
      b.push(acc);
    }
  }
  return b;
}

// largest boundary <= t
function floorBoundary(b, t) {
  let lo = 0, hi = b.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (b[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return b[lo];
}

// smallest boundary >= t
function ceilBoundary(b, t) {
  let lo = 0, hi = b.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (b[mid] >= t) hi = mid; else lo = mid + 1;
  }
  return b[lo];
}

app.get("/clip", async (req, res) => {
  try {
    if (!BASE) return res.status(500).type("text").end("Server misconfigured: BASE is not set");

    const code  = String(req.query.code || "").trim();
    const start = Number(req.query.start || 0);
    const end   = Number(req.query.end   || 0);
    if (!code || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return res.status(400).type("text").end("Bad params: code/start/end");
    }

    const m3u8Url = `${BASE}/videos/${encodeURIComponent(code)}/${PLAYLIST}`;
    console.log("FFmpeg input URL:", m3u8Url);

    // fetch playlist to compute segment boundaries
    const r = await fetch(m3u8Url, { headers: { "user-agent": UA, ...(REFERER ? { referer: REFERER } : {}) } });
    if (!r.ok) return res.status(502).type("text").end(`Failed to fetch playlist: HTTP ${r.status}`);
    const playlistText = await r.text();
    const boundaries = parseBoundaries(playlistText);
    const total = boundaries[boundaries.length - 1] || 0;

    // clamp requested times
    const sReq = Math.max(0, Math.min(start, Math.max(0, total - 0.001)));
    const eReq = Math.max(0, Math.min(end, total));

    // snap to whole segments
    const sSnap = floorBoundary(boundaries, sReq);
    let eSnap  = ceilBoundary(boundaries, eReq);
    if (eSnap <= sSnap) {
      // ensure at least one segment
      const idx = boundaries.indexOf(sSnap);
      eSnap = boundaries[Math.min(idx + 1, boundaries.length - 1)];
    }
    const dur = +(eSnap - sSnap).toFixed(3);

    const filename = `clip_${code}_${Math.floor(sReq)}-${Math.floor(eReq)}.mp4`;

    // Decide container mode:
    // - iOS (iPhone/iPad) or FORCE_SOLID or ?solid=1 → solid MP4 (write to temp, +faststart)
    // - otherwise → fragmented MP4 over pipe (faster start in browsers)
    const ua = String(req.headers["user-agent"] || "");
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const wantSolid = FORCE_SOLID || isIOS || String(req.query.solid || "") === "1";

    // Optional headers for origin
    const headerLines = [];
    if (REFERER) headerLines.push(`Referer: ${REFERER}`);
    const headersArg = headerLines.length ? ["-headers", headerLines.join("\r\n")] : [];

    const baseArgs = [
      "-hide_banner","-loglevel","error","-nostdin",
      "-protocol_whitelist","file,crypto,https,tcp,tls",
      "-rw_timeout","15000000",
      "-user_agent", UA,
      "-allowed_extensions","ALL",
      "-http_persistent","0",
      "-reconnect","1",
      "-reconnect_streamed","1",
      "-reconnect_on_http_error","4xx,5xx",
      "-reconnect_delay_max","5",
      ...headersArg,

      "-ss", String(sSnap),
      "-i", m3u8Url,
      "-t", String(dur),

      "-map","0:v?","-map","0:a?",
      "-c:v","copy",
      "-c:a","copy",
      "-bsf:a","aac_adtstoasc",
    ];

    let args, outputTarget;
    if (wantSolid) {
      // Solid MP4: write to temp file with +faststart, then send file
      const tmp = path.join(os.tmpdir(), `${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
      args = [...baseArgs, "-movflags","+faststart", "-f","mp4", tmp];
      outputTarget = tmp;
    } else {
      // Fragmented MP4 over pipe (good for browsers, but not Photos app)
      args = [...baseArgs, "-movflags","+frag_keyframe+empty_moov+faststart", "-f","mp4", "pipe:1"];
      outputTarget = "pipe:1";
    }

    const ff = spawn("ffmpeg", args, { stdio: ["ignore","pipe","pipe"] });

    // Kill ffmpeg if client disconnects
    req.on("aborted", () => { try { ff.kill("SIGKILL"); } catch {} });

    let sentHeaders = false;
    let hadData = false;
    let errLog = "";

    // watchdog for first byte when piping
    const watchdog = !wantSolid ? setTimeout(() => {
      if (!hadData) {
        console.warn("watchdog: no data within timeout, killing ffmpeg");
        try { ff.kill("SIGKILL"); } catch {}
      }
    }, TIMEOUT_MS) : null;

    if (!wantSolid) {
      // stream out immediately (fragmented MP4)
      ff.stdout.once("data", (chunk) => {
        hadData = true;
        if (watchdog) clearTimeout(watchdog);
        if (!sentHeaders) {
          sentHeaders = true;
          res.status(200);
          res.setHeader("Content-Type", "video/mp4");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
          // optional: reveal snapped window
          res.setHeader("X-Clip-Requested-Start", String(sReq.toFixed(3)));
          res.setHeader("X-Clip-Requested-End",   String(eReq.toFixed(3)));
          res.setHeader("X-Clip-Snapped-Start",   String(sSnap.toFixed(3)));
          res.setHeader("X-Clip-Snapped-End",     String(eSnap.toFixed(3)));
        }
        res.write(chunk);
        ff.stdout.pipe(res);
      });
    }

    ff.stderr.on("data", (d) => {
      const s = d.toString();
      errLog += s;
      console.error("[ffmpeg]", s.trim());
    });

    ff.on("exit", async (codeExit, signal) => {
      if (watchdog) clearTimeout(watchdog);

      if (wantSolid) {
        // send the finished solid MP4 file
        if (codeExit === 0 && !signal) {
          try {
            const st = await fs.promises.stat(outputTarget);
            res.status(200);
            res.setHeader("Content-Type", "video/mp4");
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("Content-Length", String(st.size));
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            res.setHeader("X-Clip-Requested-Start", String(sReq.toFixed(3)));
            res.setHeader("X-Clip-Requested-End",   String(eReq.toFixed(3)));
            res.setHeader("X-Clip-Snapped-Start",   String(sSnap.toFixed(3)));
            res.setHeader("X-Clip-Snapped-End",     String(eSnap.toFixed(3)));

            const read = fs.createReadStream(outputTarget);
            read.pipe(res);
            read.on("close", async () => {
              try { await fs.promises.unlink(outputTarget); } catch {}
            });
            return;
          } catch (e) {
            console.error("send solid file error", e);
          }
        }
        // failed before writing file
        const msg = (errLog.trim() || `ffmpeg exited. code=${codeExit} signal=${signal}`).slice(0, 1800);
        return res.status(500).type("text").end(msg);
      } else {
        // piping mode
        if (!hadData && !sentHeaders) {
          const msg = (errLog.trim() || `ffmpeg exited. code=${codeExit} signal=${signal}`).slice(0, 1800);
          return res.status(500).type("text").end(msg);
        }
        if (!res.writableEnded) res.end();
        if (codeExit !== 0 || signal) {
          console.error("ffmpeg exit", { codeExit, signal, err: errLog });
        }
      }
    });

    ff.on("error", (e) => {
      if (watchdog) clearTimeout(watchdog);
      console.error("spawn error", e);
      if (!sentHeaders) res.status(500).type("text").end("spawn error: " + (e.message || e));
      else try { res.end(); } catch {}
    });

  } catch (e) {
    console.error("handler", e);
    res.status(500).type("text").end("Server error: " + (e.message || e));
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
