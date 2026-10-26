import React, { useId, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Hint, SettingsSection, Switch, Tooltip, useToast } from '../components/index.js';
import { browserStorage } from '../storage.js';
import { canComeBack, clearItem, guidanceItemsFor, itemSeen, resetAllGuidance } from '../guidance/registry.js';
import { guidanceOn, itemMuted, readGuidanceState, setGuidanceOn, setItemMuted } from '../guidance/budget.js';
import { experimentalShown } from '../experimental-flag.js';
import { hasOwnDeck } from '../study-map/home-plan.js';

/* 设置 › 引导 (3.7 guidance, step 0): the master switch, every registered tip, card, tour and nudge (ui/guidance/registry.js) with its own switch when it
   appears by itself and 「再显示一次」 once it was seen, and the one 重新显示全部提示. Everything is kept in this browser (ui/storage.js); nothing is
   opened from here, and every toast says when, and whether, what was brought back can appear. */

const KIND = { tip: '一句提示', card: '卡片', tour: '导览', nudge: '小提醒' };
const PROACTIVE_TIP = '没有点它也会出现。总开关和它自己的开关都能让它不再出现；以后新加的这类提示，每天最多出现一条，做题时不出现。';
/* What the master switch hides and what it leaves, said in full (tests/guidance-settings-ui.test.mjs keeps this list equal to the proactive entries). */
const MASTER_HINT = '关掉后，阅读页的两条提示、「补全原文件」的说明、主题组提醒、Archify 推荐卡和「笔记换了位置」都不再出现；首页的入门三步、模型设置的引导、出错和空页面的说明，以及课程准备「全部完成」那句照常显示。';
const MASTER_OFF_TOAST = '引导提示已关闭：阅读页的两条提示、「补全原文件」的说明、主题组提醒、Archify 推荐卡和「笔记换了位置」不再出现。';

/** Of the shared settings services the pane reads `data` (an experiment's entry, and whether 入门三步 can still appear) and `capabilities`; the
    switches live in this browser. `storages` is for tests. */
export default function GuidancePane({ data, capabilities, storages }) {
  const toast = useToast();
  const offNoteId = useId();
  const [, setVersion] = useState(0);
  const [error, setError] = useState('');
  const local = storages ? storages.local : browserStorage();
  const where = storages || undefined;
  const refresh = () => setVersion((value) => value + 1);
  const stored = readGuidanceState(local) !== null;
  const masterOn = guidanceOn(local);
  const context = { ownDeck: !!data && hasOwnDeck(data) };
  const items = guidanceItemsFor({ experimental: experimentalShown(data), system: !!capabilities?.system });
  const seen = items.filter((item) => itemSeen(item, where));
  const returnable = seen.filter((item) => canComeBack(item, context));
  const muted = (item) => itemMuted(item.id, local);
  const refused = () => setError(ui('没能保存：这个浏览器现在不让保存设置，这次的改动没有生效。'));
  const names = (list) => list.map((item) => ui(item.title)).join(ui('、'));

  const setMaster = (on) => {
    setError('');
    if (!setGuidanceOn(on, local)) refused();
    else toast.success(on ? ui('引导提示已打开。') : ui(MASTER_OFF_TOAST));
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
    else if (item.proactive && (!masterOn || muted(item))) {
      const switches = !masterOn && muted(item) ? ui('「显示引导提示」和它自己的开关') : !masterOn ? ui('「显示引导提示」') : ui('它自己的开关');
      toast.success(uiFormat('{0}已重置，但现在被{1}关着；打开后，{2}会再出现。', [ui(item.title), switches, ui(item.again)]));
    } else toast.success(uiFormat('{0}：{1}会再出现。', [ui(item.title), ui(item.again)]));
    refresh();
  };
  const resetAll = () => {
    setError('');
    const clearedIds = resetAllGuidance(where, returnable);
    if (clearedIds.length < returnable.length) refused();
    const cleared = returnable.filter((item) => clearedIds.includes(item.id));
    if (cleared.length) {
      const parts = [uiFormat('已重新显示 {0} 项：{1}。它们不会马上弹出来，而是在各自该出现的时候再出现。', [cleared.length, names(cleared)])];
      const proactive = cleared.filter((item) => item.proactive);
      if (!masterOn && proactive.length) parts.push(uiFormat('其中{0}要等「显示引导提示」打开后才会出现。', [names(proactive)]));
      const own = proactive.filter(muted);
      if (own.length) parts.push(uiFormat('{0}自己的开关关着，打开后才会出现。', [names(own)]));
      toast.success(parts.join(''));
    }
    refresh();
  };

  return (
    <>
      <SettingsSection tour="settings-guidance" title={ui('引导')}
        lead={ui('第一次用到某个功能时，StudyHub 会给一句提示或一张卡片。这里可以把它们关掉，或让看过的再出现一次。这些选择只存在这个浏览器里。')}>
        <Switch name="guidanceOn" label={ui('显示引导提示')} checked={masterOn} onChange={setMaster} hint={ui(MASTER_HINT)} />
        {!masterOn && <Hint id={offNoteId} data-guidance="master-off">{ui('「显示引导提示」关着时，下面每一项的开关暂时不起作用；打开后恢复各自的设置。')}</Hint>}
        <div className="settings-actions">
          <Button variant="primary" disabled={!returnable.length} onClick={resetAll} data-guidance="reset-all">{ui('重新显示全部提示')}</Button>
        </div>
        <Hint>{returnable.length
          ? uiFormat('有 {0} 项已经看过。重新显示后，它们会在各自该出现的时候再出现，不会马上弹出来。', [returnable.length])
          : ui('现在没有可以重新显示的提示。')}</Hint>
        {!stored && <Hint tone="warning" data-guidance="no-storage">{ui('这个浏览器现在不能保存设置（比如无痕窗口），这一页的改动记不住。')}</Hint>}
        {error && <Hint tone="error" role="alert">{error}</Hint>}
      </SettingsSection>
      <SettingsSection title={ui('每一项提示')} lead={ui('每一项在哪里出现、什么时候出现。看过的可以单独再显示一次。')}>
        <ul className="guidance-list">
          {items.map((item) => {
            const wasSeen = seen.includes(item), title = ui(item.title), back = canComeBack(item, context);
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
                  ? <Switch name={`guidance-${item.id}`} label={title} hint={ui(item.trigger)} checked={masterOn && !muted(item)} disabled={!masterOn}
                      aria-describedby={masterOn ? undefined : offNoteId} onChange={(on) => setItem(item, on)} />
                  : <div className="guidance-item__text"><strong>{title}</strong><Hint as="span">{ui(item.trigger)}</Hint></div>}
                {!back && <Hint className="guidance-item__note" data-guidance="no-return">{ui('这个学习库已经有自己的题组，入门三步不会再出现。')}</Hint>}
                {wasSeen && back && <div className="guidance-item__actions">
                  <Button size="sm" variant="secondary" aria-label={uiFormat('再显示一次：{0}', [title])} onClick={() => again(item)}>{ui('再显示一次')}</Button>
                </div>}
              </li>
            );
          })}
        </ul>
      </SettingsSection>
    </>
  );
}
