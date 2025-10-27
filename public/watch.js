// =================== Config (R2 worker base) ===================
const HLS_BASE = 'https://fision-videos-worker.myfisionupload.workers.dev';
const PLAYLIST = 'stream_0.m3u8';

// =================== Elements ===================
const els = {
  code: document.getElementById('code'),
  load: document.getElementById('loadBtn'),
  vid: document.getElementById('vid'),
  tNow: document.getElementById('tNow'),
  tDur: document.getElementById('tDur'),
  setA: document.getElementById('setA'),
  setB: document.getElementById('setB'),
  valA: document.getElementById('valA'),
  valB: document.getElementById('valB'),
  preview: document.getElementById('previewBtn'),
  cancelPreview: document.getElementById('cancelPreviewBtn'),
  download: document.getElementById('downloadBtn'),
  chips: document.querySelectorAll('.chips button'),
  dlWrap: document.getElementById('dlWrap'),
  dlBar: document.getElementById('dlBar'),
  dlLabel: document.getElementById('dlLabel'),
  cancelDl: document.getElementById('cancelDl'),
  commentsBlock: document.getElementById('commentsBlock'),
  commentText: document.getElementById('commentText'),
  commentSec: document.getElementById('commentSec'),
  useCurrent: document.getElementById('useCurrent'),
  addComment: document.getElementById('addCommentBtn'),
  commentList: document.getElementById('commentList'),
};

// =================== State ===================
let A = null, B = null;
let hls = null;
let previewTimer = null, prevTime = 0;
let dlController = null;
let currentCode = null;

// =================== Utils ===================
const fmt = s => { s = Math.max(0, s|0); const m = (s/60)|0, ss = s%60; return m + ':' + String(ss).padStart(2,'0'); };
const getQP = k => new URLSearchParams(location.search).get(k);
const bytes = n => { if (!Number.isFinite(n) || n <= 0) return '0 B'; const u=['B','KB','MB','GB','TB']; let i=0, v=n; while(v>=1024&&i<u.length-1){v/=1024;i++;} return v.toFixed(v<10&&i>0?1:0)+' '+u[i]; };

// =================== Zoom init ===================
const container = document.getElementById('video-container');
const panzoom = Panzoom(els.vid, { maxScale: 5, contain: 'outside' });
container.addEventListener('wheel', panzoom.zoomWithWheel);

// =================== HLS load (R2 worker) ===================
async function loadVideo() {
  const code = (els.code.value || '').trim();
  if (!code) { alert('Enter a game code'); return; }

  const src = `${HLS_BASE}/videos/${encodeURIComponent(code)}/${PLAYLIST}`;
  console.log('[watch] src:', src);

  // Quick probe to reveal CORS/status in console
  try {
    const head = await fetch(src, { method: 'GET', cache: 'no-store' });
    console.log('[watch] m3u8 status:', head.status, head.statusText);
  } catch (e) {
    console.warn('[watch] m3u8 fetch failed:', e);
  }

  if (hls) { try { hls.destroy(); } catch {} hls = null; }
  els.vid.pause();
  els.vid.removeAttribute('src');
  els.vid.load();

  // helpful error hook
  els.vid.onerror = () => {
    const err = els.vid.error;
    console.error('[video] error', err);
    alert('Video error. Check console for details.');
  };

  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ enableWorker: true });
    hls.on(Hls.Events.ERROR, (_, data) => {
      console.warn('[hls] error', data?.type, data?.details, data);
      if (data?.fatal) alert('HLS fatal: ' + (data?.details || data?.type));
    });
    hls.loadSource(src);
    hls.attachMedia(els.vid);
  } else if (els.vid.canPlayType('application/vnd.apple.mpegurl')) {
    els.vid.src = src; // Safari
  } else {
    alert('HLS is not supported in this browser.');
    return;
  }

  currentCode = code;
  els.commentsBlock.style.display = '';
  await refreshComments();
  els.commentSec.value = Math.floor(els.vid.currentTime) || 0;
}

