import { win32 } from 'node:path';
import { openableExternalUrl } from '../../domain/shim-parser.js';
import { spawnDetached } from '../cli/process-runner.mjs';

function systemProgram(...parts) {
  return win32.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', ...parts);
}

function openerCommand(platform) {
  if (platform === 'win32') {
    return { command: systemProgram('rundll32.exe'), prefixArgs: ['url.dll,FileProtocolHandler'] };
  }
  if (platform === 'darwin') {
    return { command: '/usr/bin/open', prefixArgs: [] };
  }
  return { command: '/usr/bin/xdg-open', prefixArgs: [] };
}

/**
 * Open a strictly validated `http:`/`https:` URL in the OS default browser without shell interpolation.
 */
export function openExternalUrl(value, { platform = process.platform, launch = spawnDetached } = {}) {
  const safeUrl = openableExternalUrl(value);
  if (!safeUrl) {
    throw Object.assign(new Error('仅允许打开有效的 http:// 或 https:// 链接'), { code: 'link-refused' });
  }
  const { command, prefixArgs } = openerCommand(platform);
  launch(command, [...prefixArgs, safeUrl]);
  return { ok: true, url: safeUrl };
}
