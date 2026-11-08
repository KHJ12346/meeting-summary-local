import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.js';

export const PROVIDERS = ['local', 'groq'];

// EXT-02: 기본 공급자는 로컬. Groq는 설정에서 켠 경우에만 쓴다.
export const DEFAULT_SETTINGS = {
  sttProvider: 'local',
  summaryProvider: 'local',
  language: 'ko',
  groqSttModel: 'whisper-large-v3-turbo',
  groqSummaryModel: 'llama-3.3-70b-versatile',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5:7b',
  ffmpegPath: 'ffmpeg',
  whisperCliPath: '',
  whisperModelPath: '',
  segmentMinutes: 10,
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function str(v, name, max = 500) {
  if (typeof v !== 'string') throw new HttpError(400, 'bad_setting', `${name} 값이 올바르지 않습니다.`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, 'bad_setting', `${name} 값이 너무 깁니다.`);
  return t;
}

// 알려진 키만 받아 검증한다.
export function sanitize(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    switch (k) {
      case 'sttProvider':
      case 'summaryProvider':
        if (!PROVIDERS.includes(v)) throw new HttpError(400, 'bad_setting', `${k}는 local 또는 groq만 가능합니다.`);
        out[k] = v;
        break;
      case 'segmentMinutes': {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 30) {
          throw new HttpError(400, 'bad_setting', '녹음 구간 길이는 1~30분 사이의 정수여야 합니다.');
        }
        out[k] = n;
        break;
      }
      case 'ollamaUrl': {
        const s = str(v, k);
        let u;
        try {
          u = new URL(s);
        } catch {
          throw new HttpError(400, 'bad_setting', 'Ollama 주소 형식이 올바르지 않습니다.');
        }
        if (!['http:', 'https:'].includes(u.protocol) || !LOOPBACK.has(u.hostname)) {
          throw new HttpError(400, 'bad_setting', 'Ollama는 이 노트북(127.0.0.1)의 주소만 허용됩니다.');
        }
        out[k] = s.replace(/\/+$/, '');
        break;
      }
      default:
        out[k] = str(v, k);
    }
  }
  return out;
}

export class SettingsStore {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
  }

  get() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...DEFAULT_SETTINGS, ...sanitize(raw) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  set(patch) {
    const next = { ...this.get(), ...sanitize(patch) };
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    return next;
  }
}

// 외부(Groq)로 데이터가 나가는 공급자 목록.
export function externalProviders(settings, mode) {
  const used = [];
  if (mode !== 'summary' && settings.sttProvider === 'groq') used.push('전사(Groq)');
  if (settings.summaryProvider === 'groq') used.push('요약(Groq)');
  return used;
}
