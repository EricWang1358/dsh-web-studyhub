/** Download a generated voice study pack as a Markdown file. */
export function downloadVoicePackMarkdown(pack) {
  if (!pack?.markdown) return false;
  const url = URL.createObjectURL(new Blob([pack.markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = pack.filename || 'study-voice-pack.md';
  try {
    link.click();
    return true;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
