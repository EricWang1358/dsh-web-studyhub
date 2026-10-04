/* 信箱种类注册表：一封信是什么、归哪一类、用什么语气、点开去哪里、空态里怎么称呼它，
   都只在这里写一次。lib/inbox.js（投递与视图）、lib/application-messages.js（英文视图）、
   ui/Inbox.jsx（标签、提示、空态）和以后的 App 打开路由都读这张表，不再各自按前缀判断。
   新增一种信件：这里加一行，再给 label / deckTitle 配英文（lib/application-messages-en.js）
   和空态里的 topic（ui/locales/en.feedback.json）；tests/wave1-c-inbox.test.mjs 会替你查漏。

   label      信里的标题（中文原文；英文视图按它查表）
   group      card 要有题目 / job 要有后台任务 / note 要有笔记草稿
   jobDomain  job 类信件所属的后台任务：audio | pdf | translate
   tone       success | warning | error | info | neutral（不用 accent：朱砂只给唯一的主操作）
   openHint   点开这封信会去哪里（tooltip）
   deckTitle  job 类信件在“题组”位置显示的名称
   topic      空态里列举的名称（同名只出现一次） */

const card = (label, tone, topic, openHint = '跳到这道题') => ({ label, group: 'card', tone, openHint, topic });
const job = (jobDomain, label, tone, openHint, deckTitle, topic) => ({ label, group: 'job', jobDomain, tone, openHint, deckTitle, topic });
const AUDIO = ['audio', '音频转写', '录音转写'], PDF = ['pdf', 'PDF 转换', 'PDF 转换'], TRANSLATE = ['translate', '中英对照翻译', '页面翻译'];
const audio = (label, tone) => job(AUDIO[0], label, tone, '打开音频转写结果', AUDIO[1], AUDIO[2]);
const pdf = (label, tone) => job(PDF[0], label, tone, '打开 PDF 转换结果', PDF[1], PDF[2]);
const translate = (label, tone) => job(TRANSLATE[0], label, tone, '打开这份资料', TRANSLATE[1], TRANSLATE[2]);

export const INBOX_REGISTRY = Object.freeze({
  improve: card('质量提升', 'info', '题目修改'),
  link: card('前置题', 'success', '关联的前置题'),
  rewrite: card('按反馈改题', 'info', '题目修改'),
  coach: card('陪学回复', 'info', '陪学回复'),
  variant: card('定制题', 'success', '定制题'),
  followup: card('讲解追问', 'info', '追问回答'),
  note: { label: '笔记草稿', group: 'note', tone: 'info', openHint: '打开笔记草稿', topic: '新笔记草稿' },
  'audio-transcribe': audio('录音文件已转录成功', 'success'),
  'audio-proofread': audio('录音文件已校对润色', 'success'),
  'audio-proofread-warning': audio('录音校对部分未完成', 'warning'),
  'audio-translate': audio('录音文件已翻译成功', 'success'),
  'audio-result': audio('录音处理完成', 'success'),
  'audio-failed': audio('录音处理未完成', 'error'),
  // Cloud PDF conversion (MinerU): a finished or stopped conversion job, like an audio import.
  'pdf-result': pdf('PDF 转换完成', 'success'),
  'pdf-failed': pdf('PDF 转换未完成', 'error'),
  // Rubric grading (WP12): a graded open answer; the letter opens at the card.
  grade: card('批改完成', 'success', '批改'),
  // Questions written from a selected passage and added to a deck in the background; the letter opens at the first new card.
  'passage-added': card('原文补题完成', 'success', '原文补题'),
  // A page or chapter translated in the background: a letter that opens the material.
  'translate-result': translate('译文已生成', 'success'),
  'translate-failed': translate('译文未完成', 'error'),
});

/** What a letter whose card or note is gone says (tooltip and the line where its prompt was). */
const MISSING = Object.freeze({
  card: { hint: '这道题已经不在题库里了', prompt: '（题目已删除）' },
  note: { hint: '笔记已不存在', prompt: '（笔记已删除）' },
});

export const inboxKind = kind => Object.hasOwn(INBOX_REGISTRY, kind) ? INBOX_REGISTRY[kind] : null;
export const isInboxKind = kind => inboxKind(kind) !== null;
/** A job letter points at a background task (audio, PDF conversion, translation), not a card. */
export const isJobKind = kind => inboxKind(kind)?.group === 'job';
export const jobDomainOf = kind => inboxKind(kind)?.jobDomain || null;
export const inboxLabel = kind => inboxKind(kind)?.label || '';
export const inboxTone = kind => inboxKind(kind)?.tone || 'neutral';
export const inboxDeckTitle = kind => inboxKind(kind)?.deckTitle || '';
export const inboxOpenHint = (kind, { missing = false } = {}) => {
  const info = inboxKind(kind);
  if (missing) return (MISSING[info?.group] || MISSING.card).hint;
  return info?.openHint || '跳到这道题';
};
export const inboxMissingPrompt = kind => (MISSING[inboxKind(kind)?.group] || MISSING.card).prompt;
/** Every name the empty mailbox lists, once each, in table order. */
export const inboxTopics = () => [...new Set(Object.values(INBOX_REGISTRY).map(info => info.topic))];
