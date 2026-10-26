import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { usePersistentState } from '../storage.js';
import { guidanceAllows } from '../guidance/budget.js';
import { Button } from '../components/index.js';
import { HandOff } from '../hand-off/HandOff.jsx';

/* After an import the new topics sit outside the topic groups until someone
   remembers to fold them in. Say so in the library until it is done; "稍后"
   holds until the next import changes what is ungrouped. */
/** The key prefix of 稍后, one key per library (it holds the grouping it was put off at); 设置 › 引导 reads it (ui/guidance/registry.js). */
export const TOPIC_GROUP_LATER_PREFIX = 'study-topic-group-later:';
export const topicGroupLaterKey = root => `${TOPIC_GROUP_LATER_PREFIX}${root || 'local'}`;

export default function TopicGroupReminder({ grouping, root }) {
  const key = topicGroupLaterKey(root);
  const [later, setLater] = usePersistentState(key, '', { parse: String, serialize: String }); // per-device only
  if (!grouping?.ungrouped) return null;
  if (!guidanceAllows('library.topic-groups')) return null; // 设置 › 引导 switched reminders like this off (ui/guidance/registry.js)
  // A handful of topics needs no grouping; once groups exist, new topics should join them.
  if (!grouping.groups && grouping.topics < 12) return null;
  const signature = `${grouping.groups}:${grouping.ungrouped}`;
  if (later === signature) return null;
  const first = !grouping.groups;
  const hold = () => setLater(signature);
  return (
    <div className="group-reminder" role="status">
      <span>{first ? uiFormat('学习库有 {0} 个主题，还没按知识域归并成主题组', [grouping.topics]) : uiFormat('有 {0} 个主题还没归入主题组（通常来自新导入的题组）', [grouping.ungrouped])}</span>
      <span className="group-reminder-actions">
        <HandOff id="topics.group" what={first ? '让主会话把主题按知识域归并成主题组（不改题目）' : '让主会话把新增的主题归入主题组（不改题目）'}
          input={first ? { mode: 'replace', topicCount: grouping.topics } : { mode: 'merge', ungrouped: grouping.ungrouped, alternative: true }} />
        <Button variant="quiet" size="sm" onClick={hold}>{ui('稍后')}</Button>
      </span>
    </div>
  );
}
