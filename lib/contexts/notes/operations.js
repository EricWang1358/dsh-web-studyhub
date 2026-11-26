import { ownWork } from '../../runtime/work-ownership.js';
import { required, get, id } from "../../util.js";
import {
  checkNoteRevision,
  publishNoteLink,
  createNote,
  saveNote,
  isDailyWriting,
  noteView,
  openQuestionDraftHolding,
  openDailyCourseDraft,
  questionNotesNeedReconciliation,
  reconcileQuestionNotes,
} from "../../blog-notes.js";
import { findCard } from "../../prereq.js";
import {
  questionNote,
  appendQuestionEntries,
  followupOf,
  withQa,
  holdsQa,
  noteStudyDay,
  parseAutoQuestionNoteTitle,
  formatDailyQuestionNoteTitle,
  inferNoteCardsCourse,
} from './question-note.js';
import { blogGenerationInput } from "../../blog-generation.js";
import { pendingGeneration } from "./pending-generation.js";
import { NOTE_MESSAGES } from "./jobs/messages.js";
import { noteGenerateExecutor } from "./jobs/submit-note-generate.js";
import { lookupCsdnArticle, csdnRecentIds, csdnHome } from "../../adapters/csdn-public.js";
import { createDailyOperations, dailyNoteView, dailyRecapsNeedReconciliation, isRunning, stampGeneration, trackGeneration } from './daily.js';
import { noteMaterial } from '../../note-material.js';



