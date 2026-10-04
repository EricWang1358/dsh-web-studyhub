import { ui, uiFormat, uiMessage } from "../i18n.js";

/**
 * The pre-flight result of each chosen file, in words: a long recording offers a lossless split (the learner confirms
 * the extra requests), a file that cannot be imported says why, and every other file says whom it is waiting for.
 * checks: key → pre-flight probe ({ blocked, issue, seconds, requests }) or { checking: true }; confirmed: keys whose split was accepted.
 */
export function preflightNotes(files, checks = {}, confirmed = new Set()) {
  const notes = {}, audio = files.filter((file) => file.kind !== 'subtitle');
  const blocker = audio.find((file) => checks[file.key]?.blocked);
  const pending = audio.find((file) => checks[file.key]?.issue?.code === 'long-split' && !confirmed.has(file.key));
  for (const file of audio) {
    const check = checks[file.key];
    if (!check) notes[file.key] = null;
    else if (check.checking) notes[file.key] = { kind: 'checking', text: ui('正在检查…') };
    else if (check.blocked) notes[file.key] = { kind: 'blocked', text: uiMessage(check.issue?.message || ui('这个文件不能导入')) };
    else if (check.issue?.code === 'long-split') {
      const { minutes, parts, requests, partMinutes } = check.issue;
      notes[file.key] = confirmed.has(file.key)
        ? { kind: 'split-confirmed', text: uiFormat('将无损分成 {0} 段转写（占用 {1} 次请求）', [parts, requests ?? parts]) }
        : { kind: 'split', text: Number.isFinite(partMinutes)
          ? uiFormat('约 {0} 分钟，按每次最多 {1} 分钟 → 无损分成 {2} 段转写（占用 {3} 次请求）', [minutes, partMinutes, parts, requests ?? parts])
          : uiFormat('约 {0} 分钟 → 无损分成 {1} 段转写（占用 {2} 次请求）', [minutes, parts, requests ?? parts]) };
    } else if (blocker) notes[file.key] = { kind: 'held', text: uiFormat('因「{0}」未通过预检尚未开始', [blocker.name]) };
    else if (pending) notes[file.key] = { kind: 'waiting', text: uiFormat('等待「{0}」处理', [pending.name]) };
    else notes[file.key] = { kind: 'ok', text: check.seconds ? uiFormat('约 {0} 分钟 · {1} 次转写请求', [Math.max(1, Math.round(check.seconds / 60)), check.requests || 1]) : ui('可以导入') };
  }
  return notes;
}

/** What the host is told about a chosen file: an upload by its id, anything else by its path. */
export const inputOf = (file) => (file.kind === 'upload' ? { uploadId: file.uploadId } : { path: file.path });
/** The host's pre-flight answer without its per-file part: what is configured. */
export const withoutFiles = (result) => { const status = { ...result }; delete status.files; return status; };

/**
 * Ask the host about `list` (each file { key, kind, uploadId | path }). Resolves { checks, status }: `checks` is key -> probe
 * (null when the answer has no per-file part, so earlier checks stand), `status` the readiness (null when there was no answer).
 * Nothing is sent to a transcription provider.
 */
export async function checkFiles(call, list, { paidOnly = false } = {}) {
  const result = await call('audio.preflight', { files: list.map(inputOf), ...(paidOnly ? { paidOnly: true } : {}) });
  return {
    checks: Array.isArray(result?.files) ? Object.fromEntries(list.map((file, index) => [file.key, result.files[index]])) : null,
    status: result && typeof result === 'object' ? withoutFiles(result) : null,
  };
}
