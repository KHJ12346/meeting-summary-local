import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- 가짜 Groq / Ollama 서버 ---
const calls = { stt: 0, chat: 0, ollama: 0, auth: [] };
let mock;
let mockPort;

function startMock() {
  mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (req.url === '/v1/audio/transcriptions') {
      calls.stt++;
      calls.auth.push(req.headers.authorization);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ text: '안녕하세요 회의를 시작합니다', duration: 5, segments: [{ start: 0, end: 5, text: ' 안녕하세요 회의를 시작합니다' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      calls.chat++;
      const j = JSON.parse(body.toString());
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ choices: [{ message: { content: `## 핵심 요약\n- 모델 ${j.model}` } }] }));
    }
    if (req.url === '/api/chat') {
      calls.ollama++;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ message: { content: '## 핵심 요약\n- 로컬 요약' } }));
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((r) => mock.listen(0, '127.0.0.1', () => {
    mockPort = mock.address().port;
    r();
  }));
}

let app;
let base;
let dataDir;
let server;

const req = (method, p, { json, body, headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const payload = json !== undefined ? JSON.stringify(json) : body;
    const h = { ...headers };
    if (json !== undefined) h['Content-Type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = text;
        try {
          data = JSON.parse(text);
        } catch {
          // 텍스트 응답
        }
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });

async function waitDone(id) {
  for (let i = 0; i < 100; i++) {
    const { data } = await req('GET', `/api/meetings/${id}`);
    if (data.status === 'done' || data.status === 'failed') return data;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('처리 시간 초과');
}

before(async () => {
  await startMock();
  process.env.GROQ_API_KEY = 'test-key';
  process.env.GROQ_BASE_URL = `http://127.0.0.1:${mockPort}/v1`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetnote-test-'));
  const { createApp } = await import('../lib/app.js');
  app = createApp({ dataDir });
  server = app.server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});

after(() => {
  server.close();
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function recordMeeting(title = '테스트 회의') {
  const { data: m } = await req('POST', '/api/meetings', { json: { title, attendees: '김OO' } });
  const buf = Buffer.from('fake-webm-audio');
  await req('POST', `/api/meetings/${m.id}/segments/0/chunk?ext=webm`, { body: buf });
  await req('POST', `/api/meetings/${m.id}/segments/0/chunk?ext=webm`, { body: buf });
  await req('POST', `/api/meetings/${m.id}/segments/1/chunk?ext=webm`, { body: buf });
  return m;
}

test('보안: 허용되지 않은 Host(DNS 리바인딩)는 차단한다', async () => {
  const r = await req('GET', '/api/status', { headers: { Host: 'evil.example.com' } });
  assert.equal(r.status, 403);
});

test('보안: 다른 출처의 쓰기 요청은 차단한다', async () => {
  const r = await req('POST', '/api/meetings', { json: {}, headers: { Origin: 'http://evil.example.com' } });
  assert.equal(r.status, 403);
});

test('보안: 경로 조작은 차단한다', async () => {
  assert.equal((await req('GET', '/api/meetings/..%2F..%2Fpackage.json')).status, 404);
  assert.equal((await req('GET', '/..%2Fserver.js')).status, 404);
  assert.equal((await req('GET', '/%2e%2e/server.js')).status, 404);
});

test('보안: 응답에 CSP 헤더가 있고 외부 리소스를 쓰지 않는다', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /https?:\/\//);
});

test('설정: 기본 공급자는 로컬이고, 외부 Ollama 주소는 거부한다', async () => {
  const { data } = await req('GET', '/api/settings');
  assert.equal(data.sttProvider, 'local');
  assert.equal(data.summaryProvider, 'local');
  const bad = await req('PUT', '/api/settings', { json: { ollamaUrl: 'http://evil.example.com:11434' } });
  assert.equal(bad.status, 400);
  const bad2 = await req('PUT', '/api/settings', { json: { sttProvider: 'other' } });
  assert.equal(bad2.status, 400);
});

test('Groq: 동의 없이는 처리를 시작하지 않고, 동의하면 전사·요약을 보관한다', async () => {
  await req('PUT', '/api/settings', { json: { sttProvider: 'groq', summaryProvider: 'groq' } });
  const m = await recordMeeting();

  const noConsent = await req('POST', `/api/meetings/${m.id}/finish`, { json: {} });
  assert.equal(noConsent.status, 409);
  assert.equal(noConsent.data.error, 'consent_required');
  assert.equal(calls.stt, 0, '동의 전에는 외부 호출이 없어야 한다');

  const ok = await req('POST', `/api/meetings/${m.id}/finish`, { json: { consent: true } });
  assert.equal(ok.status, 202);
  const done = await waitDone(m.id);
  assert.equal(done.status, 'done', done.error);
  assert.ok(done.consent && done.consent.providers.length === 2);
  assert.equal(calls.stt, 2, '구간 2개를 각각 전사');
  assert.equal(calls.auth[0], 'Bearer test-key');

  const dir = path.join(dataDir, 'meetings', m.id);
  assert.ok(fs.existsSync(path.join(dir, 'seg-000.webm')));
  assert.ok(fs.existsSync(path.join(dir, 'seg-001.webm')));
  assert.ok(fs.existsSync(path.join(dir, 'transcript.json')));
  assert.ok(fs.existsSync(path.join(dir, 'summary.md')));
  assert.ok(!fs.existsSync(path.join(dir, 'work')), '중간 산출물은 정리된다');

  const t = (await req('GET', `/api/meetings/${m.id}/transcript`)).data;
  assert.equal(t.segments.length, 2);
  assert.equal(t.segments[1].start, 5, '두 번째 구간은 첫 구간 길이만큼 시간이 밀린다');
  assert.equal(t.durationSec, 10);

  const s = (await req('GET', `/api/meetings/${m.id}/summary`)).data;
  assert.match(s, /핵심 요약/);

  const exp = await req('GET', `/api/meetings/${m.id}/export`);
  assert.match(exp.data, /부록: 전체 녹취록/);
  assert.match(exp.data, /\[00:05\]/);
});

test('요약 편집과 검색, 요약만 다시 생성', async () => {
  const { data: list } = await req('GET', '/api/meetings');
  const m = list[0];
  const put = await req('PUT', `/api/meetings/${m.id}/summary`, { json: { text: '## 핵심 요약\n- 수정한 내용 고유키워드' } });
  assert.equal(put.status, 200);
  const found = (await req('GET', '/api/meetings?q=' + encodeURIComponent('고유키워드'))).data;
  assert.equal(found.length, 1);
  const none = (await req('GET', '/api/meetings?q=' + encodeURIComponent('없는단어xyz'))).data;
  assert.equal(none.length, 0);

  const before = calls.stt;
  const r = await req('POST', `/api/meetings/${m.id}/reprocess`, { json: { mode: 'summary', consent: true } });
  assert.equal(r.status, 202);
  const done = await waitDone(m.id);
  assert.equal(done.status, 'done');
  assert.equal(calls.stt, before, '요약만 다시 만들 때는 전사를 호출하지 않는다');
});

test('로컬 모드: 외부(Groq) 호출 없이 Ollama로 요약하고 동의를 요구하지 않는다', async () => {
  // 전사는 whisper 설정이 없어 실패해야 하지만(로컬 STT 미설치), 동의 없이도 처리가 시작되어야 한다.
  await req('PUT', '/api/settings', { json: { sttProvider: 'local', summaryProvider: 'local', ollamaUrl: `http://127.0.0.1:${mockPort}` } });
  const m = await recordMeeting('로컬 회의');
  const groqBefore = calls.stt + calls.chat;
  const r = await req('POST', `/api/meetings/${m.id}/finish`, { json: {} });
  assert.equal(r.status, 202);
  const done = await waitDone(m.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /whisper/);
  assert.equal(calls.stt + calls.chat, groqBefore, '로컬 모드에서는 Groq를 호출하지 않는다');
  // 실패해도 녹음 원본은 보존된다
  assert.ok(fs.existsSync(path.join(dataDir, 'meetings', m.id, 'seg-000.webm')));

  // 요약만(전사문이 없으므로) 거부되는지
  const s = await req('POST', `/api/meetings/${m.id}/reprocess`, { json: { mode: 'summary' } });
  assert.equal(s.status, 202);
  const f = await waitDone(m.id);
  assert.equal(f.status, 'failed');
  assert.match(f.error, /전사문이 없어/);
});

test('로컬 요약: 전사문이 있으면 Ollama로만 요약하고 Groq 호출·동의 없이 완료된다', async () => {
  await req('PUT', '/api/settings', { json: { sttProvider: 'groq', summaryProvider: 'groq' } });
  const m = await recordMeeting('로컬 요약 회의');
  await req('POST', `/api/meetings/${m.id}/finish`, { json: { consent: true } });
  assert.equal((await waitDone(m.id)).status, 'done');

  await req('PUT', '/api/settings', { json: { summaryProvider: 'local', ollamaUrl: `http://127.0.0.1:${mockPort}` } });
  const groqBefore = calls.stt + calls.chat;
  const ollamaBefore = calls.ollama;
  const r = await req('POST', `/api/meetings/${m.id}/reprocess`, { json: { mode: 'summary' } });
  assert.equal(r.status, 202, '요약이 로컬이면 동의가 필요 없다');
  assert.equal((await waitDone(m.id)).status, 'done');
  assert.equal(calls.ollama, ollamaBefore + 1);
  assert.equal(calls.stt + calls.chat, groqBefore);
  assert.match((await req('GET', `/api/meetings/${m.id}/summary`)).data, /로컬 요약/);
});

test('중간 저장: 구간 파일이 이어 붙고, 서버 재시작 시 녹음 중이던 회의는 중단됨으로 복구된다', async () => {
  const m = await recordMeeting('중단 회의');
  const seg = path.join(dataDir, 'meetings', m.id, 'seg-000.webm');
  assert.equal(fs.statSync(seg).size, Buffer.byteLength('fake-webm-audio') * 2);

  const { createApp } = await import('../lib/app.js');
  const second = createApp({ dataDir });
  const meta = second.store.get(m.id);
  assert.equal(meta.status, 'interrupted');
});

test('빈 녹음은 저장하지 않고 폐기한다', async () => {
  const { data: m } = await req('POST', '/api/meetings', { json: { title: '빈 회의' } });
  const r = await req('POST', `/api/meetings/${m.id}/finish`, { json: {} });
  assert.equal(r.data.discarded, true);
  assert.equal((await req('GET', `/api/meetings/${m.id}`)).status, 404);
});

test('삭제: 회의 폴더가 통째로 사라진다', async () => {
  const m = await recordMeeting('삭제 회의');
  await req('POST', `/api/meetings/${m.id}/finish`, { json: { process: false } });
  const del = await req('DELETE', `/api/meetings/${m.id}`);
  assert.equal(del.status, 200);
  assert.ok(!fs.existsSync(path.join(dataDir, 'meetings', m.id)));
});

test('녹음 파일 재생: Range 요청을 지원한다', async () => {
  const m = await recordMeeting('재생 회의');
  const r = await req('GET', `/api/meetings/${m.id}/segments/0/audio`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(r.status, 206);
  assert.equal(r.data, 'fake');
});

test('감사 로그에 내용 없이 이벤트만 남는다', () => {
  const log = fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8');
  assert.match(log, /"event":"create"/);
  assert.match(log, /"event":"delete"/);
  assert.doesNotMatch(log, /안녕하세요 회의를 시작합니다/);
});
