/* The export of the 复习全书 delivered the way the app's other exports are (the backup, the usage record): a text file the browser saves. */

/** Saves `bytes` (a Uint8Array) as `filename`. */
export function downloadBytes(filename, bytes, mime = 'application/zip') {
  save(filename, new Blob([bytes], { type: mime }));
}

/** Saves `text` as `filename` (UTF-8). */
export function downloadText(filename, text, mime = 'text/markdown') {
  save(filename, new Blob([text], { type: `${mime};charset=utf-8` }));
}

function save(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
