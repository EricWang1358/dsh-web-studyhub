import { abortable, childFailure, startBoundedChild } from './host-capabilities.js';
import { ASSIST } from './contexts/study/settings.js';
import { foldSessionUsage, foldUsageEvents, readSessionUsage, totalTokens } from './token-usage.js';
import { reportUsage } from './usage-scope.js';

// Only idle, local teachers are reusable. Remote/older hosts still use one-shot collection.
// Keep at most four handles, for two idle minutes and at most eight turns each.
const MAX_TEACHERS = ASSIST.teachers, IDLE_MS = ASSIST.teacherIdleMs, MAX_TURNS = ASSIST.teacherTurns;
export function createAssistChildren() {
  const teachers = [];
  // Retired teachers can still be finishing a call; shutdown must cancel those too.
  const owned = new Set();
  const reusable = run => run.localAgent?.status === 'idle' &&
    typeof run.localAgent.followup === 'function' && typeof run.localAgent.whenIdle === 'function' &&
    typeof run.localAgent.cancel === 'function' && typeof run.localAgent.session?.snapshotEvents === 'function';

  async function dispose(entry) {
    if (!entry.disposal && entry.run) {
      const run = entry.run;
      entry.run = undefined;
      entry.disposal = Promise.resolve().then(() => run.dispose()).finally(() => { entry.disposal = undefined; });
    }
    try { await entry.disposal; }
    finally { if (entry.retired && !entry.pending) owned.delete(entry); }
  }
  function retire(entry) {
    entry.retired = true;
    clearTimeout(entry.timer);
    const at = teachers.indexOf(entry);
    if (at >= 0) teachers.splice(at, 1);
    if (!entry.pending) void dispose(entry).catch(() => {});
  }
  function clearAssistChildren(root) {
    for (const entry of [...owned]) if (entry.root === root) { entry.controller.abort(new Error('后台助教已结束')); retire(entry); }
  }
  function disposeAssistChildren(ctx) {
    for (const entry of [...owned]) if (entry.ctx === ctx) { entry.controller.abort(new Error('学习插件已关闭')); retire(entry); }
  }
  const textResult = (run, result) => {
    if (result.stopReason !== 'completed') throw new Error(`后台助教未完成：${childFailure(run, result)}`);
    return (result.output || []).filter(block => block.type === 'text').map(block => block.text).join('');
  };

  const reportTurnEvents = (events) => {
    const { totals, requests } = foldUsageEvents(events);
    if (requests > 0 && totalTokens(totals) > 0) {
      reportUsage(totals, { calls: Math.max(1, requests), child: true });
      return true;
    }
    return false;
  };
  async function reportFirstTurnUsage(ctx, run) {
    try {
      const session = run?.localAgent?.session;
      if (typeof session?.snapshotEvents === 'function' && reportTurnEvents(session.snapshotEvents(0))) return;
      const live = foldSessionUsage(session);
      if (live && totalTokens(live.usage) > 0) {
        reportUsage(live.usage, { calls: Math.max(1, live.requests), child: true });
        return;
      }
      const stored = run?.id ? await readSessionUsage(ctx?.get?.('sessionQuery'), run.id) : null;
      if (stored && totalTokens(stored.usage) > 0) reportUsage(stored.usage, { calls: Math.max(1, stored.requests), child: true });
    } catch { /* usage reporting never breaks the turn */ }
  }

  async function followup(run, prompt, signal) {
    const child = run.localAgent, boundary = child.session.seq;
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
    const onAbort = () => child.cancel({ kind: 'parent' });
    signal.addEventListener('abort', onAbort, { once: true });
    let events;
    try {
      signal.throwIfAborted();
      child.followup(createUserMessage({ content: prompt, source: { kind: 'user' } }));
      await abortable(child.whenIdle(), signal);
      signal.throwIfAborted();
      events = child.session.snapshotEvents(boundary);
      const end = events.findLast(event => event.type === 'turn/end');
      const output = events.findLast(event => event.type === 'assistant/message' && event.data.message.content.length)?.data.message.content || [];
      return textResult(run, { stopReason: end?.data.reason?.kind, output });
    } finally {
      signal.removeEventListener('abort', onAbort);
      try { reportTurnEvents(events || child.session.snapshotEvents(boundary)); } catch { /* usage reporting never breaks the turn */ }
    }
  }

  /** Serialize same-card requests through one bounded native handle, including validation and saving. */
  async function withAssistChild(capability, { root, key, request, followupPrompt, task, consume, reuse }) {
    const { ctx, sessionId, parent } = capability;
    let entry = reuse && teachers.find(item => item.ctx === ctx && item.sessionId === sessionId && item.parent === parent && item.key === key);
    for (const previous of [...teachers])
      if (previous.ctx === ctx && previous.sessionId === sessionId && previous !== entry) retire(previous);
    if (!entry) {
      entry = { ctx, sessionId, parent, root, key, controller: new AbortController(), pending: 0, turns: 0, tail: Promise.resolve(), retired: !reuse };
      owned.add(entry);
      if (reuse) {
        while (teachers.length >= MAX_TEACHERS) retire(teachers[0]);
        teachers.push(entry);
      }
    }
    clearTimeout(entry.timer);
    const signal = AbortSignal.any([request.signal, entry.controller.signal]);
    entry.pending++;
    const work = entry.tail.then(async () => {
      try {
        signal.throwIfAborted();
        await entry.disposal;
        if (entry.run && (!reusable(entry.run) || entry.turns >= MAX_TURNS)) await dispose(entry);
        const reused = !!entry.run;
        if (!entry.run) { entry.run = await startBoundedChild(capability.subagents, { ...request, signal }, capability); entry.turns = 0; }
        const run = entry.run;
        Object.assign(task, { childId: run.id, reused });
        let raw;
        if (reused) {
          raw = await followup(run, followupPrompt, signal);
        } else {
          try { raw = textResult(run, await abortable(run.result, signal)); }
          finally { await reportFirstTurnUsage(ctx, run); }
        }
        signal.throwIfAborted();
        entry.turns++;
        return await consume(raw, signal);
      } catch (error) {
        retire(entry);
        await dispose(entry).catch(() => {});
        throw error;
      }
    });
    entry.tail = work.then(() => {}, () => {});
    try { return await work; }
    finally {
      entry.pending--;
      if (!entry.pending) {
        if (entry.retired || !entry.run || !reusable(entry.run) || entry.turns >= MAX_TURNS) {
          retire(entry);
          await dispose(entry);
        } else {
          entry.timer = setTimeout(() => retire(entry), IDLE_MS);
          entry.timer.unref?.();
        }
      }
    }
  }
  return Object.freeze({ clearAssistChildren, disposeAssistChildren, withAssistChild });
}

// Compatibility callers own this standalone pool; hosts create explicit pools.
export const { clearAssistChildren, disposeAssistChildren, withAssistChild } = createAssistChildren();
