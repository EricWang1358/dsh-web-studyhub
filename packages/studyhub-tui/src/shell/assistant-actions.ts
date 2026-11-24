/**
 * Real backend action executors for Persistent AI Assistant intents (#1444).
 *
 * Keeps AssistantPanel lean and enforces:
 * - Zero invented backend actions
 * - Honest scope/truncation reporting (never silent truncation)
 * - Real `[z]` undo hooks for reversible card mutations
 * - Human-readable status text (never leaking internal backend action names)
 */
import type { HostClient, PageId, StudySnapshot, UiLanguage } from '../types/contracts.js';
import type { AssistantCardContext } from '../state/store.js';
import { t, useTuiStore } from '../state/store.js';
import { tryAction } from '../host/sample-actions.js';
import { atomicWriteExportText, defaultBackupFilePath } from '../host/atomic-write.js';
import { SET_ERROR_REASON_ACTION, errorReasonArgs, errorReasonName, type ErrorReasonTarget } from './error-reason-intent.js';
import { reasonLabel } from '../views/wrongbook/helpers.js';
import type { ErrorReasonId } from '../views/wrongbook/types.js';
import type { AssistantIntent } from './assistant-intent.js';

export interface AssistantUndoHook {
  label: string;
  run: () => Promise<string>;
}

export interface AssistantActionOutcome {
  succeeded: boolean;
  actionSummary: string;
  text: string;
  undo?: AssistantUndoHook;
  toast?: { message: string; tone: 'success' | 'info' | 'warning' };
}

export interface AssistantActionDeps {
  host: HostClient;
  snapshot: StudySnapshot | null;
  cardCtx: AssistantCardContext | null;
  lastAssistantReply?: string;
  lang: UiLanguage;
  navigate: (page: PageId, ctx?: Record<string, unknown>) => void;
}

function resolveDeckId(params: Record<string, unknown>, snapshot: StudySnapshot | null, cardId: string): string {
  if (typeof params.deckId === 'string' && params.deckId) return params.deckId;
  if (!cardId) return '';
  return snapshot?.decks?.find((d) => Array.isArray(d.cards) && d.cards.some((c) => c.id === cardId))?.id || '';
}

function needCardOutcome(lang: UiLanguage, whatZh: string, whatEn: string): AssistantActionOutcome {
  return {
    succeeded: false,
    actionSummary: t(lang, '未定位题目', 'No question open'),
    text: t(lang, `请先在刷题页打开一道题再${whatZh}。`, `Open a question in Review before trying to ${whatEn}.`),
  };
}

