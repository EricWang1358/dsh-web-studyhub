import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Hint, InlineMessage } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import css from './desktop.css';

/* Under the library folder in Settings › 学习库与模型 (ui/host-parts.js LibraryNotice). */
export default function DesktopLibraryNotice({ binding }) {
  useInjectCss(css, 'study-desktop');
  const problem = binding?.libraryProblem;
  const problemText = problem?.message || problem?.reason || '';
  // The folder that was picked is a DSH workspace: the library in use is the one the plugin keeps inside it.
  const inWorkspace = binding?.pickedRoot && binding.pickedRoot !== binding.root ? binding.pickedRoot : '';
  return (
    <div className="desktop-library-note">
      {inWorkspace && (
        <InlineMessage tone="info" data-desktop-library-in-workspace="">
          {uiFormat('你选的「{0}」里已有 DSH 插件的学习库，这里直接使用它（其中的 .dsh-study 文件夹），原来的题组和记录都在。', [inWorkspace])}
        </InlineMessage>
      )}
      {problemText && (
        <InlineMessage tone="warning" data-desktop-library-problem="">
          {problemText}
        </InlineMessage>
      )}
      <Hint>
        {ui('想接着用 DSH 插件里的学习库，选那个工作区文件夹就行；两边通过文件锁共用同一份资料与题库。如需同时运行，建议避开两边同时执行批量写入。')}
      </Hint>
    </div>
  );
}
