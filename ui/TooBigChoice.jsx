import React, { useId } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, Disclosure, Hint, Icon, SegmentedControl, Tooltip } from './components/index.js';
import { formatNumber } from './format.js';
import { LARGE_DOCUMENT_LIMITS } from '../lib/large-documents.js';
import { MODES } from './too-big-choice.js';
import css from './generation-path.css';

/* 创建题组, a selection too big for one generation (or long enough to have a choice): ONE block right after the source picker. It says in a sentence why and offers the
   ways on as a choice; only the chosen way is drawn (`children`), and the old long-document card is a fold under it, never a third panel beside the others. */

const LABELS = { [MODES.path]: () => ui('分步出题'), [MODES.retrieval]: () => ui('按主题挑页面'), [MODES.single]: () => ui('一次出题') };

/** What each way does, hidden until asked: one sentence and at most one line of what follows from it. */
const EXPLAIN = {
  [MODES.path]: () => [ui('每一步是一个独立的出题任务，按顺序排队；先做完的一步就可以先练。'), ui('每一步有自己的题数，所以下面不显示「覆盖强度」。')],
  [MODES.retrieval]: () => [ui('用检索工具按「这次想练什么？」的主题挑出相关页面，只把这些页面发给 AI。'), ui('要先写主题；可以先预览会用到的页面。')],
  [MODES.single]: () => [ui('整份资料一次交给 AI 出题。'), ui('按下面的覆盖强度、难度和题数来出。')],
};

/** The words behind the "i": every way the learner can choose, so a keyboard user finds them where the choice is. */
function Explanation({ modes }) {
  return (
    <Tooltip layer placement="bottom-end" anchorClassName="too-big__info-anchor" content={<span className="too-big__tip">{modes.map(mode => {
      const [what, then] = EXPLAIN[mode]();
      return <span key={mode} className="too-big__tip-row"><strong>{LABELS[mode]()}</strong><span>{what}</span><span className="too-big__tip-then">{then}</span></span>;
    })}</span>}>
      <Button size="sm" variant="quiet" className="sh-btn--icon too-big__info" icon="info" aria-label={ui('这几种出题方式有什么不同')} />
    </Tooltip>
  );
}

/** What 「这次想练什么？」 does in each way, under the box (hidden until asked). A button of its own, not part of the label (a label may not hold another control). */
const FOCUS = {
  [MODES.path]: () => [ui('这一步没有自己的重点时，用这里写的作为默认重点。'), ui('留空就只按各步的页面出题。')],
  [MODES.retrieval]: () => [ui('StudyHub 用它去检索，挑出和主题相关的页面。'), ui('必须填写，才能生成。')],
};
export function FocusHelp({ mode }) {
  const words = FOCUS[mode]?.();
  if (!words) return null;
  return (
    <Tooltip layer placement="bottom-start" content={<span className="too-big__tip"><span>{words[0]}</span><span className="too-big__tip-then">{words[1]}</span></span>}>
      <Button size="sm" variant="link" icon="info" className="too-big__focus-help">{ui('这里写什么有什么用？')}</Button>
    </Tooltip>
  );
}

/**
 * Props: advice (generateAdvice), stats (selectionStats), modes (availableModes), mode (the one that is on, or null), onMode(mode), disabled,
 * children (the chosen way's panel), card (the long-document card, shown folded when there is no tool to search with).
 */
export default function TooBigChoice({ advice, stats = {}, modes = [], mode = null, onMode, disabled = false, children, card = null }) {
  useInjectCss(css, 'study-generation-path');
  const titleId = useId();
  const limit = formatNumber(LARGE_DOCUMENT_LIMITS.selectionChars), chars = formatNumber(advice?.chars || 0);
  const why = !advice?.tooBig ? ui('这份资料比较长：可以一次出题，也可以分步出题或按主题挑页面。')
    : stats.pages > 0 ? uiFormat('所选资料约 {0} 页、{1} 个字符，一次生成最多 {2} 个字符。', [formatNumber(stats.pages), chars, limit])
      : uiFormat('所选资料约 {0} 个字符，一次生成最多 {1} 个字符。', [chars, limit]);
  return (
    <section className="too-big" aria-labelledby={titleId} data-mode={mode || 'none'} data-tour="generate-too-big">
      <header className="too-big__head">
        <Icon name="info" size={20} className="too-big__icon" />
        <div>
          <h3 id={titleId} className="too-big__title">{advice?.tooBig ? ui('所选资料太大，一次出不完') : ui('选择出题方式')}</h3>
          <p className="muted too-big__why">{why}</p>
        </div>
        {modes.length === 1 && <Explanation modes={modes} />}
      </header>
      {modes.length > 1 && <div className="too-big__choose">
        <SegmentedControl label={ui('怎么出题')} size="sm" wrap value={mode} disabled={disabled}
          options={modes.map(value => ({ value, label: LABELS[value]() }))} onChange={onMode} />
        <Explanation modes={modes} />
      </div>}
      {children}
      {advice?.tooBig && <Hint>{ui('或者在上面少选几份/几页。')}</Hint>}
      {card && <Disclosure className="too-big__card" summary={ui('想按主题挑页面？先装检索工具')} meta={ui('转换与检索工具')}>{card}</Disclosure>}
    </section>
  );
}