/** Execute read-only / lightweight assistant actions (no ConfirmDialog required). */
export async function executeAssistantReadAction(
  intent: Extract<AssistantIntent, { kind: 'run_action' }>,
  deps: AssistantActionDeps,
): Promise<AssistantActionOutcome> {
  const { host, snapshot, cardCtx, lang } = deps;
  const cardId = (typeof intent.params.cardId === 'string' && intent.params.cardId) || cardCtx?.cardId || '';
  const deckId = resolveDeckId(intent.params, snapshot, cardId);
  const runId = (typeof intent.params.runId === 'string' && intent.params.runId) || cardCtx?.runId || '';

  if (intent.actionName === 'review.similar') {
    if (!runId || !cardId) return needCardOutcome(lang, '查找同类题', 'find similar questions');
    const res = await tryAction<{ item?: { prompt?: string; topic?: string } | null; items?: Array<{ prompt?: string; topic?: string }> }>(
      host,
      'review.similar',
      { runId, cardId, limit: 6 },
    );
    if (!res.ok) {
      return {
        succeeded: false,
        actionSummary: t(lang, '查找同类题失败', 'Similar lookup failed'),
        text: res.error?.message || t(lang, '查找同类题失败，请稍后重试。', 'Failed to find similar questions.'),
      };
    }
    const items = Array.isArray(res.value?.items) ? res.value.items : res.value?.item ? [res.value.item] : [];
    if (items.length === 0) {
      return {
        succeeded: true,
        actionSummary: t(lang, '已完成：查找同类题', 'Done: similar lookup'),
        text: t(lang, '当前题库中暂未找到与本题匹配的同类题。', 'No matching similar questions found in the library.'),
      };
    }
    const lines = items.slice(0, 3).map((it, idx) => `${idx + 1}. ${String(it.prompt || '').trim()}${it.topic ? `（${it.topic}）` : ''}`);
    return {
      succeeded: true,
      actionSummary: t(lang, `已找到 ${items.length} 道同类题`, `Found ${items.length} similar question(s)`),
      text: `${lines.join('\n')}\n${t(lang, '在刷题页按 [S] 可直接切入同类题练习。', 'Press [S] in Review to practice a similar card.')}`,
    };
  }

  if (intent.actionName === 'card.terms') {
    if (!cardId) return needCardOutcome(lang, '提取术语', 'extract terms');
    const res = await tryAction<{ terms?: unknown[] }>(host, 'card.terms', {
      ...(deckId ? { deckId } : {}),
      cardId,
    });
    if (!res.ok) {
      return {
        succeeded: false,
        actionSummary: t(lang, '提取术语失败', 'Term extraction failed'),
        text: res.error?.message || t(lang, '提取核心术语失败，请检查模型配置。', 'Failed to extract key terms.'),
      };
    }
    const rawTerms = Array.isArray(res.value?.terms) ? res.value.terms : [];
    const formatted = rawTerms
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object') {
          const obj = item as { term?: string; name?: string; gloss?: string; meaning?: string };
          const label = obj.term || obj.name || '';
          const desc = obj.gloss || obj.meaning || '';
          return desc ? `${label}：${desc}` : label;
        }
        return '';
      })
      .filter(Boolean);
    return {
      succeeded: true,
      actionSummary: t(lang, `已提取 ${formatted.length} 个术语`, `Extracted ${formatted.length} term(s)`),
      text: formatted.length > 0
        ? formatted.map((x, i) => `${i + 1}. ${x}`).join('\n')
        : t(lang, '本题未识别到额外生词或核心术语。', 'No additional key terms identified for this card.'),
    };
  }

  if (intent.actionName === 'card.translate') {
    if (!cardId) return needCardOutcome(lang, '翻译题目', 'translate this card');
    const res = await tryAction<{ translation?: { prompt?: string; answer?: string; explanation?: string } | null }>(
      host,
      'card.translate',
      { ...(deckId ? { deckId } : {}), cardId },
    );
    if (!res.ok || !res.value?.translation) {
      return {
        succeeded: false,
        actionSummary: t(lang, '翻译失败', 'Translation failed'),
        text: res.error?.message || t(lang, '翻译本题失败，请检查模型配置。', 'Failed to translate this card.'),
      };
    }
    const tr = res.value.translation;
    const lines = [tr.prompt, tr.answer ? `${t(lang, '译文答案', 'Answer')}: ${tr.answer}` : '', tr.explanation || ''].filter(Boolean);
    return {
      succeeded: true,
      actionSummary: t(lang, '已完成：题目翻译', 'Done: card translated'),
      text: lines.join('\n') || t(lang, '翻译完成，可在刷题页按 [W] 切换显示。', 'Translated; press [W] in Review to toggle.'),
    };
  }

  if (intent.actionName === 'review.move') {
    if (!runId) return needCardOutcome(lang, '跳过本题', 'skip this question');
    const dir = typeof intent.params.direction === 'number' ? intent.params.direction : 1;
    const res = await tryAction(host, 'review.move', { runId, direction: dir });
    if (!res.ok) {
      return {
        succeeded: false,
        actionSummary: t(lang, '跳过失败', 'Skip failed'),
        text: res.error?.message || t(lang, '无法切换到下一题。', 'Could not move to the next question.'),
      };
    }
    return {
      succeeded: true,
      actionSummary: t(lang, '已跳过本题', 'Skipped question'),
      text: t(lang, '已切换到下一题。按 [z] 可返回上一题。', 'Moved to the next question. Press [z] to go back.'),
      undo: {
        label: t(lang, '返回上一题', 'Return to previous question'),
        run: async () => {
          await tryAction(host, 'review.move', { runId, direction: -dir });
          return t(lang, '已撤销：已回到上一题。', 'Undone: returned to previous question.');
        },
      },
      toast: { message: t(lang, '已切换到下一题', 'Moved to next question'), tone: 'info' },
    };
  }

  return {
    succeeded: false,
    actionSummary: t(lang, '执行失败', 'Action failed'),
    text: t(lang, '未识别的只读动作。', 'Unrecognized read action.'),
  };
}

