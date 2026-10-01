import { readRetrievalSettings, saveRetrievalSettings } from '../../retrieval-settings.js';
import { RetrievalError, describeProviders, narrowSources, retrieveFromPort } from '../../retrieval.js';
import { MAX_SELECTED_CHARS } from '../../batch.js';
import { RETRIEVE_ABOVE_CHARS } from '../../large-documents.js';

/* Retrieval for generation (WP28). The provider choice and the host port
   (ports.retrieval, from the host that serves this library) are the only inputs;
   without a port or without a choice everything stays as it was. */

export { RETRIEVE_ABOVE_CHARS };
/** The text sent after narrowing (two author chunks). */
export const RETRIEVAL_BUDGET_CHARS = 120_000;
const RETRIEVE_TIMEOUT_MS = 30_000;

const charsOf = sources => sources.reduce((sum, source) => sum + String(source.text ?? '').length, 0);
const clip = (value, length) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > length ? `${text.slice(0, length)}…` : text; };
const tooLarge = chars => Object.assign(new Error(`Selected sources total ${chars} characters; the limit is ${MAX_SELECTED_CHARS}. Select fewer sources.`), { code: 'selection-too-large' });

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
export async function narrowSelection({ port, sources, request = {} }) {
  const chars = charsOf(sources), over = chars > MAX_SELECTED_CHARS;
  const wanted = request.retrieval === true || chars > RETRIEVE_ABOVE_CHARS;
  if (request.retrieval === false || !wanted) { if (over) throw tooLarge(chars); return { sources }; }
  const settings = await readRetrievalSettings().catch(() => ({ provider: 'builtin' }));
  if (!port || settings.provider === 'builtin') { if (over) throw tooLarge(chars); return { sources }; }
  const query = String(request.focus ?? '').trim();
  if (!query) {
    if (over) throw new RetrievalError('retrieval-needs-topic', `所选资料有 ${chars.toLocaleString('en-US')} 个字符，超过一次能处理的上限。请在「这次想练什么？」写下主题，StudyHub 会用检索挑出相关页面；也可以按章节缩小选择。`);
    return { sources };
  }
  try {
    const result = await retrieveFromPort(port, settings, { query, sources, course: request.course, limit: 40, signal: AbortSignal.timeout(RETRIEVE_TIMEOUT_MS) });
    if (!result) { if (over) throw tooLarge(chars); return { sources }; }
    if (!result.passages.length) {
      if (over) throw new RetrievalError('retrieval-empty', '检索没有找到与这个主题相关的页面。换个说法再试，或按章节缩小选择。');
      return { sources, retrieval: { provider: result.provider, query, selected: sources.length, used: [], error: '没有检索到相关页面，已使用你选的全部资料' } };
    }
    const narrowed = narrowSources(sources, result.passages, { budgetChars: RETRIEVAL_BUDGET_CHARS });
    return { sources: narrowed.sources, retrieval: { provider: result.provider, query, selected: sources.length, used: narrowed.pages,
      truncated: narrowed.truncated, unresolved: result.unresolved, chars: narrowed.chars } };
  } catch (error) {
    if (over || error?.code === 'selection-too-large' || error?.code === 'retrieval-needs-topic' || error?.code === 'retrieval-empty') throw error;
    return { sources, retrieval: { provider: settings.provider, query, selected: sources.length, used: [], error: String(error?.message || error).slice(0, 300) } };
  }
}

/** retrieval.status / .set / .test / .preview over the host port of `ports`. */
export function createRetrievalHandlers(ports) {
  const port = () => ports.retrieval;
  const detected = () => describeProviders({ tools: port()?.tools?.() ?? [], service: port()?.service?.() });
  const status = async () => {
    const settings = await readRetrievalSettings(), found = detected();
    const known = settings.provider === 'builtin' || found.providers.some(provider => provider.id === settings.provider)
      || found.otherTools.some(tool => `mcp:${tool.name}` === settings.provider);
    return { selected: settings.provider, effective: known ? settings.provider : 'builtin', ...(known ? {} : { missing: settings.provider }),
      ...(settings.queryArg ? { queryArg: settings.queryArg } : {}), ...(settings.limitArg ? { limitArg: settings.limitArg } : {}),
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
      await saveRetrievalSettings({ provider: choice, queryArg: a.queryArg, limitArg: a.limitArg });
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
