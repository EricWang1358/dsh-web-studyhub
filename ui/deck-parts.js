import { ui, uiFormat } from './i18n.js';
import { META_DOT } from './format.js';

/* The words of a deck's parts (lib/deck-parts.js), written ONCE: the deck page, the draft page, the 任务 console, the home card and the 资料 row's top-up all say a part through these.
   Each part up to the tenth has its own words (「第二部分」 / "Part 2"; 「第二部分 9 题」 / "Part 2: 9 questions"), so neither language is assembled from the other's pieces. */

const LABELS = [() => ui('第一部分'), () => ui('第二部分'), () => ui('第三部分'), () => ui('第四部分'), () => ui('第五部分'), () => ui('第六部分'), () => ui('第七部分'), () => ui('第八部分'), () => ui('第九部分'), () => ui('第十部分')];
const COUNTS = [(n) => uiFormat('第一部分 {0} 题', [n]), (n) => uiFormat('第二部分 {0} 题', [n]), (n) => uiFormat('第三部分 {0} 题', [n]), (n) => uiFormat('第四部分 {0} 题', [n]), (n) => uiFormat('第五部分 {0} 题', [n]),
  (n) => uiFormat('第六部分 {0} 题', [n]), (n) => uiFormat('第七部分 {0} 题', [n]), (n) => uiFormat('第八部分 {0} 题', [n]), (n) => uiFormat('第九部分 {0} 题', [n]), (n) => uiFormat('第十部分 {0} 题', [n])];

/** 「第二部分」 / "Part 2". */
export const partLabel = (n) => LABELS[n - 1]?.() ?? uiFormat('第 {0} 部分', [n]);

/** 「第一部分 12 题 · 第二部分 9 题」: what each part of a deck holds. `parts`: [{ n, count }]. */
export const partsLine = (parts) => (parts || []).map((part) => COUNTS[part.n - 1]?.(part.count) ?? uiFormat('第 {0} 部分 {1} 题', [part.n, part.count])).join(META_DOT);

/** The parts of a deck from the snapshot's summary (lib/deck-parts.js partsSummary): [{ n, count }], or [] for a deck of one part. */
export const summaryParts = (deck) => (Array.isArray(deck?.parts) && Array.isArray(deck?.partNumbers) ? deck.partNumbers.map((n, at) => ({ n, count: deck.parts[at] })) : []);

/** 「期中复习 · 第二部分」: the title of a draft (and of its job) that will be a part of a deck. */
export const partTitle = (deckTitle, n) => uiFormat('{0} · {1}', [deckTitle, partLabel(n)]);

/** The part a job makes (its own record, else its contract's): { deckId, deckTitle, n } or null. */
export const jobPart = (job) => job?.part || job?.contract?.detail?.part || null;

/** What the confirmation says before the top-up of a published deck's material starts. */
export const partStartLine = (deckTitle, n) => uiFormat('先存成一份新草稿，作为「{0}」的{1}；发布时再确认并入，原题组现在不会改动。', [deckTitle, partLabel(n)]);

/** What the draft page says about a draft that will be a part. */
export const partDraftLine = (deckTitle, n) => uiFormat('这份草稿是「{0}」的{1}。发布时选择并入那个题组，或单独成为新题组。', [deckTitle, partLabel(n)]);

/** The choices of where a part goes when it is published. */
export const intoDeckLabel = (deckTitle, n) => uiFormat('并入「{0}」，作为{1}', [deckTitle, partLabel(n)]);
export const asNewDeckLabel = () => ui('单独成为新题组');
