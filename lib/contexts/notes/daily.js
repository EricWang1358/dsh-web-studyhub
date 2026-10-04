import { id } from '../../util.js';
import { ownWork } from '../../runtime/work-ownership.js';
import { notify } from '../../inbox.js';
import { noteView, checkNoteRevision } from '../../blog-notes.js';
import { normalizeDailyRecapSettings } from '../../daily-recap-settings.js';
import { recapGroups, recapStatus, recapRunDays, recapCourses, recapPrompt, checkedRecapMarkdown, recapFingerprint } from '../../daily-recap.js';

const liveGenerations = new Set();
const session = id();
const recapTitle = (daily, language) => `${daily.day} · ${daily.course} · ${language === 'en' ? 'Daily study recap' : '每日学习总结'}`.slice(0, 200);
export function dailyRecapsNeedReconciliation(state) {
  const notes = (state.notes || []).filter(note => note.kind === 'daily-recap' && note.daily);
  if (!notes.length) return false;
  const courses = recapCourses(state), groups = new Set();
  for (const note of notes) {
    const course = courses.resolve(note.daily.courseId) || courses.resolve(note.daily.course);
    if (!course) continue;
    const key = JSON.stringify([note.daily.day, course.courseId]);
    if (course.courseId !== note.daily.courseId || course.course !== note.daily.course || groups.has(key)) return true;
    groups.add(key);
  }
  return false;
}
function isRunning(generation) {
  if (generation?.status !== 'running') return false;
  if (generation.session === session) return liveGenerations.has(generation.id);
  if (generation.pid === process.pid) return false;
  try { if (generation.pid) { process.kill(generation.pid, 0); return true; } } catch { return false; }
  return false;
}
function generationView(generation) {
  return generation?.status === 'running' && !isRunning(generation)
    ? { ...generation, status: 'interrupted', message: '上次生成已中断，可以重新生成' } : generation;
}
export function dailyNoteView(state, note) {
  const view = noteView(state, note);
  if (note.kind === 'daily-recap') view.generation = generationView(note.generation);
  return view;
}

