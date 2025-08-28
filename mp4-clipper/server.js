// server.js  (ESM)
import express from "express";
import { spawn } from "child_process";

const app = express();

/* ───── Env (Render → Environment Variables) ─────
   REQUIRED:
     BASE        e.g. https://fision-videos-worker.myfisionupload.workers.dev
   OPTIONAL (sane defaults provided):
     PLAYLIST    default: stream_0.m3u8
     MAX_SECONDS default: 30
     MAX_WIDTH   default: 720
     CRF         default: "23"
     PRESET      default: "ultrafast"
     FPS         default: 30
     UA          default: desktop Chrome UA
     REFERER     default: ""  (set if your origin requires a referrer)
-------------------------------------------------- */
const BASE        = process.env.BASE;
const PLAYLIST    = process.env.PLAYLIST || "stream_0.m3u8";
const MAX_SECONDS = Number(process.env.MAX_SECONDS || 30);
const MAX_WIDTH   = Number(process.env.MAX_WIDTH || 720);
const CRF         = String(process.env.CRF || "23");
const PRESET      = String(process.env.PRESET || "ultrafast");
const FPS         = Number(process.env.FPS || 30);
const UA          = process.env.UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const REFERER     = process.env.REFERER || "";

// health & root
app.get("/health", (_req, res) => res.type("text").send("OK"));
app.get("/", (_req, res) => res.type("text").send("Fision clipper is running."));

// simple probe to see what the server can fetch with headers
app.get("/probe", async (req, res) => {
  try {
    const code = String(req.query.code || "").trim();
    if (!code) return res.status(400).json({ error: "code is required" });
    const url = `${BASE}/videos/${encodeURIComponent(code)}/${PLAYLIST}`;

    const r = await fetch(url, {
      headers: {
        "user-agent": UA,
        ...(REFERER ? { referer: REFERER } : {}),
      },
    });

    const text = await r.text();
    res.json({
      url, status: r.status, ok: r.ok,
      contentType: r.headers.get("content-type"),
      sample: text.slice(0, 300),
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// main clipping endpoint
app.get("/clip", async (req, res) => {
  try {
    if (!BASE) return res.status(500).type("text").end("Server misconfigured: BASE is not set");

    const code  = String(req.query.code || "").trim();
    const start = Number(req.query.start || 0);
    const end   = Number(req.query.end   || 0);

    if (!code || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return res.status(400).type("text").end("Bad params: code/start/end");
    }

    const duration = +(end - start).toFixed(3);
    if (duration > MAX_SECONDS) {
      return res.status(400).type("text").end(`Max clip length is ${MAX_SECONDS}s`);
    }

    const m3u8Url = `${BASE}/videos/${encodeURIComponent(code)}/${PLAYLIST}`;
    console.log("FFmpeg input URL:", m3u8Url);

    const outfile = `clip_${code}_${Math.floor(start)}-${Math.floor(end)}.mp4`;

    // video filter: cap width, preserve AR, even dims, yuv420p
    const vf = [
      `scale='min(${MAX_WIDTH},iw)':-2:force_original_aspect_ratio=decrease`,
      "pad=ceil(iw/2)*2:ceil(ih/2)*2:(ow-iw)/2:(oh-ih)/2",
      "format=yuv420p",
    ].join(",");

    // optional origin headers
    const headerLines = [];
    if (REFERER) headerLines.push(`Referer: ${REFERER}`);
    const headersArg = headerLines.length ? ["-headers", headerLines.join("\r\n")] : [];

    // HLS-hardened args:
    //  - pre-input -ss for fast network seek
    //  - reconnect flags
    //  - browser UA
    const args = [
      "-hide_banner","-loglevel","error","-nostdin",
      "-protocol_whitelist","file,crypto,https,tcp,tls",
      "-rw_timeout","15000000",
      "-user_agent", UA,
      "-allowed_extensions","ALL",
      "-reconnect","1",
      "-reconnect_streamed","1",
      "-reconnect_on_http_error","4xx,5xx",
      "-reconnect_delay_max","5",
      ...headersArg,

      "-ss", String(start),
      "-i", m3u8Url,
      "-t", String(duration),

      "-map","0:v?","-map","0:a?",
      "-r", String(FPS),
      "-vf", vf,

      "-c:v","libx264",
      "-preset", PRESET,
      "-crf", CRF,
      "-profile:v","high",
      "-level","4.1",
      "-pix_fmt","yuv420p",
      "-threads","1",
      "-fflags","+genpts",
      "-max_muxing_queue_size","1024",

      "-c:a","aac",
      "-b:a","128k",
      "-ac","2",

      "-movflags","+faststart",
      "-f","mp4",
      "pipe:1",
    ];

    const ff = spawn("ffmpeg", args, { stdio: ["ignore","pipe","pipe"] });

    // kill ffmpeg if client disconnects
    req.on("aborted", () => { try { ff.kill("SIGKILL"); } catch {} });

    let sentHeaders = false;
    let hadData = false;
    let errLog = "";

    // watchdog: no first byte within 20s? bail and report stderr
    const FIRST_BYTE_DEADLINE_MS = 20000;
    const watchdog = setTimeout(() => {
      if (!hadData) {
        console.warn("watchdog: no data within 20s, killing ffmpeg");
        try { ff.kill("SIGKILL"); } catch {}
      }
    }, FIRST_BYTE_DEADLINE_MS);

    ff.stdout.once("data", (chunk) => {
      hadData = true;
      clearTimeout(watchdog);
      if (!sentHeaders) {
        sentHeaders = true;
        res.status(200);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Disposition", `attachment; filename="${outfile}"`);
      }
      res.write(chunk);
      ff.stdout.pipe(res);
    });

    ff.stderr.on("data", (d) => {
      const s = d.toString();
      errLog += s;
      console.error("[ffmpeg]", s.trim());
    });

    ff.on("exit", (codeExit, signal) => {
      clearTimeout(watchdog);
      if (!hadData && !sentHeaders) {
        const msg = (errLog.trim() || `ffmpeg exited. code=${codeExit} signal=${signal}`).slice(0, 1800);
        return res.status(500).type("text").end(msg);
      }
      if (!res.writableEnded) res.end();
      if (codeExit !== 0 || signal) {
        console.error("ffmpeg exit", { codeExit, signal, err: errLog });
      }
    });

    ff.on("error", (e) => {
      clearTimeout(watchdog);
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
