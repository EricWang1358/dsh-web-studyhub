import { useDraftShortfall } from '../coverage/use-shortfall.js';
import { canPublishAtOnce } from '../draft-publish.js';
import { partTargets } from '../DraftPart.jsx';
import { hasOwnDeck } from '../study-map/home-plan.js';
import { firstRunDraft, firstRunLine } from './line.js';

/**
 * firstRunLine for the snapshot, with the one fact that needs the draft's coverage: may its draft be published at once (canPublishAtOnce, the same test as the
 * run's card, ui/study-map/JobCard.jsx)? Until the coverage has arrived the answer is no, and the third step says 检查草稿. Asks for nothing once there is a deck of
 * the learner's own.
 */
export function useFirstRunLine(data) {
  const draft = data && !hasOwnDeck(data) ? firstRunDraft(data) : null;
  const { shortfall } = useDraftShortfall(draft, data, { enabled: !!draft });
  const publishAtOnce = !!draft && canPublishAtOnce({ draft, shortfall, jobs: data?.jobs || [], targets: partTargets(draft, data) });
  return firstRunLine(data, { publishAtOnce, shortfallAction: shortfall?.action ?? null });
}
