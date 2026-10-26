import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Hint, SettingsSection, Switch, Tooltip, useToast } from '../components/index.js';
import { browserStorage } from '../storage.js';
import { clearItem, guidanceItemsFor, itemSeen, resetAllGuidance } from '../guidance/registry.js';
import { experimentalShown } from '../experimental-flag.js';
import { guidanceOn, itemMuted, readGuidanceState, setGuidanceOn, setItemMuted } from '../guidance/budget.js';

/* 设置 › 引导 (3.7 guidance, step 0): the master switch, every registered tip, card, tour and nudge (ui/guidance/registry.js) with its own switch when it
   appears by itself and 「再显示一次」 once it was seen, and the one 重新显示全部提示. Everything is kept in this browser (ui/storage.js); nothing is
   opened from here: a tip that is brought back appears the next time its page is opened. */

const KIND = { tip: '一句提示', card: '卡片', tour: '导览', nudge: '小提醒' };
const PROACTIVE_TIP = '没有点它也会出现。总开关和它自己的开关都能让它不再出现；以后新加的这类提示，每天最多出现一条，做题时不出现。';

/** Of the shared settings services the pane reads only `data` (an experiment's entry shows only while experiments are shown); the switches live in
    this browser. `storages` is for tests. */
export default function GuidancePane({ data, storages }) {
  const toast = useToast();
  const [, setVersion] = useState(0);
  const [error, setError] = useState('');
  const local = storages ? storages.local : browserStorage();
  const where = storages || undefined;
  const refresh = () => setVersion((value) => value + 1);
  const stored = readGuidanceState(local) !== null;
  const masterOn = guidanceOn(local);
  const items = guidanceItemsFor({ experimental: experimentalShown(data) });
  const seen = items.filter((item) => itemSeen(item, where));
  const refused = () => setError(ui('没能保存：这个浏览器现在不让保存设置（比如无痕窗口），刷新后会恢复原样。'));

  const setMaster = (on) => {
    setError('');
    if (!setGuidanceOn(on, local)) refused();
    else toast.success(on ? ui('引导提示已打开。') : ui('引导提示已关闭：主动出现的提示和卡片不再出现。'));
    refresh();
  };
  const setItem = (item, on) => {
    setError('');
    if (!setItemMuted(item.id, !on, local)) refused();
    refresh();
  };
  const again = (item) => {
    setError('');
    if (!clearItem(item, where)) refused();
    else toast.success(uiFormat('「{0}」会在你下次打开「{1}」时再出现。', [ui(item.title), ui(item.where)]));
    refresh();
  };
  const resetAll = () => {
    setError('');
    const cleared = resetAllGuidance(where, items);
    if (cleared.length < seen.length) refused();
    if (cleared.length) {
      const names = cleared.map((id) => ui(items.find((item) => item.id === id).title)).join(ui('、'));
      const message = uiFormat('已重新显示 {0} 项：{1}。下次打开对应的页面时会再出现。', [cleared.length, names]);
      toast.success(masterOn ? message : `${message}${ui('「显示引导提示」现在关着，主动出现的那几项要等打开后才会出现。')}`);
    }
    refresh();
  };

  return (
    <>
      <SettingsSection tour="settings-guidance" title={ui('引导')}
        lead={ui('第一次用到某个功能时，StudyHub 会给一句提示或一张卡片。这里可以把它们关掉，或让看过的再出现一次。这些选择只存在这个浏览器里。')}>
        <Switch name="guidanceOn" label={ui('显示引导提示')} checked={masterOn} onChange={setMaster}
          hint={ui('关掉后，主动出现的提示和卡片都不再出现；首页的入门三步、模型设置的引导，以及出错或页面为空时的说明照常显示。')} />
        <div className="settings-actions">
          <Button variant="primary" disabled={!seen.length} onClick={resetAll} data-guidance="reset-all">{ui('重新显示全部提示')}</Button>
        </div>
        <Hint>{seen.length
          ? uiFormat('有 {0} 项已经看过。重新显示后，它们会在你下次打开对应的页面时出现，不会马上弹出来。', [seen.length])
          : ui('现在没有看过的提示，不需要重新显示。')}</Hint>
        {!stored && <Hint tone="warning" data-guidance="no-storage">{ui('这个浏览器现在不能保存设置（比如无痕窗口），这一页的改动记不住。')}</Hint>}
        {error && <Hint tone="error" role="alert">{error}</Hint>}
      </SettingsSection>
      <SettingsSection title={ui('每一项提示')} lead={ui('每一项在哪里出现、什么时候出现。看过的可以单独再显示一次。')}>
        <ul className="guidance-list">
          {items.map((item) => {
            const wasSeen = seen.includes(item), title = ui(item.title);
            return (
              <li key={item.id} className="guidance-item" data-guidance-item={item.id}>
                <div className="guidance-item__head">
                  <span className="guidance-item__meta">
                    <Badge size="sm">{ui(KIND[item.kind])}</Badge>
                    {item.proactive && <Tooltip layer content={ui(PROACTIVE_TIP)}><span tabIndex={0} className="guidance-item__tipped"><Badge size="sm" tone="info">{ui('主动出现')}</Badge></span></Tooltip>}
                    <span className="guidance-item__where">{ui(item.where)}</span>
                  </span>
                  <Badge size="sm" tone={wasSeen ? 'success' : 'neutral'} data-guidance-state={wasSeen ? 'seen' : 'unseen'}>{wasSeen ? ui('已看过') : ui('还没看过')}</Badge>
                </div>
                {item.proactive
                  ? <Switch name={`guidance-${item.id}`} label={title} hint={ui(item.trigger)} checked={masterOn && !itemMuted(item.id, local)} disabled={!masterOn}
                      onChange={(on) => setItem(item, on)} />
                  : <div className="guidance-item__text"><strong>{title}</strong><Hint as="span">{ui(item.trigger)}</Hint></div>}
                {wasSeen && <div className="guidance-item__actions">
                  <Button size="sm" variant="secondary" aria-label={uiFormat('再显示一次：{0}', [title])} onClick={() => again(item)}>{ui('再显示一次')}</Button>
                </div>}
              </li>
            );
          })}
        </ul>
        {!masterOn && <Hint>{ui('「显示引导提示」关着时，上面的单项开关不起作用，打开后恢复各自的设置。')}</Hint>}
      </SettingsSection>
    </>
  );
}
