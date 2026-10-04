import { ui, uiFormat } from '../i18n.js';
import { formatBytes } from '../format.js';
import { extensionOf } from '../file-names.js';
import { isAbsolutePath, unquotePath } from '../paths.js';
import { AUDIO_EXTENSIONS, AUDIO_MIME, MAX_AUDIO_BYTES, MAX_SUBTITLE_BYTES, SUBTITLE_EXTENSIONS } from '../../lib/audio-formats.js';

/* What the audio form accepts, said in words. Formats and limits come from lib/audio-formats.js; nothing here repeats them. */

/** The extensions a file picker offers: audio and subtitle files. */
export const AUDIO_ACCEPT = [...AUDIO_EXTENSIONS, ...SUBTITLE_EXTENSIONS];

/** One name per audio format, upper case, the first spelling of each (AIFF, not AIF). */
export function audioFormatNames() {
  const seen = new Set();
  return Object.entries(AUDIO_MIME).filter(([, mime]) => !seen.has(mime) && seen.add(mime)).map(([extension]) => extension.slice(1).toUpperCase());
}

/** One name per subtitle format, upper case. */
export const subtitleFormatNames = () => SUBTITLE_EXTENSIONS.map(extension => extension.slice(1).toUpperCase());

export const isSubtitleName = (name) => SUBTITLE_EXTENSIONS.includes(extensionOf(name));

/** Why this recording cannot be imported ('' when it can). `size` is optional: a pasted path has none yet. */
export function audioFileProblem(name, size) {
  if (!AUDIO_EXTENSIONS.includes(extensionOf(name))) return uiFormat('这不是支持的音频文件。支持 {0}。', [audioFormatNames().join(' · ')]);
  if (size !== undefined && size < 1) return ui('文件是空的。');
  if (size !== undefined && size > MAX_AUDIO_BYTES) return uiFormat('文件超过 {0}，请先压缩成 MP3 或按章节拆分。', [formatBytes(MAX_AUDIO_BYTES)]);
  return '';
}

/** Why a subtitle file cannot be imported ('' when it can). */
export const subtitleProblem = (size) => (size > MAX_SUBTITLE_BYTES ? uiFormat('字幕文件超过 {0}。', [formatBytes(MAX_SUBTITLE_BYTES)]) : '');

/** The audio path in one line of dropped text (a file tree gives text, not files): quoted, or a file:// address. '' when it is not one. */
export function droppedPath(text) {
  const value = unquotePath(String(text || '').split(/\r?\n/)[0]);
  return isAbsolutePath(value) && AUDIO_EXTENSIONS.includes(extensionOf(value)) ? value : '';
}

/** Every audio path in dropped text, one per line. */
export const pathsFromDrop = (text) => String(text || '').split(/\r?\n/).map(droppedPath).filter(Boolean);

/** The size cap shown beside the drop zone ("up to 512 MB"). */
export const audioLimitLabel = () => uiFormat('最大 {0}', [formatBytes(MAX_AUDIO_BYTES)]);
