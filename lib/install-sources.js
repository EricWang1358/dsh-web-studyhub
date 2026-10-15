/* Where a one-click install downloads from: two profiles a student can understand, not one mirror per component.
   国内镜像 (mainland, 国内直连): the Tsinghua PyPI mirror for the programs, npmmirror for Python itself, ModelScope (魔搭) for the models.
   海外官方源 (global, 需海外网络): pypi.org, GitHub (uv's default for Python) and Hugging Face.
   "Auto" asks each group's hosts once (unauthenticated HEAD requests to public pages, only while the card plans an install; no token is
   involved) and leans to the mainland profile. There is no failover inside a run: uv uses the first index only, so a second network failure
   in a row offers the other profile instead. */

export const SOURCES = Object.freeze({
  mainland: Object.freeze({
    id: 'mainland', reach: 'mainland',
    uvIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple/uv/',
    packageIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    pythonMirror: 'https://registry.npmmirror.com/-/binary/python-build-standalone/',
    modelSource: 'modelscope',
    hosts: Object.freeze(['pypi.tuna.tsinghua.edu.cn', 'registry.npmmirror.com', 'modelscope.cn']),
    probes: Object.freeze(['https://pypi.tuna.tsinghua.edu.cn/simple/uv/', 'https://registry.npmmirror.com/-/binary/python-build-standalone/', 'https://www.modelscope.cn/']),
  }),
  global: Object.freeze({
    id: 'global', reach: 'overseas',
    uvIndex: 'https://pypi.org/simple/uv/',
    packageIndex: 'https://pypi.org/simple',
    pythonMirror: '',
    modelSource: 'huggingface',
    hosts: Object.freeze(['pypi.org', 'github.com', 'huggingface.co']),
    probes: Object.freeze(['https://pypi.org/simple/uv/', 'https://github.com/', 'https://huggingface.co/']),
  }),
});

export const SOURCE_IDS = Object.freeze(Object.keys(SOURCES));
export const PROBE = Object.freeze({ timeoutMs: 3000, tieMs: 300, cacheMs: 10 * 60_000 });
export const otherSource = id => (id === 'mainland' ? 'global' : 'mainland');

async function probeOne(url, { fetch, signal, timeoutMs }) {
  const began = Date.now(), stop = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: signal ? AbortSignal.any([signal, stop]) : stop });
    // Any answer from the host counts as reachable (a mirror may refuse HEAD with 403/405); only no answer is "unreachable".
    return { url, ok: response.status > 0 && response.status < 500, ms: Date.now() - began };
  } catch { return { url, ok: false, ms: Date.now() - began }; }
}

/** Ask every probe of both profiles at once (each at most PROBE.timeoutMs). Resolves { mainland: [{ url, ok, ms }], global: [...] }. Never throws. */
export async function probeSources({ fetch = globalThis.fetch, signal, timeoutMs = PROBE.timeoutMs, sources = SOURCES } = {}) {
  const ask = urls => Promise.all(urls.map(url => probeOne(url, { fetch, signal, timeoutMs })));
  const [mainland, global] = await Promise.all([ask(sources.mainland.probes), ask(sources.global.probes)]);
  return { mainland, global };
}

/**
 * The profile from the probes: an overseas host that does not answer -> mainland ('overseas-unreachable'); else a mainland host that does not
 * answer -> global ('mainland-unreachable'); else the group whose slowest answer came first, a tie within PROBE.tieMs going to mainland ('faster').
 */
export function chooseSource(probes) {
  const slowest = list => Math.max(0, ...list.map(item => item.ms));
  if (probes.global.some(item => !item.ok)) return { id: 'mainland', reason: 'overseas-unreachable' };
  if (probes.mainland.some(item => !item.ok)) return { id: 'global', reason: 'mainland-unreachable' };
  return slowest(probes.global) + PROBE.tieMs < slowest(probes.mainland) ? { id: 'global', reason: 'faster' } : { id: 'mainland', reason: 'faster' };
}

let remembered = null;
/**
 * The source an install uses: the learner's choice as it is (nothing asked), else the probes' choice, remembered for PROBE.cacheMs in this process.
 * Resolves { id, chosenBy: 'learner' | 'auto', reason, hosts }.
 */
export async function resolveSource(asked, { probe, fetch, now = Date.now, remember = true } = {}) {
  if (SOURCE_IDS.includes(asked)) return { id: asked, chosenBy: 'learner', reason: 'learner', hosts: [...SOURCES[asked].hosts] };
  const ask = async () => chooseSource(await (probe ? probe() : probeSources(fetch ? { fetch } : {})));
  let choice;
  if (!remember) choice = await ask();
  else {
    if (!remembered || now() - remembered.at > PROBE.cacheMs) remembered = { at: now(), choice: await ask() };
    choice = remembered.choice;
  }
  return { id: choice.id, chosenBy: 'auto', reason: choice.reason, hosts: [...SOURCES[choice.id].hosts] };
}
export const forgetSourceChoice = () => { remembered = null; };