/** Execute a user-confirmed write action from ConfirmDialog. */
export async function executeAssistantWriteAction(
  intent: Extract<AssistantIntent, { kind: 'write_confirm' }>,
  deps: AssistantActionDeps,
): Promise<AssistantActionOutcome> {
  const { host, snapshot, cardCtx, lastAssistantReply, lang, navigate } = deps;
  const cardId = (typeof intent.params.cardId === 'string' && intent.params.cardId) || cardCtx?.cardId || '';
  const deckId = resolveDeckId(intent.params, snapshot, cardId);
  const runId = (typeof intent.params.runId === 'string' && intent.params.runId) || cardCtx?.runId || '';

  switch (intent.actionName) {
    case 'card.followup.add': {
      const saved = await tryAction(host, 'card.followup.add', {
        ...intent.params,
        replace: true,
      });
      if (saved.ok) {
        return {
          succeeded: true,
          actionSummary: t(lang, '已保存到本题讲解', 'Saved to question'),
          text: t(lang, '已将通俗讲解保存到当前题目，下次打开可直接复用。', 'Saved plain explanation to this question for reuse next time.'),
          toast: { message: t(lang, '通俗讲解已保存到本题', 'Plain explanation saved'), tone: 'success' },
        };
      }
      return {
        succeeded: false,
        actionSummary: t(lang, '保存失败', 'Save failed'),
        text: saved.error?.message || t(lang, '保存通俗讲解失败，请重试。', 'Failed to save plain explanation.'),
      };
    }

    case SET_ERROR_REASON_ACTION: {
      if (!cardId || !deckId) return needCardOutcome(lang, '标记错因', 'mark a wrong reason');
      const target: ErrorReasonTarget = { deckId, cardId };
      const reasonId = intent.params.errorReason as ErrorReasonId;
      const res = await tryAction<{ updated?: boolean }>(host, SET_ERROR_REASON_ACTION, errorReasonArgs(target, reasonId));
      if (res.ok && res.value?.updated === false) {
        return {
          succeeded: false,
          actionSummary: t(lang, '没有作答记录', 'No answer on record'),
          text: t(
            lang,
            '这道题还没有作答记录，标不了错因。答错的题会自动进入错题本。',
            'This question has no answer on record yet, so there is nothing to mark. Wrong answers enter the wrong-book on their own.',
          ),
        };
      }
      if (res.ok) {
        const appliedReason = errorReasonName(reasonId, lang);
        return {
          succeeded: true,
          actionSummary: t(lang, `已标记错因「${appliedReason}」`, `Marked reason: ${appliedReason}`),
          text: t(lang, `已完成：错因已标为「${appliedReason}」。按 [z] 可撤销。`, `Done: marked "${appliedReason}". Press [z] to undo.`),
          undo: {
            label: t(lang, `清除错因「${appliedReason}」`, `Clear reason "${appliedReason}"`),
            run: async () => {
              await tryAction(host, SET_ERROR_REASON_ACTION, errorReasonArgs(target, null));
              return t(lang, '已撤销：错题原因已清空。', 'Undone: wrong reason cleared.');
            },
          },
          toast: { message: t(lang, `错因已标为「${appliedReason}」`, `Marked "${appliedReason}"`), tone: 'success' },
        };
      }
      return {
        succeeded: false,
        actionSummary: t(lang, '执行失败', 'Failed'),
        text: res.error?.message || t(lang, '写入错题原因失败，请重试。', 'Failed to mark wrong reason.'),
      };
    }

    case 'export.wrongbook': {
      const root = host.getLibraryRoot?.() || snapshot?.root || '';
      if (!root) {
        return {
          succeeded: false,
          actionSummary: t(lang, '未绑定学习库', 'No library bound'),
          text: t(lang, '未绑定学习库目录，无法导出。', 'No library root bound.'),
        };
      }
      if (intent.params.singleCard === true) {
        const promptText = String(intent.params.prompt || cardCtx?.prompt || '').trim();
        const answerText = String(intent.params.answer || cardCtx?.answer || '').trim();
        const expText = String(intent.params.explanation || cardCtx?.explanation || '').trim();
        const md = [
          `# ${t(lang, '单题错题导出', 'Wrong Card Export')}`,
          '',
          `1. ${promptText || t(lang, '当前题目', 'Current question')}`,
          ...(answerText ? [`   - ${t(lang, '标准答案', 'Answer')}：${answerText}`] : []),
          ...(expText ? [`   - ${t(lang, '解析', 'Explanation')}：${expText}`] : []),
          '',
        ].join('\n');
        const outPath = defaultBackupFilePath(root, 'studyhub-wrong-card', 'md');
        const saved = await atomicWriteExportText(outPath, md);
        return {
          succeeded: true,
          actionSummary: t(lang, '已完成：导出当前错题', 'Done: exported current card'),
          text: t(lang, `已导出当前错题至 ${saved.path}`, `Exported current card to ${saved.path}`),
          toast: { message: t(lang, `已导出至 ${saved.path}`, `Exported to ${saved.path}`), tone: 'success' },
        };
      }
      const limit = 100;
      const wb = await tryAction<{ total?: number; items?: Array<{ prompt?: string; errorReason?: string }> }>(
        host,
        'wrongbook',
        { course: intent.params.course ?? '*', view: 'weak', offset: 0, limit },
      );
      const items = Array.isArray(wb.value?.items) ? wb.value.items : [];
      const total = typeof wb.value?.total === 'number' ? wb.value.total : items.length;
      const truncated = total > items.length;
      const md = [
        `# ${t(lang, '错题本导出', 'Wrong-Book Export')}`,
        ...(truncated
          ? [
              '',
              `> ${t(lang, `注：仅导出前 ${items.length} 道（共 ${total} 道，超出单次导出上限）`, `Note: exported first ${items.length} of ${total} cards (export limit reached)`)}`,
            ]
          : []),
        '',
        ...(items.length > 0
          ? items.map(
              (it, idx) =>
                `${idx + 1}. ${String(it.prompt || '').trim()}${it.errorReason ? t(lang, `（错因：${reasonLabel(it.errorReason, lang)}）`, ` (reason: ${reasonLabel(it.errorReason, lang)})`) : ''}`,
            )
          : [t(lang, '当前暂无错题记录。', 'No wrong cards found.')]),
        '',
      ].join('\n');
      const outPath = defaultBackupFilePath(root, 'studyhub-wrongbook', 'md');
      const saved = await atomicWriteExportText(outPath, md);
      const truncNote = truncated
        ? t(lang, `（共 ${total} 道，已按单次上限截断为前 ${items.length} 道）`, ` (truncated: ${items.length} of ${total} total)`)
        : '';
      return {
        succeeded: true,
        actionSummary: `已完成：导出 ${items.length} 道错题${truncated ? `/${total}` : ''}`,
        text: t(lang, `已导出 ${items.length} 道错题至 ${saved.path}${truncNote}`, `Exported ${items.length} cards to ${saved.path}${truncNote}`),
        toast: { message: t(lang, `已导出至 ${saved.path}`, `Exported to ${saved.path}`), tone: truncated ? 'warning' : 'success' },
      };
    }

    case 'assist.start': {
      if (!cardId || !deckId) return needCardOutcome(lang, '发起助教任务', 'start an assist task');
      const mode = intent.params.mode === 'improve' ? 'improve' : 'derive';
      const res = await tryAction<{ id?: string; label?: string; status?: string }>(host, 'assist.start', {
        ...intent.params,
        deckId,
        cardId,
        ...(runId ? { runId } : {}),
      });
      if (!res.ok) {
        return {
          succeeded: false,
          actionSummary: t(lang, '任务启动失败', 'Failed to start task'),
          text: res.error?.message || t(lang, '无法启动后台助教任务，请检查模型配置。', 'Could not start background assist task.'),
        };
      }
      const isPrereq = mode === 'derive';
      return {
        succeeded: true,
        actionSummary: isPrereq
          ? t(lang, '已启动：生成前置题并关联（后台任务）', 'Started: derive & link prerequisite')
          : t(lang, '已启动：后台助教修题', 'Started: improve question'),
        text: isPrereq
          ? t(lang, '已启动前置题生成后台任务，完成后将自动关联到当前题目（可在「后台任务」查看进度）。', 'Started background task to create and link a prerequisite question (check Tasks for progress).')
          : t(lang, '已启动后台助教修题任务，完成后结果会自动更新（可在「后台任务」查看进度）。', 'Started background task to improve this question (check Tasks for progress).'),
        toast: {
          message: isPrereq ? t(lang, '前置题生成任务已启动', 'Prerequisite task started') : t(lang, '修题任务已启动', 'Improve task started'),
          tone: 'success',
        },
      };
    }

    case 'note.qa.add': {
      if (!cardId || !deckId) return needCardOutcome(lang, '存到笔记', 'save to notes');
      let followupId: string | undefined;
      if (lastAssistantReply && lastAssistantReply.trim()) {
        const fuRes = await tryAction<{ item?: { id?: string } }>(host, 'card.followup.add', {
          deckId,
          cardId,
          question: t(lang, '助手解答', 'Assistant Q&A'),
          answer: lastAssistantReply.trim(),
          source: 'assistant',
          silent: true,
          replace: true,
        });
        if (fuRes.ok && fuRes.value?.item?.id) followupId = fuRes.value.item.id;
      }
      const noteTitle = `${t(lang, '学习笔记', 'Study Note')} · ${cardCtx?.topic || cardCtx?.prompt?.slice(0, 18) || t(lang, '当前题', 'Card')}`;
      const res = await tryAction<{ status?: string; note?: { title?: string } }>(host, 'note.qa.add', {
        title: noteTitle,
        deckId,
        cardId,
        language: lang,
        ...(followupId ? { followupId } : {}),
      });
      if (!res.ok) {
        return {
          succeeded: false,
          actionSummary: t(lang, '写入笔记失败', 'Save to notes failed'),
          text: res.error?.message || t(lang, '保存到学习笔记失败，请重试。', 'Failed to save to study notes.'),
        };
      }
      const title = res.value?.note?.title || noteTitle;
      return {
        succeeded: true,
        actionSummary: t(lang, '已存入学习笔记', 'Saved to study notes'),
        text: t(lang, `已将当前题目与解答保存到学习笔记「${title}」。`, `Saved to study note "${title}".`),
        toast: { message: t(lang, '已存入学习笔记', 'Saved to notes'), tone: 'success' },
      };
    }

    case 'card.flag': {
      if (!cardId || !deckId) return needCardOutcome(lang, '标记题目问题', 'flag this question');
      const reason = typeof intent.params.reason === 'string' && intent.params.reason.trim()
        ? intent.params.reason.trim()
        : t(lang, '需复核/待改进', 'Flagged via assistant');
      const res = await tryAction(host, 'card.flag', { deckId, cardId, reason });
      if (!res.ok) {
        return {
          succeeded: false,
          actionSummary: t(lang, '标记失败', 'Flag failed'),
          text: res.error?.message || t(lang, '标记题目失败，请重试。', 'Failed to flag question.'),
        };
      }
      return {
        succeeded: true,
        actionSummary: t(lang, '已标记题目有问题', 'Flagged question'),
        text: t(lang, '已为本题添加问题标记。按 [z] 可撤销。', 'Flagged this question. Press [z] to undo.'),
        undo: {
          label: t(lang, '取消问题标记', 'Clear question flag'),
          run: async () => {
            await tryAction(host, 'card.flag', { deckId, cardId, reason: '' });
            return t(lang, '已撤销：题目问题标记已清除。', 'Undone: question flag cleared.');
          },
        },
        toast: { message: t(lang, '已标记题目问题', 'Question flagged'), tone: 'success' },
      };
    }

    case 'review.grade.adjust': {
      if (!runId || !cardId) return needCardOutcome(lang, '改判评分', 'adjust grade');
      const grade = typeof intent.params.grade === 'number' ? intent.params.grade : 4;
      const res = await tryAction(host, 'review.grade.adjust', {
        runId,
        cardId,
        ...(typeof intent.params.entryIndex === 'number' ? { entryIndex: intent.params.entryIndex } : {}),
        grade,
      });
      if (!res.ok) {
        return {
          succeeded: false,
          actionSummary: t(lang, '改判失败', 'Grade adjustment failed'),
          text: res.error?.message || t(lang, '当前题目无法改判评分（仅 AI 批改题支持改判）。', 'Could not adjust grade for this card.'),
        };
      }
      return {
        succeeded: true,
        actionSummary: t(lang, `已改判评分为 ${grade} 分`, `Adjusted grade to ${grade}`),
        text: t(lang, `已完成：本题评分已改判为 ${grade} 分并同步更新复习计划。`, `Adjusted grade to ${grade} and updated schedule.`),
        toast: { message: t(lang, `评分已改判为 ${grade} 分`, `Grade adjusted to ${grade}`), tone: 'success' },
      };
    }

    case 'review.correction.ack': {
      if (!runId || !cardId) return needCardOutcome(lang, '确认订正', 'acknowledge correction');
      const res = await tryAction(host, 'review.correction.ack', {
        runId,
        cardId,
        ...(typeof intent.params.entryIndex === 'number' ? { entryIndex: intent.params.entryIndex } : {}),
      });
      if (!res.ok) {
        return {
          succeeded: false,
          actionSummary: t(lang, '确认订正失败', 'Correction ack failed'),
          text: res.error?.message || t(lang, '当前题目没有待确认的订正项。', 'No pending correction to acknowledge.'),
        };
      }
      return {
        succeeded: true,
        actionSummary: t(lang, '已确认订正并加入重练', 'Correction acknowledged'),
        text: t(lang, '已完成：订正已确认，已安排在本轮末尾重练。', 'Correction acknowledged and queued for retry.'),
        toast: { message: t(lang, '已确认订正', 'Correction acknowledged'), tone: 'success' },
      };
    }

    case 'coach.practice': {
      const res = await tryAction<{ id?: string }>(host, 'coach.practice', {});
      if (!res.ok || !res.value?.id) {
        return {
          succeeded: false,
          actionSummary: t(lang, '暂无可用变式题', 'No variants ready'),
          text: res.error?.message || t(lang, '还没有备好的错题变式题，可在错题本先生成变式。', 'No prepared variant questions available yet.'),
        };
      }
      useTuiStore.setState({ activeRunId: res.value.id });
      navigate('review', { runId: res.value.id });
      return {
        succeeded: true,
        actionSummary: t(lang, '已开启错题变式练习', 'Started variant practice'),
        text: t(lang, '已开启错题变式练习并进入刷题页。', 'Started wrong-card variant practice and switched to Review.'),
        toast: { message: t(lang, '已开启错题变式练习', 'Variant practice started'), tone: 'success' },
      };
    }

    case 'review.start': {
      const res = await tryAction<{ id?: string }>(host, 'review.start', intent.params);
      if (!res.ok || !res.value?.id) {
        return {
          succeeded: false,
          actionSummary: t(lang, '开启错题练习失败', 'Failed to start practice'),
          text: res.error?.message || t(lang, '当前范围暂无可练习的错题。', 'No wrong cards available in this scope.'),
        };
      }
      useTuiStore.setState({ activeRunId: res.value.id });
      navigate('review', { runId: res.value.id });
      return {
        succeeded: true,
        actionSummary: t(lang, '已开启错题重练', 'Started wrong-cards round'),
        text: t(lang, '已开启新一轮错题重练并进入刷题页。', 'Started a fresh wrong-cards round and switched to Review.'),
        toast: { message: t(lang, '已开启错题重练', 'Wrong-cards round started'), tone: 'success' },
      };
    }

    case 'card.slay': {
      if (!cardId || !deckId) return needCardOutcome(lang, '斩题', 'slay this question');
      const res = await tryAction(host, 'card.slay', { deckId, cardId, ...(runId ? { runId } : {}) });
      if (!res.ok) {
        return {
          succeeded: false,
          actionSummary: t(lang, '斩题失败', 'Slay failed'),
          text: res.error?.message || t(lang, '斩题失败，请重试。', 'Failed to slay card.'),
        };
      }
      return {
        succeeded: true,
        actionSummary: t(lang, '已斩题', 'Card slain'),
        text: t(lang, '已完成：本题已移入斩题组。按 [z] 可恢复到原题组。', 'Moved card to Slain deck. Press [z] to restore.'),
        undo: {
          label: t(lang, '恢复斩题', 'Restore slain card'),
          run: async () => {
            await tryAction(host, 'card.restore', { cardId });
            return t(lang, '已撤销：题目已恢复到原题组。', 'Undone: card restored to original deck.');
          },
        },
        toast: { message: t(lang, '已斩题', 'Card slain'), tone: 'success' },
      };
    }

    case 'card.suspend': {
      if (!cardId || !deckId) return needCardOutcome(lang, '暂停或恢复题目', 'suspend/resume this question');
      const suspended = intent.params.suspended !== false;
      const res = await tryAction(host, 'card.suspend', { deckId, cardId, suspended });
      if (!res.ok) {
        return {
          succeeded: false,
          actionSummary: t(lang, '更新状态失败', 'Update failed'),
          text: res.error?.message || t(lang, '更新题目暂停状态失败。', 'Failed to update card suspend state.'),
        };
      }
      return {
        succeeded: true,
        actionSummary: suspended ? t(lang, '已暂停本题', 'Card suspended') : t(lang, '已恢复本题', 'Card resumed'),
        text: suspended
          ? t(lang, '已完成：本题已暂停，将离开每日复习队列。按 [z] 可撤销。', 'Card suspended from daily queue. Press [z] to undo.')
          : t(lang, '已完成：本题已恢复到复习队列。按 [z] 可撤销。', 'Card resumed in queue. Press [z] to undo.'),
        undo: {
          label: suspended ? t(lang, '恢复本题', 'Resume card') : t(lang, '暂停本题', 'Suspend card'),
          run: async () => {
            await tryAction(host, 'card.suspend', { deckId, cardId, suspended: !suspended });
            return t(lang, '已撤销：题目暂停状态已还原。', 'Undone: suspend state restored.');
          },
        },
        toast: { message: suspended ? t(lang, '已暂停本题', 'Card suspended') : t(lang, '已恢复本题', 'Card resumed'), tone: 'success' },
      };
    }

    case 'card.focus': {
      if (!cardId) return needCardOutcome(lang, '标记考纲重点', 'toggle focus star');
      const focus = intent.params.focus !== false;
      const res = await tryAction<{ focus?: boolean }>(host, 'card.focus', {
        ...(deckId ? { deckId } : {}),
        cardId,
        focus,
      });
      if (!res.ok) {
        return {
          succeeded: false,
          actionSummary: t(lang, '更新重点失败', 'Focus toggle failed'),
          text: res.error?.message || t(lang, '更新考纲重点标记失败。', 'Failed to toggle focus mark.'),
        };
      }
      const applied = typeof res.value?.focus === 'boolean' ? res.value.focus : focus;
      return {
        succeeded: true,
        actionSummary: applied ? t(lang, '已标为考纲重点', 'Marked as Focus') : t(lang, '已取消重点标记', 'Removed Focus'),
        text: applied
          ? t(lang, '已完成：已收藏为考纲重点，将优先安排复习。按 [z] 可撤销。', 'Marked as Focus for priority review. Press [z] to undo.')
          : t(lang, '已完成：已取消考纲重点标记。按 [z] 可撤销。', 'Removed Focus mark. Press [z] to undo.'),
        undo: {
          label: applied ? t(lang, '取消重点标记', 'Remove Focus') : t(lang, '恢复重点标记', 'Restore Focus'),
          run: async () => {
            await tryAction(host, 'card.focus', { ...(deckId ? { deckId } : {}), cardId, focus: !applied });
            return t(lang, '已撤销：重点标记已还原。', 'Undone: focus mark restored.');
          },
        },
        toast: { message: applied ? t(lang, '已收藏为考纲重点', 'Marked as Focus') : t(lang, '已取消重点标记', 'Removed Focus'), tone: 'success' },
      };
    }

    case 'review.undo': {
      if (!runId) return needCardOutcome(lang, '撤销评分', 'undo last rating');
      const res = await tryAction(host, 'review.undo', { runId });
      if (!res.ok) {
        return {
          succeeded: false,
          actionSummary: t(lang, '撤销失败', 'Undo failed'),
          text: res.error?.message || t(lang, '当前没有可撤销的评分记录。', 'Nothing to undo in this round.'),
        };
      }
      return {
        succeeded: true,
        actionSummary: t(lang, '已撤销上一题评分', 'Undid last rating'),
        text: t(lang, '已完成：已撤销本轮最近一次作答评分并恢复进度。', 'Undid the last rating in this round.'),
        toast: { message: t(lang, '已撤销上一题评分', 'Undid last rating'), tone: 'success' },
      };
    }

    case 'review.queue.edit': {
      if (!runId || !cardId) return needCardOutcome(lang, '调整本轮题序', 'reorder the queue');
      const ref = { ...(deckId ? { deckId } : {}), cardId };
      const res = await tryAction(host, 'review.queue.edit', {
        runId,
        remove: [ref],
        add: [ref],
        position: 'end',
        allowCurrent: true,
      });
      if (!res.ok) {
        return {
          succeeded: false,
          actionSummary: t(lang, '调整题序失败', 'Queue edit failed'),
          text: res.error?.message || t(lang, '当前题目已作答或无法移动，未调整题序。', 'Could not move this card in the queue.'),
        };
      }
      return {
        succeeded: true,
        actionSummary: t(lang, '已将本题挪到本轮最后', 'Moved card to end'),
        text: t(lang, '已完成：本题已移至本轮练习队列末尾。', 'Moved this question to the end of the round.'),
        toast: { message: t(lang, '已挪到本轮最后', 'Moved to end of queue'), tone: 'success' },
      };
    }
  }
}
