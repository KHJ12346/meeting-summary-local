// 전사문 → 회의록 요약. 짧으면 한 번에, 길면 구간별로 정리한 뒤 합쳐서 최종 요약한다(S-03).

export const CHUNK_CHARS = 6000;
const SINGLE_PASS_CHARS = 8000;

const SYSTEM = `당신은 회의록 작성 보조자입니다. 한국어로 답합니다.
규칙:
- 녹취록에 없는 내용은 절대 추가하지 않습니다. 추측하지 않습니다.
- 담당자나 기한이 언급되지 않았다면 "미정"이라고 씁니다.
- 음성 인식 오류로 보이는 단어나 의미가 불분명한 부분은 고치지 말고 "확인 필요"에 적습니다.
- 사람 이름, 설비명, 수치는 녹취록에 나온 그대로 씁니다.`;

const FORMAT = `다음 형식(마크다운)으로 정확히 작성하세요.

## 핵심 요약
(3~5줄)

## 주요 논의 사항
- (안건별 글머리표)

## 결정 사항
- (없으면 "언급 없음")

## 액션 아이템
| 담당자 | 기한 | 내용 |
| --- | --- | --- |
(없으면 표 대신 "언급 없음")

## 확인 필요
- (인식 오류가 의심되거나 불명확한 부분. 없으면 "없음")`;

export function chunkText(text, size = CHUNK_CHARS) {
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > size) {
      chunks.push(cur);
      cur = '';
    }
    // 한 줄이 너무 길면 잘라서 나눈다.
    if (line.length > size) {
      for (let i = 0; i < line.length; i += size) {
        if (cur) {
          chunks.push(cur);
          cur = '';
        }
        chunks.push(line.slice(i, i + size));
      }
      continue;
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export async function summarize({ text, meta, chat, onProgress = () => {} }) {
  const clean = text.trim();
  if (!clean) return '## 핵심 요약\n전사된 내용이 없습니다. 녹음에 음성이 없거나 마이크 입력이 없었을 수 있습니다.\n';

  const header = `회의명: ${meta.title}${meta.attendees ? `\n참석자: ${meta.attendees}` : ''}${meta.memo ? `\n메모: ${meta.memo}` : ''}`;

  if (clean.length <= SINGLE_PASS_CHARS) {
    onProgress(0, 1);
    const out = await chat({ system: SYSTEM, user: `${header}\n\n[녹취록]\n${clean}\n\n${FORMAT}` });
    onProgress(1, 1);
    return out + '\n';
  }

  const parts = chunkText(clean);
  const notes = [];
  for (let i = 0; i < parts.length; i++) {
    onProgress(i, parts.length + 1);
    notes.push(
      await chat({
        system: SYSTEM,
        user:
          `다음은 회의 녹취록의 일부(${i + 1}/${parts.length})입니다. 이 부분의 논의 내용, 결정 사항, 할 일(담당자·기한은 언급된 경우만)을 ` +
          `빠짐없이 간결한 글머리표로 정리하세요. 의미가 불분명한 부분은 "(확인 필요)"로 표시하세요.\n\n${parts[i]}`,
      }),
    );
  }
  onProgress(parts.length, parts.length + 1);
  const out = await chat({
    system: SYSTEM,
    user: `${header}\n\n아래는 긴 회의를 구간별로 정리한 메모입니다. 이를 합쳐 회의 전체의 회의록을 작성하세요.\n\n${notes
      .map((n, i) => `[구간 ${i + 1}]\n${n}`)
      .join('\n\n')}\n\n${FORMAT}`,
  });
  onProgress(parts.length + 1, parts.length + 1);
  return out + '\n';
}
