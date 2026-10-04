/* Browser harness for tests/wp-b-overlays-browser.test.mjs: one scenario per
   overlay primitive, mounted on demand, state exposed on window. */
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmDialog, Dialog, InlineConfirm, Menu, Popover, ToastRegion, Tooltip } from '../../ui/components/index.js';

window.calls = { confirm: 0, close: 0, done: 0, inlineConfirm: 0, inlineCancel: 0, undo: 0, select: [], dialogClose: 0, dismissed: 0 };

function ConfirmScenario() {
  const [open, setOpen] = useState(true);
  return <div className="study-app">
    <button id="opener" type="button" onClick={() => setOpen(true)}>open</button>
    {open && <ConfirmDialog title="删除这张卡片？" confirmLabel="确认删除" description="删除后会立刻提示。"
      onClose={() => { window.calls.close += 1; setOpen(false); }} onDone={() => { window.calls.done += 1; setOpen(false); }}
      onConfirm={() => { window.calls.confirm += 1; return new Promise((resolve, reject) => { window.settle = fail => (fail ? reject(new Error('磁盘已满')) : resolve()); }); }}>
      <p>读论文</p>
    </ConfirmDialog>}
  </div>;
}

function InlineScenario() {
  const [asking, setAsking] = useState(false);
  const trigger = useRef(null);
  return <div className="study-app">
    {!asking
      ? <button id="trigger" ref={trigger} type="button" onClick={() => setAsking(true)}>删除</button>
      : <InlineConfirm title="删除这个工作流？" confirmLabel="确认删除" returnFocusRef={trigger}
        onCancel={() => { window.calls.inlineCancel += 1; setAsking(false); }} onConfirm={() => { window.calls.inlineConfirm += 1; setAsking(false); }}>可以撤销。</InlineConfirm>}
  </div>;
}

function PopoverScenario() {
  return <div className="study-app" style={{ padding: 40 }}>
    <button id="before" type="button">before</button>
    <Popover label="显示设置" icon="type"><button id="first" type="button">A</button><button id="second" type="button">B</button></Popover>
    <button id="after" type="button">after</button>
  </div>;
}

function MenuScenario() {
  const items = [{ id: 'edit', label: '编辑' }, { heading: true, label: '移到' }, { id: 'off', label: '停用', disabled: true }, { id: 'delete', label: '删除', danger: true }];
  return <div className="study-app" style={{ padding: 40 }}>
    <Menu label="更多操作" items={items} onSelect={id => window.calls.select.push(id)} />
    <button id="after" type="button">after</button>
  </div>;
}

function ToastScenario() {
  const [toast, setToast] = useState({ id: 1, tone: 'success', message: '已删除：读论文', undo: true, timeout: 300,
    action: { label: '撤销', onClick: () => { window.calls.undo += 1; } } });
  return <div className="study-app"><ToastRegion placement="inline" toasts={toast ? [toast] : []} onDismiss={() => { window.calls.dismissed += 1; setToast(null); }} /></div>;
}

function BusyScenario() {
  return <div className="study-app"><Dialog title="设置" busy onClose={() => { window.calls.dialogClose += 1; }}><p>处理中</p></Dialog></div>;
}

function DropScenario() {
  return <div className="study-app"><Dialog title="补全原文件" guardDrops onClose={() => {}}><p id="margin">留白</p></Dialog></div>;
}

function TooltipScenario() {
  return <div className="study-app" style={{ padding: 60 }}>
    <Tooltip content="本周三 14:00 截止"><button id="subject" type="button">日期</button></Tooltip>
    <button id="after" type="button">after</button>
  </div>;
}

const SCENARIOS = { confirm: ConfirmScenario, inline: InlineScenario, popover: PopoverScenario, menu: MenuScenario, toast: ToastScenario, busy: BusyScenario, drop: DropScenario, tooltip: TooltipScenario };
let root;
window.mountScenario = name => {
  root?.unmount();
  const host = document.getElementById('root');
  host.replaceChildren();
  root = createRoot(host);
  const Scenario = SCENARIOS[name];
  root.render(<Scenario />);
};
window.harnessReady = true;
