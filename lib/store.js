import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './errors.js';

const ID_RE = /^\d{8}-\d{6}-[a-z0-9]{4}$/;
const SEG_RE = /^seg-(\d{3})\.(webm|ogg|mp4)$/;
export const EXTS = ['webm', 'ogg', 'mp4'];
export const AUDIO_TYPES = { webm: 'audio/webm', ogg: 'audio/ogg', mp4: 'audio/mp4' };

const pad = (n) => String(n).padStart(2, '0');

function newId() {
  const d = new Date();
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-` +
    crypto.randomBytes(2).toString('hex')
  );
}

function clip(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// 회의 1건 = 폴더 1개: 녹음 구간 파일, transcript.json, summary.md, meta.json
export class Store {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.root = path.join(this.dir, 'meetings');
    fs.mkdirSync(this.root, { recursive: true });
  }

  dirOf(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(404, 'not_found', '회의를 찾을 수 없습니다.');
    return path.join(this.root, id);
  }

  audit(event, id, extra = {}) {
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), event, id, ...extra });
      fs.appendFileSync(path.join(this.dir, 'audit.log'), line + '\n', 'utf8');
    } catch {
      // 감사 로그 실패가 본 기능을 막지 않게 한다.
    }
  }

  create({ title, attendees, memo } = {}) {
    const id = newId();
    const now = new Date();
    fs.mkdirSync(this.dirOf(id), { recursive: true });
    const defaultTitle = `회의 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const meta = {
      id,
      title: clip(title, 200) || defaultTitle,
      attendees: clip(attendees, 500),
      memo: clip(memo, 5000),
      createdAt: now.toISOString(),
      status: 'recording',
      progress: null,
      error: null,
      providers: null,
      consent: null,
      durationSec: null,
      finishedAt: null,
      history: [{ at: now.toISOString(), event: 'created' }],
    };
    this.save(id, meta);
    this.audit('create', id);
    return meta;
  }

  save(id, meta) {
    const file = path.join(this.dirOf(id), 'meta.json');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  get(id) {
    const file = path.join(this.dirOf(id), 'meta.json');
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new HttpError(404, 'not_found', '회의를 찾을 수 없습니다.');
    }
  }

  update(id, fn) {
    const meta = this.get(id);
    fn(meta);
    this.save(id, meta);
    return meta;
  }

  addHistory(meta, event, extra = {}) {
    meta.history = [...(meta.history || []), { at: new Date().toISOString(), event, ...extra }].slice(-100);
  }

  ids() {
    return fs.readdirSync(this.root).filter((n) => ID_RE.test(n)).sort().reverse();
  }

  list(q = '') {
    const needle = q.trim().toLowerCase();
    const out = [];
    for (const id of this.ids()) {
      let meta;
      try {
        meta = this.get(id);
      } catch {
        continue;
      }
      if (needle) {
        const hay = [meta.title, meta.attendees, meta.memo, this.readText(id, 'summary.md'), this.transcriptText(id)]
          .join('\n')
          .toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      out.push(meta);
    }
    return out;
  }

  transcriptText(id) {
    const t = this.readJson(id, 'transcript.json');
    return t?.text || '';
  }

  // ---- 녹음 구간 파일 ----
  segmentFiles(id) {
    const dir = this.dirOf(id);
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      const m = SEG_RE.exec(name);
      if (!m) continue;
      const file = path.join(dir, name);
      out.push({ index: Number(m[1]), ext: m[2], file, bytes: fs.statSync(file).size });
    }
    return out.sort((a, b) => a.index - b.index);
  }

  segmentName(index, ext) {
    if (!Number.isInteger(index) || index < 0 || index > 999) throw new HttpError(400, 'bad_segment', '구간 번호가 올바르지 않습니다.');
    if (!EXTS.includes(ext)) throw new HttpError(400, 'bad_ext', '지원하지 않는 녹음 형식입니다.');
    return `seg-${String(index).padStart(3, '0')}.${ext}`;
  }

  appendChunk(id, index, ext, buf) {
    const meta = this.get(id);
    if (meta.status !== 'recording') throw new HttpError(409, 'not_recording', '녹음 중인 회의가 아닙니다.');
    const file = path.join(this.dirOf(id), this.segmentName(index, ext));
    fs.appendFileSync(file, buf);
  }

  // ---- 결과 파일 ----
  readText(id, name) {
    try {
      return fs.readFileSync(path.join(this.dirOf(id), name), 'utf8');
    } catch {
      return '';
    }
  }

  writeText(id, name, text) {
    const file = path.join(this.dirOf(id), name);
    const tmp = file + '.tmp';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  }

  readJson(id, name) {
    try {
      return JSON.parse(this.readText(id, name));
    } catch {
      return null;
    }
  }

  writeJson(id, name, value) {
    this.writeText(id, name, JSON.stringify(value, null, 2));
  }

  removeWork(id) {
    fs.rmSync(path.join(this.dirOf(id), 'work'), { recursive: true, force: true });
  }

  delete(id) {
    this.get(id);
    fs.rmSync(this.dirOf(id), { recursive: true, force: true });
    this.audit('delete', id);
  }

  // 서버가 재시작되면 녹음 중이던 회의는 '중단됨'으로 바꾸고, 남은 구간으로 처리할 수 있게 한다.
  recoverInterrupted() {
    for (const id of this.ids()) {
      try {
        const meta = this.get(id);
        if (meta.status === 'recording' || meta.status === 'processing') {
          const wasProcessing = meta.status === 'processing';
          meta.status = wasProcessing ? 'failed' : 'interrupted';
          meta.error = wasProcessing ? '처리 중 프로그램이 종료되었습니다. 다시 처리해 주세요.' : null;
          meta.progress = null;
          this.addHistory(meta, wasProcessing ? 'processing_interrupted' : 'recording_interrupted');
          this.save(id, meta);
        }
      } catch {
        // 손상된 폴더는 건너뛴다.
      }
    }
  }
}
