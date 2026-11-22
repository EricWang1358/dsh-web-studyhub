import type { UiLanguage } from '../../types/contracts.js';
import { t } from '../../state/store.js';
import { atomicWriteTextFile, defaultBackupFilePath } from '../../host/atomic-write.js';

export interface DeckExportOption {
  id?: string;
  text?: string;
  correct?: boolean;
}

export interface DeckExportCard {
  id?: string;
  kind?: string;
  topic?: string;
  prompt?: string;
  answer?: string;
  correctAnswer?: string;
  hint?: string;
  rubric?: string;
  explanation?: string;
  options?: readonly DeckExportOption[];
  cloze?: { text?: string; answers?: readonly { id?: string; value?: string }[] };
}

export interface DeckExportInput {
  id?: string;
  title?: string;
  name?: string;
  course?: string;
  cards?: readonly DeckExportCard[];
}

function localDayKey(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function optTag(id: string | undefined, idx: number): string {
  const s = (id ?? '').trim();
  return s ? (/^[a-z]$/i.test(s) ? s.toUpperCase() : s) : String.fromCharCode(65 + (idx % 26));
}

/** Format a deck and its cards into a printable Markdown study sheet with collapsible answers. */
export function formatDeckMarkdown({
  deck,
  lang,
  generatedAt,
}: {
  deck: DeckExportInput;
  lang: UiLanguage;
  generatedAt?: Date | string;
}): string {
  const cards: readonly DeckExportCard[] = Array.isArray(deck.cards) ? deck.cards : [];
  const title = String(deck.title || deck.name || deck.id || t(lang, '未命名题组', 'Untitled Deck')).trim();
  const course = String(deck.course || '').trim() || t(lang, '未分课', 'General');
  const d = generatedAt instanceof Date && !Number.isNaN(generatedAt.getTime()) ? generatedAt : new Date();
  const date =
    typeof generatedAt === 'string' && generatedAt.trim()
      ? generatedAt.trim()
      : `${localDayKey(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const lines: string[] = [
    `# ${title}`,
    '',
    `- **${t(lang, '课程', 'Course')}**: ${course}`,
    `- **${t(lang, '生成日期', 'Generated')}**: ${date}`,
    `- **${t(lang, '题目数量', 'Cards')}**: ${cards.length}`,
    '',
    '---',
  ];
  if (cards.length === 0) {
    lines.push('', t(lang, '_该题组暂无卡片。_', '_No cards in this deck._'), '');
    return lines.join('\n');
  }
  cards.forEach((c, i) => {
    const kind = String(c.kind || 'card').trim();
    const topic = String(c.topic || '').trim();
    const badges = [`\`${kind}\``, ...(topic ? [`\`${topic}\``] : [])].join(' ');
    const prompt = String(c.cloze?.text || c.prompt || t(lang, '（无题干）', '(No prompt)')).trim();
    lines.push('', `## ${i + 1}. ${topic || t(lang, `第 ${i + 1} 题`, `Card ${i + 1}`)}`, '', badges, '', prompt);
    const opts: readonly DeckExportOption[] = Array.isArray(c.options)
      ? c.options.filter((o): o is DeckExportOption => Boolean(o && (o.text || o.id)))
      : [];
    if (opts.length > 0) {
      lines.push('');
      opts.forEach((o, oi) => lines.push(`- **${optTag(o.id, oi)}.** ${String(o.text ?? '').trim()}`));
    }
    const optAns = opts
      .map((o, oi) => (o.correct ? `${optTag(o.id, oi)}. ${String(o.text ?? '').trim()}` : ''))
      .filter(Boolean)
      .join('; ');
    const clozeAnswers: readonly { id?: string; value?: string }[] = Array.isArray(c.cloze?.answers) ? c.cloze.answers : [];
    const clozeAns = clozeAnswers.map((a) => String(a?.value ?? '').trim()).filter(Boolean).join('; ');
    const ans = String(c.correctAnswer || c.answer || optAns || clozeAns || c.rubric || '').trim();
    const hint = String(c.hint || '').trim();
    const expl = String(c.explanation || '').trim();
    lines.push('', '<details>', '<summary>参考答案与解析 / Answer & Explanation</summary>', '');
    if (ans) lines.push(`- **${t(lang, '参考答案', 'Reference Answer')}**: ${ans}`);
    if (hint) lines.push(`- **${t(lang, '提示', 'Hint')}**: ${hint}`);
    if (expl) lines.push('', `**${t(lang, '解析', 'Explanation')}**:`, '', expl);
    if (!ans && !hint && !expl) lines.push(t(lang, '_暂无参考答案与解析。_', '_No answer or explanation._'));
    lines.push('', '</details>', '', '---');
  });
  lines.push('');
  return lines.join('\n');
}

/** Atomically write a deck study sheet Markdown file under the backups directory. */
export async function exportDeckToMarkdown({
  libraryRoot,
  deck,
  lang,
}: {
  libraryRoot: string;
  deck: DeckExportInput;
  lang: UiLanguage;
}): Promise<{ targetPath: string; count: number }> {
  const targetPath = defaultBackupFilePath(libraryRoot, 'studyhub-deck', '.md');
  await atomicWriteTextFile(targetPath, formatDeckMarkdown({ deck, lang }));
  const count = Array.isArray(deck.cards) ? deck.cards.length : 0;
  return { targetPath, count };
}
