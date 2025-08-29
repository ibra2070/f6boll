// server.js (ESM)
import express from "express";
import { spawn } from "child_process";

const app = express();

/* ── Env (Render -> Environment Variables) ─────────────────────────
   REQUIRED
     BASE           e.g. https://fision-videos-worker.myfisionupload.workers.dev

   OPTIONAL
     PLAYLIST       default: stream_0.m3u8
     MAX_SECONDS    default: 30
     MAX_WIDTH      default: 720                (used only when re-encoding)
     CRF            default: "23"               (re-encode)
     PRESET         default: "ultrafast"        (re-encode)
     FPS            default: 30                 (re-encode)
     THREADS        default: 1
     UA             default: desktop Chrome UA
     REFERER        default: ""                 (set if your origin needs one)
     SEGMENT_SEC    default: 10                 (approx segment length)
     COPY_CODECS    default: "" (off). Set to "1" to stream-copy (no re-encode).
──────────────────────────────────────────────────────────────────── */
const BASE         = process.env.BASE;
const PLAYLIST     = process.env.PLAYLIST || "stream_0.m3u8";
const MAX_SECONDS  = Number(process.env.MAX_SECONDS || 30);
const MAX_WIDTH    = Number(process.env.MAX_WIDTH || 720);
const CRF          = String(process.env.CRF || "23");
const PRESET       = String(process.env.PRESET || "ultrafast");
const FPS          = Number(process.env.FPS || 30);
const THREADS      = String(process.env.THREADS || "1");
const UA           = process.env.UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const REFERER      = process.env.REFERER || "";
const SEGMENT_SEC  = Number(process.env.SEGMENT_SEC || 10);
const COPY_CODECS  = process.env.COPY_CODECS === "1";

// health
app.get("/health", (_req, res) => res.type("text").send("OK"));
app.get("/", (_req, res) => res.type("text").send("Fision clipper is running."));

// probe (debug helper)
app.get("/probe", async (req, res) => {
  try {
    const code = String(req.query.code || "").trim();
    if (!code) return res.status(400).json({ error: "code is required" });
    const url = `${BASE}/videos/${encodeURIComponent(code)}/${PLAYLIST}`;
    const r = await fetch(url, {
      headers: { "user-agent": UA, ...(REFERER ? { referer: REFERER } : {}) },
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

    // ── Coarse + fine seek ─────────────────────────────────────────────
    // jump fast to segment boundary, then refine precisely
    const coarse = Math.max(0, Math.floor(start / SEGMENT_SEC) * SEGMENT_SEC);
    const fine   = +(start - coarse).toFixed(3);  // 0..(SEGMENT_SEC)
    const doFine = fine > 0.001;

    // optional headers (referer) for origin
    const headerLines = [];
    if (REFERER) headerLines.push(`Referer: ${REFERER}`);
    const headersArg = headerLines.length ? ["-headers", headerLines.join("\r\n")] : [];

    // build args
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

      // coarse (fast) seek
      "-ss", String(coarse),
      "-i", m3u8Url,

      // fine (accurate) seek
      ...(doFine ? ["-ss", String(fine)] : []),

      "-t", String(duration),
      "-map","0:v?","-map","0:a?",
    ];

    // choose copy vs re-encode
    let codecArgs;
    if (COPY_CODECS) {
      // fastest: no scaling/FPS change, keyframe-aligned trims
      codecArgs = [
        "-c:v","copy",
        "-c:a","copy",
        "-bsf:a","aac_adtstoasc", // ADTS->ASC for MP4
        "-movflags","+frag_keyframe+empty_moov+faststart",
        "-f","mp4","pipe:1",
      ];
    } else {
      const vf = [
        `scale='min(${MAX_WIDTH},iw)':-2:force_original_aspect_ratio=decrease`,
        "pad=ceil(iw/2)*2:ceil(ih/2)*2:(ow-iw)/2:(oh-ih)/2",
        "format=yuv420p",
      ].join(",");

      codecArgs = [
        "-r", String(FPS),
        "-vf", vf,
        "-c:v","libx264",
        "-preset", PRESET,
        "-crf", CRF,
        "-profile:v","high",
        "-level","4.1",
        "-pix_fmt","yuv420p",
        "-threads", THREADS,
        "-fflags","+genpts",
        "-max_muxing_queue_size","1024",
        "-c:a","aac",
        "-b:a","128k",
        "-ac","2",
        "-movflags","+frag_keyframe+empty_moov+faststart",
        "-f","mp4","pipe:1",
      ];
    }

    const args = [...baseArgs, ...codecArgs];

    const ff = spawn("ffmpeg", args, { stdio: ["ignore","pipe","pipe"] });

    // cancel if client disconnects
    req.on("aborted", () => { try { ff.kill("SIGKILL"); } catch {} });

    let sentHeaders = false;
    let hadData = false;
    let errLog = "";

    // watchdog: no first byte in 20s -> kill and show stderr
    const watchdog = setTimeout(() => {
      if (!hadData) {
        console.warn("watchdog: no data within 20s, killing ffmpeg");
        try { ff.kill("SIGKILL"); } catch {}
      }
    }, 20000);

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
