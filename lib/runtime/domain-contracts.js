// Owned records and the named read/transaction ports consumed by each lasting domain.
export const fields = {
  system: ['settings', 'focus'], notifications: ['inbox'], learner: ['learner', 'coach', 'feedback', 'prepared'],
  'workflow-data': ['workflowTemplates', 'workflowSessions'], 'skeleton-data': ['skeletons', 'topicGroups'],
  materials: ['sources', 'documents'], bank: ['decks', 'drafts'], courses: ['courses'], study: ['runs', 'attempts', 'oralRuns', 'teaching'],
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
  jobs: ['bank', 'notifications'],
  library: ['system', 'notifications', 'learner', 'workflow-data', 'skeleton-data', 'materials', 'bank', 'study', 'generation', 'audio', 'notes', 'recording', 'courses'],
};
export const actionGrants = {
  bank: {}, materials: {},
  study: { bank: ['draft.save', 'card.link', 'card.followup.add'], courses: ['course.profile'] },
  generation: { authoring: ['draft.publish', 'draft.publish.quick'], bank: ['get', 'append', 'deck.ensure', 'draft.save'], materials: ['selection.resolve', 'document.get', 'source.add', 'translation.translate', 'translation.plan'],
    study: ['card.grade'], courses: ['course.profile'] },
  coach: { study: ['review.start'] },
  audio: { materials: ['sources.ingest', 'document.import'], generation: ['generate'] },
  workflows: {},
  jobs: { audio: ['recover', 'audio.retry', 'mineru.retry'] },
  library: { materials: ['attachments.export', 'attachments.import'], coach: ['coach.status', 'coach.activity', 'coach.practice'],
    study: ['review.start', 'review.move'], audio: ['recover'] },
};
const actions = {
  settings: ['settings'],
  'course.save': ['courses'],
  // 有效课程: one flag on the course record (and, for "keep the chapters", on those chapters' records); no card, run or attempt is touched.
  'course.setActive': ['courses'], 'course.activate': ['courses'], 'course.deactivate': ['courses'],
  // One transaction across every record that carries a course name (WP13).
  'course.rename': ['courses', 'sources', 'audioResults', 'decks', 'drafts', 'runs', 'focus', 'workflowSessions'],
  'course.merge': ['courses', 'sources', 'audioResults', 'decks', 'drafts', 'runs', 'focus', 'workflowSessions'],
  'source.add': ['sources'], 'source.import': ['sources'], 'source.courses.set': ['sources'], 'source.archive': ['sources', 'documents'], 'source.remove': ['sources', 'documents'],
  'legacy.import': ['sources', 'decks'],
  'job.dismiss': ['inbox'],
  // A passage supplementation job leaves its record and, when it saved questions, one inbox letter that opens at the first of them.
  'selection.start': ['selectionJobs', 'inbox'],
  // A page / chapter translation job writes only its inbox letter here; the translations themselves go through the materials context.
  'translation.start': ['inbox'],
  'note.generate': ['notes', 'inbox'],
  'note.daily.generate': ['notes', 'inbox'], 'note.daily.advance': ['notes', 'inbox'],
  'assist.commit': ['decks', 'drafts', 'runs', 'inbox', 'sources', 'attempts'],
  // Rubric grading and case papers (WP12).
  'card.grade': ['runs', 'decks', 'attempts', 'inbox'], 'review.highlights': ['runs'], 'case.drills': ['decks'],
  'coach.queue': ['learner', 'prepared', 'coach', 'inbox'], 'coach.flush': ['learner', 'prepared', 'coach', 'inbox'],
  'draft.import': ['sources', 'drafts'], 'draft.save': ['drafts'], 'draft.delete': ['drafts'],
  'draft.publish': ['decks', 'drafts', 'sources', 'runs'], 'draft.publish.quick': ['decks', 'drafts', 'sources', 'runs'],
  'deck.import': ['sources', 'decks', 'drafts', 'runs'],
  'deck.course': ['decks', 'drafts'], 'deck.reorder': ['decks'], 'deck.merge': ['decks', 'drafts', 'runs', 'attempts', 'teaching', 'coach', 'feedback', 'prepared', 'inbox', 'skeletons', 'topicGroups', 'notes', 'ingest', 'workflowSessions'], 'deck.split': ['decks', 'drafts', 'runs', 'attempts', 'teaching', 'coach', 'feedback', 'prepared', 'inbox', 'skeletons', 'topicGroups', 'notes', 'ingest', 'workflowSessions'],
  'deck.move': ['decks'], 'deck.edit': ['drafts'], 'deck.archive': ['decks', 'runs'], 'deck.remove': ['decks'],
  'card.slay': ['decks', 'drafts', 'runs'], 'card.restore': ['decks', 'drafts'],
  'card.update': ['decks', 'drafts', 'runs', 'inbox'], 'card.update.batch': ['decks', 'drafts', 'runs', 'inbox'],
  'card.revert': ['decks', 'drafts', 'runs'], 'card.translate': ['decks'], 'card.flag': ['decks'], 'card.suspend': ['decks'],
  'card.link': ['decks', 'inbox'], 'card.link.batch': ['decks', 'inbox'], 'card.followup.add': ['decks', 'inbox'],
  'card.followup.suggest': ['decks'], 'card.followup': ['decks', 'inbox', 'prepared', 'coach', 'learner'],
  // The 创建题组 assist reads the library and asks the light model; it writes nothing.
  'generate.suggest': [], 'generate.path.suggest': [],
  // Retrieval providers for large textbooks (WP28): read the library and a host port, write nothing in the library.
  'retrieval.status': [], 'retrieval.set': [], 'retrieval.test': [], 'retrieval.preview': [],
  'retrieval.index.plan': [], 'retrieval.index.coverage': [], 'retrieval.index.start': [], 'retrieval.index.status': [], 'retrieval.index.cancel': [], 'retrieval.endpoint.set': [],
  'review.get': ['runs'], 'review.weak.start': ['runs'], 'review.start': ['runs'], 'review.end': ['runs'],
  // Plans and consent use the global board's atomic transaction; only starting practice writes a library run.
  'daily.plan.get': [], 'daily.plan.suggest': [], 'daily.plan.accept': [], 'daily.plan.profile': [], 'daily.plan.complete': [],
  'daily.plan.start': ['runs'],
  'review.reveal': ['runs'], 'review.answer': ['runs', 'decks', 'attempts'], 'review.move': ['runs'], 'review.skip': ['runs'],
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
  // Cloud PDF conversion (MinerU): the job only writes its inbox letter here; the document itself goes through the materials context.
  'marker.import': ['inbox'], 'marker.settings.get': [], 'marker.settings.set': [], 'marker.local.status': [],
  // One-click Marker setup: a Python environment and the program path in DSH home; nothing in the library.
  'marker.install.plan': [], 'marker.install.start': [], 'marker.install.status': [], 'marker.install.cancel': [], 'marker.install.uninstall': [],
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
