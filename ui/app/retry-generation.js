import { ui, uiFormat, uiIsEnglish } from '../i18n.js';
import { kindsOfLegacyKind } from '../../lib/generation-settings.js';
import { isLevel } from '../../lib/coverage-strength.js';
import { formatList } from '../format.js';
import { kindsPatch } from '../generate-form.js';

/* 按原资料重新设置: a failed generation job puts its own request back on the 创建题组 form. The form is reset the moment a job starts
   (ui/generation-status.js freshGeneration), so everything comes from the job: its sources, kinds and coverage level are on the card, the
   rest of what was asked (`job.asked`: focus, difficulty, language, formula notation, the typed number of questions) is echoed there by the
   generation operation. A job from before that echo (or a case paper, whose kinds are not a list of basic kinds) comes back without the
   parts it never recorded, and the notice says which, so nothing is claimed that was not put back. The learner still presses 生成. */

/**
 * @param job a failed or stopped generation job (the snapshot's view of it)
 * @returns { patch, lost } `patch` is merged into the form (`gen`); `lost` names, in words, what the job did not record.
 */
export function retryForm(job) {
  const asked = job?.asked && typeof job.asked === 'object' ? job.asked : null;
  const patch = { course: undefined }, lost = [];
  const kinds = Array.isArray(job?.kinds) && job.kinds.length ? job.kinds : kindsOfLegacyKind(job?.kind);
  if (kinds) Object.assign(patch, kindsPatch([...kinds]));
  else lost.push(ui('题型'));
  const level = isLevel(asked?.coverageLevel) ? asked.coverageLevel : isLevel(job?.coveragePlan?.level) ? job.coveragePlan.level : null;
  if (level) patch.coverageLevel = level;
  if (asked) {
    // The number the learner typed; a request that only named a level has none, and the level plans the questions again.
    patch.customCount = Number.isInteger(asked.count) ? String(asked.count) : '';
    if (typeof asked.focus === 'string') patch.focus = asked.focus;
    if (typeof asked.difficulty === 'string' && asked.difficulty) patch.difficulty = asked.difficulty;
    if (typeof asked.language === 'string' && asked.language) patch.language = asked.language;
    if (typeof asked.notation === 'string' && asked.notation) patch.notation = asked.notation;
  } else {
    lost.push(ui('侧重点'), ui('难度'), ui('自定义题数'));
  }
  if (typeof job?.deckTitle === 'string' && job.deckTitle.trim() && !job.continued) patch.title = job.deckTitle;
  return { patch, lost };
}

/** What the notice says after 按原资料重新设置: what was put back, what was not recorded, and sources that are no longer in the library (`gone`: how many of the job's source ids). */
export function retryNotice({ lost = [], gone = 0 } = {}) {
  const said = lost.length
    ? uiFormat('已带回可用资料和上次的设置；{0}当时没有记录，请重新选。', [formatList(lost)])
    : ui('已带回可用资料、题型、题数、覆盖强度、侧重点和难度；请核对后再生成。');
  return gone > 0 ? `${said}${uiIsEnglish() ? ' ' : ''}${ui('另有资料已不在资料库里，没有带回。')}` : said;
}