// =================== A/B ===================
function setA() { A = Math.floor(els.vid.currentTime); els.valA.textContent = fmt(A); }
function setB() { B = Math.floor(els.vid.currentTime); els.valB.textContent = fmt(B); }

// =================== Preview ===================
async function previewClip() {
  if (!Number.isFinite(A) || !Number.isFinite(B) || B <= A) { alert('Set valid A and B first.'); return; }
  if (previewTimer) { cancelPreview(); }
  prevTime = els.vid.currentTime;
  els.vid.currentTime = A;
  try { await els.vid.play(); } catch {}
  previewTimer = setTimeout(cancelPreview, (B - A) * 1000);
  els.preview.disabled = true;
}
function cancelPreview() {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
  try { els.vid.pause(); } catch {}
  els.vid.currentTime = prevTime || A || 0;
  els.preview.disabled = false;
}

// =================== Comments (same endpoints you already had) ===================
function renderComments(items=[]) {
  items.sort((a,b)=> (a.time||0) - (b.time||0));
  els.commentList.innerHTML = '';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'comment-item';
    const t = document.createElement('div');
    t.className = 'tchip';
    t.innerHTML = `<span class="ctime">${fmt(it.time|0)}</span>`;
    const text = document.createElement('div');
    text.className = 'ctext';
    text.textContent = it.text || '';
    const go = Object.assign(document.createElement('button'), { textContent: 'Jump' });
    go.onclick = () => { try { els.vid.currentTime = it.time||0; els.vid.focus(); } catch{} };
    row.appendChild(t); row.appendChild(text); row.appendChild(go);
    els.commentList.appendChild(row);
  }
}

async function refreshComments() {
  if (!currentCode) return;
  try {
    const r = await fetch(`/api/comments?code=${encodeURIComponent(currentCode)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    renderComments(data?.comments || []);
  } catch (e) {
    console.warn('comments fetch failed', e);
    renderComments([]);
  }
}

async function addComment() {
  if (!currentCode) { alert('Load a video first'); return; }
  const text = (els.commentText.value || '').trim();
  const sec = Number(els.commentSec.value || 0);
  if (!text) { alert('Type a comment'); return; }
  if (!Number.isFinite(sec) || sec < 0) { alert('Invalid time'); return; }
  try {
    const r = await fetch('/api/comments', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ code: currentCode, time: Math.floor(sec), text }),
    });
    if (!r.ok) throw new Error(await r.text());
    els.commentText.value = '';
    await refreshComments();
  } catch (e) {
    alert('Failed to add comment: ' + (e.message || e));
  }
}

// =================== Time labels ===================
els.vid.addEventListener('timeupdate', () => {
  els.tNow.textContent = fmt(els.vid.currentTime|0);
  if (document.activeElement !== els.commentSec) {
    els.commentSec.value = Math.floor(els.vid.currentTime) || 0;
  }
});
els.vid.addEventListener('loadedmetadata', () => {
  els.tDur.textContent = fmt(els.vid.duration|0);
});

// =================== Download MP4 via /api/clip ===================
function showProgress() {
  els.dlWrap.style.display = '';
  els.dlBar.classList.remove('indeterminate');
  els.dlBar.style.width = '0%';
  els.dlLabel.textContent = 'Preparing…';
  els.cancelDl.disabled = false;
  els.download.disabled = true;
}
function hideProgress() { els.dlWrap.style.display = 'none'; els.download.disabled = false; }
function setProgress(received, total) {
  if (total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((received / total) * 100)));
    els.dlBar.classList.remove('indeterminate');
    els.dlBar.style.width = `${pct}%`;
    els.dlLabel.textContent = `${pct}% — ${bytes(received)} of ${bytes(total)}`;
  } else {
    els.dlBar.classList.add('indeterminate');
    els.dlLabel.textContent = `Downloading… ${bytes(received)}`;
  }
}
function setStatus(msg) { els.dlLabel.textContent = msg; }

function pollServerProgress(jobId, isDownloading, intervalMs = 500) {
  let stopped = false;
  const id = setInterval(async () => {
    if (stopped) return clearInterval(id);
    try {
      const r = await fetch(`/api/progress/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (!isDownloading()) {
        const pct = Number.isFinite(j?.progress?.pct) ? j.progress.pct : 0;
        setStatus(`Processing… ${pct}%`);
      }
      if (j?.status === 'done' || j?.status === 'error' || j?.status === 'canceled') {
        clearInterval(id);
      }
    } catch {}
  }, intervalMs);
  return () => { stopped = true; clearInterval(id); };
}

