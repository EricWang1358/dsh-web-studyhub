import { parseJson, arrayItems } from '../generation.js';

/* Reading what a one-pass call returns. A reply that cannot be read is asked again ONCE with the same context marked `retry: 1` (so the 任务 console shows the
   second call as its own step); a reply still unreadable throws parseJson's SyntaxError, which the caller tells apart from a failure of the call itself. */

const AGAIN = '\n\nYour previous reply was not parseable as JSON. Return only the JSON value with no surrounding prose.';

/** The JSON value of a call: one call, and one more when the reply cannot be read. `read(text)` turns a reply into its value or null (default: parseJson). */
export async function askJson(complete, system, prompt, context = {}, read = text => parseJson(String(text ?? ''))) {
  const first = tryRead(read, await complete(system, prompt, context));
  if (first !== null) return first;
  const second = tryRead(read, await complete(system, `${prompt}${AGAIN}`, { ...context, retry: 1 }));
  if (second !== null) return second;
  throw new SyntaxError('The reply could not be read as JSON after asking again');
}

const tryRead = (read, text) => { try { return read(text) ?? null; } catch { return null; } };

/** The cards of a write reply: the whole `cards` array, or, from a reply cut off or broken in its tail, every complete card before the break; null when it holds none. */
export function readCards(text) {
  const raw = String(text ?? '');
  try { const value = parseJson(raw); if (Array.isArray(value?.cards)) return value.cards; } catch { /* a reply cut off keeps its complete cards below */ }
  const salvaged = arrayItems(raw, 'cards');
  return salvaged?.items.length ? salvaged.items : null;
}
