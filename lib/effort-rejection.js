/* A provider that refuses the reasoning level DSH sent (2.6.1).

   DSH lists the levels a model declares (`minimal`, `low`, … `max`) and sends the chosen id as the wire value. A gateway may still accept
   fewer values than the declaration says: it answers 400 `Invalid option: expected one of "off"|"low"|"medium"|…`
   for `reasoning_effort`. The light path picks the cheapest declared level (`minimal` counts as "off"), so a model that declares
   `minimal` but whose gateway only knows `off`/`low`/… failed every 帮我想想 call. The answer names the accepted values, so this module reads
   them and picks the nearest level the model still offers; the caller remembers it per model so only the first call pays the round trip. */

import { chooseEffort, classifyEffort } from './model-effort.js';

/** The values a provider says it accepts for `reasoning_effort`, or null when the message is not that complaint. */
export function acceptedEfforts(message) {
  const text = String(message ?? '');
  if (!/reasoning[_ ]?effort/i.test(text)) return null;
  const listed = /expected one of\s+((?:\\?"[\w-]+\\?"\s*\|?\s*)+)/i.exec(text);
  if (!listed) return null;
  const values = [...listed[1].matchAll(/\\?"([\w-]+)\\?"/g)].map((match) => match[1]);
  return values.length ? values : null;
}

/**
 * The level to send instead of `sent`: of the levels the model offers (`offered`, ids) that the provider accepts, the nearest to it by
 * the shared mapping of lib/model-effort.js. `undefined` when nothing fits, which means "send no level" (the model's own default).
 */
export function replacementEffort(sent, accepted, offered) {
  const usable = (offered || []).map(String).filter((id) => accepted.includes(id)).map((id) => ({ id, name: id }));
  const strength = classifyEffort({ id: String(sent) });
  if (!usable.length || !strength || strength === 'default') return undefined;
  return chooseEffort(usable, strength).id;
}
