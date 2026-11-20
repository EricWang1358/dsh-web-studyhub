import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { Hint } from './components/index.js';

/* What building the search index costs and is for, in the words every place that offers it uses (the extension panel before and after the install; ui/IndexHint.jsx
   has the same facts in its hover). It runs on this computer with a local model, so it uses no model tokens and nothing leaves the computer; only the first build
   downloads the model. The English-bias / Chinese keyword-matching caveat is kept visible so Chinese learners know to include source terms. */

/** Props: firstRun (the model is not on this computer yet: say it is downloaded once), modelMb (its size). */
export default function IndexNote({ firstRun = true, modelMb = 90 }) {
  const text = [ui('在这台电脑上建索引：不调用 AI、不耗 token，资料不离开电脑。建好后，整本书出题只读相关页面。'),
    firstRun ? uiFormat('首次需要下载约 {0} MB 的检索模型，只下载一次，之后可以离线使用。', [modelMb]) : '',
    ui('默认检索模型偏英文；中文教材结合关键词匹配，提问时尽量写原文术语。')].filter(Boolean).join(' ');
  return <Hint data-index-note>{text}</Hint>;
}
