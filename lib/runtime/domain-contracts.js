// Owned records and the named read/transaction ports consumed by each lasting domain.
export const fields = {
  system: ['settings', 'focus'], notifications: ['inbox'], learner: ['learner', 'coach', 'feedback', 'prepared'],
  'workflow-data': ['workflowTemplates', 'workflowSessions'], 'skeleton-data': ['skeletons', 'topicGroups'],
  materials: ['sources', 'documents'], bank: ['decks', 'drafts'], courses: ['courses'], study: ['runs', 'attempts', 'oralRuns', 'teaching', 'studySessions'],
  generation: ['selectionJobs'], audio: ['audioResults'], notes: ['notes', 'csdnHome'], recording: ['ingest'],
  coach: [], workflows: [], skeleton: [], jobs: [], library: [], authoring: [],
};
export const reads = {
  system: ['system'], notifications: ['notifications'], learner: ['learner'], 'workflow-data': ['workflow-data'], 'skeleton-data': ['skeleton-data'],
  materials: ['materials', 'system'], bank: ['bank', 'materials', 'system', 'notifications'],
  // Low in the graph on purpose: generation, case practice or audio may read course profiles.
  courses: ['courses', 'materials', 'bank', 'system'],
  // The queue and the exam pool read which courses are parked (lib/course-active.js).
  study: ['study', 'bank', 'materials', 'system', 'notifications', 'learner', 'workflow-data', 'courses'],
  authoring: ['bank', 'materials', 'system', 'study', 'notifications', 'learner', 'workflow-data', 'skeleton-data', 'notes', 'recording'],
  generation: ['generation', 'bank', 'materials', 'system', 'study', 'notifications', 'courses'],
  coach: ['learner', 'study', 'bank', 'materials', 'system', 'notifications', 'workflow-data'],
  notes: ['notes', 'bank', 'study', 'system', 'notifications', 'courses'], recording: ['recording', 'bank', 'materials', 'study', 'system', 'notifications'],
  skeleton: ['skeleton-data', 'bank', 'materials', 'study', 'system'],
  workflows: ['workflow-data', 'skeleton-data', 'study', 'bank', 'materials', 'system', 'learner', 'notifications'],
  audio: ['audio', 'materials', 'bank', 'system', 'notifications'],
  // The session, deck and sources of a guided question (#547) are read by jobs before it starts the supplement job.
  jobs: ['bank', 'notifications', 'study', 'materials'],
  library: ['system', 'notifications', 'learner', 'workflow-data', 'skeleton-data', 'materials', 'bank', 'study', 'generation', 'audio', 'notes', 'recording', 'courses'],
};
export const actionGrants = {
  bank: {}, materials: {},
  study: { bank: ['draft.save', 'card.link', 'card.followup.add'], courses: ['course.profile'] },
  generation: { authoring: ['draft.publish', 'draft.publish.plan', 'draft.publish.quick'], bank: ['get', 'append', 'deck.ensure', 'draft.save', 'card.answerCard.set'], materials: ['book.aiWrite', 'selection.resolve', 'document.get', 'source.add', 'translation.translate', 'translation.plan', 'sources.ingest'],
    study: ['card.grade'], courses: ['course.profile'] },
  coach: { study: ['review.start'] },
  audio: { materials: ['sources.ingest', 'document.import'], generation: ['generate'] },
  workflows: {},
  // 接着做 of an interrupted coverage run is `generate { coverage: { run: true } }`; the snapshot and the jobs context bring such runs back first (`coverage.recover`).
  // 带学现场出题 (#547): jobs starts the supplement job, reads and cancels it, opens its question, and records the session's wait in study.
  jobs: { audio: ['recover', 'audio.retry', 'mineru.retry'], generation: ['generate', 'coverage.recover', 'supplement'],
    study: ['review.start', 'study.question.wait', 'study.question.settle', 'study.question.release'] },
  library: { materials: ['attachments.export', 'attachments.import'], coach: ['coach.status', 'coach.activity', 'coach.practice'],
    study: ['review.start', 'review.move'], audio: ['recover'], generation: ['coverage.recover'] },
};
const actions = {
  settings: ['settings'],
  // 置顶 on the 资料 page: the pinned keys are one optional field of the library settings.
  'source.pin': ['settings'], 'source.pin.move': ['settings'],
  // 备考补习 personal defaults: one optional key of the library settings.
  'settings.examPrep.set': ['settings'], 'settings.examPrep.reset': ['settings'],
  // 练习 personal defaults: the same.
  'settings.practice.set': ['settings'], 'settings.practice.reset': ['settings'], 'settings.book.set': ['settings'],
  'course.save': ['courses'],
  // 有效课程: one flag on the course record (and, for "keep the chapters", on those chapters' records); no card, run or attempt is touched.
  'course.setActive': ['courses'], 'course.activate': ['courses'], 'course.deactivate': ['courses'],
  // One transaction across every record that carries a course name (WP13).
  'course.rename': ['courses', 'sources', 'audioResults', 'decks', 'drafts', 'runs', 'focus', 'workflowSessions'],
  'course.merge': ['courses', 'sources', 'audioResults', 'decks', 'drafts', 'runs', 'focus', 'workflowSessions'],
  'source.add': ['sources'], 'source.import': ['sources'], 'source.courses.set': ['sources'], 'course.book.open': ['sources'], 'course.book.save': ['sources'], 'course.book.suggestion': ['sources'], 'course.book.revert': ['sources'], 'book.qa.add': ['sources'], 'book.qa.remove': ['sources'], 'course.book.block': ['sources'], 'book.crunch.mark': ['sources'], 'book.toc': ['sources'], 'book.write': ['sources'], 'source.archive': ['sources', 'documents'], 'source.remove': ['sources', 'documents'],
  // The book's structure (lib/course-book-structure.js): the book's own record, like course.book.save.
  'course.book.rename': ['sources'], 'course.book.move': ['sources'], 'course.book.delete': ['sources'], 'course.book.rebuild.undo': ['sources'],
  'legacy.import': ['sources', 'decks'],
  'job.dismiss': ['inbox'], 'job.control': ['inbox'],
  // 任务 归档 (lib/job-archive.js): the record lives in its own file beside the library; deleting a pre-manifest job also prunes its inbox letter.
  'job.archive': [], 'job.unarchive': [], 'job.delete': ['inbox'],
  // A passage supplementation job leaves its record and, when it saved questions, one inbox letter that opens at the first of them.
  'selection.start': ['selectionJobs', 'inbox'],
  // A page / chapter translation job writes only its inbox letter here; the translations themselves go through the materials context.
  'translation.start': ['inbox'],
  // The exam blueprint build reads the library and writes nothing of its own: the blueprint is a material, saved through the materials context (sources.ingest).
  'blueprint.build': [],
  // The course outline build reads the library and writes nothing of its own: the outline is a material, saved through the materials context (sources.ingest).
  'courseOutline.build': [],
  // The 复习全书 build likewise: its notes (and an outline it organises first) are materials, saved through the materials context (sources.ingest).
  'courseBook.build': [],
  // 弄懂 / 加一段 of the 复习全书 likewise: its block is written through the materials context (book.aiWrite).
  'courseBook.explain': [],
  // 分析题答案卡 (M5) likewise: the card is saved beside its question by the bank context (card.answerCard.set: decks, and an open edit of the deck).
  'answerCard.build': [], 'card.answerCard.set': ['decks', 'drafts'],
  'note.generate': ['notes', 'inbox'],
  'note.daily.letter': ['inbox'], 'note.daily.generate': ['notes', 'inbox'], 'note.daily.advance': ['notes', 'inbox'],
  'assist.commit': ['decks', 'drafts', 'runs', 'inbox', 'sources', 'attempts'],
  // Rubric grading and case papers (WP12).
  'card.grade': ['runs', 'decks', 'attempts', 'inbox'], 'review.highlights': ['runs'], 'case.drills': ['decks'],
  'coach.queue': ['learner', 'prepared', 'coach', 'inbox'], 'coach.flush': ['learner', 'prepared', 'coach', 'inbox'],
  'draft.import': ['sources', 'drafts'], 'draft.save': ['drafts'], 'draft.delete': ['drafts'],
  // Publishing into a deck pins the members of saved workflow scopes before merging (deck-organization.js).
  'draft.publish': ['decks', 'drafts', 'sources', 'runs', 'workflowSessions'], 'draft.publish.plan': [], 'draft.publish.quick': ['decks', 'drafts', 'sources', 'runs', 'workflowSessions'],
  'deck.import': ['sources', 'decks', 'drafts', 'runs', 'workflowSessions'],
  'deck.course': ['decks', 'drafts'], 'deck.reorder': ['decks'], 'deck.merge': ['decks', 'drafts', 'runs', 'attempts', 'teaching', 'coach', 'feedback', 'prepared', 'inbox', 'skeletons', 'topicGroups', 'notes', 'ingest', 'workflowSessions'], 'deck.split': ['decks', 'drafts', 'runs', 'attempts', 'teaching', 'coach', 'feedback', 'prepared', 'inbox', 'skeletons', 'topicGroups', 'notes', 'ingest', 'workflowSessions'],
  'deck.move': ['decks'], 'deck.edit': ['drafts'], 'deck.archive': ['decks', 'runs'], 'deck.remove': ['decks'],
  'card.slay': ['decks', 'drafts', 'runs'], 'card.restore': ['decks', 'drafts'],
  'card.update': ['decks', 'drafts', 'runs', 'inbox'], 'card.convert': ['decks', 'drafts', 'runs', 'inbox'], 'card.update.batch': ['decks', 'drafts', 'runs', 'inbox'],
  'card.revert': ['decks', 'drafts', 'runs'], 'card.translate': ['decks'], 'card.flag': ['decks'], 'card.suspend': ['decks'],
  'card.link': ['decks', 'inbox'], 'card.link.batch': ['decks', 'inbox'], 'card.followup.add': ['decks', 'inbox'],
  'card.followup.suggest': ['decks'], 'card.followup': ['decks', 'inbox', 'prepared', 'coach', 'learner'],
  // The 创建题组 assist reads the library and asks the light model; it writes nothing.
  'generate.suggest': [], 'generate.path.suggest': [], 'generate.weakTopics': [],
  // Bringing back a coverage run a stopped host left running reads the drafts and writes nothing: the job record lives in memory.
  'coverage.recover': [],
  // Retrieval providers for large textbooks (WP28): read the library and a host port, write nothing in the library.
  'retrieval.status': [], 'retrieval.set': [], 'retrieval.test': [], 'retrieval.preview': [],
  'retrieval.index.plan': [], 'retrieval.index.coverage': [], 'retrieval.index.start': [], 'retrieval.index.status': [], 'retrieval.index.cancel': [], 'retrieval.index.repair': [], 'retrieval.endpoint.set': [],
  'review.get': ['runs'], 'review.weak.start': ['runs'], 'review.start': ['runs'], 'review.end': ['runs'],
  // 期末一周's mock paper (M7): an exam run over some points of the review book (review.start mode exam); the plan itself is read only.
  'book.mock': ['runs'], 'book.mock.plan': [], 'book.crunch': [],
  // 备考计划: the whole-period schedule over the same points, read only; its strategy is written by course.save.
  'course.plan': [],
  // The book page's light check when it comes back into view (lib/course-book-files.js bookRevision): reads one number, writes nothing.
  'course.book.revision': [],
  // The main chat's book reads (docs/review-book-agent.md): no library field; source.pages records what it showed in a file beside the book history.
  'book.read': [], 'book.coverage': [], 'source.pages': [],
  // Plans and consent use the global board's atomic transaction; only starting practice writes a library run.
  'daily.plan.get': [], 'daily.plan.suggest': [], 'daily.plan.accept': [], 'daily.plan.profile': [], 'daily.plan.complete': [],
  'daily.plan.start': ['runs'],
  'review.reveal': ['runs'], 'review.answer': ['runs', 'decks', 'attempts'], 'review.move': ['runs'], 'review.skip': ['runs'], 'review.queue.edit': ['runs'], 'review.draft.save': ['runs'],
  'study.session.start': ['studySessions'], 'study.session.get': [], 'study.session.list': [],
  'study.session.update': ['studySessions'], 'study.session.artifact.save': ['studySessions'],
  'study.session.pause': ['studySessions'], 'study.session.end': ['studySessions'],
  'study.session.resume': [],
  'study.scene.get': [],
  'study.branch.open': ['runs', 'studySessions'], 'study.branch.return': ['studySessions'],
  'study.qa.organize': ['decks', 'inbox', 'studySessions'],
  // The question itself is written by the supplement job it starts (its own writes); these write the session's wait and the round of the new question.
  'study.question.prepare': [], 'study.question.result': [], 'study.question.cancel': [],
  'study.question.wait': ['studySessions'], 'study.question.settle': ['studySessions'], 'study.question.release': ['studySessions'],
  'exam.submit': ['runs', 'decks', 'attempts'], 'focus.set': ['focus'],
  'teach.start': ['teaching'], 'teach.answer': ['teaching'],
  'oral.start': ['oralRuns'], 'oral.answer': ['oralRuns'], 'oral.next': ['oralRuns'], 'oral.followup': ['oralRuns'],
  'oral.submit': ['oralRuns', 'decks', 'attempts'],
  'coach.profile': ['learner'], 'coach.nudge': ['learner', 'coach', 'inbox'], 'coach.reply': ['learner', 'coach', 'inbox'],
  'coach.feedback': ['feedback', 'learner', 'coach', 'inbox', 'decks', 'drafts', 'runs', 'prepared'],
  'coach.consent': ['learner', 'prepared', 'coach', 'inbox'], 'coach.variants': ['learner', 'prepared', 'coach', 'inbox'], 'coach.rewrite.retry': ['learner', 'coach', 'inbox', 'decks', 'drafts', 'runs'],
  'coach.prepare': ['learner', 'prepared', 'coach', 'inbox'], 'coach.debrief': ['learner', 'runs', 'prepared', 'coach', 'inbox'],
  'coach.forget': ['learner', 'prepared'], 'coach.goal': ['learner'], 'coach.practice': ['learner', 'prepared', 'decks', 'sources', 'runs'],
  'coach.revert': ['coach', 'decks', 'drafts', 'runs'],
  'capture': ['decks', 'drafts', 'sources', 'inbox'], 'ingest': ['decks', 'drafts', 'sources', 'ingest', 'attempts'], 'ingest.start': ['ingest'], 'ingest.stop': ['ingest'],
  'workflow.save': ['workflowTemplates'], 'workflow.delete': ['workflowTemplates'],
  'workflow.session.start': ['workflowSessions'], 'workflow.session.record': ['workflowSessions'],
  'workflow.session.material': ['workflowSessions'], 'workflow.session.material.restore': ['workflowSessions'],
  'workflow.session.advance': ['workflowSessions', 'runs'], 'workflow.session.goto': ['workflowSessions'],
  'workflow.session.status': ['workflowSessions'], 'workflow.session.delete': ['workflowSessions', 'runs'],
  'workflow.practice.start': ['workflowSessions', 'runs'], 'workflow.quickstart': ['workflowSessions', 'skeletons'],
  'workflow.feedback': ['workflowSessions'], 'workflow.rescope': ['workflowSessions', 'runs'], 'workflow.guide': ['workflowSessions'], 'workflow.skeleton.generate': ['workflowSessions', 'skeletons'],
  // A lesson's token estimate reads the session and writes nothing (WP27).
  'workflow.teaching.estimate': [],
  'inbox.read': ['inbox'], 'inbox.open': ['inbox', 'runs', 'prepared', 'decks', 'sources', 'learner'],
  'audio.import': ['inbox', 'audioResults', 'sources'], 'audio.retry': ['inbox', 'audioResults', 'sources'],
  'live.generate': ['audioResults', 'sources'], 'live.save': ['audioResults', 'sources', 'inbox'],
  'audio.subtitles.import': ['inbox', 'audioResults', 'sources'], 'audio.corrections.review': ['inbox', 'audioResults', 'sources'],
  // PDF conversion (MinerU, Marker): the job only writes its inbox letter here; the document itself goes through the materials context.
  'marker.import': ['inbox'], 'marker.settings.get': [], 'marker.settings.set': [], 'marker.local.status': [],
  // One-click Marker setup: a Python environment and the program path in DSH home; nothing in the library.
  'marker.install.plan': [], 'marker.install.start': [], 'marker.install.status': [], 'marker.install.cancel': [], 'marker.install.uninstall': [],
  // One-click local MinerU: a program folder, its service and the install state in DSH home; nothing in the library.
  'mineru.install.plan': [], 'mineru.install.start': [], 'mineru.install.status': [], 'mineru.install.cancel': [], 'mineru.install.uninstall': [],
  'mineru.local.status': [], 'mineru.local.start': [], 'mineru.local.stop': [],
  // The local engine of the live class: a program folder and the install state in DSH home; nothing in the library.
  'live.local.status': [], 'live.local.plan': [], 'live.local.install': [], 'live.local.cancel': [], 'live.local.uninstall': [],
  'mineru.import': ['inbox'], 'mineru.retry': ['inbox'],
  // The conversion history is a folder of job records beside the library's shards (lib/mineru-history.js); no library field is written.
  'mineru.history.list': [], 'mineru.history.remove': [], 'mineru.history.clear': [],
};
export function writesFor(domain, action) {
  if (actions[action]) return actions[action];
  if (action.startsWith('note.')) return ['notes', 'csdnHome'];
  if (action.startsWith('skeleton.') || action === 'topic.groups.save') return ['skeletons', 'topicGroups'];
  if (action.startsWith('workflow.teaching.') || action.startsWith('workflow.retell.')) return ['workflowSessions'];
  return fields[domain];
}
