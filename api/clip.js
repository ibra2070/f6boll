// api/clip.js — Vercel Node serverless function (CommonJS)
// Streams a 0–10 min MP4 by remuxing HLS with ffmpeg (no re-encode).

const { spawn } = require('child_process');

// Try ffmpeg-static first; fall back to @ffmpeg-installer/ffmpeg
let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch {}
if (!ffmpegPath) {
  try { ffmpegPath = require('@ffmpeg-installer/ffmpeg').path; } catch {}
}
if (!ffmpegPath) {
  // Let it throw early with a clear message
  throw new Error('FFmpeg binary not found. Install ffmpeg-static or @ffmpeg-installer/ffmpeg');
}

// Force Node runtime (not Edge)
module.exports.config = { runtime: 'nodejs18.x' };
// ↑ If your project uses Node 20 on Vercel, you can also use: 'nodejs20.x'

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
      '-protocol_whitelist', 'file,crypto,data,http,https,tcp,tls',
      '-ss', String(start),
      '-t', String(duration),
      '-i', m3u8Url,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      '-f', 'mp4',
      'pipe:1'
    ];

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // If the client aborts (closes tab), kill ffmpeg
    req.on('aborted', () => { try { proc.kill('SIGKILL'); } catch {} });

    // Prepare response headers early (streaming)
    res.statusCode = 200;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="clip_${code}_${Math.floor(start)}-${Math.floor(end)}.mp4"`
    );

    // Stream video out
    proc.stdout.pipe(res);

    // Capture stderr for diagnostics
    let errLog = '';
    proc.stderr.on('data', (d) => { errLog += d.toString(); });

    proc.on('close', (exitCode) => {
      if (exitCode !== 0) {
        console.error('ffmpeg exit', exitCode, errLog);
        // If headers already sent, the stream ended abruptly.
        // If not sent (rare), return a helpful error.
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

