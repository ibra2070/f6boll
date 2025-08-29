// server.js (ESM)
import express from "express";
import { spawn } from "child_process";
import os from "os";
import fs from "fs";
import path from "path";

const app = express();

/* ========= Environment (Render → Environment Variables) =========
   BASE        required (e.g. https://fision-videos-worker.myfisionupload.workers.dev)
   PLAYLIST    optional, default: stream_0.m3u8
   UA          optional, default: a desktop Chrome UA
   REFERER     optional, set if your origin requires it (e.g. https://your-site)
   TIMEOUT_MS  optional, default: 20000 (watchdog for first byte in piping mode)
   SOLID_MP4   optional, default: "" — set "1" to always write solid MP4 (good for iOS)
   =============================================================== */
const BASE        = process.env.BASE;
const PLAYLIST    = process.env.PLAYLIST || "stream_0.m3u8";
const UA          = process.env.UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const REFERER     = process.env.REFERER || "";
const TIMEOUT_MS  = Number(process.env.TIMEOUT_MS || 20000);
const FORCE_SOLID = process.env.SOLID_MP4 === "1";

// ───────────────────────────── health & root ─────────────────────────────
app.get("/health", (_req, res) => res.type("text").send("OK"));
app.get("/", (_req, res) => res.type("text").send("Fision clipper is running."));

// ───────────────────────────── progress SSE bus ──────────────────────────
const progress = new Map(); // pid -> Set(res)

function pushProgress(pid, data) {
  const subs = progress.get(pid);
  if (!subs) return;
  const line = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of subs) {
    try { res.write(line); } catch { /* ignore */ }
  }
}

app.get("/progress/:pid", (req, res) => {
  const { pid } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  if (!progress.has(pid)) progress.set(pid, new Set());
  const subs = progress.get(pid);
  subs.add(res);

  // hello event
  res.write(`event: hello\ndata: ${JSON.stringify({ pid })}\n\n`);

  req.on("close", () => {
    subs.delete(res);
    if (subs.size === 0) progress.delete(pid);
  });
});

// ───────────────────────────── debug probe (optional) ─────────────────────
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

