import fs from 'node:fs';
import path from 'node:path';
import { UserError } from '../errors.js';

// Groq 무료 플랜의 오디오 파일 크기 상한(대략 25MB). 정확한 한도는 Groq 콘솔에서 확인한다.
export const GROQ_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const baseUrl = () => (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');

function apiKey() {
  const k = process.env.GROQ_API_KEY;
  if (!k) throw new UserError('GROQ_API_KEY가 설정되지 않았습니다. 프로젝트 폴더의 .env 파일에 키를 넣어 주세요.');
  return k;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 429(한도 초과)와 5xx는 짧게 재시도한다. 키는 오류 메시지에 포함하지 않는다.
async function request(url, makeInit, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...makeInit(), signal: AbortSignal.timeout(10 * 60 * 1000) });
    } catch (e) {
      lastErr = new UserError(`Groq에 연결하지 못했습니다(네트워크 확인): ${e.cause?.code || e.message}`);
      if (attempt < retries) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw lastErr;
    }
    if (res.ok) return res.json();

    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message || '';
    } catch {
      // 본문이 JSON이 아닐 수 있다.
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const wait = Math.min(Number(res.headers.get('retry-after')) || 5 * (attempt + 1), 60);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 401) throw new UserError('Groq API 키가 올바르지 않습니다(401).');
    if (res.status === 429) {
      throw new UserError(`Groq 무료 사용 한도를 초과했습니다(429). 잠시 뒤 [이어서 다시 처리]를 눌러 주세요. ${detail}`.trim());
    }
    throw new UserError(`Groq 오류(${res.status}): ${detail || '응답을 처리하지 못했습니다.'}`);
  }
  throw lastErr;
}

export async function transcribe({ filePath, language, settings }) {
  const key = apiKey();
  const bytes = fs.statSync(filePath).size;
  if (bytes > GROQ_MAX_AUDIO_BYTES) {
    throw new UserError(
      `녹음 구간 파일이 Groq 업로드 한도(${Math.round(GROQ_MAX_AUDIO_BYTES / 1048576)}MB)를 넘습니다. 설정에서 녹음 구간 길이를 줄여 주세요.`,
    );
  }
  const data = await fs.promises.readFile(filePath);
  const name = path.basename(filePath);
  const type = name.endsWith('.mp4') ? 'audio/mp4' : name.endsWith('.ogg') ? 'audio/ogg' : 'audio/webm';
  const json = await request(`${baseUrl()}/audio/transcriptions`, () => {
    const form = new FormData();
    form.append('file', new Blob([data], { type }), name);
    form.append('model', settings.groqSttModel);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (language) form.append('language', language);
    return { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form };
  });
  const segments = (json.segments || []).map((s) => ({ start: s.start, end: s.end, text: String(s.text || '').trim() }));
  const duration = Number(json.duration) || segments.at(-1)?.end || 0;
  const text = String(json.text || '').trim();
  if (!segments.length && text) segments.push({ start: 0, end: duration, text });
  return { text, duration, segments, model: settings.groqSttModel };
}

export async function chat({ system, user, settings }) {
  const key = apiKey();
  const json = await request(`${baseUrl()}/chat/completions`, () => ({
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.groqSummaryModel,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  }));
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new UserError('Groq가 빈 응답을 돌려보냈습니다.');
  return content.trim();
}
