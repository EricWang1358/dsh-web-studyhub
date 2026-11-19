import React from 'react';
import { ui } from '../i18n.js';
import { Hint, InlineMessage } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import css from './desktop.css';

/* Under the library folder in Settings › 学习库与模型 (ui/host-parts.js LibraryNotice). */
export default function DesktopLibraryNotice({ binding }) {
  useInjectCss(css, 'study-desktop');
  const problem = binding?.libraryProblem;
  const problemText = problem?.message || problem?.reason || '';
  return (
    <div className="desktop-library-notice">
      {problemText && (
        <InlineMessage tone="warning" data-desktop-library-problem="">
          {problemText}
        </InlineMessage>
      )}
      <Hint>
        {ui('桌面版可以直接选择已有 DSH 学习库目录，并通过文件锁与 DSH 共享同一份资料与题库；如需同时运行，建议避开两边同时执行批量写入。')}
      </Hint>
    </div>
  );
}
