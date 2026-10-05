import { ui } from '../i18n.js';
import { contractOf } from './task-model.js';
import { isLiveStatus } from '../../lib/job-contract.js';

/* Where 打开结果 leads, for the console's header and for the compact card: read from the job's contract (the references to what it made) and carried out by
   the app's own navigation (`app` is the controller of ui/app/app-context.js, or anything shaped like its learn / drafts / intents / data). One place, so a
   job opens the same thing from wherever it is shown. Null when there is nothing to open (yet). */
export function resultOpener(job, app) {
  const contract = contractOf(job), refs = contract.result.refs, data = app?.data;
  // A source that has since been deleted is not offered (an archived task outlives what it made); without a list of sources nothing is checked.
  const known = Array.isArray(data?.sources) ? new Set(data.sources.map((source) => source.id)) : null;
  const sourceIds = refs.filter((ref) => ref.kind === 'source' && (!known || known.has(ref.id))).map((ref) => ref.id);
  if (sourceIds.length && app?.learn?.openAudioSources) return { label: ui('打开资料'), run: () => app.learn.openAudioSources(sourceIds) };
  const deck = refs.find((ref) => ref.kind === 'deck');
  if (deck && app?.intents?.openDeck && data?.decks?.some((item) => item.id === deck.id)) return { label: ui('打开题组'), run: () => app.intents.openDeck(deck.id) };
  const draft = refs.find((ref) => ref.kind === 'draft'), found = draft && data?.drafts?.find((item) => item.id === draft.id);
  if (found && app?.drafts?.openDraft && !isLiveStatus(contract.status)) return { label: ui('打开草稿'), run: () => app.drafts.openDraft(found, { navigation: true }) };
  return null;
}

/* Where 在资料中查看 of a part of a question run leads (资料部分): to the first of the sources the part was written from that is still in the library, by the
   same handler 打开结果 uses for a transcript or a conversion (learn.openAudioSources opens the reader on one source). `part` is a partList entry of the job contract
   (sourceIds, sourceCount, range). Null when the app has no such navigation; otherwise { label, available, count, firstId?, reason?, run }: unavailable when the part has
   no recorded sources (an older run) or every one of them has since been deleted, with the reason to show beside the disabled button. */
export function partOpener(part, app) {
  const open = app?.learn?.openAudioSources;
  if (typeof open !== 'function') return null;
  const ids = Array.isArray(part?.sourceIds) ? part.sourceIds : [], library = app?.data?.sources;
  const firstId = Array.isArray(library) ? ids.find((id) => library.some((source) => source.id === id)) : ids[0];
  const base = { label: ui('在资料中查看'), count: Math.max(ids.length, Number(part?.sourceCount) || 0) };
  if (!ids.length) return { ...base, available: false, reason: ui('这次运行没有记录用到的资料。'), run: () => {} };
  if (firstId === undefined) return { ...base, available: false, reason: ui('这些资料已被删除，无法查看。'), run: () => {} };
  return { ...base, available: true, firstId, run: () => open([firstId]) };
}
