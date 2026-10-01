import { ownWork } from '../../runtime/work-ownership.js';
import { required, get, id } from "../../util.js";
import { checkNoteRevision, noteView, publishNoteLink, createNote, saveNote } from "../../blog-notes.js";
import { blogGenerationInput, blogGenerationSystem, checkedBlogMarkdown } from "../../blog-generation.js";
import { notify } from "../../inbox.js";
import { lookupCsdnArticle, csdnRecentIds, csdnHome } from "../../adapters/csdn-public.js";



/** notes operations close over only the ports declared by this context. */
export function createOperations(ports) {
  const { state: storagePort, complete: providedComplete, workOwner: providedWorkOwner } = ports;
  const { noteJobs } = ports.work;
const handlers = {
"note.generate": async function (a) {
      if (!providedComplete) throw new Error("请先选择用于起草笔记的模型");
      const state = await storagePort.read();
      const note = get(state.notes, a.id, "笔记");
      if (note.status !== "draft") throw new Error("已发布文章不能重新起草");
      checkNoteRevision(note, a.expectedRevision);
      const revision = note.revision || 0;
      const key = `${storagePort.root}:${note.id}`;
      if (noteJobs.has(key) && note.generation?.status === 'running') return { id: note.id, status: "running" };
      const cards = blogGenerationInput(state, note);
      const jobId = id();
      await storagePort.update((current) => {
        const latest = get(current.notes, note.id, "笔记");
        checkNoteRevision(latest, revision);
        latest.generation = { id: jobId, status: "running", startedAt: new Date().toISOString() };
      });
      const controller = new AbortController();
      const work = Promise.resolve().then(async () => {
        try {
          const raw = await providedComplete(blogGenerationSystem,
            JSON.stringify({ articleTitle: note.title, cards }), { signal: controller.signal });
          controller.signal.throwIfAborted();
          const markdown = checkedBlogMarkdown(raw);
          await storagePort.update((current) => {
            const latest = get(current.notes, note.id, "笔记");
            if (latest.status !== "draft" || latest.generation?.id !== jobId || (latest.revision || 0) !== revision) return;
            latest.markdown = markdown;
            latest.revision = revision + 1;
            latest.updatedAt = new Date().toISOString();
            latest.generation = { id: jobId, status: "done", finishedAt: latest.updatedAt };
            notify(current, { kind: "note", ...latest.cards[0], noteId: note.id,
              detail: `笔记草稿「${note.title}」已生成，请审阅后发布` });
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          await storagePort.update((current) => {
            const latest = get(current.notes, note.id, "笔记");
            if (latest.generation?.id === jobId && latest.generation.status === "running")
              latest.generation = { id: jobId, status: "failed", message: String(error.message).slice(0, 300) };
          });
        } finally { if (noteJobs.get(key) === work) noteJobs.delete(key); }
      });
      ownWork(work, providedWorkOwner); work.controller = controller;
      noteJobs.set(key, work);
      return { id: note.id, jobId, status: "running" };
    },
"note.list": async function () {
      const state = await storagePort.read();
      return { home: state.csdnHome || "", notes: (state.notes || []).map(note => noteView(state, note)) };
    },
"note.get": async function (a) {
      const state = await storagePort.read();
      return noteView(state, get(state.notes, a.id, "笔记"));
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
"note.create": (s, a) => createNote(s, a),
"note.save": (s, a) => saveNote(s, a),
"note.link": (s, a) => publishNoteLink(s, a),
"note.delete": (s, a) => {
      const note = get(s.notes, a.id, "笔记");
      s.notes.splice(s.notes.indexOf(note), 1);
      return { id: a.id };
    }
};
  return { handlers, mutations };
}