// ─────────────────────────── HLS helpers (VOD) ────────────────────────────
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
  return b; // [0, t1, t2, ..., total]
}
function floorBoundary(b, t) { // largest boundary <= t
  let lo = 0, hi = b.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (b[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return b[lo];
}
function ceilBoundary(b, t) { // smallest boundary >= t
  let lo = 0, hi = b.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (b[mid] >= t) hi = mid; else lo = mid + 1;
  }
  return b[lo];
}

// ───────────────────────────── main clip endpoint ─────────────────────────
app.get("/clip", async (req, res) => {
  try {
    if (!BASE) return res.status(500).type("text").end("Server misconfigured: BASE is not set");

    const code  = String(req.query.code || "").trim();
    const start = Number(req.query.start || 0);
    const end   = Number(req.query.end   || 0);
    const pid   = String(req.query.pid || "");               // progress id (optional)
    const solidQuery = String(req.query.solid || "");        // force solid=1 per request
    const debug = String(req.query.debug || "") === "1";     // verbose ffmpeg logs (optional)

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

    // snap to whole segments (fast, stream-copy)
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
    // - iOS UA OR ?solid=1 OR SOLID_MP4=1  → solid MP4 (write to temp, +faststart) to avoid iOS 1s bug
    // - else → fragmented MP4 piped (fast first byte in desktop browsers)
    const reqUA = String(req.headers["user-agent"] || "");
    const isIOS = /iPhone|iPad|iPod/i.test(reqUA);
    const wantSolid = FORCE_SOLID || isIOS || solidQuery === "1";

    // Optional headers for origin
    const headerLines = [];
    if (REFERER) headerLines.push(`Referer: ${REFERER}`);
    const headersArg = headerLines.length ? ["-headers", headerLines.join("\r\n")] : [];

    const baseArgs = [
      "-hide_banner","-loglevel", debug ? "info" : "error","-nostdin",
      "-protocol_whitelist","file,crypto,https,tcp,tls",
      "-rw_timeout","30000000",     // 30s per I/O op
      "-user_agent", UA,
      "-allowed_extensions","ALL",
      "-http_persistent","0",
      "-reconnect","1",
      "-reconnect_streamed","1",
      "-reconnect_on_http_error","4xx,5xx",
      "-reconnect_delay_max","8",
      ...headersArg,

      // progress channel
      "-progress","pipe:2",

      // fast seek to snapped start & duration to end boundary
      "-ss", String(sSnap),
      "-i", m3u8Url,
      "-t", String(dur),

      // map (copy only)
      "-map","0:v?","-map","0:a?",
      "-c:v","copy",
      "-c:a","copy",
      "-bsf:a","aac_adtstoasc",
    ];

    let args, outputTarget;
    if (wantSolid) {
      // Solid MP4: write to temp, then send with Content-Length
      const tmp = path.join(os.tmpdir(), `${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
      args = [...baseArgs, "-movflags","+faststart", "-f","mp4", tmp];
      outputTarget = tmp;
    } else {
      // Fragmented MP4 over pipe (fast start for browsers)
      args = [...baseArgs, "-movflags","+frag_keyframe+empty_moov+faststart", "-f","mp4", "pipe:1"];
      outputTarget = "pipe:1";
    }

    const ff = spawn("ffmpeg", args, { stdio: ["ignore","pipe","pipe"] });

    // Only kill early in piping mode; for solid path we prefer to finish preparing
    if (!wantSolid) {
      req.on("aborted", () => { try { ff.kill("SIGKILL"); } catch {} });
    } else {
      req.on("aborted", () => { console.warn("client aborted; continuing solid MP4 preparation"); });
    }

    let sentHeaders = false;
    let hadData = false;
    let errLog = "";

    // Watchdog: bail if no first byte within TIMEOUT_MS (piping mode only)
    const watchdog = !wantSolid ? setTimeout(() => {
      if (!hadData) {
        console.warn("watchdog: no data within timeout, killing ffmpeg");
        try { ff.kill("SIGKILL"); } catch {}
      }
    }, TIMEOUT_MS) : null;

    // parse ffmpeg progress for SSE
    ff.stderr.on("data", (d) => {
      const s = d.toString();
      errLog += s;
      if (pid) {
        const ms = s.match(/out_time_ms=(\d+)/);
        if (ms) {
          const outUs = parseInt(ms[1], 10);
          const pct = dur > 0 ? Math.min(100, (outUs / (dur * 1e6)) * 100) : 0;
          pushProgress(pid, { pct: +pct.toFixed(1) });
        }
        if (/progress=end/.test(s)) pushProgress(pid, { done: true });
      }
      if (debug) console.error("[ffmpeg]", s.trim());
    });

    if (!wantSolid) {
      // stream out immediately (fragmented MP4 piping)
      ff.stdout.once("data", (chunk) => {
        hadData = true;
        if (watchdog) clearTimeout(watchdog);
        if (!sentHeaders) {
          sentHeaders = true;
          res.status(200);
          res.setHeader("Content-Type", "video/mp4");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
          res.setHeader("X-Clip-Requested-Start", String(sReq.toFixed(3)));
          res.setHeader("X-Clip-Requested-End",   String(eReq.toFixed(3)));
          res.setHeader("X-Clip-Snapped-Start",   String(sSnap.toFixed(3)));
          res.setHeader("X-Clip-Snapped-End",     String(eSnap.toFixed(3)));
        }
        res.write(chunk);
        ff.stdout.pipe(res);
      });
    }

    ff.on("exit", async (codeExit, signal) => {
      if (watchdog) clearTimeout(watchdog);

      if (wantSolid) {
        // send finished file
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
            read.on("close", async () => { try { await fs.promises.unlink(outputTarget); } catch {} });
            return;
          } catch (e) {
            console.error("send solid file error", e);
          }
        }
        const msg = (errLog.trim() || `ffmpeg exited. code=${codeExit} signal=${signal}`).slice(0, 1800);
        res.setHeader("X-Debug-Error", msg.slice(0, 200));
        return res.status(500).type("text").end(msg);
      } else {
        // piping mode
        if (!hadData && !sentHeaders) {
          const msg = (errLog.trim() || `ffmpeg exited. code=${codeExit} signal=${signal}`).slice(0, 1800);
          res.setHeader("X-Debug-Error", msg.slice(0, 200));
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
