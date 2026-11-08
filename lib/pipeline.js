import { getStt, getChat } from './providers/index.js';
import { summarize } from './summarize.js';
import { UserError } from './errors.js';

const pad = (n) => String(n).padStart(3, '0');

// 전사 → 요약을 한 번에 하나씩(대기열) 처리한다. 실패해도 녹음 원본은 그대로 둔다.
export class Pipeline {
  constructor({ store, settingsStore }) {
    this.store = store;
    this.settingsStore = settingsStore;
    this.chain = Promise.resolve();
    this.active = new Set();
  }

  isBusy(id) {
    return this.active.has(id);
  }

  // mode: 'resume'(이어서) | 'fresh'(처음부터 전사) | 'summary'(요약만)
  enqueue(id, { mode = 'resume', consent = null } = {}) {
    this.active.add(id);
    this.store.update(id, (m) => {
      m.status = 'processing';
      m.error = null;
      m.progress = { stage: 'queued' };
      if (consent) m.consent = consent;
      this.store.addHistory(m, 'process_start', { mode });
    });
    this.chain = this.chain.then(() => this.run(id, mode)).catch(() => {});
    return this.done(id);
  }

  done(id) {
    return this.chain.then(() => this.store.get(id));
  }

  progress(id, stage, done = 0, total = 0) {
    this.store.update(id, (m) => {
      m.progress = { stage, done, total };
    });
  }

  async run(id, mode) {
    try {
      const settings = this.settingsStore.get();
      this.store.update(id, (m) => {
        m.providers = {
          stt: mode === 'summary' ? (m.providers?.stt ?? settings.sttProvider) : settings.sttProvider,
          summary: settings.summaryProvider,
        };
      });
      if (mode === 'fresh') this.store.removeWork(id);

      let transcript;
      if (mode === 'summary') {
        transcript = this.store.readJson(id, 'transcript.json');
        if (!transcript) throw new UserError('저장된 전사문이 없어 요약만 다시 만들 수 없습니다.');
      } else {
        transcript = await this.transcribeAll(id, settings);
        this.store.writeJson(id, 'transcript.json', transcript);
      }

      this.progress(id, 'summarizing', 0, 1);
      const meta = this.store.get(id);
      const chat = getChat(settings.summaryProvider);
      const summary = await summarize({
        text: transcript.text,
        meta,
        chat: ({ system, user }) => chat({ system, user, settings }),
        onProgress: (d, t) => this.progress(id, 'summarizing', d, t),
      });
      this.store.writeText(id, 'summary.md', summary);
      this.store.removeWork(id); // 중간 산출물 정리

      this.store.update(id, (m) => {
        m.status = 'done';
        m.progress = null;
        m.error = null;
        m.finishedAt = new Date().toISOString();
        m.durationSec = Math.round(transcript.durationSec || 0);
        this.store.addHistory(m, 'process_done', { stt: m.providers?.stt, summary: m.providers?.summary });
      });
      this.store.audit('process_done', id, { providers: this.store.get(id).providers });
    } catch (e) {
      const message = e instanceof UserError ? e.message : `처리 중 오류가 발생했습니다: ${e.message}`;
      this.store.update(id, (m) => {
        m.status = 'failed';
        m.progress = null;
        m.error = message;
        this.store.addHistory(m, 'process_failed', { error: message });
      });
      this.store.audit('process_failed', id, { error: message });
    } finally {
      this.active.delete(id);
    }
  }

  async transcribeAll(id, settings) {
    const files = this.store.segmentFiles(id).filter((f) => f.bytes > 0);
    if (!files.length) throw new UserError('저장된 녹음이 없습니다.');
    const stt = getStt(settings.sttProvider);

    const parts = [];
    let offset = 0;
    for (let i = 0; i < files.length; i++) {
      this.progress(id, 'transcribing', i, files.length);
      const cacheName = `work/seg-${pad(files[i].index)}.json`;
      let r = this.store.readJson(id, cacheName);
      if (!r) {
        r = await stt({ filePath: files[i].file, language: settings.language, settings });
        this.store.writeJson(id, cacheName, r); // 한도 초과 등으로 실패해도 이어서 처리할 수 있게 저장
      }
      parts.push({ offset, r });
      offset += r.duration || 0;
    }

    const segments = parts.flatMap(({ offset: o, r }) =>
      r.segments.map((s) => ({ start: round(s.start + o), end: round(s.end + o), text: s.text })).filter((s) => s.text),
    );
    return {
      language: settings.language,
      provider: settings.sttProvider,
      model: parts[0]?.r.model || '',
      durationSec: round(offset),
      segments,
      text: segments.map((s) => s.text).join('\n'),
    };
  }
}

const round = (n) => Math.round(n * 100) / 100;
