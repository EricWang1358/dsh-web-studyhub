import { ui } from '../i18n.js';
import { contractOf } from './task-model.js';
import { isLiveStatus } from '../../lib/job-contract.js';

/* Where 打开结果 leads, for the console's header and for the compact card: read from the job's contract (the references to what it made) and carried out by
   the app's own navigation (`app` is the controller of ui/app/app-context.js, or anything shaped like its learn / drafts / intents / data). One place, so a
   job opens the same thing from wherever it is shown. Null when there is nothing to open (yet). */
export function resultOpener(job, app) {
  const contract = contractOf(job), refs = contract.result.refs, data = app?.data;
  const sourceIds = refs.filter((ref) => ref.kind === 'source').map((ref) => ref.id);
  if (sourceIds.length && app?.learn?.openAudioSources) return { label: ui('打开资料'), run: () => app.learn.openAudioSources(sourceIds) };
  const deck = refs.find((ref) => ref.kind === 'deck');
  if (deck && app?.intents?.openDeck && data?.decks?.some((item) => item.id === deck.id)) return { label: ui('打开题组'), run: () => app.intents.openDeck(deck.id) };
  const draft = refs.find((ref) => ref.kind === 'draft'), found = draft && data?.drafts?.find((item) => item.id === draft.id);
  if (found && app?.drafts?.openDraft && !isLiveStatus(contract.status)) return { label: ui('打开草稿'), run: () => app.drafts.openDraft(found, { navigation: true }) };
  return null;
}
