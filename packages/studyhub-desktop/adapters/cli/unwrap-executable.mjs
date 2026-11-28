import { access, readFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { parseCmdShimTarget } from '../../domain/shim-parser.js';

const WINDOWS_SHIM_EXTS = new Set(['.cmd', '.bat']);
const NODE_SCRIPT_EXTS = new Set(['.js', '.mjs', '.cjs']);

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely unwrap Windows `.cmd`/`.bat` shims and `.js` scripts without ever using `shell: true`.
 */
export async function unwrapExecutable(commandPath, { exists = fileExists, readText = (p) => readFile(p, 'utf8') } = {}) {
  const ext = extname(commandPath).toLowerCase();
  if (NODE_SCRIPT_EXTS.has(ext)) {
    return { ok: true, command: process.execPath, prefixArgs: [commandPath] };
  }
  if (!WINDOWS_SHIM_EXTS.has(ext)) {
    return { ok: true, command: commandPath, prefixArgs: [] };
  }

  let content;
  try {
    content = await readText(commandPath);
  } catch (error) {
    return { ok: false, errorCode: 'BROKEN_SHIM', reason: `无法读取启动脚本：${error?.message || commandPath}` };
  }

  const parsed = parseCmdShimTarget(content, dirname(commandPath));
  if (!parsed) {
    return { ok: false, errorCode: 'BROKEN_SHIM', reason: `无法解析 .cmd 启动脚本目标：${commandPath}` };
  }
  if (!(await exists(parsed.targetPath))) {
    return { ok: false, errorCode: 'BROKEN_SHIM', reason: `启动脚本指向的目标文件不存在：${parsed.targetPath}` };
  }
  if (parsed.kind === 'node-script') {
    return { ok: true, command: process.execPath, prefixArgs: [parsed.targetPath] };
  }
  return { ok: true, command: parsed.targetPath, prefixArgs: [] };
}
