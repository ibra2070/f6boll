// api/clip.js (CommonJS for Vercel Node)
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

// Your Cloudflare Worker base + playlist
const BASE = 'https://fision-videos-worker.myfisionupload.workers.dev';
const PLAYLIST = 'stream_0.m3u8';

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const code  = q.code;
    const start = parseFloat(q.start || '0');
    const end   = parseFloat(q.end   || '0');

    if (!code || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      res.statusCode = 400; return res.end('Bad params');
    }
    const duration = +(end - start).toFixed(3);
    const MAX = 600; // 10 minutes
    if (duration > MAX) {
      res.statusCode = 400; return res.end(`Max clip length is ${MAX}s`);
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

    res.statusCode = 200;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="clip_${code}_${Math.floor(start)}-${Math.floor(end)}.mp4"`
    );

    proc.stdout.pipe(res);

    let err = '';
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', codeExit => { if (codeExit !== 0) console.error('ffmpeg exit', codeExit, err); });
    proc.on('error', e => {
      console.error('ffmpeg spawn error', e);
      try { if (!res.headersSent) res.statusCode = 500; res.end('Server error'); } catch {}
    });
  } catch (e) {
    console.error(e);
    res.statusCode = 500; res.end('Server error');
  }
};
