import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// .env 파일을 읽어 process.env에 넣는다. 이미 설정된 환경 변수가 우선한다.
// API 키는 이 파일(또는 환경 변수)에서만 읽고, 화면·API 응답으로는 내보내지 않는다.
export function loadEnvFile(file = path.join(ROOT, '.env')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export function dataDirFromEnv() {
  return path.resolve(process.env.DATA_DIR || path.join(ROOT, '회의록데이터'));
}
