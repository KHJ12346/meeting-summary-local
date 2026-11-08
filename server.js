import { exec } from 'node:child_process';
import { loadEnvFile, dataDirFromEnv } from './lib/config.js';

loadEnvFile();

const { createApp } = await import('./lib/app.js');

const PORT = Number(process.env.PORT) || 8765;
const HOST = '127.0.0.1'; // SEC-02: 이 노트북에서만 접속 가능. 0.0.0.0으로 바꾸지 말 것.

const { server, store } = createApp({ dataDir: dataDirFromEnv() });

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`포트 ${PORT}이(가) 이미 사용 중입니다. PORT 환경 변수로 다른 포트를 지정하세요.`);
  else console.error(e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`회의록 요약 서비스: ${url}`);
  console.log(`데이터 폴더: ${store.dir}`);
  console.log(`Groq API 키: ${process.env.GROQ_API_KEY ? '설정됨' : '없음(로컬 모드만 가능)'}`);
  console.log('종료: Ctrl+C');
  if (process.platform === 'win32' && process.env.OPEN_BROWSER !== '0') exec(`start "" "${url}"`);
});
