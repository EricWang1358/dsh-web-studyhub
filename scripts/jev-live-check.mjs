#!/usr/bin/env node
/* EXPERIMENTAL. A few real, tiny round trips with Jev (TypeSafe AI "System One"), for the owner to run by hand with their own key:

     JEV_API_KEY=<your key> node scripts/jev-live-check.mjs               (the checks below, a handful of tiny requests)
     JEV_API_KEY=<your key> node scripts/jev-live-check.mjs --check-only  (only the harmless key check)
     node scripts/jev-live-check.mjs --provider opencode-zen-free         (OpenCode Zen's free Jev model, key from OPENCODE_GO_API_KEY_2)
     node scripts/jev-live-check.mjs --provider opencode-zen [--key-env NAME]   (jev-1.13; NAME is another variable holding the key)
     node scripts/jev-live-check.mjs --provider custom --endpoint https://gateway.example/v1/systemone --model <id>   (key from JEV_CUSTOM_API_KEY)

   --provider is typesafe (the default), opencode-zen-free or opencode-zen (lib/jev-providers.js). The key is read from the environment
   variable the preset names (JEV_API_KEY, or OPENCODE_GO_API_KEY_2), never from a file. Without it the script does NOTHING (no network,
   no files) and says so. It never prints the key. It sends only a few made-up sentences;
   no study material is read or sent. It reports each assumption StudyHub makes about the API that the tests can only check against a fake server,
   so a mismatch is visible at once:
     1. the key check (one tiny noul question) tells a valid key from a bad one;
     2. a noul, a choice and a score question in ONE request are accepted and answered as the documentation says
        (noul 0-1, the chosen option among the given ones with a probability for each, a score with probabilities);
     3. usage tokens are reported;
     4. Chinese text is accepted (the documentation says CJK is supported but less optimised);
     5. the time each request took (the documentation says 70-500 ms). */

import { JevError, choice, createJevClient, jevBaseUrl, noul, score } from '../lib/jev.js';
import { scriptKeySource } from '../lib/jev-providers.js';

const source = scriptKeySource(process.argv.slice(2));
if (source.error) { console.log(source.error); process.exit(2); }
const { provider, keyEnvName: keyName, key, endpoint, model } = source;
if (!key) {
  console.log(`${keyName} is not set: nothing was done. Set it to your own Jev key (${provider.family === 'opencode' ? 'an OpenCode key; DSH may not pass its own variable on to scripts you start by hand' : 'a TypeSafe key'}) to run a few real, tiny requests with made-up sentences.`);
  process.exit(0);
}
const checkOnly = process.argv.includes('--check-only');
const client = createJevClient({ apiKey: key, provider: provider.id, ...(endpoint ? { endpoint, model } : {}) });
const host = endpoint ? new URL(endpoint).host : new URL(jevBaseUrl(provider)).host;
const say = (ok, text) => console.log(`${ok === null ? '·' : ok ? 'OK ' : 'FAIL'} ${text}`);
let failed = false;
const timed = async work => { const started = performance.now(); const value = await work(); return { value, ms: Math.round(performance.now() - started) }; };
const fail = (text) => { say(false, text); failed = true; };

console.log(`Experimental Jev check: talking to ${host} (provider ${provider.id}, model ${model ?? provider.model}); only made-up sentences are sent.`);
try {
  const { value, ms } = await timed(() => client.check());
  say(true, `key check: the key is valid (model ${value.model}, ${value.usage.inputTokens} in / ${value.usage.outputTokens} out tokens, ${ms} ms)`);
} catch (error) {
  if (error instanceof JevError) fail(`key check: ${error.code}${error.httpStatus ? ` (HTTP ${error.httpStatus})` : ''}: ${error.message}`); else fail(`key check: ${error.message}`);
  process.exit(1);
}
if (checkOnly) process.exit(0);

try {
  const options = { billing: 'Charges, invoices and payment problems', shipping: 'Delivery status, delays and lost parcels', returns: 'Exchanges and wrong or damaged items' };
  const { value, ms } = await timed(() => client.decide('My running shoes arrived in the wrong size. Can I swap them for a size 10?', {
    refund: noul('Is the customer asking for their money back?'),
    team: choice('Which team should handle this?', options),
    urgency: score('How urgent is this message?', ['Not urgent', 'Somewhat urgent', 'Very urgent']),
  }));
  say(true, `one request with a noul, a choice and a score question was accepted (${ms} ms)`);
  const picked = value.answers.team;
  const sum = Object.values(picked.probabilities).reduce((a, b) => a + b, 0);
  say(Object.hasOwn(options, picked.choice) && Math.abs(sum - 1) < 0.05, `choice: "${picked.choice}" with probabilities summing to ${sum.toFixed(3)} over ${Object.keys(picked.probabilities).length} options`);
  say(value.answers.refund.noul >= 0 && value.answers.refund.noul <= 1, `noul: ${value.answers.refund.noul} (between 0 and 1)`);
  say(Number.isFinite(value.answers.urgency.score), `score: ${value.answers.urgency.score} on a 3-level scale, probabilities ${JSON.stringify(value.answers.urgency.probabilities)}`);
  say(value.usage.inputTokens > 0, `usage reported: ${value.usage.inputTokens} in / ${value.usage.outputTokens} out tokens`);
  if (!(Object.hasOwn(options, picked.choice) && value.usage.inputTokens > 0)) failed = true;
  if (ms > 500) say(null, `slower than the documented 70-500 ms (${ms} ms); network distance counts`);
} catch (error) { fail(`mixed request: ${error.message}`); }

try {
  const { value, ms } = await timed(() => client.decide('数据库事务具有原子性、一致性、隔离性和持久性。', { subject: choice('这段话讲的是哪一门课？', { databases: '数据库', networks: '计算机网络', cooking: '烹饪' }) }));
  say(true, `Chinese text accepted: "${value.answers.subject.choice}" at ${Math.round(Math.max(...Object.values(value.answers.subject.probabilities)) * 100)}% (${ms} ms). Whether that is good enough is for scripts/eval-jev.mjs to measure.`);
} catch (error) { fail(`Chinese request: ${error.message}`); }

process.exit(failed ? 1 : 0);
