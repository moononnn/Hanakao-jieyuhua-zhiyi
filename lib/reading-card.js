import { randomBytes } from 'node:crypto';
import { prepareReading, sourceFromAgentEnd } from './reply-reading.js';

export function createReadingCards(sdk, { readConfig, readModel, sessionForPath, ignoredPath, reportError, prepare = prepareReading,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const revisions = new Map();
  const handled = new WeakSet();
  const busy = new Set();
  const records = 'reply-reading:';
  const knownId = /^a_[0-9a-f]{20}$/;

  async function idle(sessionId) {
    const state = await sdk.bus.request('session:context', { sessionId, scope: 'all' }, { timeoutMs: 2500 });
    return state?.isStreaming === false && !(Number(state.pendingMessageCount) > 0);
  }

  async function note(event, sessionPath) {
    if (!sessionPath || ignoredPath(sessionPath) || !event || typeof event !== 'object') return;
    if (event.type === 'agent_start' || event.type === 'session_closed') {
      revisions.delete(sessionPath);
      if (event.type === 'agent_start') {
        if (revisions.size >= 128) revisions.delete(revisions.keys().next().value);
        revisions.set(sessionPath, {});
      }
      return;
    }
    if (event.type !== 'agent_end' || handled.has(event) || busy.has(sessionPath)) return;
    handled.add(event);
    const revision = revisions.get(sessionPath);
    // No start / no explicit session identity: leave the conversation untouched.
    if (!revision || revision.ended) return;
    let claimed = false;
    try {
      const config = await readConfig();
      if (!config.enabled || revisions.get(sessionPath) !== revision || revision.ended) return;
      const source = sourceFromAgentEnd(event);
      if (!source) return;
      revision.ended = true;
      busy.add(sessionPath);
      claimed = true;
      const sessionId = await sessionForPath(event, sessionPath);
      if (!sessionId) return;
      const cardId = 'a_' + randomBytes(10).toString('hex');
      // Wait for the host to finish its end-of-turn housekeeping before trying to deliver.
      let ready = false;
      for (const delay of [100, 250, 600, 1100]) {
        await wait(delay);
        if (revisions.get(sessionPath) !== revision) return;
        if (await idle(sessionId)) { ready = true; break; }
      }
      if (!ready) return;
      const reading = await prepare(sdk, source, readModel(), `zhiyi_reading_${cardId}`);
      if (!reading || revisions.get(sessionPath) !== revision || !(await readConfig()).enabled) return;
      await sdk.storage.global.set(records + cardId, reading);
      if (revisions.get(sessionPath) !== revision || !(await idle(sessionId)) || revisions.get(sessionPath) !== revision) return;
      // The edited text lives only in card storage; never supply it as a user message.
      const sent = await sdk.bus.request('session:send-custom', {
        sessionId, scope: 'all', customType: 'zhiyi-reply-reading', display: true, triggerTurn: false,
        details: { cardInstanceId: cardId },
        content: [{ type: 'text', text: '（知意的整理版入口，供阅读，不是新话题。）' }],
      }, { timeoutMs: 5000 });
      if (!sent?.ok || !sent.entryId) reportError('NOT_DELIVERED');
    } catch (error) {
      reportError(String(error?.code || 'READING_FAILED').slice(0, 80));
    } finally {
      if (claimed) busy.delete(sessionPath);
    }
  }

  async function read(id) {
    return typeof id === 'string' && knownId.test(id) ? sdk.storage.global.get(records + id, null) : null;
  }
  return { note, read };
}
