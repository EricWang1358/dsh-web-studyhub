/**
 * OSC 52 terminal clipboard copy with atomic Markdown file fallback (#1315 — Round 82 Track D0).
 *
 * - Prefers OSC 52 (`\x1b]52;c;<base64>\x07`, with tmux DCS passthrough when `$TMUX` is set) so
 *   copying works even over SSH without local clipboard binaries.
 * - On non-TTY streams or write failures, falls back atomically to
 *   `<libraryRoot>/backups/copy-YYYY-MM-DD-HHmmss.md` and returns the path.
 */
import { atomicWriteExportText, defaultBackupFilePath } from '../host/atomic-write.js';
import type { UiLanguage } from '../types/contracts.js';
import { detectMultiplexer, wrapMultiplexerPassthrough, type MultiplexerKind } from './terminal-compat.js';

export type GuidedStageId = 'question' | 'answer' | 'judge' | 'retell' | 'summary';

export interface CopyTurnRecord {
  role: 'user' | 'assistant' | 'system';
  text: string;
  stage?: GuidedStageId;
  actionSummary?: string;
}

export interface CopyResult {
  ok: boolean;
  method: 'osc52' | 'file' | 'none';
  chars: number;
  filePath?: string;
  sequence?: string;
  error?: string;
}

export interface CopyOptions {
  stdout?: { isTTY?: boolean; write?: (chunk: string) => unknown };
  libraryRoot?: string | null;
  env?: NodeJS.ProcessEnv;
  forceFileFallback?: boolean;
  now?: Date;
}

const STAGE_LABELS_ZH: Record<GuidedStageId, string> = {
  question: '提问',
  answer: '作答',
  judge: '判定',
  retell: '复述',
  summary: '小结',
};

const STAGE_LABELS_EN: Record<GuidedStageId, string> = {
  question: 'Question',
  answer: 'Answer',
  judge: 'Verdict',
  retell: 'Retell',
  summary: 'Summary',
};

export function stageLabel(stage: GuidedStageId, lang: UiLanguage = 'zh'): string {
  return lang === 'en' ? STAGE_LABELS_EN[stage] : STAGE_LABELS_ZH[stage];
}

/**
 * Build an OSC 52 clipboard escape sequence for UTF-8 text.
 * Wraps with tmux or GNU screen DCS passthrough when inside a terminal multiplexer.
 */
export function buildOsc52Sequence(text: string, opts?: { tmux?: boolean; mux?: MultiplexerKind }): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const raw = `\x1b]52;c;${b64}\x07`;
  const mux: MultiplexerKind = opts?.mux ?? (opts?.tmux ? 'tmux' : 'none');
  return wrapMultiplexerPassthrough(raw, mux);
}

/**
 * Copy UTF-8 text via OSC 52 first, falling back to `<libraryRoot>/backups/copy-<time>.md`.
 */
export async function copyTextWithFallback(text: string, opts: CopyOptions = {}): Promise<CopyResult> {
  const payload = String(text ?? '');
  const chars = [...payload].length;
  if (!payload.trim()) {
    return { ok: false, method: 'none', chars: 0, error: '没有可复制的内容' };
  }

  const env = opts.env ?? process.env;
  const stdout = opts.stdout ?? process.stdout;
  const mux = detectMultiplexer(env);

  if (!opts.forceFileFallback && stdout && stdout.isTTY && typeof stdout.write === 'function') {
    try {
      const seq = buildOsc52Sequence(payload, { mux });
      const written = stdout.write(seq);
      if (written !== false) {
        return { ok: true, method: 'osc52', chars, sequence: seq };
      }
    } catch {
      // Fall through to file fallback
    }
  }

  const root = typeof opts.libraryRoot === 'string' ? opts.libraryRoot.trim() : '';
  if (!root) {
    return {
      ok: false,
      method: 'none',
      chars,
      error: '当前终端不支持剪贴板且未绑定学习库目录，无法落盘保存',
    };
  }

  try {
    const targetPath = defaultBackupFilePath(root, 'copy', 'md', { now: opts.now });
    const written = await atomicWriteExportText(targetPath, payload.endsWith('\n') ? payload : `${payload}\n`);
    return { ok: true, method: 'file', chars, filePath: written.path };
  } catch (err) {
    return {
      ok: false,
      method: 'none',
      chars,
      error: `复制落盘失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Format an entire Assistant / Guided Study session as Markdown including question,
 * user answer, AI explanation, and explicit stage markers (`[阶段: ...]`).
 */
export function formatSessionTranscript(opts: {
  title?: string;
  prompt?: string;
  userAnswer?: string;
  currentStage?: GuidedStageId;
  turns: readonly CopyTurnRecord[];
  lang?: UiLanguage;
}): string {
  const lang = opts.lang ?? 'zh';
  const lines: string[] = [];
  lines.push(`# ${opts.title || (lang === 'en' ? 'StudyHub AI Assistant Session' : 'StudyHub AI 助手与带学会话')}`);
  if (opts.currentStage) {
    lines.push(
      lang === 'en'
        ? `- Current Stage: [Stage: ${stageLabel(opts.currentStage, 'en')}]`
        : `- 当前阶段：[阶段: ${stageLabel(opts.currentStage, 'zh')}]`,
    );
  }
  lines.push('');

  if (opts.prompt && opts.prompt.trim()) {
    lines.push(lang === 'en' ? '## Question' : '## 题目');
    lines.push(opts.prompt.trim());
    lines.push('');
  }

  if (opts.userAnswer && opts.userAnswer.trim()) {
    lines.push(lang === 'en' ? '## My Answer' : '## 我的作答');
    lines.push(opts.userAnswer.trim());
    lines.push('');
  }

  lines.push(lang === 'en' ? '## Conversation & AI Explanation' : '## 对话与 AI 讲解');
  lines.push('');
  for (const turn of opts.turns) {
    const roleLabel =
      turn.role === 'user'
        ? lang === 'en'
          ? 'User'
          : '我'
        : turn.role === 'assistant'
          ? lang === 'en'
            ? 'AI'
            : 'AI 讲解'
          : lang === 'en'
            ? 'System'
            : '系统';
    const stageTag = turn.stage
      ? lang === 'en'
        ? ` [Stage: ${stageLabel(turn.stage, 'en')}]`
        : ` [阶段: ${stageLabel(turn.stage, 'zh')}]`
      : '';
    lines.push(`### ${roleLabel}${stageTag}`);
    if (turn.actionSummary) {
      lines.push(`> ${turn.actionSummary}`);
    }
    lines.push(turn.text.trim());
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}
