'use strict';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 공통
async function api(path, { method = 'GET', json, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }
  const res = await fetch('/api' + path, init);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.message) || res.statusText);
    err.status = res.status;
    err.code = data && data.error;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 7000 : 3500);
}

const pad2 = (n) => String(n).padStart(2, '0');
const fmtClock = (sec) => `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(Math.floor(sec % 60))}`;
const fmtMs = (sec) => `${pad2(Math.floor(sec / 60))}:${pad2(Math.floor(sec % 60))}`;
const fmtDate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fmtDur = (sec) => (sec == null ? '-' : sec >= 3600 ? `${Math.floor(sec / 3600)}시간 ${Math.floor((sec % 3600) / 60)}분` : `${Math.max(1, Math.round(sec / 60))}분`);

const STATUS = { recording: '녹음 중', interrupted: '녹음 중단됨', recorded: '처리 대기', processing: '처리 중', done: '완료', failed: '실패' };
const PROVIDER = { local: '로컬', groq: 'Groq' };

function externalList(s, mode) {
  const out = [];
  if (mode !== 'summary' && s.sttProvider === 'groq') out.push('전사(Groq)');
  if (s.summaryProvider === 'groq') out.push('요약(Groq)');
  return out;
}

function askConsent(list) {
  return new Promise((resolve) => {
    const d = $('#consentDialog');
    $('#consentList').textContent = list.join(', ');
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
    d.showModal();
  });
}

// ---------------------------------------------------------------- 마크다운(요약 표시용 최소 변환)
function renderMd(src) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let html = '';
  let inList = false;
  const closeList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|/.test(l)) {
      closeList();
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      i--;
      const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^[\s|:-]+$/.test(r));
      html += '<table>' + body.map((r, idx) => `<tr>${cells(r).map((c) => `<${idx ? 'td' : 'th'}>${inline(c)}</${idx ? 'td' : 'th'}>`).join('')}</tr>`).join('') + '</table>';
    } else if (/^##\s+/.test(l)) {
      closeList();
      html += `<h2>${inline(l.replace(/^##\s+/, ''))}</h2>`;
    } else if (/^#\s+/.test(l)) {
      closeList();
      html += `<h2>${inline(l.replace(/^#\s+/, ''))}</h2>`;
    } else if (/^###\s+/.test(l)) {
      closeList();
      html += `<h3>${inline(l.replace(/^###\s+/, ''))}</h3>`;
    } else if (/^\s*[-*]\s+/.test(l)) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`;
    } else if (l.trim()) {
      closeList();
      html += `<p>${inline(l)}</p>`;
    } else {
      closeList();
    }
  }
  closeList();
  return html;
}

// ---------------------------------------------------------------- 화면 전환
let currentView = 'record';
let detailTimer = null;
let currentId = null;
let detailTab = 'summary';

function showView(name) {
  currentView = name;
  clearTimeout(detailTimer);
  for (const v of ['record', 'list', 'detail', 'settings']) $('#view-' + v).hidden = v !== name;
  for (const b of document.querySelectorAll('#nav button')) b.classList.toggle('active', b.dataset.view === (name === 'detail' ? 'list' : name));
  if (name === 'list') loadList();
  if (name === 'settings') loadSettings();
  if (name === 'record') refreshRecordInfo();
}

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) showView(b.dataset.view);
});

async function refreshBadge() {
  try {
    const s = await api('/settings');
    const ext = externalList(s, 'resume');
    const b = $('#modeBadge');
    b.textContent = ext.length ? `외부 전송 사용: ${ext.join(', ')}` : '로컬 처리 (외부 전송 없음)';
    b.classList.toggle('ext', ext.length > 0);
    return s;
  } catch {
    return null;
  }
}

async function refreshRecordInfo() {
  const s = await refreshBadge();
  let info = '';
  if (s) {
    info = `전사: ${PROVIDER[s.sttProvider]} · 요약: ${PROVIDER[s.summaryProvider]}.`;
    const ext = externalList(s, 'resume');
    if (ext.length) info += ' 녹음을 종료하면 전송 동의를 먼저 확인합니다.';
  }
  try {
    const st = await api('/status');
    if (st.freeBytes != null) {
      const gb = st.freeBytes / 1024 ** 3;
      info += ` 저장 공간 여유: ${gb.toFixed(1)}GB${gb < 1 ? ' (부족)' : ''}.`;
    }
  } catch {
    // 상태 조회 실패는 무시
  }
  $('#recInfo').textContent = info;
}

// ---------------------------------------------------------------- 녹음
const rec = {
  active: false,
  stream: null,
  recorder: null,
  meetingId: null,
  segIndex: 0,
  segMs: 600000,
  ext: 'webm',
  mime: '',
  timer: null,
  lastTick: 0,
  activeMs: 0,
  segActiveMs: 0,
  paused: false,
  queue: Promise.resolve(),
  pending: 0,
  uploadFailed: false,
  ctx: null,
  raf: 0,
};

function pickMime() {
  const cands = [
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/webm', 'webm'],
    ['audio/ogg;codecs=opus', 'ogg'],
    ['audio/mp4', 'mp4'],
  ];
  for (const [m, ext] of cands) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return { mime: m, ext };
  return { mime: '', ext: 'webm' };
}

function showRecMsg(text, kind = '') {
  const el = $('#recMsg');
  el.textContent = text;
  el.className = 'msg ' + kind;
  el.hidden = !text;
}

async function loadMics() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const sel = $('#recMic');
    const keep = sel.value;
    sel.innerHTML = '<option value="">기본 마이크</option>' + devs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || '마이크 ' + (i + 1))}</option>`).join('');
    sel.value = keep;
  } catch {
    // 장치 목록을 못 읽어도 기본 마이크로 진행
  }
}

