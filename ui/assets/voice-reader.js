const TIMED_CHARACTER = /[\p{L}\p{N}]/u;

function countTimedCharacters(value) {
  let count = 0;
  for (const character of String(value || "")) {
    if (TIMED_CHARACTER.test(character)) count += 1;
  }
  return count;
}

export function buildReaderSegments(value, timings) {
  const text = String(value || "");
  if (!text) return { segments: [], marks: [] };
  const rows = (Array.isArray(timings) ? timings : [])
    .map((row) => ({
      start: Number(row?.start),
      end: Number(row?.end),
      text: String(row?.text || "").trim(),
    }))
    .filter((row) => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end > row.start && row.text)
    .sort((a, b) => a.start - b.start)
    .slice(0, 1200);

  const segments = [];
  const marks = [];
  let cursor = 0;
  let covered = 0;
  for (const row of rows) {
    const index = text.indexOf(row.text, cursor);
    if (index < 0) continue;
    if (index > cursor) segments.push({ type: "text", text: text.slice(cursor, index) });
    const mark = { ...row, type: "mark" };
    segments.push(mark);
    marks.push(mark);
    cursor = index + row.text.length;
    covered += countTimedCharacters(row.text);
  }

  const eligibleCharacters = countTimedCharacters(text);
  if (marks.length < 2 || eligibleCharacters === 0 || covered < eligibleCharacters * 0.6) {
    // covered/eligible 一起返回：退化时页面要把「对上了多少字」说出来，
    // 否则只能猜到底是没时间戳，还是时间戳跟原文对不上。
    return { segments: [{ type: "text", text }], marks: [], covered, eligibleCharacters };
  }
  if (cursor < text.length) segments.push({ type: "text", text: text.slice(cursor) });
  return { segments, marks, covered, eligibleCharacters };
}

export function activeTimingIndex(timings, currentMs) {
  const rows = Array.isArray(timings) ? timings : [];
  const at = Number(currentMs);
  if (!Number.isFinite(at)) return -1;
  return rows.findIndex((row) => at >= row.start && at < row.end);
}

export function formatTimeLabel(seconds) {
  const value = Number(seconds);
  const total = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const minutes = Math.floor(total / 60);
  const remainder = String(total % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}
