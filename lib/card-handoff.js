import { randomUUID } from 'node:crypto';
import { formatAskAnswer } from './ask.js';

const CARD_WAIT_MS = 10 * 60 * 1000;

// This registry never grants external actions. A host restart forgets pending cards safely.
export function createCardAskRegistry({ now = Date.now, newId = randomUUID } = {}) {
  const records = new Map();

  function find(askId, sessionPath) {
    const item = records.get(askId);
    if (!item || item.sessionPath !== sessionPath) return null;
    if (now() >= item.expiresAt && item.status !== 'answered') item.status = 'expired';
    return item;
  }

  function prepare(request, sessionPath) {
    for (const item of records.values()) {
      if (item.sessionPath === sessionPath && item.status !== 'answered' && item.status !== 'cancelled') {
        find(item.askId, sessionPath);
        if (item.status !== 'expired') throw new Error('这段对话已有一题等你处理，不能叠加新问题。');
      }
    }
    const askId = newId();
    const expiresAt = now() + CARD_WAIT_MS;
    records.set(askId, { askId, sessionPath, request, expiresAt, status: 'prepared', cardId: '' });
    return { askId, expiresAt, ...request };
  }

  function bind({ askId, sessionPath, cardId }) {
    const item = find(askId, sessionPath);
    if (!item || item.status === 'expired') return { ok: false, text: '这道选择已失效，请重新发问。' };
    if (typeof cardId !== 'string' || !/^c_[a-z0-9_-]{4,100}$/i.test(cardId)) {
      return { ok: false, text: '卡片编号无效，不能开放作答。' };
    }
    if (item.status === 'ready' && item.cardId === cardId) return { ok: true, text: '卡片已绑定，可以作答。' };
    if (item.status !== 'prepared') return { ok: false, text: '这道选择已绑定或处理，不能改绑其他卡片。' };
    item.cardId = cardId;
    item.status = 'ready';
    return { ok: true, text: '卡片已绑定，可以作答。' };
  }

  function resolve({ askId, sessionPath, cardId, choice, note = '', action = 'confirmed' }) {
    const item = find(askId, sessionPath);
    if (!item || item.status === 'expired') return { ok: false, text: '这道选择已过期或所属会话不符，未继续任务。' };
    if (item.status !== 'ready' || item.cardId !== cardId) return { ok: false, text: '卡片来源不匹配或选择已处理，未继续任务。' };
    if (!['confirmed', 'custom', 'rejected'].includes(action)) return { ok: false, text: '回答状态无效，未继续任务。' };
    if (action === 'custom' && (typeof choice !== 'string' || !choice.trim() || [...choice.trim()].length > 500)) {
      return { ok: false, text: '自定义回答无效，未继续任务。' };
    }
    if (typeof note !== 'string' || [...note].length > 500) return { ok: false, text: '补充说明格式无效，未继续任务。' };
    const answer = action === 'rejected'
      ? { action: 'rejected' }
      : action === 'custom'
        ? { action: 'confirmed', value: { customChoice: choice.trim() } }
        : { action: 'confirmed', value: { choice, note } };
    const formatted = formatAskAnswer(answer, item.request);
    if (formatted.isError) return { ok: false, text: formatted.text };
    item.status = 'answered';
    return { ok: true, ...formatted, request: item.request };
  }

  function cancel({ askId, sessionPath }) {
    const item = find(askId, sessionPath);
    if (!item || item.status !== 'prepared') return false;
    item.status = 'cancelled';
    return item.request;
  }

  return { prepare, bind, resolve, cancel };
}
