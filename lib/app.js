import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { HttpError } from './errors.js';
import { Store, AUDIO_TYPES, EXTS } from './store.js';
import { SettingsStore, externalProviders } from './settings.js';
import { Pipeline } from './pipeline.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_JSON = 1024 * 1024;
const MAX_CHUNK = 32 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0];
}

// SEC-02: 127.0.0.1 바인딩에 더해, DNS 리바인딩과 다른 사이트에서의 요청을 막는다.
function guardRequest(req) {
  if (!LOOPBACK_HOSTS.has(hostnameOf(req.headers.host))) {
    throw new HttpError(403, 'forbidden_host', '허용되지 않은 접속 주소입니다.');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin) {
      let u;
      try {
        u = new URL(origin);
      } catch {
        throw new HttpError(403, 'forbidden_origin', '허용되지 않은 요청 출처입니다.');
      }
      if (u.host !== req.headers.host) throw new HttpError(403, 'forbidden_origin', '허용되지 않은 요청 출처입니다.');
    }
  }
}

async function readBody(req, limit) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new HttpError(413, 'too_large', '요청이 너무 큽니다.');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json', '요청 형식이 올바르지 않습니다.');
  }
}

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendFile(req, res, file, type) {
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    let start;
    let end;
    if (m[1] === '') {
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (start >= size || end < start) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...base, 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', '허용되지 않는 요청입니다.');
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'bad_path', '주소가 올바르지 않습니다.');
  }
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new HttpError(404, 'not_found', '찾을 수 없습니다.');
  }
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  const data = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function exportMarkdown(store, id) {
  const meta = store.get(id);
  const summary = store.readText(id, 'summary.md').trim();
  const t = store.readJson(id, 'transcript.json');
  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const lines = (t?.segments || []).map((s) => `[${mmss(s.start)}] ${s.text}`);
  return [
    `# ${meta.title}`,
    '',
    `- 일시: ${new Date(meta.createdAt).toLocaleString('ko-KR')}`,
    meta.attendees ? `- 참석자: ${meta.attendees}` : null,
    meta.memo ? `- 메모: ${meta.memo}` : null,
    '- 주의: 요약은 AI가 만든 초안입니다. 원문 녹취록과 대조해 확인하세요.',
    '',
    summary || '(요약 없음)',
    '',
    '## 부록: 전체 녹취록',
    '',
    lines.join('\n') || '(전사문 없음)',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

export function createApp({ dataDir }) {
  const store = new Store(dataDir);
  const settingsStore = new SettingsStore(store.dir);
  const pipeline = new Pipeline({ store, settingsStore });
  store.recoverInterrupted();

  const withSegments = (meta) => ({
    ...meta,
    segments: store.segmentFiles(meta.id).map(({ index, ext, bytes }) => ({ index, ext, bytes })),
    hasTranscript: !!store.readJson(meta.id, 'transcript.json'),
    hasSummary: !!store.readText(meta.id, 'summary.md'),
  });

  // 외부(Groq) 전송이 필요하면 사용자 동의가 있어야 한다(EXT-03). 서버에서 강제한다.
  function requireConsent(settings, mode, body) {
    const ext = externalProviders(settings, mode);
    if (!ext.length) return null;
    if (body.consent !== true) {
      throw new HttpError(409, 'consent_required', `회의 내용이 외부(Groq)로 전송됩니다: ${ext.join(', ')}. 동의가 필요합니다.`);
    }
    return { at: new Date().toISOString(), providers: ext };
  }

  const routes = [
    ['GET', /^\/api\/status$/, async (req, res) => {
      let freeBytes = null;
      try {
        const s = fs.statfsSync(store.dir);
        freeBytes = s.bavail * s.bsize;
      } catch {
        // 지원하지 않는 환경
      }
      send(res, 200, { groqKeySet: !!process.env.GROQ_API_KEY, freeBytes, dataDir: store.dir, version: '0.1.0' });
    }],
    ['GET', /^\/api\/settings$/, async (req, res) => send(res, 200, settingsStore.get())],
    ['PUT', /^\/api\/settings$/, async (req, res) => {
      const next = settingsStore.set(await readJson(req));
      store.audit('settings_changed', null, { stt: next.sttProvider, summary: next.summaryProvider });
      send(res, 200, next);
    }],
    ['GET', /^\/api\/meetings$/, async (req, res, m, url) => {
      send(res, 200, store.list(url.searchParams.get('q') || '').map(withSegments));
    }],
    ['POST', /^\/api\/meetings$/, async (req, res) => send(res, 201, withSegments(store.create(await readJson(req))))],
    ['GET', /^\/api\/meetings\/([^/]+)$/, async (req, res, m) => send(res, 200, withSegments(store.get(m[1])))],
    ['PUT', /^\/api\/meetings\/([^/]+)$/, async (req, res, m) => {
      const body = await readJson(req);
      const meta = store.update(m[1], (x) => {
        if (typeof body.title === 'string' && body.title.trim()) x.title = body.title.trim().slice(0, 200);
        if (typeof body.attendees === 'string') x.attendees = body.attendees.trim().slice(0, 500);
        if (typeof body.memo === 'string') x.memo = body.memo.trim().slice(0, 5000);
      });
      send(res, 200, withSegments(meta));
    }],
    ['DELETE', /^\/api\/meetings\/([^/]+)$/, async (req, res, m) => {
      if (pipeline.isBusy(m[1])) throw new HttpError(409, 'busy', '처리 중인 회의는 삭제할 수 없습니다.');
      store.delete(m[1]);
      send(res, 200, { ok: true });
    }],
    ['POST', /^\/api\/meetings\/([^/]+)\/segments\/(\d+)\/chunk$/, async (req, res, m, url) => {
      const ext = url.searchParams.get('ext') || 'webm';
      if (!EXTS.includes(ext)) throw new HttpError(400, 'bad_ext', '지원하지 않는 녹음 형식입니다.');
      const buf = await readBody(req, MAX_CHUNK);
      try {
        store.appendChunk(m[1], Number(m[2]), ext, buf);
      } catch (e) {
        if (e.code === 'ENOSPC') throw new HttpError(507, 'disk_full', '디스크 용량이 부족합니다.');
        throw e;
      }
      send(res, 200, { ok: true, bytes: buf.length });
    }],
    ['POST', /^\/api\/meetings\/([^/]+)\/finish$/, async (req, res, m) => {
      const body = await readJson(req);
      const meta = store.get(m[1]);
      if (!['recording', 'interrupted'].includes(meta.status)) throw new HttpError(409, 'bad_state', '이미 종료된 회의입니다.');
      const segs = store.segmentFiles(m[1]).filter((s) => s.bytes > 0);
      if (!segs.length) {
        store.delete(m[1]);
        return send(res, 200, { discarded: true });
      }
      store.audit('recording_finished', m[1], { segments: segs.length, bytes: segs.reduce((a, s) => a + s.bytes, 0) });
      if (body.process === false) {
        const next = store.update(m[1], (x) => {
          x.status = 'recorded';
          store.addHistory(x, 'recorded');
        });
        return send(res, 200, withSegments(next));
      }
      const consent = requireConsent(settingsStore.get(), 'resume', body);
      store.update(m[1], (x) => {
        x.status = 'recorded';
      });
      pipeline.enqueue(m[1], { mode: 'resume', consent });
      send(res, 202, withSegments(store.get(m[1])));
    }],
    ['POST', /^\/api\/meetings\/([^/]+)\/reprocess$/, async (req, res, m) => {
      const body = await readJson(req);
      const meta = store.get(m[1]);
      if (meta.status === 'recording' || pipeline.isBusy(m[1])) throw new HttpError(409, 'busy', '지금은 처리할 수 없습니다.');
      const mode = ['resume', 'fresh', 'summary'].includes(body.mode) ? body.mode : 'resume';
      const consent = requireConsent(settingsStore.get(), mode, body);
      pipeline.enqueue(m[1], { mode, consent });
      send(res, 202, withSegments(store.get(m[1])));
    }],
    ['GET', /^\/api\/meetings\/([^/]+)\/transcript$/, async (req, res, m) => {
      store.get(m[1]);
      send(res, 200, store.readJson(m[1], 'transcript.json') || { segments: [], text: '' });
    }],
    ['GET', /^\/api\/meetings\/([^/]+)\/summary$/, async (req, res, m) => {
      store.get(m[1]);
      send(res, 200, store.readText(m[1], 'summary.md'));
    }],
    ['PUT', /^\/api\/meetings\/([^/]+)\/summary$/, async (req, res, m) => {
      store.get(m[1]);
      const body = await readJson(req);
      if (typeof body.text !== 'string' || body.text.length > 200000) throw new HttpError(400, 'bad_summary', '요약 내용이 올바르지 않습니다.');
      store.writeText(m[1], 'summary.md', body.text);
      store.update(m[1], (x) => store.addHistory(x, 'summary_edited'));
      send(res, 200, { ok: true });
    }],
    ['GET', /^\/api\/meetings\/([^/]+)\/segments\/(\d+)\/audio$/, async (req, res, m) => {
      store.get(m[1]);
      const seg = store.segmentFiles(m[1]).find((s) => s.index === Number(m[2]));
      if (!seg) throw new HttpError(404, 'not_found', '녹음 파일을 찾을 수 없습니다.');
      sendFile(req, res, seg.file, AUDIO_TYPES[seg.ext]);
    }],
    ['GET', /^\/api\/meetings\/([^/]+)\/export$/, async (req, res, m) => {
      const text = exportMarkdown(store, m[1]);
      store.audit('export', m[1]);
      send(res, 200, text, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${m[1]}.md"`,
      });
    }],
  ];

  async function handle(req, res) {
    guardRequest(req);
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    for (const [method, re, fn] of routes) {
      const m = re.exec(url.pathname);
      if (m && method === req.method) return fn(req, res, m, url);
    }
    throw new HttpError(404, 'not_found', '찾을 수 없습니다.');
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      await handle(req, res);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) {
        send(res, e.status, { error: e.code, message: e.message });
      } else {
        console.error('서버 오류:', e.message);
        send(res, 500, { error: 'internal', message: '서버 내부 오류가 발생했습니다.' });
      }
    }
  });

  return { server, store, settingsStore, pipeline };
}
