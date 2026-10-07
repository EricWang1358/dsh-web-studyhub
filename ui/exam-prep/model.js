import { isExamBlueprintSource } from '../../lib/exam-blueprint-material.js';
import { sourceMatchesCourse } from '../../lib/source-courses.js';
import { groupSourcesByDocument } from '../../lib/source-groups.js';
import { contractOf, isRunningTask, taskId } from '../tasks/task-model.js';

/* 备考补习: what the page reads from the snapshot, as plain data and predicates (no React, no ui(); the words are in ./words.js).
   A 考点清单 is a source record of the library (lib/exam-blueprint-material.js: `provenance: 'exam-blueprint'` and a `blueprint` field),
   so the course scope, the id and the time are the record's own, and the lists are found by one predicate. */

/** The host's switch (`runtime.pilot.examBlueprint`, default off) as the snapshot publishes it. Only a literal true. */
export const examPrepEnabled = data => data?.features?.examBlueprint === true;

/** Is this record a point list? (The one predicate; the data module renames it `isExamPointListSource` when the build job is reworked: change it here.) */
export const isPointList = isExamBlueprintSource;

/** The materials of the 资料 page and its nav badge: point lists have a page of their own while that page is on; off, nothing changes. */
export function materialSources(data) {
  const sources = Array.isArray(data?.sources) ? data.sources : [];
  return examPrepEnabled(data) && sources.some(isPointList) ? sources.filter(source => !isPointList(source)) : sources;
}

export const BUILD_KIND = 'exam-blueprint-build';
const SLIDE_ROLES = ['lecture', 'syllabus'];
const isSlideRole = role => SLIDE_ROLES.includes(role);
const placesOfPoint = point => Array.isArray(point?.evidence) ? point.evidence : [];

/* ---------- tiers and the tree ---------- */

/** 必学 or 补充. The build writes `tier` next to `backing`; a list without it is read the same way: must = a sample paper is among the places. */
export function tierOf(point) {
  if (point?.tier === 'must' || point?.tier === 'extra') return point.tier;
  const papers = point?.backing ? Number(point.backing.samplePapers) > 0 : placesOfPoint(point).some(place => place.role === 'past-paper');
  return papers ? 'must' : 'extra';
}

/** A point no slide (or syllabus line) teaches: only a sample paper asks for it. */
export const lacksSlides = point => point?.backing && Number.isFinite(point.backing.slides)
  ? point.backing.slides === 0 : !placesOfPoint(point).some(place => isSlideRole(place.role));

/**
 * The points as a two-level tree by parentId. A parent that is not in the list makes a root; a loop is cut where it closes; a third level is
 * kept under its big point. Every point appears exactly once, in the order the list gave.
 * @returns { roots: [{ id, point, tier, depth, parentId, children: [node] }], byId }
 */
export function buildTree(points) {
  const list = (Array.isArray(points) ? points : []).filter(point => point && typeof point === 'object' && point.id !== undefined);
  const parent = new Map(list.map(point => [point.id, point.parentId !== undefined && point.parentId !== point.id && list.some(other => other.id === point.parentId) ? point.parentId : null]));
  for (const point of list) {
    const seen = new Set([point.id]);
    let at = point.id;
    while (parent.get(at) !== null && parent.get(at) !== undefined) {
      const up = parent.get(at);
      if (seen.has(up)) { parent.set(at, null); break; }
      seen.add(up);
      at = up;
    }
  }
  const topOf = id => { let at = id; while (parent.get(at) !== null) at = parent.get(at); return at; };
  const nodes = new Map(list.map(point => [point.id, { id: point.id, point, tier: tierOf(point), depth: 1, parentId: null, children: [] }]));
  const roots = [];
  for (const point of list) {
    const node = nodes.get(point.id), top = topOf(point.id);
    if (top === point.id) roots.push(node);
    else { node.depth = 2; node.parentId = top; nodes.get(top).children.push(node); }
  }
  return { roots, byId: nodes };
}

const leavesOf = roots => roots.flatMap(node => node.children.length ? node.children : [node]);

/** How many points a learner studies: a big point with small ones is their heading, not one more point. */
export function countPoints(tree) {
  const leaves = leavesOf(tree?.roots || []);
  const must = leaves.filter(node => node.tier === 'must').length;
  return { must, extra: leaves.length - must, total: leaves.length, withoutSlides: leaves.filter(node => lacksSlides(node.point)).length };
}

const textOf = point => [point.title, point.requirement, ...placesOfPoint(point).map(place => place.quote)].filter(Boolean).join('\n').toLowerCase();

/**
 * The tree's roots after the tier filter ('all' | 'must' | 'extra') and the text search (title, requirement, quotes; every word must hit).
 * A big point stays while one of its small points shows; a big point that matches by itself shows its small points of the tier.
 */
