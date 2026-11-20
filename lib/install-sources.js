/* Where a one-click install downloads from: two profiles a student can understand, not one mirror per component.
   国内镜像 (mainland, 国内直连): the Tsinghua PyPI mirror for the programs, npmmirror for Python itself, ModelScope (魔搭) for the models.
   海外官方源 (global, 需海外网络): pypi.org, GitHub (uv's default for Python) and Hugging Face.
   "Auto" asks each group's hosts once (unauthenticated HEAD requests to public pages, only while the card plans an install; no token is
   involved) and leans to the mainland profile. There is no failover inside a run: uv uses the first index only, so a second network failure
   in a row offers the other profile instead. */

import { hostFetch } from './http.js';

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

async function probeOne(url, { httpFetch, signal, timeoutMs }) {
  const began = Date.now(), stop = AbortSignal.timeout(timeoutMs);
  try {
    const response = await httpFetch(url, { method: 'HEAD', redirect: 'follow', signal: signal ? AbortSignal.any([signal, stop]) : stop });
    // Any answer from the host counts as reachable (a mirror may refuse HEAD with 403/405); only no answer is "unreachable".
    return { url, ok: response.status > 0 && response.status < 500, ms: Date.now() - began };
  } catch { return { url, ok: false, ms: Date.now() - began }; }
}

/** Ask every probe of both profiles at once (each at most PROBE.timeoutMs). Resolves { mainland: [{ url, ok, ms }], global: [...] }. Never throws. */
export async function probeSources({ httpFetch, fetch: rawFetch, signal, timeoutMs = PROBE.timeoutMs, sources = SOURCES } = {}) {
  const transport = httpFetch ?? rawFetch ?? hostFetch;
  const ask = urls => Promise.all(urls.map(url => probeOne(url, { httpFetch: transport, signal, timeoutMs })));
  const [mainland, global] = await Promise.all([ask(sources.mainland.probes), ask(sources.global.probes)]);
  return { mainland, global };
}

/**
 * Preferred profile for tie-breaking when both mainland and overseas hosts answer within PROBE.tieMs:
 * explicit `prefer` ('global' | 'mainland') wins; otherwise a non-Chinese `language` hint (e.g. 'en', 'en-US')
 * prefers 'global' so overseas learners are not routed to mainland mirrors on ties; 0-option calls keep 'mainland'.
 */
export function preferredSource({ prefer, language } = {}) {
  if (SOURCE_IDS.includes(prefer)) return prefer;
  if (typeof language === 'string' && language.trim()) {
    return /^zh\b/i.test(language.trim()) ? 'mainland' : 'global';
  }
  return 'mainland';
}

/**
 * The profile from the probes: an unreachable group yields to the reachable one; when both answer, the faster
 * group wins, with ties within PROBE.tieMs resolved toward `preferredSource(options)` ('mainland' by default,
 * 'global' when `prefer: 'global'` or a non-zh `language` is supplied).
 */
export function chooseSource(probes, options = {}) {
  const slowest = list => Math.max(0, ...list.map(item => item.ms));
  const prefer = preferredSource(options);
  if (prefer === 'global') {
    if (probes.mainland.some(item => !item.ok)) return { id: 'global', reason: 'mainland-unreachable' };
    if (probes.global.some(item => !item.ok)) return { id: 'mainland', reason: 'overseas-unreachable' };
    return slowest(probes.mainland) + PROBE.tieMs < slowest(probes.global) ? { id: 'mainland', reason: 'faster' } : { id: 'global', reason: 'faster' };
  }
  if (probes.global.some(item => !item.ok)) return { id: 'mainland', reason: 'overseas-unreachable' };
  if (probes.mainland.some(item => !item.ok)) return { id: 'global', reason: 'mainland-unreachable' };
  return slowest(probes.global) + PROBE.tieMs < slowest(probes.mainland) ? { id: 'global', reason: 'faster' } : { id: 'mainland', reason: 'faster' };
}

let remembered = null;
/**
 * The source an install uses: the learner's choice as it is (nothing asked), else the probes' choice, remembered for PROBE.cacheMs in this process.
 * Resolves { id, chosenBy: 'learner' | 'auto', reason, hosts }.
 */
export async function resolveSource(asked, { probe, httpFetch, fetch: rawFetch, now = Date.now, remember = true, prefer, language } = {}) {
  const transport = httpFetch ?? rawFetch;
  if (SOURCE_IDS.includes(asked)) return { id: asked, chosenBy: 'learner', reason: 'learner', hosts: [...SOURCES[asked].hosts] };
  const targetPrefer = preferredSource({ prefer, language });
  const ask = async () => chooseSource(await (probe ? probe() : probeSources(transport ? { httpFetch: transport } : {})), { prefer: targetPrefer });
  let choice;
  if (!remember) choice = await ask();
  else {
    if (!remembered || remembered.prefer !== targetPrefer || now() - remembered.at > PROBE.cacheMs) {
      remembered = { at: now(), prefer: targetPrefer, choice: await ask() };
    }
    choice = remembered.choice;
  }
  return { id: choice.id, chosenBy: 'auto', reason: choice.reason, hosts: [...SOURCES[choice.id].hosts] };
}
export const forgetSourceChoice = () => { remembered = null; };
