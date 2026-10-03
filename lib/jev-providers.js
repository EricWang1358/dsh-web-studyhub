/* EXPERIMENTAL. The provider presets of the Jev layer: where a Jev request goes and which model it names. One small table, in one place.

   Jev (TypeSafe AI's "System One") is reachable two ways:
     typesafe            TypeSafe's own API, https://api.typesafe.ai/v1/systemone, the model alias jev-latest. The default; behaves as
                         it always did.
     opencode-zen-free   OpenCode Zen, https://opencode.ai/zen/v1/systemone, model jev-1.13-free ("available on OpenCode for a limited time").
     opencode-zen        The same endpoint, model jev-1.13 (paid by OpenCode's own pricing; this product never shows a price).
     opencode-go         OpenCode Go (the subscription DSH calls "OpenCode Go 2"), https://opencode.ai/zen/go/v1/systemone, model jev-1.13. The route
                         exists (an unauthenticated POST answers 401, an unknown path 404) but OpenCode's public Go model list does not name a Jev
                         model, so whether a Go key is accepted there is NOT verified.
   Source of the OpenCode facts: https://opencode.ai/docs/zen/ and the public /zen/v1/models list. The request and answer shapes are the
   same for all three, so only the address, the model id, the default key variable and the words differ.

   The key of an OpenCode preset normally comes from an environment variable (DSH's "OpenCode 2" account keeps its key in
   OPENCODE_GO_API_KEY_2, and DSH does not copy it into plugin settings; neither do we). `family` says which service a key belongs to:
   a TypeSafe key is never sent to OpenCode and the other way round. `brand` is how the service is named to the learner. */

const PRESETS = [
  { id: 'typesafe', family: 'typesafe', baseUrl: 'https://api.typesafe.ai', path: '/v1/systemone', model: 'jev-latest', host: 'api.typesafe.ai',
    defaultKeyEnv: 'JEV_API_KEY', docsUrl: 'https://docs.typesafe.ai', privacyUrl: 'https://docs.typesafe.ai/legal', free: false, brand: 'TypeSafe' },
  { id: 'opencode-go', family: 'opencode', baseUrl: 'https://opencode.ai', path: '/zen/go/v1/systemone', model: 'jev-1.13', host: 'opencode.ai',
    defaultKeyEnv: 'OPENCODE_GO_API_KEY_2', docsUrl: 'https://opencode.ai/docs/go/', privacyUrl: 'https://opencode.ai/docs/go/', free: false, brand: 'OpenCode Go' },
  { id: 'opencode-zen-free', family: 'opencode', baseUrl: 'https://opencode.ai', path: '/zen/v1/systemone', model: 'jev-1.13-free', host: 'opencode.ai',
    defaultKeyEnv: 'OPENCODE_GO_API_KEY_2', docsUrl: 'https://opencode.ai/docs/zen/', privacyUrl: 'https://opencode.ai/docs/zen/', free: true, brand: 'OpenCode Zen' },
  { id: 'opencode-zen', family: 'opencode', baseUrl: 'https://opencode.ai', path: '/zen/v1/systemone', model: 'jev-1.13', host: 'opencode.ai',
    defaultKeyEnv: 'OPENCODE_GO_API_KEY_2', docsUrl: 'https://opencode.ai/docs/zen/', privacyUrl: 'https://opencode.ai/docs/zen/', free: false, brand: 'OpenCode Zen' },
  // The learner's own endpoint for another gateway that offers the same typed API (reported: OpenRouter, AIML, Netlify AI Gateway; their
  // wire formats are NOT verified here). Address and model id come from the settings; this row only names the family and the key variable.
  { id: 'custom', family: 'custom', baseUrl: '', path: '', model: '', host: '', defaultKeyEnv: 'JEV_CUSTOM_API_KEY', docsUrl: '', privacyUrl: '', free: false, brand: '' },
];

export const JEV_PROVIDERS = Object.freeze(Object.fromEntries(PRESETS.map(preset => [preset.id, Object.freeze(preset)])));
export const JEV_PROVIDER_IDS = Object.freeze(PRESETS.map(preset => preset.id));
export const DEFAULT_JEV_PROVIDER = 'typesafe';

export const isJevProvider = id => typeof id === 'string' && Object.hasOwn(JEV_PROVIDERS, id);
/** The preset for an id; anything unknown (or missing, as in a settings file from before the presets) is the default. */
export const jevProvider = id => JEV_PROVIDERS[isJevProvider(id) ? id : DEFAULT_JEV_PROVIDER];

/**
 * A custom endpoint: the normalised address, or null. https only (http is accepted for this machine, so a local gateway or a test can be
 * used), no credentials in the address, no query, no fragment, at most 300 characters.
 */
export function isCustomEndpoint(value) {
  if (typeof value !== 'string' || !value || value.length > 300) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) return null;
  if (!url.hostname || url.username || url.password || url.search || url.hash) return null;
  return url.href;
}
/** A model id of the custom endpoint: a plain token (letters, digits and . _ : / -), at most 100 characters. */
export const isCustomModel = value => typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,100}$/.test(value);

/** A plain environment variable name: letters, digits and underscores, not starting with a digit. */
export const isKeyEnvName = name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name);

/**
 * For the scripts (scripts/jev-live-check.mjs, scripts/eval-jev.mjs): the provider and its key from `--provider <id>`, `--key-env <NAME>`
 * and the environment (the custom preset also needs `--endpoint <address>` and `--model <id>`). Resolves { provider, keyEnvName, key,
 * endpoint?, model? } (key '' when the variable is not set) or { error } for an unknown provider, variable name, endpoint or model.
 * The scripts never read a key from a file or from the DSH home.
 */
export function scriptKeySource(args, env = process.env) {
  const flag = name => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
  const id = flag('provider') ?? DEFAULT_JEV_PROVIDER, keyEnv = flag('key-env');
  if (!isJevProvider(id)) return { error: `Unknown provider for --provider (expected ${JEV_PROVIDER_IDS.join(', ')})` };
  if (keyEnv !== undefined && !isKeyEnvName(keyEnv)) return { error: '--key-env must be the NAME of an environment variable (letters, digits and underscores)' };
  const { name, key } = keyFromEnvironment(id, keyEnv, env);
  if (jevProvider(id).family !== 'custom') return { provider: jevProvider(id), keyEnvName: name, key };
  const endpoint = isCustomEndpoint(flag('endpoint')), model = flag('model');
  if (!endpoint || !isCustomModel(model)) return { error: '--provider custom needs --endpoint <https address> and --model <id> (letters, digits and . _ : / -)' };
  return { provider: jevProvider(id), keyEnvName: name, key, endpoint, model };
}

/** The key an environment variable holds for `providerId`: { name, key, found }. `keyEnv` overrides the preset's default name. Never logged. */
export function keyFromEnvironment(providerId, keyEnv = '', env = process.env) {
  const name = isKeyEnvName(keyEnv) ? keyEnv : jevProvider(providerId).defaultKeyEnv;
  const key = String(env?.[name] ?? '').trim();
  return { name, key, found: !!key };
}
