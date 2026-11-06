import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { Hint, Tooltip } from './components/index.js';

/* What building the search index costs and is for, in the words every place that offers it uses (the extension panel before and after the install; ui/IndexHint.jsx
   has the same facts in its hover). It runs on this computer with a local model, so it uses no model tokens and nothing leaves the computer; only the first build
   downloads the model. The remark about the default model favouring English is a hover, not a warning. */

/** Props: firstRun (the model is not on this computer yet: say it is downloaded once), modelMb (its size). */
export default function IndexNote({ firstRun = true, modelMb = 90 }) {
  const text = [ui('在这台电脑上建索引：不调用 AI、不耗 token，资料不离开电脑。建好后，整本书出题只读相关页面。'),
    firstRun ? uiFormat('首次需要下载约 {0} MB 的检索模型，只下载一次，之后可以离线使用。', [modelMb]) : ''].filter(Boolean).join(' ');
  return (
    <Tooltip layer anchorClassName="extension-panel__tip" content={ui('默认检索模型主要针对英文；中文教材也能检索（会结合关键词匹配），但语义匹配较弱。')}>
      <Hint tabIndex={0} data-index-note>{text}</Hint>
    </Tooltip>
  );
}
