// server.js
// Re-encodes HLS to Instagram-friendly MP4 (H.264/AAC) and streams it.
// Endpoint: GET /clip?code=<videoCode>&start=<sec>&end=<sec>

import express from "express";
import { spawn } from "node:child_process";

const app = express();
const PORT = process.env.PORT || 8080;

// Your HLS origin (Cloudflare Worker)
const BASE = process.env.HLS_BASE || "https://fision-videos-worker.myfisionupload.workers.dev";
const PLAYLIST = process.env.PLAYLIST || "stream_0.m3u8";

// Limits & tuning
const MAX_SECONDS = Number(process.env.MAX_SECONDS || 600);  // 10 minutes
const PRESET = process.env.PRESET || "veryfast";             // x264 speed/quality
const CRF = process.env.CRF || "22";                         // lower = higher quality
const FPS = process.env.FPS || "30";                         // social-friendly fps
const MAX_WIDTH = Number(process.env.MAX_WIDTH || 1080);     // cap width to 1080

// allow downloads from your site/app (relax now, lock later)
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  next();
});

app.get("/health", (_req, res) => res.type("text").send("ok"));

app.get("/clip", async (req, res) => {
  try {
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
    const outfile = `clip_${code}_${Math.floor(start)}-${Math.floor(end)}.mp4`;

    // Video filter: scale down to MAX_WIDTH, keep AR, even dims, YUV420p
    const vf = [
      `scale='min(${MAX_WIDTH},iw)':-2:force_original_aspect_ratio=decrease`,
      "pad=ceil(iw/2)*2:ceil(ih/2)*2:(ow-iw)/2:(oh-ih)/2",
      "format=yuv420p"
    ].join(",");

    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-rw_timeout", "15000000",
      "-user_agent", "FisionClipper/1.0",

      "-ss", String(start),
      "-t", String(duration),
      "-i", m3u8Url,

      "-map", "0:v?", "-map", "0:a?",
      "-r", FPS,
      "-vf", vf,

      "-c:v", "libx264",
      "-preset", PRESET,
      "-crf", CRF,
      "-profile:v", "high",
      "-level", "4.1",
      "-pix_fmt", "yuv420p",

      "-c:a", "aac",
      "-b:a", "128k",
      "-ac", "2",

      "-movflags", "+faststart",
      "-f", "mp4",
      "pipe:1"
    ];

    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    // stop work if the client cancels the request
    req.on("aborted", () => { try { ff.kill("SIGKILL"); } catch {} });

    let sentHeaders = false;
    let hadData = false;
    let errLog = "";

    // write first chunk, then pipe rest
    ff.stdout.once("data", (chunk) => {
      hadData = true;
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

    ff.stderr.on("data", d => { errLog += d.toString(); });

    ff.on("close", (codeExit) => {
      if (!hadData && !sentHeaders) {
        return res.status(500).type("text").end((errLog.trim() || `ffmpeg failed code=${codeExit}`).slice(0, 2000));
      }
      if (!res.writableEnded) res.end();
      if (codeExit !== 0) console.error("ffmpeg exit", codeExit, errLog);
    });

    ff.on("error", (e) => {
      console.error("spawn error", e);
      if (!sentHeaders) res.status(500).type("text").end("spawn error: " + (e.message || e));
      else try { res.end(); } catch {}
    });

  } catch (e) {
    console.error("handler", e);
    res.status(500).type("text").end("Server error: " + (e.message || e));
  }
});

app.listen(PORT, () => console.log("MP4 clipper on :" + PORT));
