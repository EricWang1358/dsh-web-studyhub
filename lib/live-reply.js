import { parseJson } from './generation.js';

/**
 * The reply guard of the live class's model work (translation, correction): many chat models answer a JSON request with a friendly paragraph instead
 * ("你发来的是一段……"). A paragraph is not about the text's size, so asking with less text never helps; what helps is asking once more with a strict
 * rule, then asking a model that keeps to the format (Gemini answers in JSON mode). One place decides this for every live request.
 */
export const REPLY_RULE = '\n\nYour reply must be ONLY the JSON object described in the system instructions: the first character { and the last }. ' +
  'No greeting, no explanation, no Markdown, and do not comment on the input.';

/** What a reply looks like: usable JSON somewhere in it, prose with no JSON at all, or JSON that starts but never closes (cut off by a reply limit). */
export function replyShape(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return 'prose';
  try { parseJson(text); return 'json'; } catch { /* not whole: prose, or cut off */ }
  return text.includes('{') ? 'cut' : 'prose';
}

/** A model that would not answer in the format asked; `reply` is the start of what it said, for the learner's message. */
export class ReplyFormatError extends Error {
  constructor(reply) {
    super(`模型没有按格式回答，回了一段话：「${String(reply ?? '').trim().slice(0, 40)}」`);
    this.name = 'ReplyFormatError';
    this.kind = 'prose';
  }
}

// Not the request's or the model's format: the connection, a rate limit, a quota or a server error. Another model may answer this one request.
const transient = error => !['TimeoutError', 'AbortError', 'ReplyFormatError'].includes(error?.name) && error?.cause?.name !== 'TimeoutError' &&
  !/超时|timed? ?out/i.test(String(error?.message || ''));

/**
 * `primary` and the optional `fallback` are complete(system, prompt, options) functions. The returned function has the same shape and returns the raw
 * reply, which holds JSON (or JSON cut off: the caller treats that as a size problem). The first request is sent as the caller wrote it; a prose reply is
 * asked again with REPLY_RULE after the input, and a model that needed the rule gets it on every later request. A model that still answers in prose hands
 * over to the fallback, which then answers every later request too (`onSwitch` tells). A connection failure tries the fallback for that request only.
 */
export function rescuedComplete({ primary, fallback = null, onSwitch = () => {} }) {
  let current = primary, other = fallback;
  const strict = new Set();
  const once = async (model, system, prompt, options) => {
    if (!strict.has(model)) {
      const first = await model(system, prompt, options);
      if (replyShape(first) !== 'prose') return first;
      if (options?.signal?.aborted) throw new ReplyFormatError(first);
      strict.add(model);
    }
    const reply = await model(system, prompt + REPLY_RULE, options);
    if (replyShape(reply) !== 'prose') return reply;
    throw new ReplyFormatError(reply);
  };
  return async (system, prompt, options = {}) => {
    try { return await once(current, system, prompt, options); }
    catch (error) {
      if (!other || options.signal?.aborted) throw error;
      if (error?.name === 'ReplyFormatError') {
        const reply = await once(other, system, prompt, options);
        [current, other] = [other, current];
        onSwitch('prose');
        return reply;
      }
      if (!transient(error)) throw error;
      try { return await once(other, system, prompt, options); }
      catch { throw error; }
    }
  };
}
