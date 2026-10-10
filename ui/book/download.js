/* The export of the 复习全书 delivered the way the app's other exports are (the backup, the usage record): a text file the browser saves. */

/** Saves `text` as `filename` (UTF-8). */
export function downloadText(filename, text, mime = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