/** notes operations close over only the ports declared by this context. */
export function createOperations(ports) {
  const { state: storagePort, complete: providedComplete, language: providedLanguage, workOwner: providedWorkOwner } = ports;
  const { noteJobs } = ports.work;
  // How a draft is carried out: in process, or as a Job of the unified runtime (jobs/submit-note-generate.js, the one reader of runtime.pilot.noteGenerate).
  const startDraft = noteGenerateExecutor({ worker: ports.worker, store: storagePort, complete: providedComplete });
const handlers = {
...createDailyOperations(ports),
"note.material.prepare": async a => {
      const state = await storagePort.view(), note = get(state.notes, a.id, '笔记');
      checkNoteRevision(note, a.expectedRevision);
      return noteMaterial(dailyNoteView(state, note));
    },
"note.generate": async function (a) {
      if (!providedComplete) throw new Error("请先选择用于起草笔记的模型");
      const state = await storagePort.read();
      const note = get(state.notes, a.id, "笔记");
      if (isDailyWriting(note)) throw new Error('每日总结请使用「更新今日总结」');
      if (note.status !== "draft") throw new Error("已发布文章不能重新起草");
      checkNoteRevision(note, a.expectedRevision);
      const revision = note.revision || 0;
      const key = `${storagePort.root}:${note.id}`;
      if (noteJobs.has(key) && isRunning(note.generation)) return { id: note.id, jobId: note.generation.id, status: "running" };
      const cards = blogGenerationInput(state, note, providedLanguage);
      const jobId = id();
      // What every caller stops the draft by (a cancelled draft, a deleted note, an unloaded plugin): `pending.controller.abort`; a Job is stopped through the Job.
      const controller = new AbortController(), pending = ownWork(pendingGeneration(controller), providedWorkOwner);
      const untrack = trackGeneration(jobId, controller.signal);
      try {
        await storagePort.update((current) => {
          const latest = get(current.notes, note.id, "笔记");
          checkNoteRevision(latest, revision);
          noteJobs.get(key)?.controller?.abort(new Error("Generation superseded"));
          latest.generation = stampGeneration({ id: jobId, startedAt: new Date().toISOString() });
        });
        noteJobs.set(key, pending);
        const job = { noteId: note.id, jobId, revision, title: note.title, cards, signal: controller.signal, pending };
        const { done } = await startDraft(job);
        pending.task = done.finally(() => {
          untrack();
          if (noteJobs.get(key) === pending) noteJobs.delete(key);
        });
        return { id: note.id, jobId, status: "running" };
      } catch (error) {
        untrack();
        if (noteJobs.get(key) === pending) noteJobs.delete(key);
        throw error;
      }
    },
"note.cancel": async function (a) {
      const snapshot = await storagePort.read();
      const target = get(snapshot.notes, a.id, "笔记");
      if (target.kind === "daily-recap") return handlers["note.daily.cancel"](a);
      const result = await storagePort.update((current) => {
        const latest = get(current.notes, a.id, "笔记");
        if (latest.generation?.status === "running") {
          latest.generation = { ...latest.generation, status: "cancelled", message: NOTE_MESSAGES.cancelled };
          delete latest.generation.progress;
        }
        return dailyNoteView(current, latest);
      });
      noteJobs.get(`${storagePort.root}:${a.id}`)?.controller?.abort(new Error("Generation cancelled"));
      return result;
    },
"note.list": async function () {
      const state = await storagePort.read();
      return { home: state.csdnHome || "", notes: (state.notes || []).map(note => dailyNoteView(state, note)) };
    },
"note.get": async function (a) {
      const state = await storagePort.read();
      return dailyNoteView(state, get(state.notes, a.id, "笔记"));
    },
"note.lookup": async function (a) {
      const state = await storagePort.read();
      const note = get(state.notes, a.id, "笔记");
      checkNoteRevision(note, a.expectedRevision);
      if (!state.csdnHome) throw new Error("请先设置 CSDN 公开博客主页");
      const result = await lookupCsdnArticle(state.csdnHome, note.title);
      const candidate = result.matches[0];
      const articleId = candidate && Number(candidate.split("/").at(-1));
      if (result.matches.length === 1 && Number.isSafeInteger(note.publishBaselineMaxId) &&
          articleId > note.publishBaselineMaxId) {
        const linked = await storagePort.update((current) => {
          const latest = get(current.notes, a.id, "笔记");
          if (latest.status !== "draft" || latest.publishBaselineMaxId !== note.publishBaselineMaxId || (latest.revision || 0) !== (note.revision || 0))
            return null;
          return publishNoteLink(current, { id: a.id, url: candidate });
        });
        if (linked) return { ...result, linked };
      }
      return { ...result, matched: false,
        reason: result.matches.length === 1 ? "找到同名文章，但无法确认它是在本次草稿之后发布的，请核对后关联" : result.reason };
    },
"note.preparePublish": async function (a) {
      const state = await storagePort.read();
      const note = get(state.notes, a.id, "笔记");
      if (note.status !== "draft") throw new Error("这篇笔记已发布");
      if (!state.csdnHome) return { autoLookupReady: false,
        reason: "尚未设置 CSDN 公开主页，发布后可手动关联" };
      const ids = await csdnRecentIds(state.csdnHome);
      if (!ids.length) return { autoLookupReady: false,
        reason: "暂时无法确认公开主页的文章列表，发布后请手动核对链接" };
      await storagePort.update((current) => {
        const latest = get(current.notes, a.id, "笔记");
        if (latest.status !== "draft") throw new Error("这篇笔记已发布");
        latest.publishBaselineMaxId = Math.max(...ids);
      });
      return { autoLookupReady: true };
    }
};
const mutations = {
"note.home": (s, a) => {
      s.csdnHome = csdnHome(required(a.home, "CSDN 公开主页"));
      return { home: s.csdnHome };
    },
"note.create": (s, a) => {
      if (questionNotesNeedReconciliation(s, { isRunning })) reconcileQuestionNotes(s, { isRunning });
      const lang = a.language || providedLanguage;
      const created = createNote(s, { ...a, ...(lang ? { language: lang } : {}), isRunning });
      const stored = get(s.notes, created.id, "笔记");
      // 写笔记 under a question (prefill): a brand-new note starts with what the card holds; a same-day + same-course append adds the new card's section separated by `\n\n---\n\n`.
      if (a.prefill === true && !created.reused) {
        if (created.appended?.length) {
          const appended = appendQuestionEntries(s, stored.markdown, stored.followupIds, created.appended, lang);
          stored.markdown = appended.markdown;
          stored.followupIds = appended.followupIds;
          return { ...noteView(s, stored), appended: created.appended };
        }
        Object.assign(stored, questionNote(s, stored.cards, stored.title, lang));
        return noteView(s, stored);
      }
      return stored.generation ? { ...dailyNoteView(s, stored), ...(created.reused ? { reused: true } : {}) } : created;
    },
// 存进笔记 under a Q&A: into today's course study note (or an open question draft already holding this card), appending a new question's block when needed; once per follow-up.
"note.qa.add": (s, a) => {
      if (questionNotesNeedReconciliation(s, { isRunning })) reconcileQuestionNotes(s, { isRunning });
      const lang = a.language || providedLanguage;
      const { deck, card } = findCard(s, a), followup = followupOf(card, a.followupId), cards = [{ deckId: deck.id, cardId: card.id }];
      const open = openQuestionDraftHolding(s, cards);
      if (!open) {
        const parsed = parseAutoQuestionNoteTitle(a.title);
        const day = a.day || parsed?.day || noteStudyDay(s);
        const course = inferNoteCardsCourse(s, cards);
        const daily = course !== null ? openDailyCourseDraft(s, { day, course, isRunning: () => false }) : undefined;
        if (!daily) {
          const title = typeof a.title === "string" && a.title.trim()
            ? a.title
            : formatDailyQuestionNoteTitle({ day, course, language: lang });
          const created = mutations["note.create"](s, { title, cards, reuse: true, prefill: true, language: lang });
          return { status: "created", note: created };
        }
        if (isRunning(daily.generation)) throw new Error("AI 正在起草这篇笔记，等它写完再存进笔记");
        let { markdown: nextMarkdown, followupIds: nextFollowups } = appendQuestionEntries(s, daily.markdown, daily.followupIds, cards, lang);
        if (!holdsQa(nextMarkdown, followup)) nextMarkdown = withQa(nextMarkdown, followup, lang);
        if (!nextFollowups.includes(followup.id)) nextFollowups = [...nextFollowups, followup.id];
        const autoTitle = parseAutoQuestionNoteTitle(daily.title);
        const nextTitle = autoTitle && (autoTitle.legacy || (course && !autoTitle.course))
          ? formatDailyQuestionNoteTitle({ day: autoTitle.day, course, language: lang || autoTitle.language })
          : undefined;
        saveNote(s, { id: daily.id, ...(nextTitle ? { title: nextTitle } : {}), cards: [...daily.cards, ...cards], markdown: nextMarkdown, expectedRevision: daily.revision || 0 });
        daily.followupIds = nextFollowups;
        daily.day ||= day;
        return { status: "added", note: noteView(s, daily) };
      }
      // Saved means recorded AND still in the text: a Q&A the learner deleted, or a recovered draft saved over, is added again.
      if ((open.followupIds || []).includes(followup.id) && holdsQa(open.markdown, followup)) return { status: "unchanged", note: noteView(s, open) };
      // While an AI draft is being written for the note, an edit would supersede it and waste the model call: refused, the draft goes on.
      if (isRunning(open.generation)) throw new Error("AI 正在起草这篇笔记，等它写完再存进笔记");
      // Through note.save's own checks (length, revision): a learner's later save of an older revision is refused, never lost.
      saveNote(s, { id: open.id, markdown: withQa(open.markdown, followup, lang), expectedRevision: open.revision || 0 });
      open.followupIds = [...(open.followupIds || []).filter(fid => fid !== followup.id), followup.id];
      return { status: "added", note: noteView(s, open) };
    },
// Composite atomic Q&A save (#1354 D7 / P3): upsert card follow-up + append into study note in one transaction.
// Any validation or running-draft refusal throws before commit, leaving both decks and notes untouched.
"note.qa.save": (s, a) => {
      const followupRes = ports.ports.mutate("card.followup.add", s, {
        ...(a.deckId !== undefined ? { deckId: a.deckId } : {}),
        cardId: a.cardId,
        question: a.question,
        answer: a.answer,
        ...(a.source !== undefined ? { source: a.source } : {}),
        ...(a.kind !== undefined ? { kind: a.kind } : {}),
        ...(a.terms !== undefined ? { terms: a.terms } : {}),
        ...(a.deeper !== undefined ? { deeper: a.deeper } : {}),
        // Same default as card.followup.add: a learner's saved follow-up is overwritten only on an explicit replace:true.
        replace: a.replace === true,
        silent: a.silent !== false,
      });
      const noteRes = mutations["note.qa.add"](s, {
        deckId: followupRes.deckId,
        cardId: followupRes.cardId,
        followupId: followupRes.item.id,
        ...(a.title !== undefined ? { title: a.title } : {}),
        ...(a.day !== undefined ? { day: a.day } : {}),
        ...(a.language !== undefined ? { language: a.language } : {}),
      });
      return {
        deckId: followupRes.deckId,
        cardId: followupRes.cardId,
        item: followupRes.item,
        ...(followupRes.replaced ? { replaced: true } : {}),
        status: noteRes.status,
        note: noteRes.note,
      };
    },
"note.save": (s, a) => {
      const note = saveNote(s, a);
      if (note.kind === 'daily-recap' && note.generation?.status === 'superseded')
        noteJobs.get(`${storagePort.root}:${note.id}`)?.controller?.abort(new Error('Note edited'));
      const stored = get(s.notes, note.id, "笔记");
      return stored.generation ? dailyNoteView(s, stored) : note;
    },
"note.link": (s, a) => publishNoteLink(s, a),
"note.delete": (s, a) => {
      const note = get(s.notes, a.id, "笔记");
      s.notes.splice(s.notes.indexOf(note), 1);
      noteJobs.get(`${storagePort.root}:${note.id}`)?.controller?.abort(new Error('Note deleted'));
      return { id: a.id };
    }
};
  // Persisted course aliases and stale recap metadata are the durable retry condition.
  // A failed post-commit course hook is repaired on the next public note read, even after restart.
  for (const action of ['note.list', 'note.get', 'note.material.prepare', 'note.daily.status', 'note.daily.generate', 'note.daily.advance']) {
    const handle = handlers[action];
    handlers[action] = async args => {
      const snapshot = await storagePort.view();
      if (dailyRecapsNeedReconciliation(snapshot)) await handlers['note.daily.reconcile']();
      if (questionNotesNeedReconciliation(snapshot, { isRunning })) {
        await storagePort.update(state => { reconcileQuestionNotes(state, { isRunning }); });
      }
      return handle(args);
    };
  }
  return { handlers, mutations };
}
