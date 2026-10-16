import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* A one-click install in the 任务 console (the legacy `local-install` row of lib/contexts/audio/install-row.js, shared by MinerU and Marker): the row and
   the detail say the step (第 3/6 步：安装 MinerU), the detail shows the steps and the log in place of the model-call panels (an install makes no model
   calls), and an install that was stopped is 已暂停 with 继续安装, not a crimson 删除. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as TaskConsole } from './ui/tasks/TaskConsole.jsx';
  export { setUiLanguage } from './ui/i18n.js';
  export { installResume } from './ui/tasks/task-control.js';
`);

const iso = minutes => new Date(Date.UTC(2026, 9, 16, 10, minutes)).toISOString();
const NAMES = ['准备安装工具', '准备 Python', '安装 MinerU', '下载模型', '启用本机服务', '检查能不能用'];
const steps = (at, ended = '') => ['tools', 'python', 'package', 'models', 'enable', 'check'].map((id, index) => ({ id, name: NAMES[index],
  state: index < at ? 'done' : index === at ? (ended === 'failed' ? 'failed' : 'active') : 'pending' }));
const row = extra => ({ id: 'mineru-install-1a2b3c4d', type: 'local-install', tool: 'mineru', label: '安装本机 MinerU', status: 'running', stage: '第 3/6 步：安装 MinerU',
  done: 2, total: 6, installSteps: steps(2), folder: 'D:\\StudyHub\\MinerU', tier: 'standard', startedAt: iso(2),
  events: [{ id: 'e1', at: iso(2), level: 'info', code: 'status', args: { status: 'running' }, text: '第 1/6 步：准备安装工具' },
    { id: 'e2', at: iso(3), level: 'step', code: 'stage', text: '第 3/6 步：安装 MinerU' }], ...extra });
const render = (jobs, language = 'zh', app = {}) => {
  m.setUiLanguage(language);
  try {
    return renderToStaticMarkup(inApp(m, React.createElement(m.TaskConsole, { data: { jobs, drafts: [], decks: [] }, openers: { resultOf: () => null } }),
      { data: { jobs }, app: { lib: { taskFocus: null }, ...app } }));
  } finally { m.setUiLanguage('zh'); }
};
const detailOf = html => html.slice(html.indexOf('class="tc-detail"'));
const textOf = html => html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');

test('a running install says its step in the row and in the detail, and shows its steps and its log instead of the model-call panels', () => {
  const html = render([row()]);
  const list = html.slice(0, html.indexOf('class="tc-detail"'));
  assert.match(textOf(list), /第 3\/6 步：安装 MinerU/, 'the row says the step, not only 进行中');
  const detail = detailOf(html);
  assert.match(textOf(detail), /第 3\/6 步：安装 MinerU/);
  for (const absent of ['并行时间线', '实时输出', '正在进行 0', '模型任务']) assert.ok(!textOf(detail).includes(absent), `no ${absent}: an install makes no model calls`);
  assert.match(textOf(detail), /当前步骤 安装 MinerU/, 'the facts tile says the step it is on');
  assert.match(textOf(detail), /安装步骤 6/);
  for (const name of NAMES) assert.ok(textOf(detail).includes(name), name);
  assert.equal((detail.match(/<li data-state="done"/g) || []).length, 2);
  assert.match(detail, /<li data-state="active" aria-current="step"/);
  assert.match(textOf(detail), /日志/);
  assert.match(detail, />停止</, 'a running install can still be stopped from here');
});

test('an install that was stopped is 已暂停, offers 继续安装 in its own folder and tier, and is not a crimson 删除', () => {
  const html = render([row({ status: 'cancelled', stage: '已暂停；已下载的部分保留', installSteps: steps(3), done: 3, finishedAt: iso(9) })]);
  const detail = detailOf(html);
  assert.match(textOf(html), /已暂停/);
  assert.doesNotMatch(textOf(html), /已停止/);
  assert.match(detail, /data-install-resume[^>]*>继续安装</);
  assert.doesNotMatch(detail, /tc-head__delete/, 'no 删除 beside 继续安装');
  assert.match(textOf(detail), /知道了/, 'it can still be put away');
});

test('继续安装 starts the install of its tool again, in the folder and the tier it used; a running or finished install has none', () => {
  const failed = row({ status: 'failed', stage: '安装没有完成', installSteps: steps(3, 'failed'), finishedAt: iso(9) });
  assert.deepEqual(m.installResume(failed), { action: 'mineru.install.start', args: { confirm: true, location: 'D:\\StudyHub\\MinerU', tier: 'standard' } });
  assert.match(detailOf(render([failed])), /data-install-resume/);
  const marker = row({ id: 'marker-install-1', tool: 'marker', label: '安装 Marker', status: 'cancelled', stage: '已取消安装', folder: 'E:\\Marker', tier: '',
    installSteps: [{ id: 'install', name: '正在下载并安装 marker-pdf', state: 'active' }], finishedAt: iso(9) });
  assert.deepEqual(m.installResume(marker), { action: 'marker.install.start', args: { confirm: true, location: 'E:\\Marker' } });
  assert.match(detailOf(render([marker])), /data-install-resume[^>]*>继续安装</);
  assert.equal(m.installResume(row()), null);
  assert.equal(m.installResume(row({ status: 'complete', finishedAt: iso(9) })), null);
});

test('English: the step and the steps are in the learner\'s language', () => {
  const html = render([row()], 'en');
  assert.match(textOf(html), /Step 3\/6: Installing MinerU/);
  assert.match(textOf(detailOf(html)), /Install steps 6/);
  assert.match(textOf(detailOf(html)), /Getting the installer/);
});
