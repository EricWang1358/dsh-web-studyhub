import { get } from "../../util.js";
import { learningState, learningScope } from "../../learning-scope.js";
import { skeletonTopics, topicGroupsView, lintScope, skeletonContext, skeletonSummary, saveSkeleton, patchSkeleton, saveTopicGroups } from "../../skeleton.js";
import { readDiagramSource, writeDiagramFile, readDiagramFile, removeDiagramFiles, removeDiagramFolder, diagramView, newDiagramRecord, addDiagram } from "../../skeleton-diagrams.js";



/* The knowledge skeleton is the structure of what the learner knows, not review work pushed at them: parked courses
   (lib/course-active.js) stay in it, so "all courses" here is still every course. */
const structure = (a) => ({ ...a, includeInactive: true });

/** skeleton operations close over only the ports declared by this context. */
export function createOperations(ports) {
  const { state: storagePort } = ports;
const handlers = {
"skeleton.topics": async function (a) {
      const state = await storagePort.view(),
        s = learningState(state, structure(a)),
        samples = Math.max(0, Math.min(3, Number(a.samples) || 0));
      const topics = skeletonTopics(s, { samples });
      // A course view hides groups whose topics all live in other courses.
      const groups = topicGroupsView(s, topics, { hideEmpty: s !== state });
      // A large library is read a page at a time (optionally only the topics not
      // yet in a group), so each result stays small enough to use directly
      // instead of spilling to a file the conversation then has to parse.
      const paged = a.ungrouped !== undefined || a.offset !== undefined || a.limit !== undefined;
      const waiting = new Set(groups.ungrouped);
      const pool = a.ungrouped ? topics.filter((t) => waiting.has(t.key)) : topics;
      const offset = Math.max(0, Math.floor(Number(a.offset) || 0));
      const limit = a.limit === undefined ? pool.length : Math.max(1, Math.min(500, Math.floor(Number(a.limit) || 1)));
      const page = pool.slice(offset, offset + limit);
      // compact: what the conversation needs to group topics, without deck lists.
      const list = a.compact
        ? page.map(({ key, topic, count, decks, samples: examples }) => ({ key, topic, count, decks: decks.map((d) => d.deckTitle), ...(examples ? { samples: examples } : {}) }))
        : page;
      if (!paged) return { topics: list, groups };
      return { topics: list, total: pool.length, ...(offset + limit < pool.length ? { nextOffset: offset + limit } : {}),
        groups: { groups: groups.groups.map(({ id, title, description, count }) => ({ id, title, description, count })),
          ungroupedCount: groups.ungrouped.length } };
    },
"skeleton.lint": async function (a) {
      return lintScope(await storagePort.view(), a.scope);
    },
"skeleton.context": async function (a) {
      return skeletonContext(await storagePort.view(), a.scope);
    },
"skeleton.list": async function (a) {
      const state = await storagePort.view(), selection = learningScope(state, structure(a));
      const matches = ref => state.decks.find(deck => deck.id === ref.deckId)?.cards.some(card =>
        (!ref.cardId || card.id === ref.cardId) && (!ref.topic || (card.topic || '未分类') === ref.topic) && selection.matches(ref.deckId, card));
      return { skeletons: (state.skeletons || []).filter(skeleton => selection.all || skeleton.scope.some(matches)).map(skeletonSummary).reverse() };
    },
"skeleton.get": async function (a) {
      return get((await storagePort.view()).skeletons || [], a.id, "Skeleton");
    },
/* Interactive diagrams of a skeleton drawn by an outside tool (Archify): stored as files, never run (lib/skeleton-diagrams.js). */
"skeleton.diagram.attach": async function (a) {
      const skeleton = get((await storagePort.view()).skeletons || [], a.id, "Skeleton");
      const source = await readDiagramSource({ path: a.path, workspace: a.workspace, root: storagePort.root });
      const same = (skeleton.diagrams || []).find((d) => d.sha256 === source.sha256);
      if (same) return { diagram: diagramView(skeleton, same), unchanged: true };
      let record, dropped = [];
      const written = newDiagramRecord({ skeleton, source, title: a.title });
      await writeDiagramFile(storagePort.root, skeleton.id, written.id, source.text);
      try {
        await storagePort.update((s) => {
          const current = get(s.skeletons || [], a.id, "Skeleton");
          record = { ...written, skeletonRevision: current.updatedAt };
          dropped = addDiagram(current, record);
        });
      } catch (error) {
        await removeDiagramFiles(storagePort.root, skeleton.id, [written.id]);
        throw error;
      }
      await removeDiagramFiles(storagePort.root, skeleton.id, dropped.map((d) => d.id));
      return { diagram: { ...record, stale: false }, unchanged: false,
        ...(dropped.length ? { rotated: dropped.map(({ id, title }) => ({ id, title })), notice: `最早的图「${dropped.map((d) => d.title).join("」「")}」已被替换：每个骨架最多留 8 张图。` } : {}) };
    },
"skeleton.diagram.list": async function (a) {
      const skeleton = get((await storagePort.view()).skeletons || [], a.id, "Skeleton");
      return { diagrams: (skeleton.diagrams || []).map((d) => diagramView(skeleton, d)).reverse() };
    },
"skeleton.diagram.get": async function (a) {
      const skeleton = get((await storagePort.view()).skeletons || [], a.id, "Skeleton");
      const record = get(skeleton.diagrams || [], a.diagramId, "Diagram");
      return { ...diagramView(skeleton, record), ...(await readDiagramFile(storagePort.root, skeleton.id, record)) };
    },
"skeleton.diagram.remove": async function (a) {
      get((await storagePort.view()).skeletons || [], a.id, "Skeleton");
      await storagePort.update((s) => {
        const current = get(s.skeletons || [], a.id, "Skeleton");
        get(current.diagrams || [], a.diagramId, "Diagram");
        current.diagrams = current.diagrams.filter((d) => d.id !== a.diagramId);
      });
      await removeDiagramFiles(storagePort.root, a.id, [a.diagramId]);
      return { removed: a.diagramId };
    },
"skeleton.delete": async function (a) {
      await storagePort.update((s) => {
        get(s.skeletons || [], a.id, "Skeleton");
        s.skeletons = s.skeletons.filter((k) => k.id !== a.id);
      });
      await removeDiagramFolder(storagePort.root, a.id);
      return { deleted: a.id };
    }
};
const mutations = {
"skeleton.save": (s, a) => saveSkeleton(s, a.skeleton ?? a),
"skeleton.patch": (s, a) => patchSkeleton(s, a),
"topic.groups.save": (s, a) => saveTopicGroups(s, a, learningState(s, structure(a)))
};
  return { handlers, mutations };
}
