import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { AUDIO_EXTENSIONS, MAX_AUDIO_BYTES } from './audio-file.js';

/** What identifies an audio input: its content hash and size, after the checks every import path makes (absolute path, known format, not empty, within the size limit). */
export async function identity(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('音频文件路径必须是绝对路径');
  if (!AUDIO_EXTENSIONS.includes(extname(path).toLowerCase())) throw new Error(`不支持的音频格式；支持 ${AUDIO_EXTENSIONS.join('、')}`);
  const info = await stat(path);
  if (!info.isFile() || !info.size) throw new Error('音频文件是空的或不是文件');
  if (info.size > MAX_AUDIO_BYTES) throw new Error('音频超过 512 MB，请先压缩成 MP3 或按章节拆分');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return { hash: hash.digest('hex'), size: info.size };
}
