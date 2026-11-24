import { ui } from '../i18n.js';
import { contractOf } from './task-model.js';
import { isLiveStatus } from '../../lib/job-contract.js';
import { taskMaterial } from './task-material.js';
import { openCompanionTarget, resolveCompanionTarget } from '../companions/companion-ref.js';
import { writePageScope } from '../PageScope.jsx';
import { keepBook } from '../book/model.js';
import { requestOpenSourcesOrganize } from '../use-material-classify.js';

/* Where 打开结果 leads, for the console's header and for the compact card: read from the job's contract (the references to what it made) and carried out by
   the app's own navigation (`app` is the controller of ui/app/app-context.js, or anything shaped like its learn / drafts / intents / data). One place, so a
   job opens the same thing from wherever it is shown. Null when there is nothing to open (yet). */
export function resultOpener(job, app) {
  const contract = contractOf(job), refs = contract.result.refs, data = app?.data;
  const companionRef = refs.find((ref) => ref.kind === 'companion')
    || (Array.isArray(job?.result?.refs) ? job.result.refs.find((ref) => ref.kind === 'companion') : null);
  const isCompanionJob = Boolean(companionRef || contract.kind === 'companion-lesson-build' || job?.type === 'companion-lesson-build');
  if (isCompanionJob) {
    const openModal = app?.set?.setModal || app?.openModal;
    const rawCompanionId = companionRef?.id || contract.detail?.companionId || job?.result?.companionId || job?.companionId || '';
    if (!rawCompanionId || contract.status !== 'complete' || isLiveStatus(contract.status) || typeof openModal !== 'function') return null;
    const fallbackCourse = companionRef?.course || contract.detail?.course || job?.result?.course || job?.course || '';
    const target = resolveCompanionTarget({
      card: { companionRef: { companionId: rawCompanionId } },
      courses: data?.courses,
      sources: data?.sources,
      fallbackCourse,
    });
    if (!target) return null;
    const title = target.companionTitle || companionRef?.title || job?.result?.title || contract.title || '';
    return {
      kind: 'companion',
      label: ui('打开伴学页'),
      run: () => openCompanionTarget(openModal, { ...target, companionTitle: title }),
    };
  }
  const classifyRef = refs.find((ref) => ref.kind === 'material-classify')
    || (Array.isArray(job?.result?.refs) ? job.result.refs.find((ref) => ref.kind === 'material-classify') : null);
  const isClassifyJob = Boolean(classifyRef || contract.kind === 'material-classify' || job?.type === 'material-classify');
  if (isClassifyJob) {
    if (contract.status !== 'complete' || isLiveStatus(contract.status) || !(app?.nav?.navigate || app?.nav?.show?.page)) return null;
    const rawCourse = classifyRef?.course || contract.detail?.course || job?.course || data?.settings?.materialClassifyPending?.course || '';
    const targetScope = typeof rawCourse === 'string' && rawCourse.trim() ? rawCourse.trim() : '*';
    return {
      kind: 'material-classify',
      label: ui('查看分类建议'),
      run: () => {
        if (data?.root !== undefined) writePageScope(data.root, 'sources', targetScope);
        if (app.nav.navigate) app.nav.navigate('sources');
        else app.nav.show.page('sources');
      },
    };
  }
  const organizeRef = refs.find((ref) => ref.kind === 'material-organize')
    || (Array.isArray(job?.result?.refs) ? job.result.refs.find((ref) => ref.kind === 'material-organize') : null);
  const isOrganizeJob = Boolean(organizeRef || contract.kind === 'material-organize' || job?.type === 'material-organize');
  if (isOrganizeJob) {
    if (contract.status !== 'complete' || isLiveStatus(contract.status) || !(app?.nav?.navigate || app?.nav?.show?.page)) return null;
    return {
      kind: 'material-organize',
      label: ui('查看归属建议'),
      run: () => {
        requestOpenSourcesOrganize();
        app?.set?.setSourcesOrganizeOpen?.(true);
        if (app.nav.navigate) app.nav.navigate('sources');
        else app.nav.show.page('sources');
      },
    };
  }
  // A source that has since been deleted is not offered (an archived task outlives what it made); without a list of sources nothing is checked.
  const known = Array.isArray(data?.sources) ? new Set(data.sources.map((source) => source.id)) : null;
  const sourceIds = refs.filter((ref) => ref.kind === 'source' && (!known || known.has(ref.id))).map((ref) => ref.id);
  if (sourceIds.length && app?.learn?.openAudioSources) return { kind: 'source', label: ui('打开资料'), run: () => app.learn.openAudioSources(sourceIds) };
  const deck = refs.find((ref) => ref.kind === 'deck');
  if (deck && app?.intents?.openDeck && data?.decks?.some((item) => item.id === deck.id)) return { label: ui('打开题组'), run: () => app.intents.openDeck(deck.id) };
  if (contract.kind === 'assist' && contract.status === 'complete' && !isLiveStatus(contract.status)) {
    const assistDeckId = contract.detail?.deckId;
    if (assistDeckId && app?.intents?.openDeck && data?.decks?.some((item) => item.id === assistDeckId)) {
      return { label: ui('打开题组'), run: () => app.intents.openDeck(assistDeckId) };
    }
  }
  // The note an AI draft wrote (lib/contexts/notes/jobs/note-generate.js): offered while the note is still there.
  const note = refs.find((ref) => ref.kind === 'note' && Array.isArray(data?.notes) && data.notes.some((item) => item.id === ref.id));
  if (note && app?.learn?.openLearningTarget) return { label: ui('打开笔记'), run: () => app.learn.openLearningTarget({ kind: 'note', id: note.id }) };
  // A 考点清单 lives on the 备考补习 page, which lists the lists of the course and takes no id: the page is the way in.
  if (refs.some((ref) => ref.kind === 'exam-point-list') && !isLiveStatus(contract.status) && app?.nav?.show?.page) return { label: ui('打开考点清单'), run: () => app.nav.show.page('examprep') };
  // A 复习全书 is read on the dedicated 'book' page (with heading location preserved via keepBook); a 课程总纲 is shown on 'outline'.
  const bookRef = refs.find((ref) => ref.kind === 'course-book');
  if (bookRef && !isLiveStatus(contract.status) && app?.nav?.navigate) return { label: ui('打开复习全书'), run: async () => {
    const targetCourse = typeof bookRef.course === 'string' ? bookRef.course : (data?.focus?.course ?? '');
    const switched = typeof bookRef.course === 'string' && bookRef.course !== (data?.focus?.course ?? null);
    if (switched && app.core?.act) {
      if (!await app.core.act('focus.set', { course: bookRef.course })) return;
    }
    if (data?.root !== undefined) {
      keepBook(data.root, targetCourse, { target: bookRef.heading || null, ...(switched ? { switched: true } : {}) });
    }
    app.nav.navigate('book');
  } };
  const outline = refs.find((ref) => ref.kind === 'course-outline');
  if (outline && !isLiveStatus(contract.status) && app?.nav?.navigate) return { label: ui('打开总纲'), run: async () => {
    const switched = typeof outline.course === 'string' && outline.course !== (data?.focus?.course ?? null);
    if (switched && app.core?.act) {
      if (!await app.core.act('focus.set', { course: outline.course })) return;
    }
    app.nav.navigate('outline');
  } };
  const draft = refs.find((ref) => ref.kind === 'draft'), found = draft && data?.drafts?.find((item) => item.id === draft.id);
  if (found && app?.drafts?.openDraft && !isLiveStatus(contract.status)) return { label: ui('检查草稿'), run: () => app.drafts.openDraft(found, { navigation: true }) };
  return null;
}

