import { readRetrievalSettings, saveRetrievalSettings } from '../../retrieval-settings.js';
import { RetrievalError, describeProviders, narrowSources, retrieveFromPort } from '../../retrieval.js';
import { MAX_SELECTED_CHARS } from '../../batch.js';
import { RETRIEVE_ABOVE_CHARS } from '../../large-documents.js';
import { INDEX_TOOLS, MODEL_DOWNLOAD_MB, canIngest, contentHash, readManifest } from '../../retrieval-index.js';
import { sourcesWithCourses } from '../../source-courses.js';
import { createIndexPlanner } from './retrieval/index-plan.js';
import { createIndexRuns } from './retrieval/index-runs.js';

/* Retrieval for generation (WP28). The provider choice and the host port
   (ports.retrieval, from the host that serves this library) are the only inputs;
   without a port or without a choice everything stays as it was. */

export { RETRIEVE_ABOVE_CHARS };
/** The text sent after narrowing (two author chunks). */
export const RETRIEVAL_BUDGET_CHARS = 120_000;
const RETRIEVE_TIMEOUT_MS = 30_000;

const charsOf = sources => sources.reduce((sum, source) => sum + String(source.text ?? '').length, 0);
const clip = (value, length) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > length ? `${text.slice(0, length)}…` : text; };
const tooLarge = (chars, limit = MAX_SELECTED_CHARS) => Object.assign(new Error(`Selected sources total ${chars} characters; the limit is ${limit}. Select fewer sources.`), { code: 'selection-too-large' });

/**
 * Decide what a generation request sends. Returns { sources, retrieval? }.
 * - small selection, or `request.retrieval === false`: unchanged;
 * - large selection and a chosen provider and a topic (`request.focus`):
 *   the best pages for the topic, in reading order; `retrieval` says which;
 * - over the limit and no way to narrow it: rejects with a code the page turns into advice
 *   (selection-too-large, retrieval-needs-topic, retrieval-empty, or the provider's own failure).
 * A provider that fails on a selection that still fits is not fatal: the selection is sent
 * unchanged and `retrieval.error` records why.
 */
export async function narrowSelection({ port, sources, request = {}, limit = MAX_SELECTED_CHARS, above = RETRIEVE_ABOVE_CHARS }) {
  const chars = charsOf(sources), over = chars > limit;
  const wanted = request.retrieval === true || chars > above;
  if (request.retrieval === false || !wanted) { if (over) throw tooLarge(chars, limit); return { sources }; }
  const settings = await readRetrievalSettings().catch(() => ({ provider: 'builtin' }));
  if (!port || settings.provider === 'builtin') { if (over) throw tooLarge(chars, limit); return { sources }; }
  const query = String(request.focus ?? '').trim();
  if (!query) {
    if (over) throw new RetrievalError('retrieval-needs-topic', `所选资料有 ${chars.toLocaleString('en-US')} 个字符，超过一次能处理的上限。请在「这次想练什么？」写下主题，StudyHub 会用检索挑出相关页面；也可以按章节缩小选择。`);
    return { sources };
  }
  try {
    const result = await retrieveFromPort(port, settings, { query, sources, course: request.course, limit: 40, signal: AbortSignal.timeout(RETRIEVE_TIMEOUT_MS) });
    if (!result) { if (over) throw tooLarge(chars, limit); return { sources }; }
    if (!result.passages.length) {
      if (over) throw new RetrievalError('retrieval-empty', '检索没有找到与这个主题相关的页面。换个说法再试，或按章节缩小选择。');
      return { sources, retrieval: { provider: result.provider, query, selected: sources.length, used: [], error: '没有检索到相关页面' } };
    }
    const narrowed = narrowSources(sources, result.passages, { budgetChars: RETRIEVAL_BUDGET_CHARS });
    return { sources: narrowed.sources, retrieval: { provider: result.provider, query, selected: sources.length, used: narrowed.pages,
      truncated: narrowed.truncated, unresolved: result.unresolved, chars: narrowed.chars } };
  } catch (error) {
    if (over || error?.code === 'selection-too-large' || error?.code === 'retrieval-needs-topic' || error?.code === 'retrieval-empty') throw error;
    return { sources, retrieval: { provider: settings.provider, query, selected: sources.length, used: [], error: String(error?.message || error).slice(0, 300) } };
  }
}