function enqueueUpload(idx, blob) {
  rec.pending++;
  rec.queue = rec.queue.then(async () => {
    let ok = false;
    for (let attempt = 0; attempt < 5 && !ok; attempt++) {
      try {
        const r = await fetch(`/api/meetings/${rec.meetingId}/segments/${idx}/chunk?ext=${rec.ext}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: blob,
        });
        if (r.ok) ok = true;
        else if (r.status === 507) break;
      } catch {
        // 재시도
      }
      if (!ok) await sleep(1000 * (attempt + 1));
    }
    rec.pending--;
    if (!ok && !rec.uploadFailed) {
      rec.uploadFailed = true;
      showRecMsg('녹음 데이터를 저장하지 못했습니다. 디스크 공간과 프로그램 실행 상태를 확인하세요.', 'err');
    }
  });
}

function startSegment() {
  const idx = rec.segIndex;
  const opts = { audioBitsPerSecond: 32000 };
  if (rec.mime) opts.mimeType = rec.mime;
  const r = new MediaRecorder(rec.stream, opts);
  r.ondataavailable = (e) => {
    if (e.data && e.data.size) enqueueUpload(idx, e.data);
  };
  r.start(5000); // 5초마다 디스크에 저장(R-04)
  rec.recorder = r;
  rec.segActiveMs = 0;
}

function rotateSegment() {
  const old = rec.recorder;
  rec.segIndex++;
  startSegment();
  old.stop();
}

function tick() {
  const now = performance.now();
  const dt = now - rec.lastTick;
  rec.lastTick = now;
  if (!rec.paused) {
    rec.activeMs += dt;
    rec.segActiveMs += dt;
  }
  $('#recTimer').textContent = fmtClock(rec.activeMs / 1000);
  $('#recSave').textContent = rec.pending > 0 ? `저장 중… (대기 ${rec.pending})` : '노트북에 저장되고 있습니다.';
  if (!rec.paused && rec.segActiveMs >= rec.segMs) rotateSegment();
}

function startMeter() {
  try {
    rec.ctx = new AudioContext();
    const src = rec.ctx.createMediaStreamSource(rec.stream);
    const an = rec.ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const bar = $('#levelBar');
    const loop = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      bar.style.width = Math.min(100, Math.sqrt(sum / buf.length) * 300) + '%';
      rec.raf = requestAnimationFrame(loop);
    };
    loop();
  } catch {
    // 음량 표시는 부가 기능
  }
}

function micError(e) {
  if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) return '마이크 권한이 거부되었습니다. 주소창의 마이크 아이콘에서 허용한 뒤 다시 시도하세요.';
  if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) return '사용할 수 있는 마이크를 찾지 못했습니다. 마이크 연결과 Windows 개인정보 설정을 확인하세요.';
  return '마이크를 시작하지 못했습니다: ' + (e && e.message ? e.message : e);
}

async function startRecording() {
  showRecMsg('');
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    showRecMsg('이 브라우저는 녹음을 지원하지 않습니다. 최신 Edge 또는 Chrome을 사용하세요.', 'err');
    return;
  }
  const btn = $('#btnStart');
  btn.disabled = true;
  try {
    const deviceId = $('#recMic').value;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
    } catch (e) {
      showRecMsg(micError(e), 'err');
      return;
    }
    loadMics();

    const st = await api('/status').catch(() => ({}));
    if (st.freeBytes != null && st.freeBytes < 1024 ** 3) {
      if (!confirm('저장 공간이 1GB 미만입니다. 그래도 녹음을 시작할까요?')) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
    }
    const settings = await api('/settings');
    const meeting = await api('/meetings', {
      method: 'POST',
      json: { title: $('#recTitle').value, attendees: $('#recAttendees').value, memo: $('#recMemo').value },
    });

    const { mime, ext } = pickMime();
    Object.assign(rec, {
      active: true,
      stream,
      meetingId: meeting.id,
      segIndex: 0,
      segMs: settings.segmentMinutes * 60 * 1000,
      mime,
      ext,
      activeMs: 0,
      segActiveMs: 0,
      paused: false,
      pending: 0,
      uploadFailed: false,
      queue: Promise.resolve(),
      lastTick: performance.now(),
    });
    startSegment();
    startMeter();
    rec.timer = setInterval(tick, 500);

    $('#recSetup').hidden = true;
    $('#recLive').hidden = false;
    $('#recDot').classList.remove('paused');
    $('#recStateText').textContent = '녹음 중';
    $('#btnPause').textContent = '일시정지';
    $('#recTimer').textContent = '00:00:00';
  } catch (e) {
    showRecMsg('녹음을 시작하지 못했습니다: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function togglePause() {
  if (!rec.active) return;
  rec.paused = !rec.paused;
  if (rec.paused) rec.recorder.pause();
  else rec.recorder.resume();
  rec.lastTick = performance.now();
  $('#btnPause').textContent = rec.paused ? '재개' : '일시정지';
  $('#recDot').classList.toggle('paused', rec.paused);
  $('#recStateText').textContent = rec.paused ? '일시정지' : '녹음 중';
}

async function stopRecording() {
  if (!rec.active) return;
  const stopBtn = $('#btnStop');
  stopBtn.disabled = true;
  clearInterval(rec.timer);
  cancelAnimationFrame(rec.raf);
  const last = rec.recorder;
  await new Promise((resolve) => {
    last.onstop = resolve;
    if (last.state !== 'inactive') last.stop();
    else resolve();
  });
  await sleep(300);
  await rec.queue;
  rec.stream.getTracks().forEach((t) => t.stop());
  if (rec.ctx) rec.ctx.close().catch(() => {});
  rec.active = false;
  const id = rec.meetingId;

  $('#recLive').hidden = true;
  $('#recSetup').hidden = false;
  stopBtn.disabled = false;
  if (rec.uploadFailed) showRecMsg('일부 녹음이 저장되지 않았을 수 있습니다. 회의 목록에서 확인하세요.', 'err');

  await finishAndProcess(id, 'finish');
  $('#recTitle').value = '';
  $('#recAttendees').value = '';
  $('#recMemo').value = '';
}

// 녹음 종료 후, 또는 상세 화면에서 처리를 시작한다. 외부 전송이 있으면 동의를 먼저 받는다(EXT-03).
async function finishAndProcess(id, kind, mode = 'resume') {
  try {
    const settings = await api('/settings');
    const ext = externalList(settings, mode);
    const body = {};
    if (ext.length) {
      if (await askConsent(ext)) body.consent = true;
      else if (kind === 'finish') body.process = false; // 동의하지 않으면 녹음만 저장
      else return false;
    }
    if (kind === 'finish') {
      const r = await api(`/meetings/${id}/finish`, { method: 'POST', json: body });
      if (r.discarded) {
        showRecMsg('녹음된 내용이 없어 저장하지 않았습니다.');
        return false;
      }
    } else {
      await api(`/meetings/${id}/reprocess`, { method: 'POST', json: { ...body, mode } });
    }
    openDetail(id);
    return true;
  } catch (e) {
    toast(e.message, true);
    openDetail(id);
    return false;
  }
}

$('#btnStart').addEventListener('click', startRecording);
$('#btnPause').addEventListener('click', togglePause);
$('#btnStop').addEventListener('click', stopRecording);
window.addEventListener('beforeunload', (e) => {
  if (rec.active) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------------------------------------------------------- 목록
async function loadList() {
  const q = $('#searchBox').value;
  try {
    const items = await api('/meetings' + (q ? '?q=' + encodeURIComponent(q) : ''));
    $('#listEmpty').hidden = items.length > 0;
    $('#listTable tbody').innerHTML = items
      .map((m) => {
        const prov = m.providers ? `${PROVIDER[m.providers.stt] || '-'} / ${PROVIDER[m.providers.summary] || '-'}` : '-';
        return `<tr class="clickable" data-id="${esc(m.id)}"><td>${esc(fmtDate(m.createdAt))}</td><td>${esc(m.title)}</td><td>${esc(fmtDur(m.durationSec))}</td><td><span class="st ${esc(m.status)}">${esc(STATUS[m.status] || m.status)}</span></td><td>${esc(prov)}</td></tr>`;
      })
      .join('');
  } catch (e) {
    toast(e.message, true);
  }
}

$('#listTable tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openDetail(tr.dataset.id);
});
let searchTimer;
$('#searchBox').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadList, 300);
});

// ---------------------------------------------------------------- 상세
function openDetail(id) {
  currentId = id;
  detailTab = 'summary';
  showView('detail');
  renderDetail();
}

function progressText(p) {
  if (!p) return '';
  if (p.stage === 'transcribing') return `전사 중 (${Math.min(p.done + 1, p.total)}/${p.total} 구간)`;
  if (p.stage === 'summarizing') return p.total > 1 ? `요약 중 (${p.done}/${p.total})` : '요약 중';
  return '처리 대기 중';
}

async function renderDetail() {
  clearTimeout(detailTimer);
  const id = currentId;
  let m;
  try {
    m = await api('/meetings/' + id);
  } catch (e) {
    toast(e.message, true);
    showView('list');
    return;
  }
  if (currentView !== 'detail' || currentId !== id) return;

  const live = rec.active && rec.meetingId === id;
  let actions = '';
  if (!live) {
    if (m.status === 'recording' || m.status === 'interrupted') actions += '<button class="primary" data-act="finish">녹음 종료하고 처리</button>';
    if (m.status === 'recorded') actions += '<button class="primary" data-act="process-resume">처리 시작</button>';
    if (m.status === 'failed') actions += '<button class="primary" data-act="process-resume">이어서 다시 처리</button>';
    if (m.status === 'done') actions += '<button data-act="process-summary">요약만 다시 생성</button><button data-act="process-fresh">처음부터 다시 전사</button><a href="/api/meetings/' + esc(id) + '/export"><button type="button">내보내기(.md)</button></a>';
    if (m.status !== 'processing') actions += '<button class="danger" data-act="delete">삭제</button>';
  }

  let status = `<span class="st ${esc(m.status)}">${esc(STATUS[m.status] || m.status)}</span>`;
  if (m.status === 'processing') status += ' ' + esc(progressText(m.progress));

  $('#detailBox').innerHTML = `
    <div class="row between"><h2>${esc(m.title)}</h2><button data-act="back">← 목록</button></div>
    <div class="meta">${esc(fmtDate(m.createdAt))} · ${esc(fmtDur(m.durationSec))} · ${status}${m.providers ? ` · 전사 ${esc(PROVIDER[m.providers.stt])}, 요약 ${esc(PROVIDER[m.providers.summary])}` : ''}${m.attendees ? `<br>참석자: ${esc(m.attendees)}` : ''}${m.memo ? `<br>메모: ${esc(m.memo)}` : ''}</div>
    ${m.error ? `<p class="msg err">${esc(m.error)}</p>` : ''}
    ${m.status === 'interrupted' ? '<p class="msg">녹음이 중간에 끊겼습니다. 저장된 구간까지 처리할 수 있습니다.</p>' : ''}
    ${live ? '<p class="msg">이 회의는 지금 녹음 중입니다. [녹음] 화면에서 종료하세요.</p>' : ''}
    <div class="row">${actions}</div>
    <div class="tabs"><button data-tab="summary">요약</button><button data-tab="transcript">전사문</button><button data-tab="audio">녹음 (${m.segments.length}구간)</button></div>
    <div id="pane"></div>`;
  for (const b of $('#detailBox').querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === detailTab);
  await renderPane(m);

  if (m.status === 'processing') detailTimer = setTimeout(renderDetail, 2000);
}

async function renderPane(m) {
  const pane = $('#pane');
  const id = m.id;
  if (detailTab === 'summary') {
    if (!m.hasSummary) {
      pane.innerHTML = '<p class="hint">아직 요약이 없습니다.</p>';
      return;
    }
    const text = await api(`/meetings/${id}/summary`);
    pane.innerHTML = `<p class="hint warn">AI가 만든 초안입니다. 전사문과 대조해 확인한 뒤 필요하면 수정하세요.</p><div class="md" id="mdView">${renderMd(text)}</div><div class="row"><button data-act="edit-summary">요약 편집</button></div>`;
    pane.dataset.text = text;
  } else if (detailTab === 'transcript') {
    if (!m.hasTranscript) {
      pane.innerHTML = '<p class="hint">아직 전사문이 없습니다.</p>';
      return;
    }
    const t = await api(`/meetings/${id}/transcript`);
    pane.innerHTML = (t.segments || []).map((s) => `<div class="line"><span class="ts">${fmtMs(s.start)}</span>${esc(s.text)}</div>`).join('') || '<p class="hint">전사된 내용이 없습니다.</p>';
  } else {
    pane.innerHTML = m.segments.length
      ? m.segments.map((s) => `<div class="seg"><div class="hint">구간 ${s.index + 1} · ${(s.bytes / 1048576).toFixed(1)}MB</div><audio controls preload="none" src="/api/meetings/${esc(id)}/segments/${s.index}/audio"></audio></div>`).join('') +
        '<p class="hint">녹음은 구간별 파일로 저장됩니다. 브라우저 특성상 재생 막대에 전체 길이가 표시되지 않을 수 있습니다.</p>'
      : '<p class="hint">저장된 녹음이 없습니다.</p>';
  }
}

$('#detailBox').addEventListener('click', async (e) => {
  const tab = e.target.closest('button[data-tab]');
  if (tab) {
    detailTab = tab.dataset.tab;
    renderDetail();
    return;
  }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = currentId;
  if (act === 'back') showView('list');
  else if (act === 'finish') finishAndProcess(id, 'finish');
  else if (act === 'process-resume') finishAndProcess(id, 'reprocess', 'resume');
  else if (act === 'process-fresh') finishAndProcess(id, 'reprocess', 'fresh');
  else if (act === 'process-summary') finishAndProcess(id, 'reprocess', 'summary');
  else if (act === 'delete') {
    if (!confirm('이 회의의 녹음, 전사문, 요약을 모두 삭제합니다. 되돌릴 수 없습니다. 삭제할까요?')) return;
    try {
      await api('/meetings/' + id, { method: 'DELETE' });
      toast('삭제했습니다.');
      showView('list');
    } catch (err) {
      toast(err.message, true);
    }
  } else if (act === 'edit-summary') {
    const pane = $('#pane');
    pane.innerHTML = `<textarea class="big" id="sumEdit">${esc(pane.dataset.text || '')}</textarea><div class="row"><button class="primary" data-act="save-summary">저장</button><button data-act="cancel-edit">취소</button></div>`;
  } else if (act === 'save-summary') {
    try {
      await api(`/meetings/${id}/summary`, { method: 'PUT', json: { text: $('#sumEdit').value } });
      toast('저장했습니다.');
      renderDetail();
    } catch (err) {
      toast(err.message, true);
    }
  } else if (act === 'cancel-edit') renderDetail();
});

// ---------------------------------------------------------------- 설정
const F = {
  sttProvider: '#setStt',
  summaryProvider: '#setSummary',
  groqSttModel: '#setGroqStt',
  groqSummaryModel: '#setGroqSummary',
  ollamaUrl: '#setOllamaUrl',
  ollamaModel: '#setOllamaModel',
  ffmpegPath: '#setFfmpeg',
  whisperCliPath: '#setWhisperCli',
  whisperModelPath: '#setWhisperModel',
  segmentMinutes: '#setSegMin',
};

function updateGroqWarn() {
  $('#groqWarn').hidden = $('#setStt').value !== 'groq' && $('#setSummary').value !== 'groq';
}
$('#setStt').addEventListener('change', updateGroqWarn);
$('#setSummary').addEventListener('change', updateGroqWarn);

async function loadSettings() {
  try {
    const [s, st] = await Promise.all([api('/settings'), api('/status')]);
    for (const [k, sel] of Object.entries(F)) $(sel).value = s[k];
    updateGroqWarn();
    $('#groqKeyState').textContent = st.groqKeySet ? 'Groq API 키: .env에서 읽음(화면에는 표시하지 않음)' : 'Groq API 키: 없음. 프로젝트 폴더의 .env 파일에 GROQ_API_KEY를 넣고 프로그램을 다시 시작하세요.';
    $('#dataDirInfo').textContent = `데이터 저장 위치: ${st.dataDir}`;
  } catch (e) {
    toast(e.message, true);
  }
}

$('#btnSaveSettings').addEventListener('click', async () => {
  const patch = {};
  for (const [k, sel] of Object.entries(F)) patch[k] = k === 'segmentMinutes' ? Number($(sel).value) : $(sel).value;
  try {
    await api('/settings', { method: 'PUT', json: patch });
    toast('설정을 저장했습니다.');
    refreshBadge();
  } catch (e) {
    toast(e.message, true);
  }
});

// ---------------------------------------------------------------- 시작
loadMics();
refreshRecordInfo();
