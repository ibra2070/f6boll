// api/clip.js — Vercel Node serverless function (CommonJS)
// Streams a 0–10 min MP4 by remuxing HLS with ffmpeg (no re-encode).
// Fixes ENOENT by preferring @ffmpeg-installer/ffmpeg, verifying the path,
// and ensuring Node runtime.

const fs = require('fs');
const { spawn } = require('child_process');

// Resolve ffmpeg path (prefer @ffmpeg-installer/ffmpeg)
function resolveFfmpegPath() {
  const candidates = [];
  try {
    const p = require('@ffmpeg-installer/ffmpeg').path;
    if (p) candidates.push(p);
  } catch {}
  try {
    const p = require('ffmpeg-static');
    if (p) candidates.push(p);
  } catch {}

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

const ffmpegPath = resolveFfmpegPath();
if (!ffmpegPath) {
  throw new Error(
    'FFmpeg binary not found at runtime. Ensure @ffmpeg-installer/ffmpeg or ffmpeg-static is installed and included (see vercel.json includeFiles).'
  );
}

// Force Node runtime (NOT Edge)
module.exports.config = { runtime: 'nodejs18.x' };
// Use 'nodejs20.x' if your project default is Node 20.

const BASE = 'https://fision-videos-worker.myfisionupload.workers.dev';
const PLAYLIST = 'stream_0.m3u8';
const MAX_LEN = 600; // 10 minutes

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const code  = (q.code || '').trim();
    const start = parseFloat(q.start || '0');
    const end   = parseFloat(q.end   || '0');

    if (!code || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      res.statusCode = 400;
      return res.end('Bad params: code/start/end');
    }
    const duration = +(end - start).toFixed(3);
    if (duration > MAX_LEN) {
      res.statusCode = 400;
      return res.end(`Max clip length is ${MAX_LEN}s`);
    }

    const m3u8Url = `${BASE}/videos/${encodeURIComponent(code)}/${PLAYLIST}`;

    const args = [
      '-hide_banner', '-loglevel', 'error',
      // allow https HLS fetch inside serverless
      '-protocol_whitelist', 'file,crypto,data,http,https,tcp,tls',
      // fast seek & duration clamp
      '-ss', String(start),
      '-t', String(duration),
      '-i', m3u8Url,
      // remux only (no re-encode)
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      '-f', 'mp4',
      'pipe:1'
    ];

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // If client aborts, kill ffmpeg
    req.on('aborted', () => { try { proc.kill('SIGKILL'); } catch {} });

    // Prepare streaming response
    res.statusCode = 200;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="clip_${code}_${Math.floor(start)}-${Math.floor(end)}.mp4"`
    );

    proc.stdout.pipe(res);

    let errLog = '';
    proc.stderr.on('data', (d) => { errLog += d.toString(); });

    proc.on('close', (exitCode) => {
      if (exitCode !== 0) {
        console.error('ffmpeg exit', exitCode, errLog);
        // If headers not sent (rare), return a helpful message
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(`ffmpeg failed (code ${exitCode})\n${errLog.slice(0, 2000)}`);
        }
      }
    });

    proc.on('error', (e) => {
      console.error('ffmpeg spawn error', e);
      try {
        if (!res.headersSent) res.statusCode = 500;
        res.end('ffmpeg spawn error: ' + (e.message || e));
      } catch {}
    });
  } catch (e) {
    console.error('handler error', e);
    res.statusCode = 500;
    res.end('Server error: ' + (e.message || e));
  }
};
