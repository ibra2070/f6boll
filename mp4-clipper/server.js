// server.js (ESM)
import express from "express";
import { spawn } from "child_process";
import os from "os";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
app.use(express.json()); // <-- NEW: parse JSON bodies

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

/* -------------------------- Progress tracking store ------------------------- */
const jobs = new Map();      // jobId -> job state
const sseClients = new Map();// jobId -> Set(res)

/* -------------------------- Comments store (in-memory) ---------------------- */
const comments = new Map();  // code -> [{id,time,text,createdAt}]
function getComments(code) {
  const list = comments.get(code) || [];
  // ensure numeric time and sort by time asc
  return list.slice().sort((a,b) => (a.time||0) - (b.time||0));
}

/* utils */
function makeJobId() {
  return crypto.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2,10));
}
function initJob(jobId, seed) {
  const job = {
    id: jobId,
    status: "starting",           // starting | running | ready | done | error | canceled
    error: "",
    requested: { start: 0, end: 0 },
    snapped: { start: 0, end: 0, duration: 0 },
    progress: { timeMs: 0, pct: 0 },
    transfer: { bytes: 0, totalBytes: null },
    updatedAt: Date.now(),
    ...seed,
  };
  jobs.set(jobId, job);
  pushSSE(jobId);
  return job;
}
function patchJob(jobId, patch) {
  const cur = jobs.get(jobId) || {};
  const job = { ...cur, ...patch, updatedAt: Date.now() };
  if (patch?.requested) job.requested = { ...cur.requested, ...patch.requested };
  if (patch?.snapped)   job.snapped   = { ...cur.snapped,   ...patch.snapped   };
  if (patch?.progress)  job.progress  = { ...cur.progress,  ...patch.progress  };
  if (patch?.transfer)  job.transfer  = { ...cur.transfer,  ...patch.transfer  };
  jobs.set(jobId, job);
  pushSSE(jobId);
  return job;
}
function endJob(jobId, status, error = "") {
  const job = patchJob(jobId, { status, error, progress: { ...(jobs.get(jobId)?.progress||{}), pct: status === "done" ? 100 : jobs.get(jobId)?.progress?.pct || 0 } });
  pushSSE(jobId);
  return job;
}
function pushSSE(jobId) {
  const clients = sseClients.get(jobId);
  if (!clients || clients.size === 0) return;
  const data = JSON.stringify(jobs.get(jobId) || { id: jobId, status: "unknown" });
  for (const res of clients) {
    try { res.write(`data: ${data}\n\n`); } catch {}
  }
}

/* ------------------------------ Basic routes -------------------------------- */
app.get("/health", (_req, res) => res.type("text").send("OK"));
app.get("/", (_req, res) => res.type("text").send("Fision clipper is running."));

/* Probe helper */
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

/* -------------------- Playlist boundary helpers ----------------------------- */
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
function floorBoundary(b, t) { let lo = 0, hi = b.length - 1; while (lo < hi) { const mid = Math.floor((lo + hi + 1) / 2); if (b[mid] <= t) lo = mid; else hi = mid - 1; } return b[lo]; }
function ceilBoundary(b, t)  { let lo = 0, hi = b.length - 1; while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (b[mid] >= t) hi = mid; else lo = mid + 1; } return b[lo]; }

/* ----------------------------- Progress APIs -------------------------------- */
app.get("/progress/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json(job);
});
app.get("/progress-stream/:jobId", (req, res) => {
  const { jobId } = req.params;
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.flushHeaders?.();

  if (!sseClients.has(jobId)) sseClients.set(jobId, new Set());
  sseClients.get(jobId).add(res);

  res.write(`data: ${JSON.stringify(jobs.get(jobId) || { id: jobId, status: "unknown" })}\n\n`);

  req.on("close", () => {
    const set = sseClients.get(jobId);
    if (set) set.delete(res);
  });
});