export function filterTree(tree, { tier = 'all', query = '' } = {}) {
  const words = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tier === 'all' && !words.length) return tree.roots;
  const tierOk = node => tier === 'all' || node.tier === tier;
  const hit = node => !words.length || words.every(word => textOf(node.point).includes(word));
  const shown = [];
  for (const node of tree.roots) {
    if (!node.children.length) { if (tierOk(node) && hit(node)) shown.push(node); continue; }
    const wholeHit = words.length > 0 && hit(node);
    const kids = node.children.filter(child => tierOk(child) && (hit(child) || wholeHit));
    if (kids.length) shown.push(kids.length === node.children.length ? node : { ...node, children: kids });
  }
  return shown;
}

/**
 * The rows of the tree as they are on screen: a big point, then its small points while it is open. `open` holds the ids of the open big points
 * and of the points whose quotes are shown.
 */
export function treeRows(roots, open) {
  const rows = [];
  for (const [index, node] of roots.entries()) {
    const hasChildren = node.children.length > 0;
    rows.push({ id: node.id, node, level: 1, hasChildren, expanded: hasChildren ? open.has(node.id) : undefined, parentId: null, posinset: index + 1, setsize: roots.length });
    if (hasChildren && open.has(node.id)) node.children.forEach((child, at) => rows.push({ id: child.id, node: child, level: 2, hasChildren: false, expanded: undefined, parentId: node.id, posinset: at + 1, setsize: node.children.length }));
  }
  return rows;
}

/**
 * What a key does on the tree (the ARIA tree pattern): { focus: id }, { toggle: id, open: boolean } (a big point opens its small points, a small
 * point its quotes), {} for a key that has nowhere to go, null for a key that is not the tree's.
 */
export function treeKey(rows, current, key, open) {
  if (!rows.length) return null;
  const at = Math.max(0, rows.findIndex(row => row.id === current)), row = rows[at];
  const focus = target => ({ focus: (target || row).id });
  switch (key) {
    case 'ArrowDown': return focus(rows[Math.min(rows.length - 1, at + 1)]);
    case 'ArrowUp': return focus(rows[Math.max(0, at - 1)]);
    case 'Home': return focus(rows[0]);
    case 'End': return focus(rows.at(-1));
    case 'ArrowRight': return !row.hasChildren ? {} : row.expanded ? focus(rows[at + 1]) : { toggle: row.id, open: true };
    case 'ArrowLeft': return row.hasChildren && row.expanded ? { toggle: row.id, open: false } : row.parentId !== null ? { focus: row.parentId } : {};
    case 'Enter': case ' ': return { toggle: row.id, open: !open.has(row.id) };
    default: return null;
  }
}

/* ---------- places, left-overs ---------- */

/** The places a point comes from: slides (and the syllabus) and sample-paper questions; a textbook is never evidence. */
export function placesOf(point) {
  return placesOfPoint(point).flatMap(place => {
    const kind = isSlideRole(place.role) ? 'slide' : place.role === 'past-paper' ? 'paper' : null;
    return kind ? [{ kind, role: place.role, sourceId: place.sourceId, quote: place.quote, page: place.page }] : [];
  });
}

/** Sample-paper questions that matched no point: the ones the build listed, else the questions of the shape that reach no point. */
export function unmatchedQuestions(blueprint) {
  const shape = blueprint?.examShape;
  if (Array.isArray(shape?.unmatched)) return shape.unmatched;
  return Array.isArray(shape?.questions) ? shape.questions.filter(question => !question.pointIds?.length).map(question => question.label) : [];
}

/** Slides with no readable text, by deck: [{ title, pages }]. */
export function skippedPages(blueprint) {
  return (blueprint?.inputs || []).filter(input => isSlideRole(input.role) && input.skippedPages?.length)
    .map(input => ({ title: input.title || input.documentId || input.sourceIds?.[0] || '', pages: [...input.skippedPages] }));
}

/* ---------- builds ---------- */

const isBuildJob = job => job?.type === BUILD_KIND || job?.contract?.kind === BUILD_KIND;

/** The build jobs of the snapshot, running ones first then the newest; `taskId` is the id the 任务 console opens them by. */
export function buildsOf(data) {
  const jobs = (Array.isArray(data?.jobs) ? data.jobs : []).filter(isBuildJob);
  return jobs.map((job, index) => {
    const contract = contractOf(job), progress = contract.progress || {}, live = isRunningTask(job);
    return { jobId: contract.jobId || job.id, taskId: taskId(job), title: contract.title || job.title || '', status: contract.status || job.status, live,
      failed: contract.status === 'failed' || contract.status === 'interrupted', done: Number(progress.done) || 0, total: Number.isFinite(progress.total) ? progress.total : null,
      stage: contract.stage?.text || '', startedAt: contract.startedAt || job.startedAt || '', finishedAt: contract.finishedAt || job.finishedAt || '',
      resultIds: (contract.result?.refs || []).filter(ref => ref.kind === 'source').map(ref => ref.id), index };
  }).sort((a, b) => Number(b.live) - Number(a.live) || (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0) || a.index - b.index);
}

/* ---------- the lists ---------- */

