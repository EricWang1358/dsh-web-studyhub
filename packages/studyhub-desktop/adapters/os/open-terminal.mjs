import { win32 } from 'node:path';
import { buildStartCommandLine } from '../../domain/terminal-command.js';
import { spawnVerbatimDetached, unwrapExecutable } from '../cli/process-runner.mjs';

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function commandInterpreter(env) {
  return win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'cmd.exe');
}

/** An npm `.cmd` shim becomes its real program plus script, so `cmd.exe` never interprets a script found on the user's PATH. */
async function realProgram(unwrap, executablePath) {
  const program = await unwrap(executablePath);
  if (program.ok) return program;
  throw coded(program.reason || '启动脚本损坏或目标文件缺失', program.errorCode || 'BROKEN_SHIM');
}

async function startLine(launch, env, line, cwd) {
  try {
    await launch(commandInterpreter(env), line, { cwd });
  } catch (error) {
    throw coded(`没能打开命令行窗口（${error?.code || 'unknown'}）`, 'terminal-launch-failed');
  }
}

/**
 * Open a new console window in `cwd` running the local CLI at `executablePath` (Windows only).
 * `start` is the one system way to give a program a console window of its own, and it follows the user's default terminal.
 * The line it runs is built from checked absolute paths only (`buildStartCommandLine`).
 */
export async function openCliTerminal({ executablePath, cwd }, {
  platform = process.platform,
  launch = spawnVerbatimDetached,
  unwrap = unwrapExecutable,
  env = process.env,
} = {}) {
  if (platform !== 'win32') {
    throw coded('当前系统暂不支持自动打开命令行', 'terminal-unsupported');
  }
  const program = await realProgram(unwrap, executablePath);
  const line = buildStartCommandLine({ cwd, command: program.command, args: program.prefixArgs });
  await startLine(launch, env, line, cwd);
  return { ok: true };
}
