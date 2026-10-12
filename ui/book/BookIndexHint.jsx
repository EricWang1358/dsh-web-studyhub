import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useStudy } from '../study-context.jsx';
import { formatNumber } from '../format.js';
import { openIndexBuilder } from '../index-focus.js';
import { courseScopeLine, indexGoTip } from '../index-scope.js';
import css from './book-index-hint.css';

/* One quiet line on the 复习全书 when the course's search index is not ready (docs/review-book.md): not built, some pages missing, or a build going.
   With the index, 弄懂 / 加一段 and the main chat's book tools find the relevant pages first (book.search). The link is the shortcut of the material
   badges (ui/index-focus.js: 设置 › 检索扩展 with the course chosen; 去安装检索扩展 without the extension); nothing starts from the click. The line is one
   line at every width (a shorter text in a narrow window) and its slot can be reserved before the answer arrives, so it never moves the page. */

/** The words of a state: { full, short, link? } (link: the shortcut's label; none while a build is going), or null when there is nothing to say. */
export function hintWords(state) {
  if (!state || state.kind === 'ready') return null;
  const install = state.canIndex === false ? ui('去安装检索扩展') : null;
  if (state.kind === 'building') {
    const text = uiFormat('正在建立索引 {0}/{1} 页', [formatNumber(state.done), formatNumber(state.total)]);
    return { full: text, short: text };
  }
  if (state.kind === 'partial') {
    return { full: uiFormat('索引还差 {0} 页（新加的资料）', [formatNumber(state.missing)]), short: uiFormat('索引还差 {0} 页', [formatNumber(state.missing)]), link: install || ui('去补建') };
  }
  return { full: ui('这门课的资料还没建索引。建好后，弄懂、加一段和主会话改书都会先找到相关的页，覆盖率也更高'), short: ui('这门课的资料还没建索引'),
    link: install || ui('去建立索引') };
}

/** The hover: where the index is built and what it costs (the settings' own sentence), which pages are missing (the course line of 检索扩展), where the link goes. */
export function hintTip(state, plan, course) {
  if (!state || state.kind === 'ready') return '';
  const lines = [ui('在本机把还没编目录的页编好，不调用 AI，不花 token。')];
  const scope = state.kind === 'building' ? '' : courseScopeLine(plan, course);
  if (scope) lines.push(scope);
  if (state.kind !== 'building') lines.push(indexGoTip(state.canIndex));
  return lines.join('\n');
}

/**
 * Props: state (book-index.js bookIndexState; null while unknown), plan (retrieval.index.plan), course, reserve (keep an empty line while unknown or once
 * shown: the page was drawn before the answer, so the line keeps its room), variant: 'line' (the book page) | 'muted' (the 弄懂 panel: no slot, no link wrap).
 */
export default function BookIndexHint({ state, plan, course, reserve = false, variant = 'line' }) {
  useInjectCss(css, 'study-book-index-hint');
  const { openSettings } = useStudy();
  const words = hintWords(state);
  if (!words) return reserve ? <p className="book-index-hint book-index-hint--slot" aria-hidden="true" data-book-index="slot" /> : null;
  return (
    <p className={`book-index-hint book-index-hint--${variant}`} role="status" data-book-index={state.kind}>
      <Tooltip layer anchorClassName="book-index-hint__tip" content={hintTip(state, plan, course)}>
        <span className="book-index-hint__text" tabIndex={0}>
          <span className="book-index-hint__full">{words.full}</span><span className="book-index-hint__short">{words.short}</span>
        </span>
      </Tooltip>
      {words.link && openSettings && <>
        <span className="book-index-hint__dot" aria-hidden="true">·</span>
        <Button variant="link" size="sm" className="book-index-hint__go" data-book-index-go onClick={() => openIndexBuilder(openSettings, course ?? '')}>{words.link}</Button>
      </>}
    </p>
  );
}