const timeOf = value => Date.parse(value) || 0;

/** The ids of the lists a newer list says it supersedes (its `blueprint.supersedes`). */
export const supersededIds = lists => new Set(lists.map(source => source.blueprint?.supersedes).filter(Boolean));

/** One row of the list view: everything a learner needs to choose a list, read from the record (and the snapshot's jobs, or their `builds`, for its time and its build). */
export function listRow(source, { jobs = [], builds = buildsOf({ jobs }), older = 0 } = {}) {
  const blueprint = source.blueprint || {}, tree = buildTree(blueprint.points);
  const finished = builds.find(build => build.resultIds?.includes(source.id))?.finishedAt;
  const papers = Number.isFinite(blueprint.basis?.samplePapers) ? blueprint.basis.samplePapers : (blueprint.inputs || []).filter(input => input.role === 'past-paper').length;
  return { id: source.id, source, title: source.title, scope: blueprint.scope?.label || '', course: source.courses?.[0] || '', papers, counts: countPoints(tree),
    updatedAt: blueprint.builtAt || source.createdAt || finished || null, olderVersions: older, build: builds.find(build => build.live && build.title === source.title) || null };
}

/** The point lists of a course scope ('*' all, '' uncategorised, a course and its sub-courses), newest first; older versions fold into the newer one. */
export function pointLists(data, { scope = '*', known = [] } = {}) {
  const all = (Array.isArray(data?.sources) ? data.sources : []).filter(source => isPointList(source) && !source.archived && !source.historical);
  const replaced = supersededIds(all), byId = new Map(all.map(source => [source.id, source]));
  const chain = source => { let count = 0, at = source.blueprint?.supersedes; const seen = new Set(); while (at && byId.has(at) && !seen.has(at)) { seen.add(at); count += 1; at = byId.get(at).blueprint?.supersedes; } return count; };
  const builds = buildsOf(data);
  return all.filter(source => !replaced.has(source.id) && sourceMatchesCourse(source, scope, known))
    .map(source => listRow(source, { builds, older: chain(source) }))
    .sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt) || a.title.localeCompare(b.title));
}

/* ---------- the create form ---------- */

export const ROLES = Object.freeze(['lecture', 'past-paper', 'syllabus']);

/** The materials offered for a role: not point lists, and not what another role already took (one material has one role in one list). */
export function pickPool(sources, picks, role) {
  const taken = new Set(ROLES.filter(other => other !== role).flatMap(other => picks?.[other] || []));
  return sources.filter(source => !isPointList(source) && !taken.has(source.id));
}

const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

/** What `generation.blueprint.build` takes: the name, the course, the scope and the inputs by role (one input per document). */
export function buildRequest(form, sources, { language = 'zh' } = {}) {
  const items = groupSourcesByDocument(sources);
  const inputs = ROLES.flatMap(role => {
    const chosen = new Set(form.picks?.[role] || []);
    return items.filter(item => item.sourceIds.some(id => chosen.has(id))).map(item => {
      const ids = item.sourceIds.filter(id => chosen.has(id)), whole = ids.length === item.sourceIds.length;
      return { role, sourceIds: ids, title: item.title, ...(whole && item.documentId && !item.documentId.startsWith('legacy-') ? { documentId: item.documentId } : {}) };
    });
  });
  const reading = form.reading || {}, book = { title: clean(reading.title), author: clean(reading.author), url: clean(reading.url), note: clean(reading.note) };
  const scope = clean(form.scope), course = clean(form.course);
  return { title: clean(form.title), ...(course ? { course } : {}), ...(scope ? { scope: { label: scope } } : {}), language: language === 'en' ? 'en' : 'zh', inputs,
    ...(book.title ? { recommendedReading: Object.fromEntries(Object.entries(book).filter(([, value]) => value)) } : {}), ...(form.supersedes ? { supersedes: form.supersedes } : {}) };
}

/** What is still missing from the form: 'title', 'lecture' (slides or a syllabus), 'reading-url' (an address that is not http or https). */
export function formProblems(form) {
  const problems = [];
  if (!clean(form.title)) problems.push('title');
  if (!(form.picks?.lecture?.length || form.picks?.syllabus?.length)) problems.push('lecture');
  const url = clean(form.reading?.url);
  if (url && !/^https?:\/\//i.test(url)) problems.push('reading-url');
  return problems;
}

/** The form of a new version of a list: the same name, course, scope, inputs and note, to be checked and asked again. */
export function formFromList(source) {
  const blueprint = source.blueprint || {}, book = blueprint.recommendedReading || {};
  const idsOf = role => [...new Set((blueprint.inputs || []).filter(input => input.role === role).flatMap(input => input.sourceIds || []))];
  return { title: source.title, supersedes: source.id, course: source.courses?.[0] || '', scope: blueprint.scope?.label || '',
    picks: Object.fromEntries(ROLES.map(role => [role, idsOf(role)])), reading: { title: book.title || '', author: book.author || '', url: book.url || '', note: book.note || '' } };
}
