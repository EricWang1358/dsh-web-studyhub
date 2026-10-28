import React from 'react';
import { InlineMessage } from '../components/index.js';

/* Under the library folder in Settings › 学习库与模型 (ui/host-parts.js LibraryNotice): the folder ZCode was set to use
   could not be opened at start, so another one is in use for now (packages/studyhub-zcode/host/workspace.mjs
   resolveLibrary). The host says it in the panel's language; 更换目录… right above is the way out. */
export default function ZcodeLibraryNotice({ binding }) {
  const problem = binding?.libraryProblem;
  if (!problem?.message) return null;
  return <InlineMessage tone="warning" data-zcode-library-problem="">{problem.message}</InlineMessage>;
}
