import test from 'node:test';
import assert from 'node:assert/strict';
import { tapChildStream } from '../lib/job-output.js';

// 2.6.1: "等待模型开始输出…" stayed on a running DSH sub-agent. tests/job-output.test.mjs hands the listener a hand-made `{ agent, frame }`, so it could never
// tell whether the REAL DSH delivers a sub-agent's frames to a plugin the way the plugin expects. This file builds the host from the DSH sources instead
// and pins the finding: the tap is NOT the fault (the owner also sees generation sub-agents stream in 2.6.0); the panel's empty body was.
//
// What DSH 0.2.0-rc.1/rc.2 does (the same files in both), read from the installed packages:
//   dsh-agent-loop/lib/index.js:1067-1069  the loop emits  this.dispatch.emit("agent/assistant-stream", { frame })  — the payload has NO `agent`.
//   dsh-agent-loop/lib/index.js:777        this.dispatch = agentEvents(loopCtx, this)  — the "fused dispatcher" of the agent.
//   dsh-agent/lib/index.js:234-262         agentEvents(...).emit builds args = [carrier, name, { ...payload, agent }] and calls every listener that
//                                           ctx.events.dispatch("emit", args) returns, as callback(...args) — the listener's `this` is the carrier.
//   cordis/lib/index.js:257-263            dispatch(): a hook is kept when `hook.global || !filter || filter.call(carrier, hook.ctx)`.
//   dsh-scope/lib/index.js:328-339         the carrier's filter: a listener whose context carries NO scope tag is admitted; a tagged one only when its
//                                           tag is the agent (or an ancestor of it).
//   dsh-agent-loop/lib/index.js:373,1062   every frame of one attempt carries attemptId = `${session.id}:${n}` — the child's session id is in the frame itself.
//   dsh-api-session-controller/lib/index.js:1388,1481  DSH's own consumers listen with `{ global: true }` for exactly this reason.
// Verified live against DSH 0.2.0-rc.2 with a streaming fake model (a probe plugin running lib/generation-agent.js and lib/index.js complete):
// an unscoped `root.on` hears the child's text and reasoning, in a live-parent and in a cold (desktop) session.

const SCOPE = Symbol('scope');

/** The dispatcher of cordis + dsh-scope + dsh-agent, reduced to what routing needs. */
function createHost() {
  const hooks = [];
  const scopeChain = (key) => { const chain = []; for (let cursor = key; cursor; cursor = cursor.parent) chain.push(cursor); return chain; };
  const ctxFor = (tag) => ({
    [SCOPE]: tag,
    on(name, callback, options = {}) {
      const hook = { name, callback, ctx: this, global: options && typeof options === 'object' && options.global === true };
      hooks.push(hook);
      return () => { const at = hooks.indexOf(hook); if (at >= 0) hooks.splice(at, 1); };
    },
  });
  /** Emit like `agentEvents(ctx, agent).emit(name, payload)`. */
  const emit = (agent, name, payload, { fused = true } = {}) => {
    const carrierFilter = (hookCtx) => {
      const tag = hookCtx[SCOPE];
      return tag === undefined || scopeChain(agent).includes(tag);
    };
    const args = [fused ? { ...payload, agent } : payload];
    for (const hook of hooks.filter((entry) => entry.name === name && (entry.global || carrierFilter(entry.ctx)))) hook.callback.call({ carrier: true }, ...args);
  };
  return { ctxFor, emit, count: (name) => hooks.filter((hook) => hook.name === name).length };
}

const chunk = (type, extra, attemptId = 'child-1:1') => ({ type: 'chunk', attemptId, revision: 1, index: 0, time: 0, chunk: { type, index: 0, ...extra } });
const agentOf = (id) => ({ id, session: { id } });
const collector = () => {
  const seen = { text: [], reasoning: [] };
  return { seen, sink: { text: (value) => seen.text.push(value), reasoning: (count) => seen.reasoning.push(count) } };
};

test('the real dispatcher: an unscoped plugin context hears a child through the fused { frame, agent } payload', () => {
  const host = createHost(), child = agentOf('child-1'), { seen, sink } = collector();
  tapChildStream(host.ctxFor(undefined), 'child-1', sink);
  host.emit(child, 'agent/assistant-stream', { frame: chunk('text-delta', { text: 'Hello ' }) });
  host.emit(agentOf('somebody-else'), 'agent/assistant-stream', { frame: chunk('text-delta', { text: 'NOT MINE' }, 'somebody-else:1') });
  host.emit(child, 'agent/assistant-stream', { frame: chunk('reasoning-delta', { text: 'hmm' }) });
  host.emit(child, 'agent/assistant-stream', { frame: chunk('text-delta', { text: 'world' }) });
  assert.deepEqual(seen.text, ['Hello ', 'world']);
  assert.deepEqual(seen.reasoning, [3]);
});

test('the tap stops when the call ends', () => {
  const host = createHost(), { seen, sink } = collector();
  const off = tapChildStream(host.ctxFor(undefined), 'child-1', sink);
  assert.equal(host.count('agent/assistant-stream'), 1);
  off();
  assert.equal(host.count('agent/assistant-stream'), 0);
  host.emit(agentOf('child-1'), 'agent/assistant-stream', { frame: chunk('text-delta', { text: 'late' }) });
  assert.deepEqual(seen.text, []);
});
