import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UserError } from '../errors.js';

const run = promisify(execFile);

// 로컬 전사: ffmpeg로 16kHz wav로 바꾼 뒤 whisper.cpp(whisper-cli)로 전사한다.
// ffmpeg와 whisper.cpp는 이 프로그램에 포함되어 있지 않아 따로 설치(반입)해야 한다.
export async function transcribe({ filePath, language, settings }) {
  if (!settings.whisperCliPath || !settings.whisperModelPath) {
    throw new UserError('로컬 전사를 쓰려면 설정에서 whisper-cli 경로와 모델(.bin) 경로를 지정해야 합니다.');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meetnote-'));
  try {
    const wav = path.join(tmp, 'audio.wav');
    try {
      await run(settings.ffmpegPath || 'ffmpeg', ['-y', '-i', filePath, '-ar', '16000', '-ac', '1', wav], {
        timeout: 30 * 60 * 1000,
        windowsHide: true,
      });
    } catch (e) {
      throw new UserError(`ffmpeg 실행에 실패했습니다. 설정의 ffmpeg 경로를 확인하세요. (${e.code || e.message})`);
    }
    const outBase = path.join(tmp, 'out');
    try {
      await run(
        settings.whisperCliPath,
        ['-m', settings.whisperModelPath, '-f', wav, '-l', language || 'ko', '-oj', '-of', outBase],
        { timeout: 6 * 60 * 60 * 1000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (e) {
      throw new UserError(`whisper-cli 실행에 실패했습니다. 경로와 모델 파일을 확인하세요. (${e.code || e.message})`);
    }
    const out = JSON.parse(fs.readFileSync(outBase + '.json', 'utf8'));
    const segments = (out.transcription || [])
      .map((s) => ({ start: (s.offsets?.from ?? 0) / 1000, end: (s.offsets?.to ?? 0) / 1000, text: String(s.text || '').trim() }))
      .filter((s) => s.text);
    const duration = Math.max(0, (fs.statSync(wav).size - 44) / 32000); // 16kHz, 16bit, mono
    return { text: segments.map((s) => s.text).join(' '), duration, segments, model: path.basename(settings.whisperModelPath) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true }); // SEC-04: 임시 파일 삭제
  }
}

// 로컬 요약: 이 노트북의 Ollama(127.0.0.1)를 호출한다.
export async function chat({ system, user, settings }) {
  let res;
  try {
    res = await fetch(`${settings.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.ollamaModel,
        stream: false,
        options: { temperature: 0.2 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(60 * 60 * 1000),
    });
  } catch {
    throw new UserError('Ollama에 연결하지 못했습니다. Ollama가 실행 중인지, 설정의 주소를 확인하세요.');
  }
  if (!res.ok) {
    throw new UserError(`Ollama 오류(${res.status}). 모델 "${settings.ollamaModel}"이 설치되어 있는지 확인하세요.`);
  }
  const json = await res.json();
  const content = json?.message?.content;
  if (!content) throw new UserError('Ollama가 빈 응답을 돌려보냈습니다.');
  return content.trim();
}
