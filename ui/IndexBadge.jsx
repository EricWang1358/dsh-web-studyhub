import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { Badge, Button, Icon, Spinner, Tooltip } from './components/index.js';
import { formatNumber } from './format.js';
import { indexGoLabel, indexGoTip, indexTip, NEEDS_INDEX } from './index-scope.js';

/* One quiet badge on a material row: whether its search index is built (资料 page and the picker of 创建题组). The index is what lets a big book be asked about
   and turned into questions page by page; the row says where it stands, so nobody has to open the settings to find out. It counts THIS document's pages
   (the course's pages are the course line's business, ui/index-scope.js), and its hover says so. */

/** The words for a state ({ state, indexed, stale, total } from documentIndexState) given the coverage the backend reported. */
export function indexLabel(info, coverage = {}) {
  const pages = (value) => formatNumber(value);
  switch (info?.state) {
    case 'indexed': return uiFormat('索引已建好 · 这份资料 {0}/{1} 页', [pages(info.indexed ?? info.total), pages(info.total)]);
    case 'partial': return uiFormat('索引建了一部分 · 这份资料 {0}/{1} 页', [pages(info.indexed), pages(info.total)]);
    case 'stale': return uiFormat('索引需要更新 · 这份资料有 {0} 页改过', [pages(info.stale)]);
    case 'building': return ui('正在建立索引…');
    case 'missing': return coverage?.canIndex === false ? ui('还没建索引（需要先安装检索扩展）') : ui('还没建索引');
    default: return '';
  }
}

/** The same without the scope word, for a narrow window (the hover still says whose pages these are); the states that name no pages have only the one label. */
export function indexShortLabel(info, coverage = {}) {
  const pages = (value) => formatNumber(value);
  switch (info?.state) {
    case 'indexed': return uiFormat('索引已建好 · {0}/{1} 页', [pages(info.indexed ?? info.total), pages(info.total)]);
    case 'partial': return uiFormat('索引建了一部分 · {0}/{1} 页', [pages(info.indexed), pages(info.total)]);
    case 'stale': return uiFormat('索引需要更新 · {0} 页改过', [pages(info.stale)]);
    default: return indexLabel(info, coverage);
  }
}

/** Tone and mark per state: the words always say it, the icon and colour back them up. */
const LOOK = { indexed: ['success', 'check'], partial: ['warning', 'warning'], stale: ['warning', 'refresh'], building: ['info', null], missing: ['neutral', null] };

/** The quiet text button after the badge. A row puts the badge inside a button or a label, so this is a role="button" span that takes its own click and keys and lets neither reach the row. */
function GoAction({ label, onGo }) {
  const take = (event) => { event.preventDefault(); event.stopPropagation(); onGo(); };
  return <span role="button" tabIndex={0} className="index-badge__go" data-index-action onClick={take}
    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') take(event); }}>{label}</span>;
}

/**
 * Props: info (documentIndexState), coverage ({ canIndex }), onIndex (optional: the click that goes to 设置 › 检索扩展 to build the index; ui/index-focus.js).
 * With onIndex, a document whose index is partial, stale or missing gets 「建立索引」 after the badge (「安装扩展」 when the extension is not installed), and the hover says where it goes.
 */
export default function IndexBadge({ info, coverage, onIndex }) {
  if (!info) return null;
  const label = indexLabel(info, coverage), short = indexShortLabel(info, coverage);
  const [tone, icon] = LOOK[info.state] || LOOK.missing;
  const actionable = !!onIndex && NEEDS_INDEX.has(info.state);
  // Beside the action the mark is wrapped, so a narrow row can drop it (the words say the state) to make room for the action.
  const mark = info.state === 'building' ? <Spinner size="sm" /> : !icon ? undefined : actionable ? <span className="index-badge__mark"><Icon name={icon} size={12} /></span> : icon;
  const badge = <Badge className="index-badge" size="sm" tone={tone} icon={mark} data-state={info.state} tabIndex={0}>
    {short === label ? label : <><span className="index-badge__full">{label}</span><span className="index-badge__short">{short}</span></>}
  </Badge>;
  if (!actionable) return <Tooltip layer content={indexTip(info).join('\n')}>{badge}</Tooltip>;
  return <Tooltip layer anchorClassName="index-badge-line" content={[...indexTip(info), indexGoTip(coverage?.canIndex)].join('\n')}>
    <span className="index-badge-line__inner">{badge}<GoAction label={indexGoLabel(coverage?.canIndex)} onGo={onIndex} /></span>
  </Tooltip>;
}

/** One quiet line above a list of materials when some of them are not fully indexed: 「有 N 份资料的索引还没建完 · 去建立索引」 (the link says 安装 when the extension is not installed). */
export function IndexGapLine({ count, canIndex, onGo }) {
  if (!count || !onGo) return null;
  return <p className="index-gap" role="status" data-index-gap>
    <span>{uiFormat('有 {0} 份资料的索引还没建完', [formatNumber(count)])}</span>
    <span aria-hidden="true"> · </span>
    <Button variant="link" size="sm" onClick={onGo}>{canIndex === false ? ui('去安装检索扩展') : ui('去建立索引')}</Button>
  </p>;
}
