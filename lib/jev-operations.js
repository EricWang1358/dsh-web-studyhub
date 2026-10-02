import { publicJevSettings, readJevSettings, saveJevSettings } from './jev-settings.js';
import { jevUsage } from './jev-usage.js';
import { createJevRuntime } from './jev-runtime.js';

/* EXPERIMENTAL. The operations of the Jev layer that do not depend on the library: settings, the key test, the usage page.
   They are mounted by the system context (lib/contexts/system/operations.js); the features that read the library
   (lib/jev-course-suggest.js, lib/jev-levels.js) are mounted by the library context.

   `seam` is `options.jev` of the service (tests and previews): { baseUrl, fetch, sleep, random, timeoutMs, maxRetries }
   standing in for the real address, the clock and the retry budget. */

const runtimes = new WeakMap();
let shared;
/** One runtime per seam object (so the "last failure" a page shows belongs to the service that made it), one for production. */
export function jevRuntimeFor(seam) {
  if (!seam || typeof seam !== 'object') return (shared ||= createJevRuntime());
  let runtime = runtimes.get(seam);
  if (!runtime) runtimes.set(seam, runtime = createJevRuntime(seam));
  return runtime;
}

export const JEV_KEY_WORKS = 'Jev 密钥有效，Jev 连得上';

export function createJevOperations({ jev: seam, language } = {}) {
  const runtime = jevRuntimeFor(seam);
  return {
    'jev.settings.get': async () => publicJevSettings(await readJevSettings()),
    'jev.settings.set': async (a = {}) => {
      const patch = {};
      for (const field of ['key', 'confirm', 'enabled', 'features', 'threshold']) if (a[field] !== undefined) patch[field] = a[field];
      return publicJevSettings(await saveJevSettings(patch));
    },
    /** One tiny harmless call with no learner text: the key works, is invalid, or Jev cannot be reached. */
    'jev.test': async () => {
      const result = await runtime.test({ language });
      if (result.ok) return { ok: true, state: 'valid', message: language === 'en' ? 'The Jev key works and Jev is reachable' : JEV_KEY_WORKS, model: result.model, usage: result.usage };
      return { ok: false, state: result.reason, message: result.message };
    },
    /** What Jev used (tokens and calls, today and in total, per experiment), the last failure, and the settings. */
    'jev.usage': async () => ({ settings: publicJevSettings(await readJevSettings()), usage: await jevUsage().summary(), failure: runtime.lastFailure() }),
  };
}
