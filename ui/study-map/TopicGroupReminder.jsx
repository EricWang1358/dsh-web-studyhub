import React, { useState } from 'react';
import { ui, uiFormat, getUiLanguage } from '../i18n.js';
import { Button } from '../components/index.js';
import { groupPrompt } from '../topic-group-prompt.js';

/* After an import the new topics sit outside the topic groups until someone
   remembers to fold them in. Say so in the library until it is done; "稍后"
   holds until the next import changes what is ungrouped. */
export default function TopicGroupReminder({ grouping, root, askInChat }) {
  const key = `study-topic-group-later:${root || 'local'}`;
  const [later, setLater] = useState(() => { try { return localStorage.getItem(key) || ''; } catch { return ''; } });
  if (!grouping?.ungrouped || !askInChat) return null;
  // A handful of topics needs no grouping; once groups exist, new topics should join them.
  if (!grouping.groups && grouping.topics < 12) return null;
  const signature = `${grouping.groups}:${grouping.ungrouped}`;
  if (later === signature) return null;
  const first = !grouping.groups;
  const hold = () => { setLater(signature); try { localStorage.setItem(key, signature); } catch { /* per-device only */ } };
  return (
    <div className="group-reminder" role="status">
      <span>{first ? uiFormat('学习库有 {0} 个主题，还没按知识域归并成主题组', [grouping.topics]) : uiFormat('有 {0} 个主题还没归入主题组（通常来自新导入的题组）', [grouping.ungrouped])}</span>
      <span className="group-reminder-actions">
        <Button variant="link" size="sm" iconEnd="arrow-right" onClick={() => askInChat(groupPrompt(first ? { mode: 'replace', topicCount: grouping.topics } : { mode: 'merge', ungrouped: grouping.ungrouped }, getUiLanguage()))}>{first ? ui('让对话归并主题') : ui('让对话归入主题组')}</Button>
        <Button variant="quiet" size="sm" onClick={hold}>{ui('稍后')}</Button>
      </span>
    </div>
  );
}
