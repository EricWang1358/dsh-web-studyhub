import { importCourses, libraryCourses, resolveCourse } from "./source-courses.js";
import { prepareJsonImport } from "./json-import.js";
import { cardKey, normalizeImportText, sameTitle } from "./bulk-import.js";
import { currentCourse } from "./focus.js";
import { get } from "./util.js";
import { norm } from "./domain.js";
import { mergePartPlans } from "./plan-record.js";


function publicationTarget(state, draft, args) {
  const explicit = [];
  for (const field of ['mergeTargetId', 'deckId', 'deck']) {
    if (args[field] === undefined) continue;
    const value = field === 'deck' && args[field] && typeof args[field] === 'object' ? args[field].id : args[field];
    if (typeof value !== 'string' || !value.trim()) throw new Error('发布目标题组必须是有效 ID');
    explicit.push(value.trim());
  }
  const retained = draft.editingDeckId || draft.editorial?.repairOfDeckId || draft.mergeTargetId;
  if (new Set([...explicit, ...(retained ? [retained] : [])]).size > 1)
    throw new Error('发布目标题组冲突，请先重新保存草稿的目标');
  const targetId = explicit[0] || retained;
  if (!targetId) return null;
  const target = state.decks.find(deck => deck.id === targetId);
  if (!target) throw new Error('发布目标题组不存在');
  if (target.archived || target.systemKind) throw new Error('发布目标必须是未归档的普通题组');
  return target;
}

function publicationDuplicates(cards) {
  const indexes = ['objective', 'prompt'].map(field => {
    const values = new Map();
    for (const card of cards) {
      const value = norm(card[field]);
      if (!values.has(value)) values.set(value, new Set());
      values.get(value).add(card.id);
    }
    return { field, values };
  });
  return card => indexes.some(({ field, values }) => {
    const ids = values.get(norm(card[field]));
    return ids && (ids.size > 1 || !ids.has(card.id));
  });
}

function repairContextIssues(card, draft, state, suppliedSources) {
  const issues = [];
  const suppliedIds = new Set(suppliedSources.map((source) => source.id));
  if (Array.isArray(card.citations) && card.citations.some((ref) => !suppliedIds.has(ref?.sourceId)))
    issues.push("修题引用了未提供给独立复审的资料");
  const peers = draft.cards.filter((other) => other.id !== card.id &&
    !draft.editorial?.rejectedIssues?.[other.id]);
  const liveId = draft.editingDeckId || draft.editorial?.repairOfDeckId;
  const live = liveId && state.decks.find((deck) => deck.id === liveId);
  if (live) peers.push(...live.cards.filter((other) =>
    draft.editorial?.repairOfDeckId || other.id !== card.id));
  if (peers.some((other) => norm(other.objective) === norm(card.objective)))
    issues.push("学习目标与已通过或已发布的题目重复，请改成不同考点");
  if (peers.some((other) => norm(other.prompt) === norm(card.prompt)))
    issues.push("问题与已通过或已发布的题目重复，请改成不同问题");
  if (live?.cards.some((other) => other.id === card.id && draft.editorial?.repairOfDeckId))
    issues.push("题目编号与已发布的题目重复");
  return issues;
}

