// Templates are application copy; values are user-owned names and stay intact.
export function runTitleInfo(s, r) {
  const title = (template, ...values) => ({ template, values });
  if (r.purpose === 'course') return r.course ? title('课程 · {0}', r.course) : title('未分类课程');
  if (r.workflowSessionId) {
    const session = s.workflowSessions.find(x => x.id === r.workflowSessionId);
    if (session) return title('学习流 · {0}', session.topic);
  }
  if (r.mode === 'path' && !r.scope?.length) return title('今日学习');
  if (r.mode === 'exam') return title('模拟考试 · {0} 题', r.entries.length);
  if (r.scope?.length && r.scope.every(x => x.cardId)) {
    const coach = s.decks.find(d => d.systemKind === 'coach');
    if (coach && r.scope.every(x => x.deckId === coach.id)) return title('为你定制 · {0} 题', r.scope.length);
    if (r.purpose === 'inbox') return title('信箱 · {0} 道', r.scope.length);
    return title(r.returnTo ? '前置题 · {0} 道' : '所选 {0} 道题', r.scope.length);
  }
  const titles = [...new Set((r.scope?.length ? r.scope : [{ deckId: r.deckId }]).map(x => s.decks.find(d => d.id === x.deckId)?.title || '题组'))];
  const topics = (r.scope || []).filter(x => x.topic).map(x => x.topic);
  return topics.length === 1 && titles.length === 1 ? title('{0} › {1}', titles[0], topics[0])
    : titles.length > 1 ? title('{0} 等 {1} 个题组', titles[0], titles.length) : title('{0}', titles[0]);
}
export function runTitle(s, r) {
  const { template, values } = runTitleInfo(s, r);
  return template.replace(/\{(\d+)\}/g, (_, i) => values[i] ?? '');
}
