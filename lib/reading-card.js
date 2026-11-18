import { randomUUID } from 'node:crypto';
import { appendSummaryBlock, hasToolCalls } from './length-summary.js';
import { prepareReading, readVisibleText, sourceFromAgentEnd } from './reply-reading.js';

export function formatInlineReading(reading) {
  const title = reading.mode === 'result' ? '知意整理 · 这件事的结果' : '知意整理版';
  const body = reading.text.split(/\r?\n/).map(line => line ? `> ${line}` : '>').join('\n');
  const note = reading.modelNote ? `\n>\n> 由备用模型 ${reading.modelNote.replace(/\s+/g, ' ')} 整理` : '';
  return `> **${title}**\n>\n${body}${note}`;
}

export function createInlineReading(sdk, { readConfig, readModel, reportError, prepare = prepareReading }) {
  const turns = new Map();
  const keyFor = session => typeof session === 'string' ? session : (session?.sessionId || session?.sessionPath || session?.path);
  function start(session, prompt) {
    const key = keyFor(session);
    if (!key) return;
    if (turns.size >= 128) turns.delete(turns.keys().next().value);
    turns.set(key, { messages: [{ role: 'user', content: prompt }], chars: prompt.length, ended: false });
  }
  async function finish(session, message) {
    const key = keyFor(session);
    const turn = turns.get(key);
    if (!turn || turn.ended || !message) return;
    const text = readVisibleText(message);
    if (message.phase === 'commentary' || hasToolCalls(message) || message.stopReason === 'toolUse' || message.content?.some?.(part => ['tool-call', 'tool_use'].includes(part?.type))) {
      turn.chars += text.length;
      if (turn.chars > 12000 || turn.messages.length >= 64) { turn.ended = true; turn.messages = []; }
      else if (text) turn.messages.push({ role: 'assistant', content: text });
      return;
    }
    turn.ended = true;
    const messages = turn.messages;
    turn.messages = [];
    try {
      if (!(await readConfig()).enabled || turns.get(key) !== turn) return;
      const source = sourceFromAgentEnd({ type: 'agent_end', messages: [...messages, { ...message, role: 'assistant' }] });
      if (!source) return;
      const reading = await prepare(sdk, source, readModel(), `zhiyi_reading_${randomUUID()}`);
      if (!reading || !(await readConfig()).enabled || turns.get(key) !== turn) return;
      return appendSummaryBlock(message, formatInlineReading(reading));
    } catch (error) {
      reportError(String(error?.code || 'READING_FAILED').slice(0, 80));
    }
  }
  return { start, finish };
}