/* Where 打开资料 of a task leads when it concerns ONE material (ui/tasks/task-material.js): the reader on that material, by the handler a row of the 资料 page ends in (learn.openAudioSources with
   one source is setModal({ type: 'source' })). { key, title, run }; null when the task has no single material that is still in the library, or the app has no such navigation. */
export function materialOpener(job, app) {
  const open = app?.learn?.openAudioSources, found = typeof open === 'function' ? taskMaterial(job, app?.data?.sources) : null;
  return found ? { key: found.key, title: found.title, run: () => open([found.openId]) } : null;
}

/* Where 在资料中查看 of a part of a question run leads (资料部分): to the first of the sources the part was written from that is still in the library, by the
   same handler 打开结果 uses for a transcript or a conversion (learn.openAudioSources opens the reader on one source). `part` is a partList entry of the job contract
   (sourceIds, sourceCount, range, ranges, open). When the part records where it sits (`open` / `ranges`, lib/part-plan.js) and the app can take a position (learn.openSourceAt), the reader
   opens at that section; else at the top of the source. Null when the app has no such navigation; otherwise { label, available, count, firstId?, reason?, run }: unavailable when the part has
   no recorded sources (an older run) or every one of them has since been deleted, with the reason to show beside the disabled button. */
export function partOpener(part, app) {
  const open = app?.learn?.openAudioSources, openAt = app?.learn?.openSourceAt;
  if (typeof open !== 'function') return null;
  const ids = Array.isArray(part?.sourceIds) ? part.sourceIds : [], library = app?.data?.sources, there = (id) => !Array.isArray(library) || library.some((source) => source.id === id);
  // Where the part opens (lib/part-plan.js: the start of the first section its label names), else where its first range begins; a part with neither (an older run) opens its first source.
  const places = [part?.open, ...(Array.isArray(part?.ranges) ? part.ranges : [])];
  const range = places.find((item) => typeof item?.sourceId === 'string' && there(item.sourceId));
  const firstId = range ? range.sourceId : Array.isArray(library) ? ids.find(there) : ids[0];
  const base = { label: ui('在资料中查看'), count: Math.max(ids.length, Number(part?.sourceCount) || 0) };
  if (!ids.length && !range) return { ...base, available: false, reason: ui('这次运行没有记录用到的资料。'), run: () => {} };
  if (firstId === undefined) return { ...base, available: false, reason: ui('这些资料已被删除，无法查看。'), run: () => {} };
  // The reader is opened at that section when the app can take a position, else at the top of the source.
  return { ...base, available: true, firstId, run: () => (range && typeof openAt === 'function' ? openAt(range.sourceId, range.start) : open([firstId])) };
}