/** Daily summaries use the existing local note collection, revision guard and background-work owner. */
export function createDailyOperations({ state: store, complete, workOwner, work, language }) {
  const noteJobs = work.noteJobs;
  const generate = async (args = {}, automatic = false) => {
    const snapshot = await store.view();
    const scope = recapGroups(snapshot, args);
    const initial = scope.groups[0];
    if (!initial?.eligible) throw new Error('当天同一课程累计完成 10 道不同题目后，才可生成每日总结');
    const tone = args.tone ?? scope.tone;
    if (!['friendly', 'professional'].includes(tone)) throw new Error('总结口吻请选择亲切或专业');
    const final = args.final === true;
    const jobId = id(), controller = new AbortController();
    let started = false, group, noteId, revision;
    const response = await store.update(state => {
      const current = recapGroups(state, { ...args, timeZone: initial.timeZone, day: initial.day }).groups[0];
      if (!current?.eligible) throw new Error('当天同一课程累计完成 10 道不同题目后，才可生成每日总结');
      let note = current.note;
      if (note) checkNoteRevision(note, args.expectedRevision);
      if (note?.daily.manualEditedAt && args.force !== true) return { id: note.id, status: 'protected', daily: note.daily };
      if (automatic && !normalizeDailyRecapSettings(state.settings?.dailyRecap).automatic) return { id: note?.id, status: 'disabled' };
      const key = note && `${store.root}:${note.id}`, pending = key && noteJobs.get(key);
      if (note && isRunning(note.generation)) {
        if (note.generation.fingerprint !== current.fingerprint || (final && !note.generation.final) || note.daily.tone !== tone) {
          const next = { course: current.courseId, day: current.day, timeZone: current.timeZone,
            final: final || note.generation.next?.final === true, tone, automatic, ...(args.force ? { force: true } : {}) };
          note.generation.next = next;
          if (pending) pending.next = next;
        }
        return { id: note.id, jobId: note.generation.id, status: 'running', daily: note.daily };
      }
      if (note && note.daily.fingerprint === current.fingerprint && note.daily.tone === tone && (!final || note.daily.final) && args.force !== true)
        return { id: note.id, status: 'done', daily: note.daily };
      // A failed automatic checkpoint is retried only after evidence changes or by an explicit manual request.
      if (automatic && note?.generation?.status === 'failed' && note.generation.fingerprint === current.fingerprint)
        return { id: note.id, status: 'failed', generation: note.generation };
      if (!complete) throw new Error('请先选择用于每日总结的模型');
      if (!note) {
        const now = new Date().toISOString();
        note = { id: id(), kind: 'daily-recap', title: recapTitle(current, language),
          status: 'draft', markdown: '', cards: [], revision: 0, createdAt: now, updatedAt: now,
          daily: { day: current.day, courseId: current.courseId, course: current.course, timeZone: current.timeZone } };
        state.notes.push(note);
      }
      pending?.controller?.abort(new Error('Generation superseded'));
      note.daily = { ...note.daily, courseId: current.courseId, course: current.course, tone,
        answeredCount: current.answeredCount, wrongCount: current.wrongCount, unassessedCount: current.unassessedCount };
      note.cards = current.questions.map(({ deckId, cardId }) => ({ deckId, cardId }));
      revision = note.revision || 0;
      note.generation = { id: jobId, status: 'running', startedAt: new Date().toISOString(), fingerprint: current.fingerprint, final, revision, pid: process.pid, session };
      noteId = note.id; group = current; started = true;
      const pendingJob = ownWork({ controller, next: null }, workOwner);
      noteJobs.set(`${store.root}:${note.id}`, pendingJob);
      liveGenerations.add(jobId);
      return { id: note.id, jobId, status: 'running', daily: note.daily };
    });
    if (response.daily) { const { fragments: _fragments, ...daily } = response.daily; response.daily = daily; }
    if (!started) return response;
    const key = `${store.root}:${noteId}`, pending = noteJobs.get(key);
    const task = Promise.resolve().then(async () => {
      let successful = false;
      try {
        const base = { day: group.day, course: group.course, courseId: group.courseId, tone, final,
          answeredCount: group.answeredCount, wrongCount: group.wrongCount, unassessedCount: group.unassessedCount };
        const system = recapPrompt(tone, language);
        // A long day is explained in bounded batches and consolidated once; successful batches are reused.
        const chunks = [], cached = group.note?.daily.fragments || [];
        for (let offset = 0; offset < group.questions.length; offset += 30) {
          const questions = group.questions.slice(offset, offset + 30), stage = group.questions.length > 30 ? 'prepare' : 'recap';
          const fingerprint = recapFingerprint({ questions, tone, language, ...(stage === 'recap' ? { final } : {}) });
          let markdown = args.force === true ? undefined : cached.find(fragment => fragment.fingerprint === fingerprint)?.markdown;
          if (!markdown) markdown = checkedRecapMarkdown(await complete(system, JSON.stringify({ ...base, stage, questions }), { signal: controller.signal }));
          controller.signal.throwIfAborted();
          chunks.push({ fingerprint, markdown });
          if (stage === 'prepare') {
            const saved = await store.update(state => {
              const note = state.notes.find(item => item.id === noteId);
              if (!note || note.generation?.id !== jobId || note.generation.status !== 'running' || (note.revision || 0) !== note.generation.revision) return false;
              if (automatic && !normalizeDailyRecapSettings(state.settings?.dailyRecap).automatic) {
                note.generation.status = 'cancelled'; return false;
              }
              // Keep the finished writing untouched while persisting resumable explanation batches.
              const fragments = [...(note.daily.fragments || []).filter(fragment => !chunks.some(chunk => chunk.fingerprint === fragment.fingerprint)), ...chunks];
              note.daily.fragments = fragments.slice(-Math.ceil(group.questions.length / 30) * 2);
              return true;
            });
            if (!saved) return;
            controller.signal.throwIfAborted();
          }
        }
        const markdown = chunks.length === 1 ? chunks[0].markdown : checkedRecapMarkdown(await complete(system,
          JSON.stringify({ ...base, stage: 'consolidate', sections: chunks.map(chunk => chunk.markdown) }), { signal: controller.signal }));
        controller.signal.throwIfAborted();
        await store.update(state => {
          const note = state.notes.find(item => item.id === noteId);
          if (!note || note.generation?.id !== jobId || note.generation.status !== 'running' || (note.revision || 0) !== note.generation.revision) return;
          if (automatic && (!normalizeDailyRecapSettings(state.settings?.dailyRecap).automatic || note.daily.manualEditedAt)) {
            note.generation = { ...note.generation, status: 'cancelled' }; return;
          }
          pending.next = note.generation.next || pending.next;
          note.markdown = markdown; note.revision = (note.revision || 0) + 1; note.updatedAt = new Date().toISOString();
          const firstContent = !note.daily.fingerprint;
          note.daily = { ...note.daily, fingerprint: group.fingerprint, final, fragments: chunks };
          if (args.force === true) { note.title = recapTitle(group, language); delete note.daily.manualEditedAt; }
          note.generation = { id: jobId, status: 'done', fingerprint: group.fingerprint, final, finishedAt: note.updatedAt };
          successful = true;
          if (firstContent || final) notify(state, { kind: 'note', ...note.cards[0], noteId,
            detail: `「${note.daily.course}」今日学习总结已${firstContent ? '生成' : '整理'}，可直接阅读` });
        });
      } catch (error) {
        await store.update(state => {
          const note = state.notes.find(item => item.id === noteId);
          if (note?.generation?.id === jobId && note.generation.status === 'running')
            note.generation = { ...note.generation, status: controller.signal.aborted ? 'cancelled' : 'failed', message: String(error.message).slice(0, 300) };
        }).catch(() => {}); // The plugin may have been unloaded; content is already committed safely.
      } finally {
        liveGenerations.delete(jobId);
        if (noteJobs.get(key) === pending) noteJobs.delete(key);
        // Only successful work catches up. A provider failure never triggers an automatic retry loop.
        if (successful && pending.next && !controller.signal.aborted) {
          const { automatic: nextAutomatic, ...next } = pending.next;
          await generate(next, nextAutomatic).catch(() => {});
        }
      }
    });
    pending.task = task;
    return response;
  };
  return {
    'note.daily.status': async (args = {}) => {
      const result = recapStatus(await store.view(), args);
      for (const group of result.groups) group.generation = generationView(group.generation);
      return result;
    },
    'note.daily.generate': args => generate(args),
    'note.daily.advance': async (args = {}) => {
      const settings = normalizeDailyRecapSettings((await store.read(['settings'])).settings?.dailyRecap);
      if (!settings.automatic || !complete) return { generated: [] };
      const snapshot = await store.view(), scope = recapGroups(snapshot, args);
      const groups = [...scope.groups, ...recapRunDays(snapshot, args).filter(day => day !== scope.day)
        .flatMap(day => recapGroups(snapshot, { ...args, day }).groups)];
      const generated = [];
      for (const group of groups) {
        const preparedCount = group.note?.daily.answeredCount || 0;
        if (group.eligible && (!group.note || args.final || group.answeredCount >= preparedCount + 5))
          generated.push(await generate({ course: group.courseId, day: group.day, timeZone: group.timeZone, final: args.final === true }, true));
      }
      return { generated };
    },
    'note.daily.cancel': async args => {
      const result = await store.update(state => {
        const note = state.notes.find(item => item.id === args.id && item.kind === 'daily-recap');
        if (!note) throw new Error('每日总结不存在');
        if (note.generation?.status === 'running') note.generation = { ...note.generation, status: 'cancelled', message: '已取消生成，可稍后重新生成' };
        return noteView(state, note);
      });
      noteJobs.get(`${store.root}:${args.id}`)?.controller?.abort(new Error('Generation cancelled'));
      return result;
    },
    'note.daily.reconcile': async () => store.update(state => {
      const courses = recapCourses(state), grouped = new Map();
      for (const note of state.notes) if (note.kind === 'daily-recap' && note.daily) {
        const course = courses.resolve(note.daily.courseId) || courses.resolve(note.daily.course);
        if (!course) continue;
        if (note.daily.courseId !== course.courseId || note.daily.course !== course.course) {
          Object.assign(note.daily, course);
          if (!note.daily.manualEditedAt) note.title = recapTitle(note.daily, language);
          if (note.generation?.status === 'running') {
            note.generation.status = 'superseded';
            noteJobs.get(`${store.root}:${note.id}`)?.controller?.abort(new Error('Course changed'));
          }
          note.revision = (note.revision || 0) + 1;
          note.updatedAt = new Date().toISOString();
        }
        const key = JSON.stringify([note.daily.day, course.courseId]);
        const previous = grouped.get(key);
        if (!previous) grouped.set(key, note);
        else {
          // Preserve both writings through a course merge; one remains the live daily recap, the other remains readable history.
          const keep = previous.daily.manualEditedAt ? previous : note.daily.manualEditedAt ? note : previous;
          const history = keep === previous ? note : previous;
          history.kind = 'daily-recap-history'; history.daily.mergedInto = keep.id;
          for (const changed of [history, keep]) {
            if (changed.generation?.status === 'running') {
              changed.generation.status = 'superseded';
              noteJobs.get(`${store.root}:${changed.id}`)?.controller?.abort(new Error('Course merged'));
            }
            changed.revision = (changed.revision || 0) + 1;
            changed.updatedAt = new Date().toISOString();
          }
          keep.cards = [...new Map([...keep.cards, ...history.cards].map(ref => [JSON.stringify(ref), ref])).values()];
          delete keep.daily.fingerprint;
          grouped.set(key, keep);
        }
      }
      return { reconciled: true };
    }),
  };
}