function mergeContinuedDraft(base, fresh, sources, { addSourceIds = [], requested = base.editorial.requested } = {}) {
  const cards = [...base.cards], failures = [...(fresh.editorial.failures || [])];
  const targets = new Set(cards.map((card) => norm(card.objective)));
  const prompts = new Set(cards.map((card) => norm(card.prompt)));
  const ids = new Set(cards.map((card) => card.id));
  for (const card of fresh.cards) {
    if (ids.has(card.id) || targets.has(norm(card.objective)) || prompts.has(norm(card.prompt))) {
      failures.push("补题时跳过了一道与已有草稿重复的题");
      continue;
    }
    cards.push(card);
    ids.add(card.id);
    targets.add(norm(card.objective));
    prompts.add(norm(card.prompt));
  }
  const sourceIds = new Set([...base.editorial.generation.sourceIds, ...addSourceIds]);
  const cited = new Set(cards.flatMap((card) => card.citations.map((c) => c.sourceId)).filter((sourceId) => sourceIds.has(sourceId)));
  const oldPlanned = new Map((base.editorial.coverage?.sources || []).map((row) => [row.id, row.planned]));
  if (!base.editorial.coverage?.sources)
    for (const audit of base.editorial.audits || [])
      for (const target of audit.targets || [])
        for (const sourceId of new Set((target.citations || []).map((ref) => ref.sourceId)))
          oldPlanned.set(sourceId, (oldPlanned.get(sourceId) || 0) + 1);
  const newPlanned = new Map((fresh.editorial.coverage?.sources || []).map((row) => [row.id, row.planned]));
  const completedBefore = base.editorial.completedParts || 0;
  return {
    ...base,
    cards,
    editorial: {
      ...fresh.editorial,
      // The plan the draft was made from (lib/coverage-plan.js) stays with it: a top-up continues it.
      ...(base.editorial.coverageSpec ? { coverageSpec: base.editorial.coverageSpec } : {}),
      // A top-up for the uncovered sections is not asked for a number: what the draft was asked for stays what it was (a draft that holds more than that says how many it holds).
      requested,
      generated: cards.length,
      parts: completedBefore + fresh.editorial.parts,
      completedParts: completedBefore + fresh.editorial.completedParts,
      generation: { ...base.editorial.generation, sourceIds: [...sourceIds], course: fresh.editorial.generation.course,
        referenceSourceIds: fresh.editorial.generation.referenceSourceIds ?? base.editorial.generation.referenceSourceIds ?? [],
        referenceLimits: fresh.editorial.generation.referenceLimits ?? base.editorial.generation.referenceLimits,
        referenceFormat: fresh.editorial.generation.referenceFormat ?? base.editorial.generation.referenceFormat,
        performance: fresh.editorial.generation.performance ?? base.editorial.generation.performance },
      audits: [...(base.editorial.audits || []), ...(fresh.editorial.audits || []).map((audit) => ({ ...audit, part: completedBefore + audit.part }))],
      reviewedCards: Object.fromEntries(cards.flatMap((card) => {
        const mark = base.editorial.reviewedCards?.[card.id] || fresh.editorial.reviewedCards?.[card.id];
        return mark ? [[card.id, mark]] : [];
      })),
      previousFailures: [...(base.editorial.previousFailures || []), ...(base.editorial.failures || [])],
      // What the reviews suggested (and the program kept) stays readable next to this run's.
      ...(base.editorial.suggestions?.length || fresh.editorial.suggestions?.length ? { suggestions: [...(base.editorial.suggestions || []),
        ...(fresh.editorial.suggestions || [])].filter((item) => !item.cardId || cards.some((card) => card.id === item.cardId)).slice(-40) } : {}),
      // What earlier runs dropped stays readable next to what this one drops.
      ...(base.editorial.omitted?.length || fresh.editorial.omitted?.length ? { omitted: [...(base.editorial.omitted || []),
        ...(fresh.editorial.omitted || []).map((item) => ({ ...item, part: completedBefore + item.part }))].slice(-40) } : {}),
      failures,
      // What every earlier run planned (failed parts too) stays on record next to what this run planned, numbered after it (lib/plan-record.js).
      ...(base.editorial.partPlans?.length || fresh.editorial.partPlans?.length ? { partPlans: mergePartPlans(base.editorial.partPlans, fresh.editorial.partPlans, completedBefore) } : {}),
      coverage: {
        selected: sourceIds.size,
        cited: cited.size,
        sources: sources.filter((source) => sourceIds.has(source.id)).map(({ id: sourceId, title }) => ({
          id: sourceId, title,
          planned: (oldPlanned.get(sourceId) || 0) + (newPlanned.get(sourceId) || 0),
          accepted: cards.filter((card) => card.citations.some((ref) => ref.sourceId === sourceId)).length,
        })),
        uncited: sources.filter((source) => sourceIds.has(source.id) && !cited.has(source.id)).map(({ id: sourceId, title }) => ({ id: sourceId, title })),
      },
    },
  };
}

function importCourse(state, args, deck, preferred = currentCourse(state)) {
  return resolveCourse(state, args, {
    course: deck.course ?? (args.folder !== undefined || libraryCourses(state).includes(deck.folder) ? deck.folder : undefined),
    preferred: preferred ?? deck.folder ?? '',
  });
}

function importJsonDeck(s, file, a, preferred, ports) {
  const { source, deck } = prepareJsonImport(normalizeImportText(file.text, file.name), s.sources);
  if (typeof a.folder === "string") deck.folder = a.folder.trim();
  deck.course = importCourse(s, a, deck, preferred);
  const target = a.into !== undefined ? get(s.decks, a.into, "目标题组")
    : s.decks.find((d) => !d.archived && !d.systemKind && sameTitle(d.title, deck.title) &&
      (d.folder || "") === (deck.folder || "") && (d.course ?? d.folder ?? '') === deck.course);
  if (target && (target.archived || target.systemKind)) throw new Error("只能并入普通题组");
  // Questions already in the target (or repeated within the file) are skipped.
  const have = new Set((target?.cards || []).map(cardKey)), seen = new Set();
  const fresh = deck.cards.filter((card) => {
    const key = cardKey(card);
    if (!key || have.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const skipped = deck.cards.length - fresh.length;
  const report = (final, added) => ({ file: file.name, title: final.title, deckId: final.id, folder: final.folder || "",
    created: !target, added, skipped, total: final.cards.length,
    ...(deck.quality?.warnings?.length ? { warnings: deck.quality.warnings.slice(0, 5) } : {}) });
  if (!fresh.length) return report(target || { title: deck.title, id: null, folder: deck.folder, cards: [] }, 0);
  deck.cards = fresh;
  if (target) {
    deck.title = target.title;
    deck.folder = target.folder || "";
    deck.course = target.course ?? target.folder ?? '';
    deck.mergeTargetId = target.id;
  }
  source.courses = importCourses({ course: deck.course });
  s.sources.push(source);
  s.drafts.push(deck);
  const published = ports.mutate("draft.publish.quick", s, { id: deck.id, draftVersion: deck.draftVersion });
  return report(get(s.decks, published.id, "题组"), fresh.length);
}

const cleanFolder = (folder) =>
  (typeof folder === "string" ? folder : "")
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean)
    .join(" / ")
    .slice(0, 200);

export { publicationTarget, publicationDuplicates, repairContextIssues, mergeContinuedDraft, importCourse, importJsonDeck, cleanFolder };
