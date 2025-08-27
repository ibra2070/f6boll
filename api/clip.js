// api/clip.js — Vercel Serverless (Node / CommonJS)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const BASE = 'https://fision-videos-worker.myfisionupload.workers.dev';
const PLAYLIST = 'stream_0.m3u8';
const MAX_LEN = 600; // 10 minutes

function findFfmpeg() {
  try {
    const p = require('@ffmpeg-installer/ffmpeg').path;
    if (p && fs.existsSync(p)) return p;
  } catch {}
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return null;
}

function prepareFfmpeg() {
  const src = findFfmpeg();
  if (!src) throw new Error('FFmpeg not found. Ensure node_modules is bundled.');
  const dst = path.join(os.tmpdir(), 'ffmpeg-bin');
  if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) {
    fs.copyFileSync(src, dst);
    try { fs.chmodSync(dst, 0o755); } catch {}
  }
  return dst;
}

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
    const ffmpeg = prepareFfmpeg();

    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      // more robust network behavior
      '-rw_timeout', '15000000',                // 15s socket read timeout
      '-user_agent', 'FisionClipper/1.0',
      '-protocol_whitelist', 'file,crypto,data,http,https,tcp,tls',
      // seek & limit
      '-ss', String(start),
      '-t', String(duration),
      '-i', m3u8Url,
      // tolerate missing tracks
      '-map', '0:v?', '-map', '0:a?',
      // remux only (fast)
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      '-f', 'mp4',
      'pipe:1'
    ];

    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // if client cancels, kill ffmpeg
    req.on('aborted', () => { try { proc.kill('SIGKILL'); } catch {} });

    let sentHeaders = false;
    let hadData = false;
    let errLog = '';
    let exitSignal = null;

    // write the first chunk before piping (prevents 0-byte files)
    proc.stdout.once('data', chunk => {
      hadData = true;
      if (!sentHeaders) {
        sentHeaders = true;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition',
          `attachment; filename="clip_${code}_${Math.floor(start)}-${Math.floor(end)}.mp4"`);
      }
      res.write(chunk);
      proc.stdout.pipe(res);
    });

    proc.stderr.on('data', d => { errLog += d.toString(); });

    proc.on('exit', (code, signal) => { exitSignal = signal || null; });

    proc.on('close', (codeExit /* may be null if killed */) => {
      if (!hadData) {
        if (!sentHeaders) {
          res.statusCode = 500;
          const why = errLog.trim() || `ffmpeg exited. code=${codeExit} signal=${exitSignal}`;
          return res.end(why.slice(0, 2000));
        }
      }
      try { if (!res.writableEnded) res.end(); } catch {}
      if (codeExit !== 0) console.error('ffmpeg close', { codeExit, exitSignal, errLog });
    });

    proc.on('error', (e) => {
      console.error('ffmpeg spawn error', e);
      if (!sentHeaders) {
        res.statusCode = 500;
        res.end('ffmpeg spawn error: ' + (e.message || e));
      } else {
        try { res.end(); } catch {}
      }
    });
  } catch (e) {
    console.error('handler error', e);
    res.statusCode = 500;
    res.end('Server error: ' + (e.message || e));
  }
};
