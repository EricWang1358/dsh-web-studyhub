import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { Badge, Spinner } from './components/index.js';
import { formatNumber } from './format.js';

/* One quiet badge on a material row: whether its search index is built (资料 page and the picker of 创建题组). The index is what lets a big book be asked about
   and turned into questions page by page; the row says where it stands, so nobody has to open the settings to find out. */

/** The words for a state ({ state, indexed, stale, total } from documentIndexState) given the coverage the backend reported. */
export function indexLabel(info, coverage = {}) {
  const pages = (value) => formatNumber(value);
  switch (info?.state) {
    case 'indexed': return uiFormat('索引已建好 · {0} 页', [pages(info.total)]);
    case 'partial': return uiFormat('索引建了一部分 · {0} / {1} 页', [pages(info.indexed), pages(info.total)]);
    case 'stale': return uiFormat('索引需要更新 · {0} 页改过', [pages(info.stale)]);
    case 'building': return ui('正在建立索引…');
    case 'missing': return coverage?.canIndex === false ? ui('还没建索引（需要先安装检索扩展）') : ui('还没建索引');
    default: return '';
  }
}

/** Tone and mark per state: the words always say it, the icon and colour back them up. */
const LOOK = { indexed: ['success', 'check'], partial: ['warning', 'warning'], stale: ['warning', 'refresh'], building: ['info', null], missing: ['neutral', null] };

export default function IndexBadge({ info, coverage }) {
  if (!info) return null;
  const label = indexLabel(info, coverage);
  const [tone, icon] = LOOK[info.state] || LOOK.missing;
  return <Badge className="index-badge" size="sm" tone={tone} icon={info.state === 'building' ? <Spinner size="sm" /> : icon || undefined} data-state={info.state}
    title={ui('索引是按页提前编好的目录：对整本书提问或出题时，只把相关的页面发给 AI。')}>{label}</Badge>;
}