/** retrieval.status / .set / .test / .preview / .index.* over the host port of `ports`. */
export function createRetrievalHandlers(ports) {
  const port = () => ports.retrieval;
  const detected = () => describeProviders({ tools: port()?.tools?.() ?? [], service: port()?.service?.() });
  const COMPANION = `mcp:${INDEX_TOOLS.query}`;
  const canIndex = () => canIngest(port());
  // The search-index build is served by the runtime or by the original background run: the one reader of the switch is ../retrieval/index-runs.js.
  const indexRuns = () => createIndexRuns(ports);
  const status = async () => {
    let settings = await readRetrievalSettings();
    const found = detected();
    // The search extension, once it holds an index, is the provider unless the learner chose another one.
    if (!settings.explicit && settings.provider === 'builtin' && found.providers.some(provider => provider.id === COMPANION)
        && Object.keys((await readManifest(ports.state.root)).sources).length) settings = await saveRetrievalSettings({ ...settings, provider: COMPANION });
    const known = settings.provider === 'builtin' || found.providers.some(provider => provider.id === settings.provider)
      || found.otherTools.some(tool => `mcp:${tool.name}` === settings.provider);
    return { selected: settings.provider, effective: known ? settings.provider : 'builtin', ...(known ? {} : { missing: settings.provider }),
      ...(settings.queryArg ? { queryArg: settings.queryArg } : {}), ...(settings.limitArg ? { limitArg: settings.limitArg } : {}),
      ...(settings.hfEndpoint ? { hfEndpoint: settings.hfEndpoint } : {}), explicit: settings.explicit === true,
      companion: { id: COMPANION, running: found.providers.some(provider => provider.id === COMPANION) || canIndex() },
      hostCanSearch: found.providers.length > 0 || found.otherTools.length > 0, providers: found.providers, otherTools: found.otherTools,
      limits: { retrieveAboveChars: RETRIEVE_ABOVE_CHARS, maxSelectedChars: MAX_SELECTED_CHARS } };
  };
  const library = async (storage, ids) => {
    const wanted = Array.isArray(ids) ? new Set(ids.filter(id => typeof id === 'string')) : null;
    return (await storage.read()).sources.filter(source => !wanted || wanted.has(source.id));
  };
  const ask = async (settings, sources, query, { course, limit }) => {
    const result = await retrieveFromPort(port(), settings, { query, sources, course, limit, signal: AbortSignal.timeout(RETRIEVE_TIMEOUT_MS) });
    if (!result) return null;
    const narrowed = narrowSources(sources, result.passages, { budgetChars: RETRIEVAL_BUDGET_CHARS });
    const text = new Map(result.passages.map(passage => [passage.sourceId, passage.text]));
    const bySource = new Map(sources.map(source => [source.id, source]));
    return { provider: result.provider, query, hits: result.hits, unresolved: result.unresolved, truncated: narrowed.truncated, chars: narrowed.chars,
      pages: narrowed.pages.map(page => ({ ...page, snippet: clip(text.get(page.sourceId) || bySource.get(page.sourceId)?.text, 160) })) };
  };
  return {
    'retrieval.status': status,
    'retrieval.set': async a => {
      const found = detected(), choice = a?.provider;
      const ok = choice === 'builtin' || found.providers.some(provider => provider.id === choice) || found.otherTools.some(tool => `mcp:${tool.name}` === choice);
      if (!ok) throw new RetrievalError('retrieval-missing', `${typeof choice === 'string' ? choice.replace(/^mcp:/, '') : '这个检索工具'} 现在找不到。请确认它在 DSH 里已启用后再选。`);
      await saveRetrievalSettings({ provider: choice, queryArg: a.queryArg, limitArg: a.limitArg, explicit: true, hfEndpoint: (await readRetrievalSettings()).hfEndpoint });
      return status();
    },
    'retrieval.preview': async a => {
      const settings = await readRetrievalSettings();
      if (settings.provider === 'builtin' || !port()) return { provider: 'builtin', pages: [], unresolved: 0, hits: 0 };
      const query = String(a?.query ?? '').trim();
      if (!query) throw new Error('请先写下要检索的主题');
      const limit = Math.max(1, Math.min(50, Math.trunc(Number(a.limit)) || 20));
      return await ask(settings, await library(ports.state, a.sourceIds), query, { course: typeof a.course === 'string' ? a.course : undefined, limit })
        ?? { provider: 'builtin', pages: [], unresolved: 0, hits: 0 };
    },
    'retrieval.endpoint.set': async a => {
      // Where the search extension downloads its embedding model from (read when DSH starts it).
      const current = await readRetrievalSettings(), value = typeof a?.endpoint === 'string' ? a.endpoint.trim() : '';
      await saveRetrievalSettings({ ...current, hfEndpoint: value });
      return status();
    },
    'retrieval.index.plan': async a => {
      const { picked, plan, firstRun } = await createIndexPlanner(ports).prepare(a.course);
      return { course: a.course ?? '*', pages: picked.length, toIndex: plan.add.length, unchanged: plan.unchanged, toRemove: plan.remove.length,
        chars: plan.add.reduce((sum, source) => sum + String(source.text ?? '').length, 0), firstRun, modelMb: MODEL_DOWNLOAD_MB, canIndex: canIndex() };
    },
    /* Per source id: is its page in the index (and still the text that was indexed), indexed before but edited since (stale), or not indexed.
       Every material row says so, and the picker of 创建题组 too. Only pages that have an index entry are hashed, so an unbuilt library costs nothing. */
    'retrieval.index.coverage': async () => {
      const root = ports.state.root, state = await ports.state.read(), entries = (await readManifest(root)).sources || {};
      const result = { indexed: [], stale: [], missing: [], hasIndex: Object.keys(entries).length > 0, canIndex: canIndex(),
        building: await indexRuns().building() };
      for (const source of sourcesWithCourses(state)) {
        const entry = entries[source.id];
        if (!entry) result.missing.push(source.id);
        else if (entry.hash === contentHash(source.text)) result.indexed.push(source.id);
        else result.stale.push(source.id);
      }
      return result;
    },
    'retrieval.index.start': a => indexRuns().start(a),
    'retrieval.index.status': () => indexRuns().status(),
    'retrieval.index.cancel': () => indexRuns().cancel(),
    'retrieval.test': async a => {
      const settings = await readRetrievalSettings();
      if (settings.provider === 'builtin' || !port()) return { ok: false, reason: 'builtin' };
      try {
        const sources = (await library(ports.state)).slice(0, 400);
        const query = typeof a?.query === 'string' && a.query.trim() ? a.query.trim() : '概念 定义 原理';
        const result = await ask(settings, sources, query, { limit: 10 });
        return { ok: true, provider: settings.provider, hits: result.hits, matched: result.pages.length, unresolved: result.unresolved, sample: result.pages.slice(0, 3) };
      } catch (error) { return { ok: false, provider: settings.provider, message: String(error?.message || error).slice(0, 300) }; }
    },
  };
}
