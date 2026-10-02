import { get } from "../../util.js";
import { learningState, learningScope } from "../../learning-scope.js";
import { skeletonTopics, topicGroupsView, lintScope, skeletonContext, skeletonSummary, saveSkeleton, patchSkeleton, saveTopicGroups } from "../../skeleton.js";



/** skeleton operations close over only the ports declared by this context. */
export function createOperations(ports) {
  const { state: storagePort } = ports;
const handlers = {
"skeleton.topics": async function (a) {
      const state = await storagePort.view(),
        s = learningState(state, a),
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
      const state = await storagePort.view(), selection = learningScope(state, a);
      const matches = ref => state.decks.find(deck => deck.id === ref.deckId)?.cards.some(card =>
        (!ref.cardId || card.id === ref.cardId) && (!ref.topic || (card.topic || '未分类') === ref.topic) && selection.matches(ref.deckId, card));
      return { skeletons: (state.skeletons || []).filter(skeleton => selection.all || skeleton.scope.some(matches)).map(skeletonSummary).reverse() };
    },
"skeleton.get": async function (a) {
      return get((await storagePort.view()).skeletons || [], a.id, "Skeleton");
    }
};
const mutations = {
"skeleton.save": (s, a) => saveSkeleton(s, a.skeleton ?? a),
"skeleton.patch": (s, a) => patchSkeleton(s, a),
"topic.groups.save": (s, a) => saveTopicGroups(s, a, learningState(s, a)),
"skeleton.delete": (s, a) => {
      get(s.skeletons || [], a.id, "Skeleton");
      s.skeletons = s.skeletons.filter((k) => k.id !== a.id);
      return { deleted: a.id };
    }
};
  return { handlers, mutations };
}