/* ----------------------------- Comments APIs -------------------------------- */
// GET /comments?code=abc   -> { comments: [{id,time,text,createdAt}] }
app.get("/comments", (req, res) => {
  const code = String(req.query.code || "").trim();
  if (!code) return res.status(400).json({ error: "code is required" });
  return res.json({ comments: getComments(code) });
});

// POST /comments  { code, time, text }
app.post("/comments", (req, res) => {
  const code = String(req.body?.code || "").trim();
  const time = Number(req.body?.time);
  const text = String(req.body?.text || "").trim();
  if (!code) return res.status(400).json({ error: "code is required" });
  if (!Number.isFinite(time) || time < 0) return res.status(400).json({ error: "invalid time" });
  if (!text || text.length > 500) return res.status(400).json({ error: "text required (<=500 chars)" });

  const item = { id: crypto.randomUUID?.() || (Date.now()+"_"+Math.random().toString(16).slice(2)), time: Math.floor(time), text, createdAt: Date.now() };
  const list = comments.get(code) || [];
  list.push(item);
  comments.set(code, list);
  return res.json({ ok: true, comment: item });
});

/* -------------------------------- /clip ------------------------------------- */
app.get("/clip", async (req, res) => {
  try {
    if (!BASE) return res.status(500).type("text").end("Server misconfigured: BASE is not set");

    const jobId = String(req.query.job || makeJobId());
    res.setHeader("X-Job-Id", jobId);

    const code  = String(req.query.code || "").trim();
    const start = Number(req.query.start || 0);
    const end   = Number(req.query.end   || 0);
    if (!code || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      initJob(jobId, { status: "error", error: "Bad params: code/start/end" });
      return res.status(400).type("text").end("Bad params: code/start/end");
    }

    const m3u8Url = `${BASE}/videos/${encodeURIComponent(code)}/${PLAYLIST}`;
    console.log("FFmpeg input URL:", m3u8Url);

    const r = await fetch(m3u8Url, { headers: { "user-agent": UA, ...(REFERER ? { referer: REFERER } : {}) } });
    if (!r.ok) {
      initJob(jobId, { status: "error", error: `Failed to fetch playlist: HTTP ${r.status}` });
      return res.status(502).type("text").end(`Failed to fetch playlist: HTTP ${r.status}`);
    }
    const playlistText = await r.text();
    const boundaries = parseBoundaries(playlistText);
    const total = boundaries[boundaries.length - 1] || 0;

    const sReq = Math.max(0, Math.min(start, Math.max(0, total - 0.001)));
    const eReq = Math.max(0, Math.min(end, total));

    const sSnap = floorBoundary(boundaries, sReq);
    let eSnap  = ceilBoundary(boundaries, eReq);
    if (eSnap <= sSnap) {
      const idx = boundaries.indexOf(sSnap);
      eSnap = boundaries[Math.min(idx + 1, boundaries.length - 1)];
    }
    const dur = +(eSnap - sSnap).toFixed(3);
    const filename = `clip_${code}_${Math.floor(sReq)}-${Math.floor(eReq)}.mp4`;

    initJob(jobId, {
      status: "running",
      requested: { start: +sReq.toFixed(3), end: +eReq.toFixed(3) },
      snapped:   { start: +sSnap.toFixed(3), end: +eSnap.toFixed(3), duration: dur },
      progress:  { timeMs: 0, pct: 0 },
      transfer:  { bytes: 0, totalBytes: null }
    });

    const ua = String(req.headers["user-agent"] || "");
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const wantSolid = FORCE_SOLID || isIOS || String(req.query.solid || "") === "1";

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

      "-progress","pipe:2",
      "-stats_period","0.5",
    ];

    let args, outputTarget;
    if (wantSolid) {
      const tmp = path.join(os.tmpdir(), `${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
      args = [...baseArgs, "-movflags","+faststart", "-f","mp4", tmp];
      outputTarget = tmp;
    } else {
      args = [...baseArgs, "-movflags","+frag_keyframe+empty_moov+faststart", "-f","mp4", "pipe:1"];
      outputTarget = "pipe:1";
    }

    const ff = spawn("ffmpeg", args, { stdio: ["ignore","pipe","pipe"] });

    req.on("aborted", () => {
      try { ff.kill("SIGKILL"); } catch {}
      endJob(jobId, "canceled");
    });

    let sentHeaders = false;
    let hadData = false;
    let errLog = "";
    let progBuf = "";
    const watchdog = !wantSolid ? setTimeout(() => {
      if (!hadData) {
        console.warn("watchdog: no data within timeout, killing ffmpeg");
        try { ff.kill("SIGKILL"); } catch {}
      }
    }, TIMEOUT_MS) : null;

    if (!wantSolid) {
      ff.stdout.on("data", (chunk) => {
        patchJob(jobId, { transfer: { bytes: (jobs.get(jobId)?.transfer?.bytes || 0) + chunk.length } });
      });

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
          res.setHeader("X-Job-Id", jobId);
        }
        res.write(chunk);
        ff.stdout.pipe(res);
      });
    }

    ff.stderr.on("data", (d) => {
      const s = d.toString();
      errLog += s;

      progBuf += s;
      let idx;
      while ((idx = progBuf.indexOf("\n")) >= 0) {
        const line = progBuf.slice(0, idx).trim();
        progBuf = progBuf.slice(idx + 1);
        const kv = line.split("=");
        if (kv.length === 2) {
          const [key, val] = kv;
          if (key === "out_time_ms") {
            const ms = Number(val) || 0;
            const pct = Math.max(0, Math.min(99, Math.round((ms / (dur * 1000)) * 100)));
            patchJob(jobId, { progress: { timeMs: ms, pct } });
          } else if (key === "progress" && val === "end") {
            patchJob(jobId, { progress: { ...(jobs.get(jobId)?.progress||{}), pct: 100 } });
          }
        }
      }
      if (s.trim()) console.error("[ffmpeg]", s.trim());
    });

    ff.on("exit", async (codeExit, signal) => {
      if (watchdog) clearTimeout(watchdog);

      if (wantSolid) {
        if (codeExit === 0 && !signal) {
          try {
            const st = await fs.promises.stat(outputTarget);
            patchJob(jobId, { status: "ready", transfer: { totalBytes: st.size } });

            res.status(200);
            res.setHeader("Content-Type", "video/mp4");
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("Content-Length", String(st.size));
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            res.setHeader("X-Clip-Requested-Start", String(sReq.toFixed(3)));
            res.setHeader("X-Clip-Requested-End",   String(eReq.toFixed(3)));
            res.setHeader("X-Clip-Snapped-Start",   String(sSnap.toFixed(3)));
            res.setHeader("X-Clip-Snapped-End",     String(eSnap.toFixed(3)));
            res.setHeader("X-Job-Id", jobId);

            const read = fs.createReadStream(outputTarget);
            read.on("data", (chunk) => {
              patchJob(jobId, { transfer: { bytes: (jobs.get(jobId)?.transfer?.bytes || 0) + chunk.length } });
            });
            read.pipe(res);
            read.on("close", async () => {
              try { await fs.promises.unlink(outputTarget); } catch {}
              endJob(jobId, "done");
            });
            return;
          } catch (e) {
            console.error("send solid file error", e);
          }
        }
        const msg = (errLog.trim() || `ffmpeg exited. code=${codeExit} signal=${signal}`).slice(0, 1800);
        endJob(jobId, "error", msg);
        return res.status(500).type("text").end(msg);
      } else {
        if (!hadData && !sentHeaders) {
          const msg = (errLog.trim() || `ffmpeg exited. code=${codeExit} signal=${signal}`).slice(0, 1800);
          endJob(jobId, "error", msg);
          return res.status(500).type("text").end(msg);
        }
        if (!res.writableEnded) res.end();
        if (codeExit !== 0 || signal) {
          console.error("ffmpeg exit", { codeExit, signal, err: errLog });
        }
        endJob(jobId, "done");
      }
    });

    ff.on("error", (e) => {
      if (watchdog) clearTimeout(watchdog);
      console.error("spawn error", e);
      endJob(jobId, "error", e.message || String(e));
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
