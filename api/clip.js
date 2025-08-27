// api/clip.js — Vercel Node serverless (CommonJS)
// Streams a 0–10 min MP4 by remuxing HLS (no re-encode).
// Robust against ENOENT by preferring @ffmpeg-installer/ffmpeg and verifying the path.

const fs = require('fs');
const { spawn } = require('child_process');

// Resolve ffmpeg path (prefer @ffmpeg-installer/ffmpeg, fallback to ffmpeg-static)
function resolveFfmpegPath() {
  const candidates = [];
  try { const p = require('@ffmpeg-installer/ffmpeg').path; if (p) candidates.push(p); } catch {}
  try { const p = require('ffmpeg-static');                 if (p) candidates.push(p); } catch {}
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

const ffmpegPath = resolveFfmpegPath();
if (!ffmpegPath) {
  throw new Error('FFmpeg binary not found at runtime. Did you add includeFiles in vercel.json and install @ffmpeg-installer/ffmpeg?');
}

// Force **Node** runtime (not Edge)
module.exports.config = { runtime: 'nodejs20.x' };

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
      res.statusCode = 400; return res.end('Bad params: code/start/end');
    }
    const duration = +(end - start).toFixed(3);
    if (duration > MAX_LEN) { res.statusCode = 400; return res.end(`Max clip length is ${MAX_LEN}s`); }

    const m3u8Url = `${BASE}/videos/${encodeURIComponent(code)}/${PLAYLIST}`;

    const args = [
      '-hide_banner','-loglevel','error',
      '-protocol_whitelist','file,crypto,data,http,https,tcp,tls',
      '-ss', String(start),
      '-t', String(duration),
      '-i', m3u8Url,
      '-c','copy',
      '-bsf:a','aac_adtstoasc',
      '-movflags','+faststart',
      '-f','mp4',
      'pipe:1'
    ];

    console.log('Using ffmpeg at:', ffmpegPath); // <— shows up in Vercel function logs

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore','pipe','pipe'] });

    // Kill ffmpeg if client cancels
    req.on('aborted', () => { try { proc.kill('SIGKILL'); } catch {} });

    // Stream MP4 out
    res.statusCode = 200;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="clip_${code}_${Math.floor(start)}-${Math.floor(end)}.mp4"`);
    proc.stdout.pipe(res);

    let errLog = '';
    proc.stderr.on('data', d => { errLog += d.toString(); });

    proc.on('close', codeExit => {
      if (codeExit !== 0) {
        console.error('ffmpeg exit', codeExit, errLog);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(`ffmpeg failed (code ${codeExit})\n${errLog.slice(0, 2000)}`);
        }
      }
    });

    proc.on('error', e => {
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
