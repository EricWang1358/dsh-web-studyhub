/* Token estimates before a run (WP27): no model call, no network.

   Prices are not here and never will be: a provider's price list is the
   learner's to apply to the tokens. */

/* ---------- pricing text the way DSH does ---------- */

const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
const ROLE_OVERHEAD = 4;

/** DSH's `estimateMessage` for one user message: a text block (chars / 4 + 4) plus role framing. */
export const dshUserTokens = (text) => Math.ceil(String(text).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD + ROLE_OVERHEAD;
/** DSH's `estimateSystemMessage`: text density plus role framing, no block overhead; empty is free. */
export const dshSystemTokens = (text) => String(text).length === 0 ? 0 : Math.ceil(String(text).length / CHARS_PER_TOKEN) + ROLE_OVERHEAD;

// DeepSeek's published conversion: a Chinese character is about 0.6 token, an English character about 0.3.
const CJK = /[　-ヿ㐀-鿿가-힯豈-﫿＀-￯]/;
const CJK_TOKENS = 0.6, OTHER_TOKENS = 0.3;
function documentedTokens(text) {
  let cjk = 0, other = 0;
  for (const char of String(text)) { if (CJK.test(char)) cjk++; else other += char.length; }
  return Math.ceil(cjk * CJK_TOKENS + other * OTHER_TOKENS);
}

/**
 * Text pricing for estimates. The lower bound is DSH's own fixed heuristic (the `tokenMeter` service when the host
 * has it, else a mirror of its rule); the upper bound counts by DeepSeek's documented per-character rates, because
 * DSH itself says its heuristic underprices Chinese text and JSON.
 * @param services `{ tokenMeter }`: `ctx.tokenMeter` when the host provides it.
 */
export function createTextMeasure({ tokenMeter } = {}) {
  const dsh = (text, role = 'user') => {
    const value = String(text ?? '');
    if (typeof tokenMeter?.estimateMessage === 'function') {
      try {
        const tokens = tokenMeter.estimateMessage({ role, content: role === 'system' && !value ? [] : [{ type: 'text', text: value }] });
        if (Number.isFinite(tokens) && tokens >= 0) return tokens;
      } catch { /* the mirrored rule below prices the same text */ }
    }
    return role === 'system' ? dshSystemTokens(value) : dshUserTokens(value);
  };
  /** { low, high } tokens of one message. */
  const range = (text, role = 'user') => {
    const low = dsh(text, role);
    const framing = role === 'system' ? (String(text ?? '').length ? ROLE_OVERHEAD : 0) : BLOCK_OVERHEAD + ROLE_OVERHEAD;
    return { low, high: Math.max(low, documentedTokens(text ?? '') + framing) };
  };
  return { dsh, range };
}