async function downloadClip() {
  const code = (els.code.value || '').trim();
  if (!code || !Number.isFinite(A) || !Number.isFinite(B) || B <= A) {
    alert('Enter code and set valid A/B times.');
    return;
  }
  if (dlController) return;

  const jobId = (crypto.randomUUID?.() || (Date.now() + '_' + Math.random().toString(16).slice(2)));
  const url = `/api/clip?code=${encodeURIComponent(code)}&start=${A.toFixed(2)}&end=${B.toFixed(2)}&job=${encodeURIComponent(jobId)}`;

  showProgress();
  dlController = new AbortController();
  let downloadStarted = false;
  const stopPolling = pollServerProgress(jobId, () => downloadStarted);

  const cancel = () => {
    if (dlController) {
      dlController.abort();
      els.cancelDl.disabled = true;
      setStatus('Canceling…');
    }
  };
  els.cancelDl.onclick = cancel;

  try {
    const res = await fetch(url, { signal: dlController.signal });
    if (!res.ok) {
      const t = await res.text().catch(()=>res.statusText);
      hideProgress(); dlController = null; stopPolling?.();
      alert('Download failed: ' + t);
      return;
    }

    const total = Number(res.headers.get('Content-Length')) || 0;

    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (!downloadStarted && value && value.byteLength) downloadStarted = true;
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        setProgress(received, total);
      }

      els.dlBar.classList.remove('indeterminate');
      els.dlBar.style.width = '100%';
      setStatus('Finalizing…');

      const blob = new Blob(chunks, { type: 'video/mp4' });
      const name = `clip_${code}_${A}-${B}.mp4`;

      if (navigator.share && navigator.canShare?.({ files:[new File([blob], name, { type:'video/mp4' })] })) {
        try {
          await navigator.share({ files:[new File([blob], name, { type:'video/mp4' })], title:'Clip' });
          setStatus('Shared ✅');
          setTimeout(hideProgress, 800);
          stopPolling?.();
          dlController = null;
          return;
        } catch {}
      }

      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);

      setStatus('Saved ✅');
      setTimeout(hideProgress, 800);
      stopPolling?.();
    } else {
      els.dlBar.classList.add('indeterminate');
      setStatus('Downloading…');
      const blob = await res.blob();
      const name = `clip_${code}_${A}-${B}.mp4`;
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);

      setStatus('Saved ✅');
      setTimeout(hideProgress, 800);
      stopPolling?.();
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      setStatus('Canceled');
      setTimeout(hideProgress, 500);
    } else {
      console.error(err);
      alert('Download failed: ' + (err?.message || err));
      hideProgress();
    }
  } finally {
    dlController = null;
    els.cancelDl.disabled = false;
  }
}

// =================== Events ===================
els.load.onclick = loadVideo;
els.code.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') loadVideo(); });
els.setA.onclick = setA;
els.setB.onclick = setB;
els.preview.onclick = previewClip;
els.cancelPreview.onclick = cancelPreview;
els.download.onclick = downloadClip;
els.chips.forEach(b => b.onclick = () => { els.vid.currentTime += Number(b.dataset.skip); });

els.useCurrent.onclick = (e)=>{ e.preventDefault(); els.commentSec.value = Math.floor(els.vid.currentTime)||0; };
els.addComment.onclick = (e)=>{ e.preventDefault(); addComment(); };

// Auto-load from ?code=...
const qCode = getQP('code');
if (qCode) { els.code.value = qCode; loadVideo(); }
