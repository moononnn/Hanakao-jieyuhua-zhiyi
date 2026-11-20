import { randomUUID } from 'node:crypto';
import { appendSummaryBlock, hasToolCalls } from './length-summary.js';
import { prepareReading, readVisibleText, sourceFromAgentEnd } from './reply-reading.js';
import { isSubagentSessionPath, isSubagentSessionTarget } from './resume-watch.js';

const MAX_SOURCE_CHARS = 12000;
const MAX_SOURCE_MESSAGES = 64;

/**
 * 子代理会话不是用户窗口：知意的东西落进去只剩噪音。
 * 这里用现成的识别口径（路径 / kind / provenance），不另造规则。
 * 会话标识也可能是直接给的一串路径（字符串），那一支要单独认。
 */
function isSubagentSession(session) {
  if (typeof session === 'string') return isSubagentSessionPath(session);
  if (isSubagentSessionTarget(session)) return true;
  if (isSubagentSessionPath(session?.path)) return true;
  if (isSubagentSessionPath(session?.sessionPath)) return true;
  return false;
}

export function formatInlineReading(reading) {
  const title = reading.mode === 'result' ? '知意整理 · 这件事的结果' : '知意整理版';
  const body = reading.text.split(/\r?\n/).map(line => line ? `> ${line}` : '>').join('\n');
  const note = reading.modelNote ? `\n>\n> 由备用模型 ${reading.modelNote.replace(/\s+/g, ' ')} 整理` : '';
  return `> **${title}**\n>\n${body}${note}`;
}

/**
 * @param {object} sdk
 * @param {{readConfig:Function, readModel:Function, reportError:Function, prepare?:Function, reportDecision?:Function}} options
 *   reportDecision 是可选诊断回调：只收固定白名单里的事件名，不收正文。
 */
export function createInlineReading(sdk, { readConfig, readModel, reportError, prepare = prepareReading, reportDecision = null }) {
  const turns = new Map();
  const keyFor = session => typeof session === 'string' ? session : (session?.sessionId || session?.sessionPath || session?.path);
  const note = (event) => {
    if (typeof reportDecision !== 'function') return;
    try { reportDecision(event); } catch { /* 诊断不能影响正事 */ }
  };
  function start(session, prompt) {
    // 子代理：连诊断都不记，更不读配置、不碰正文。
    if (isSubagentSession(session)) return;
    const key = keyFor(session);
    if (!key) return;
    const previous = turns.get(key);
    // 新一轮盖掉了还在等的那一轮：旧的那轮不会再有结果了。
    if (previous && !previous.ended) note('superseded');
    if (turns.size >= 128) turns.delete(turns.keys().next().value);
    turns.set(key, { messages: [{ role: 'user', content: prompt }], chars: prompt.length, ended: false });
    note('start');
  }
  async function finish(session, message) {
    // 子代理：一步都不走——不读配置、不跑模型、不记诊断。
    if (isSubagentSession(session)) return undefined;
    const key = keyFor(session);
    const turn = key ? turns.get(key) : null;
    if (!turn) { note('no_turn'); return undefined; }
    if (turn.ended) { note('already_ended'); return undefined; }
    if (!message) { note('missing_message'); return undefined; }
    note('finish');
    const text = readVisibleText(message);
    const toolTurn = hasToolCalls(message) || message.stopReason === 'toolUse'
      || message.content?.some?.(part => ['tool-call', 'tool_use'].includes(part?.type));
    if (message.phase === 'commentary') note('accumulate_phase');
    if (toolTurn) note('accumulate_tool');
    if (message.phase === 'commentary' || toolTurn) {
      turn.chars += text.length;
      if (turn.chars > MAX_SOURCE_CHARS) {
        note('source_overflow_chars');
        note('source_overflow');
        turn.ended = true;
        turn.messages = [];
      } else if (turn.messages.length >= MAX_SOURCE_MESSAGES) {
        note('source_overflow_messages');
        note('source_overflow');
        turn.ended = true;
        turn.messages = [];
      } else if (text) turn.messages.push({ role: 'assistant', content: text });
      return undefined;
    }
    turn.ended = true;
    const messages = turn.messages;
    turn.messages = [];
    try {
      if (!(await readConfig()).enabled) { note('disabled'); return undefined; }
      if (turns.get(key) !== turn) { note('superseded'); return undefined; }
      const source = sourceFromAgentEnd({ type: 'agent_end', messages: [...messages, { ...message, role: 'assistant' }] }, note);
      if (!source) return undefined;
      const reading = await prepare(sdk, source, readModel(), `zhiyi_reading_${randomUUID()}`, note);
      if (!reading) return undefined;
      if (!(await readConfig()).enabled) { note('disabled'); return undefined; }
      if (turns.get(key) !== turn) { note('superseded'); return undefined; }
      const result = appendSummaryBlock(message, formatInlineReading(reading));
      note('applied');
      return result;
    } catch (error) {
      note('error');
      reportError(String(error?.code || 'READING_FAILED').slice(0, 80));
    }
  }
  return { start, finish };
}
