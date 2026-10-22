import { getUiLanguage } from '../i18n.js';
import { situationPrompt } from './situation.js';

/* The hand-off for a file the built-in import does not take or does not suit (the hand-off plan, 1.3): ONE entry, 'import.file', with the purpose that says
   what the file is for. It is built on situation.js (where the learner is, the facts in a fence, the fixed way of working, what to report) and ends with the
   file line (the @ that opens the chat's file picker), so the learner picks the files in the chat. Today: 'audio' (AudioImport: several recordings in an order,
   or files from somewhere else). The other purposes (questions, material, generate …) are added with the pages that use them. */

const PURPOSES = Object.freeze({
  audio: {
    area: '音频导入',
    goal: '把这些音频按我指定的顺序合成一份逐字稿',
    hints: [
      '- 用 audio.import 的 files:[{path}] 导入，路径用绝对路径；files 的顺序就是录音的顺序。',
      '- 视频先抽出音频，超过上限就按章拆开，按顺序导入同一课程。',
    ],
  },
});

/** The purposes the registry knows. */
export const IMPORT_PURPOSES = Object.freeze(Object.keys(PURPOSES));

/** input: { purpose ('audio'), facts (what the page knows, may be empty), error (a message shown there), files (names) }. An unknown purpose throws. */
export function importFilePrompt({ purpose = 'audio', facts = null, error = '', files = [] } = {}, language = getUiLanguage()) {
  const entry = PURPOSES[purpose];
  if (!entry) throw new Error(`Unknown import purpose: ${purpose}`);
  return situationPrompt({ area: entry.area, goal: entry.goal, facts, error, files, skill: 'study-import', context: 'imports', hints: entry.hints }, language);
}
