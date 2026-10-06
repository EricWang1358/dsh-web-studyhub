/* Browser harness for tests/select-combobox-browser.test.mjs: Select and Combobox mounted with state, results on window. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Combobox, Dialog, Field, Popover, Select } from '../../ui/components/index.js';
import { courseEntries } from '../../ui/course-picker-entries.js';
import Ingest from '../../ui/Ingest.jsx';

window.calls = { select: [], course: [], actions: [], deck: [], dialog: [], heading: [], popover: [], ingest: [] };

const TONES = [{ value: 'friendly', label: '亲切', hint: '默认' }, { value: 'professional', label: '专业' }, { value: 'strict', label: '严格', disabled: true }];
const GROUPED = [{ group: '常用', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] }, { group: '其他', options: [{ value: 'c', label: 'Gamma' }, { value: '', label: '不选' }] }];
const COURSES = ['MA1522 线性代数', 'MA1522 线性代数 / 第 1 章 行列式', 'MA1522 线性代数 / 第 2 章 矩阵', 'MA1522 线性代数 / 第 3 章 向量空间', 'CS2040S 数据结构', 'ST2131 概率论', 'PC1101 大学物理']
  .map(name => ({ name }));
const DECKS = [{ group: 'MA1522 线性代数', options: [{ value: 'd1', label: '第 4 章 特征值与特征向量', hint: '38 题' }, { value: 'd2', label: '期末 · 特征分解专项', hint: '12 题' }, { value: 'd3', label: '第 1 章 行列式', hint: '9 题' }] },
  { group: 'CS2040S 数据结构', options: [{ value: 'd4', label: '图与最短路', hint: '20 题' }] }];

function Scenario() {
  const [tone, setTone] = useState('friendly');
  const [empty, setEmpty] = useState('');
  const [many, setMany] = useState(1);
  const [grouped, setGrouped] = useState('');
  const [course, setCourse] = useState('MA1522 线性代数');
  const [deck, setDeck] = useState('new');
  const [heading, setHeading] = useState('MA1522 线性代数 / 第 2 章 矩阵');
  const [dialog, setDialog] = useState(false);
  const [inner, setInner] = useState('a');
  const [innerDeck, setInnerDeck] = useState('');
  const [typed, setTyped] = useState('');
  const [inPopover, setInPopover] = useState('a');
  return <div className="study-app" id="scene" style={{ padding: 24, display: 'block', height: 'auto', minHeight: 900 }}>
    <div id="fields" style={{ display: 'grid', gap: 16, maxWidth: 420 }}>
      <Field label="讲解口吻" hint="亲切或专业"><Select name="tone" value={tone} options={TONES} onChange={(value, { option }) => { window.calls.select.push([value, option.label]); setTone(value); }} /></Field>
      <Field label="空的选择" required error={empty ? undefined : '请先选择'}><Select value={empty} placeholder="选择…" options={GROUPED.slice(0, 1)[0].options} onChange={setEmpty} /></Field>
      <Field label="分组" hint="分组与空值"><Select value={grouped} options={GROUPED} onChange={value => { window.calls.select.push([value, 'grouped']); setGrouped(value); }} /></Field>
      <Field label="停用"><Select value="a" disabled options={GROUPED[0].options} onChange={() => { window.calls.select.push(['disabled']); }} /></Field>
      <Field label="很多项"><Select value={many} onChange={setMany} options={Array.from({ length: 60 }, (_, i) => ({ value: i + 1, label: `第 ${i + 1} 项` }))} /></Field>
      <Field label="换课程" hint="可搜索">
        <Combobox value={course} onChange={value => { window.calls.course.push(value); setCourse(value); }} options={courseEntries({ courses: COURSES, current: course })}
          label="换课程" searchPlaceholder="搜索课程或章节" emptyText={query => `没有叫「${query}」的课程`}
          actions={[{ id: 'settings', label: '课程设置…', icon: 'settings', onSelect: () => window.calls.actions.push('settings') }]} />
      </Field>
      <Field label="题组"><Combobox value={deck} valueLabel="＋ 新建题组" onChange={value => { window.calls.deck.push(value); setDeck(value); }} options={DECKS} label="题组" searchPlaceholder="搜索题组"
        emptyText={query => `没有叫「${query}」的题组`}
        actions={[{ id: 'new', icon: 'plus', enter: true, label: query => (query ? `新建题组「${query}」` : '新建题组'), onSelect: query => { window.calls.actions.push(['new', query]); setTyped(query); setDeck('new'); } }]} />
      </Field>
      <p id="typed">{typed}</p>
    </div>
    <h1 id="heading" style={{ fontSize: 28, margin: '24px 0' }}>
      <Combobox variant="heading" label="切换当前课程" value={heading} onChange={value => { window.calls.heading.push(value); setHeading(value); }} options={courseEntries({ courses: COURSES, current: heading })}
        actions={[{ id: 'course-settings', label: '课程设置…', icon: 'settings', onSelect: () => window.calls.actions.push('course-settings') }]}>{heading}</Combobox>
    </h1>
    <Button onClick={() => setDialog(true)}>打开对话框</Button>
    <Popover label="布局" placement="bottom-start" trigger={({ props, ref }) => <Button ref={ref} {...props}>布局</Button>}>
      <Select aria-label="布局方向" value={inPopover} options={GROUPED[0].options} onChange={value => { window.calls.popover.push(value); setInPopover(value); }} />
    </Popover>
    {dialog && <Dialog title="对话框里的选择" onClose={() => setDialog(false)} footer={<Button onClick={() => setDialog(false)}>完成</Button>}>
      <Field label="对话框 Select"><Select value={inner} options={GROUPED[0].options} onChange={value => { window.calls.dialog.push(value); setInner(value); }} /></Field>
      <Field label="对话框 Combobox"><Combobox value={innerDeck} placeholder="选择题组" onChange={value => { window.calls.dialog.push(value); setInnerDeck(value); }} options={DECKS} label="对话框题组" /></Field>
    </Dialog>}
  </div>;
}

/* The real Ingest form with a small library: its deck picker is a Combobox whose footer action creates a deck with the typed name. */
function IngestScenario() {
  const decks = [{ id: 'd1', title: '第 4 章 特征值', course: 'MA1522 线性代数', count: 38 }, { id: 'd2', title: '图与最短路', course: 'CS2040S 数据结构', count: 20 }, { id: 'd3', title: '期末 · 错题', course: 'MA1522 线性代数', count: 12 }];
  const data = { decks, modelReady: true, focus: { course: 'MA1522 线性代数', courses: [{ name: 'MA1522 线性代数' }, { name: 'CS2040S 数据结构' }] } };
  return <div className="study-app" id="scene" style={{ padding: 24, display: 'block', height: 'auto', minHeight: 900 }}><Ingest data={data} busy={false} start={config => window.calls.ingest.push(config)} onOpenSettings={() => {}} /></div>;
}

let root;
window.mountScenario = (name) => {
  root?.unmount();
  const host = document.getElementById('root');
  host.replaceChildren();
  root = createRoot(host);
  root.render(name === 'ingest' ? <IngestScenario /> : <Scenario />);
};
window.harnessReady = true;
