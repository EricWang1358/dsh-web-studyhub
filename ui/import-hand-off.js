/* 「发给主会话」 where adding files ends (the hand-off plan N2, N3, N5): what the 'import.file' message carries for the files a drop zone refused, for the
   files of a batch that did not import, and for a pasted question JSON that did not pass. The pages draw it (ImportHub, JsonImport, AudioImport); the message
   is ui/agent-prompts/import.js. Only what will fail again is handed over: an upload that broke off is retried, not handed over. */

/** How much of a refused question JSON the message carries (the start is enough to see its shape; the chat reads the file itself). */
export const DECK_HEAD_CHARS = 4000;
/** How much of a pasted question JSON the message carries (the hand-off plan N5: 20,000 characters, said to be cut when longer). */
export const PASTED_JSON_CHARS = 20000;

/** One line per file: its name and the reason as the page showed it. */
const reasons = (rows) => rows.map(({ name, message }) => `${name}: ${message}`).join('\n');

/** The files a drop zone refused (FileDrop rejections: { name, message }): `purpose` is the page's ('file' when it takes several kinds). */
export const rejectedFilesInput = (rejections, { purpose = 'file', area = '' } = {}) =>
  ({ purpose, ...(area ? { area } : {}), files: rejections.map((item) => item.name), error: reasons(rejections) });

/** The items of an import batch the hand-off is for: failed for a reason that will repeat, and not on their way to the audio form. */
export const lastingFailures = (items) => items.filter((item) => item.status === 'error' && item.permanent && !item.carry);

/**
 * The input for the failed files of an import batch (the hub's summary, N3): every file with its reason; a question JSON also gives its start
 * (read from the file, at most DECK_HEAD_CHARS each, said to be cut). `courses`: the course line of the panel.
 */
export async function failedImportInput(items, { courses = [] } = {}) {
  const failed = lastingFailures(items);
  const decks = failed.filter((item) => item.kind === 'deck' && typeof item.file?.text === 'function');
  let excerpt = null;
  if (decks.length) {
    const texts = await Promise.all(decks.map(async (item) => ({ name: item.name, text: await item.file.text().catch(() => '') })));
    const joined = (cut) => texts.map(({ name, text }) => `${name}\n${cut ? text.slice(0, DECK_HEAD_CHARS) : text}`).join('\n\n');
    excerpt = { text: joined(true), total: joined(false).length };
  }
  return { purpose: 'file', area: '添加资料', files: failed.map((item) => item.name), error: reasons(failed.map((item) => ({ name: item.name, message: item.error }))),
    ...(courses.length ? { facts: { courses } } : {}), ...(excerpt ? { excerpt } : {}) };
}

/** A pasted question JSON that did not pass (N5): the error as shown and the text, cut at PASTED_JSON_CHARS (the message says so). */
export const pastedJsonInput = (text, error) =>
  ({ purpose: 'questions', area: '导入 JSON 题组', error, excerpt: { text: String(text ?? '').slice(0, PASTED_JSON_CHARS), total: String(text ?? '').length } });
