import { ui, uiIsEnglish } from './i18n.js';

/* 知识骨架页的纯逻辑：按课程过滤主题组、把「骨架不存在」之类的错误翻成
   人话、处理已经不存在的骨架焦点。不碰 React，方便单独测试。 */

/**
 * Group rows for the picker. Groups are stored library-wide, so a course view
 * only keeps groups that still have members in the current topic list; a search
 * keeps the groups whose title matches (all members) or that hold matching
 * topics (those members). The 未归入 bucket is a row too, flagged `loose`.
 */
export function courseGroupRows({ topics, groupView, query = '', shown = [] }) {
  if (!topics || !groupView?.groups?.length) return [];
  const byKey = new Map(topics.map(topic => [topic.key, topic]));
  const needle = query.trim().toLowerCase();
  const rows = [
    ...groupView.groups.map(group => ({ ...group, members: group.topics.map(key => byKey.get(key)).filter(Boolean) })),
    ...(groupView.ungrouped?.length
      ? [{ id: '__ungrouped', title: ui('未归入主题组'), description: ui('还没有归入任何主题组的主题'),
        members: groupView.ungrouped.map(key => byKey.get(key)).filter(Boolean), loose: true }]
      : []),
  ].filter(group => group.members.length);
  return rows.map(group => {
    if (!needle) return group;
    const titleHit = group.title.toLowerCase().includes(needle) || (group.description || '').toLowerCase().includes(needle);
    const members = titleHit ? group.members : group.members.filter(member => shown.includes(member));
    return members.length ? { ...group, members, searchHit: !titleHit } : null;
  }).filter(Boolean);
}

/** Saved groups in the rows (the 未归入 bucket is not a group the user made). */
export const countGroupRows = rows => rows.filter(row => !row.loose).length;

const HAN = /[㐀-鿿]/;

/**
 * Plain-language version of a skeleton failure. `stale` (the remembered skeleton
 * was deleted or is not in this course) is not an error at all. Anything that is
 * already readable in the UI language is kept; raw server English in a Chinese
 * UI is replaced. Local on purpose: swap for the shared friendly-error mapper
 * once one exists in lib/ui.
 */
export function classifySkeletonError(error) {
  if (error?.code === 'not-found') return { kind: 'stale' };
  if (error?.code === 'STUDY_UNAVAILABLE')
    return { kind: 'error', text: ui('学习插件暂时没有连上，稍等一下会自动重试。') };
  const message = String(error?.message || '').trim();
  const readable = message && (uiIsEnglish() ? !HAN.test(message) && !/Study request failed|STUDY_ERROR/.test(message) : HAN.test(message));
  return { kind: 'error', text: readable ? message : ui('这一步没有成功，请稍后再试一次。') };
}

/** Open one skeleton. A missing one resolves to { stale: true } instead of rejecting. */
export async function openSkeleton(call, id) {
  try {
    return { skeleton: await call('skeleton.get', { id }) };
  } catch (error) {
    const result = classifySkeletonError(error);
    return result.kind === 'stale' ? { stale: true } : { error: result };
  }
}

/** After switching course: is the open skeleton listed there? A failed check keeps the user's place. */
export async function focusSurvivesCourse(call, id, course) {
  if (!id) return true;
  try {
    const { skeletons } = await call('skeleton.list', { course });
    return skeletons.some(item => item.id === id);
  } catch {
    return true;
  }
}
