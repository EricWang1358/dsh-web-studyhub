import { id } from '../../util.js';
import { ownWork } from '../../runtime/work-ownership.js';
import { noteView, checkNoteRevision } from '../../blog-notes.js';
import { normalizeDailyRecapSettings } from '../../daily-recap-settings.js';
import { recapGroups, recapStatus, recapRunDays, recapCourses } from '../../daily-recap.js';
import { recapTitle, RECAP_BATCH_SIZE, runDailyGeneration } from './daily-generation.js';

const liveGenerations = new Set();
const session = id();
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
  const view = generation?.status === 'running' && !isRunning(generation)
    ? { ...generation, status: 'interrupted', message: '上次生成已中断，可以重新生成' } : generation;
  if (!view || view.status === 'running') return view;
  const { progress: _progress, ...settled } = view;
  return settled;
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
    let job;
    const response = await store.update(state => {
      const current = recapGroups(state, { ...args, timeZone: initial.timeZone, day: initial.day }).groups[0];
      if (!current?.eligible) throw new Error('当天同一课程累计完成 10 道不同题目后，才可生成每日总结');
      let note = current.note;
      if (note) checkNoteRevision(note, args.expectedRevision);
      if (note?.daily.manualEditedAt && args.force !== true) return { id: note.id, status: 'protected', daily: note.daily };
      if (automatic && !normalizeDailyRecapSettings(state.settings?.dailyRecap).automatic) return { id: note?.id, status: 'disabled' };
      const key = note && `${store.root}:${note.id}`, existingJob = key && noteJobs.get(key);
      if (note && isRunning(note.generation)) {
        if (note.generation.fingerprint !== current.fingerprint || (final && !note.generation.final) || note.daily.tone !== tone) {
          const next = { course: current.courseId, day: current.day, timeZone: current.timeZone,
            final: final || note.generation.next?.final === true, tone, automatic, ...(args.force ? { force: true } : {}) };
          note.generation.next = next;
          if (existingJob) existingJob.next = next;
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
      existingJob?.controller?.abort(new Error('Generation superseded'));
      note.daily = { ...note.daily, courseId: current.courseId, course: current.course, tone,
        answeredCount: current.answeredCount, wrongCount: current.wrongCount, unassessedCount: current.unassessedCount };
      note.cards = current.questions.map(({ deckId, cardId }) => ({ deckId, cardId }));
      note.generation = { id: jobId, status: 'running', startedAt: new Date().toISOString(), fingerprint: current.fingerprint,
        final, revision: note.revision || 0, pid: process.pid, session,
        progress: { phase: 'explaining', completed: 0, total: Math.ceil(current.questions.length / RECAP_BATCH_SIZE) } };
      const pending = ownWork({ controller, next: null }, workOwner);
      job = { id: jobId, noteId: note.id, group: current, tone, final, force: args.force === true, automatic, controller, pending };
      noteJobs.set(`${store.root}:${note.id}`, pending);
      liveGenerations.add(jobId);
      return { id: note.id, jobId, status: 'running', daily: note.daily };
    });
    if (response.daily) { const { fragments: _fragments, ...daily } = response.daily; response.daily = daily; }
    if (!job) return response;
    const key = `${store.root}:${job.noteId}`, { pending } = job;
    const task = Promise.resolve().then(async () => {
      let successful;
      try {
        successful = await runDailyGeneration({ store, complete, language, job });
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
        if (note.generation?.status === 'running') {
          note.generation = { ...note.generation, status: 'cancelled', message: '已取消生成，可稍后重新生成' };
          delete note.generation.progress;
        }
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
            delete note.generation.progress;
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
              delete changed.generation.progress;
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
