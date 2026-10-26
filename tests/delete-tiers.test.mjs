import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as espree from 'espree';

/* The two tiers of deletion (ui/DESIGN.md Confirmations, 3.7.0 D1). Tier 1 (资料, 题目 / 题组) keeps archive-first and PermanentDeleteDialog; a draft asks once,
   in DeleteDraftDialog; everything else is one click with 撤销 (ui/undoable.js). These guards read the JSX (espree), so a nested `/>` in a prop, a title kept in a
   variable or an aliased import does not hide anything: an InlineConfirm must never confirm a deletion, and a button must never swap its label to ask twice. */

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : /\.(jsx?)$/.test(name) ? [path.replace(/\\/g, '/')] : [];
});
const read = (file) => readFileSync(file, 'utf8');
const files = walk('ui').filter((file) => !file.includes('/locales/'));
const parse = (code) => espree.parse(code, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true });

function visit(node, enter, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  enter(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) for (const item of value) visit(item, enter, node); else if (value && typeof value.type === 'string') visit(value, enter, node);
  }
}

/* An operation that deletes: a host action named *.delete / *.remove / *.clear / *.dismiss, or a function whose name says remove / delete / clear. */
const DELETE_ACTION = /\.(delete|remove|clear|dismiss)$/;
const DELETE_NAME = /^(remove|delete|clear|wipe|purge|drop)/i;
/* Reviewed InlineConfirm uses that delete nothing for good: { file: [handler names] }. Each needs a reason. */
const REVERSIBLE = {
  // 移除这一步: takes a step out of the flow being edited (unsaved form state); nothing is stored until 保存.
  'ui/Workflows.jsx': ['removeStep'],
};

/** The deletions an InlineConfirm in `code` would confirm, and the "tap twice" label swaps: [{ kind, line, what }]. `file` picks the allow-list. */
export function deletionFindings(code, file = '') {
  const ast = parse(code), findings = [];
  const line = (node) => code.slice(0, node.range[0]).split('\n').length;
  const inlineNames = new Set(['InlineConfirm']), functions = new Map();
  visit(ast, (node) => {
    if (node.type === 'ImportSpecifier' && node.imported.name === 'InlineConfirm') inlineNames.add(node.local.name);
    if (node.type === 'FunctionDeclaration' && node.id) functions.set(node.id.name, node);
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && /Function/.test(node.init?.type || '')) functions.set(node.id.name, node.init);
  });
  // What a handler does: the host actions it names and the functions it calls, following functions of this file one level deep.
  const effects = (expression, depth = 0) => {
    const out = { actions: [], calls: [] };
    visit(expression, (node) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee.type === 'Identifier' ? node.callee.name : node.callee.type === 'MemberExpression' && !node.callee.computed ? node.callee.property.name : '';
      if (callee) out.calls.push(callee);
      const first = node.arguments[0];
      if (first?.type === 'Literal' && typeof first.value === 'string' && DELETE_ACTION.test(first.value)) out.actions.push(first.value);
      if (depth < 1 && node.callee.type === 'Identifier' && functions.has(node.callee.name)) {
        const inner = effects(functions.get(node.callee.name), depth + 1);
        out.actions.push(...inner.actions);
      }
    });
    if (depth < 1 && expression?.type === 'Identifier' && functions.has(expression.name)) out.actions.push(...effects(functions.get(expression.name), depth + 1).actions);
    if (expression?.type === 'Identifier') out.calls.push(expression.name);
    return out;
  };
  visit(ast, (node) => {
    if (node.type !== 'JSXOpeningElement' || node.name.type !== 'JSXIdentifier') return;
    if (inlineNames.has(node.name.name)) {
      const confirm = node.attributes.find((attr) => attr.type === 'JSXAttribute' && attr.name.name === 'onConfirm');
      const expression = confirm?.value?.expression;
      if (!expression) return;
      const { actions, calls } = effects(expression);
      const allowed = REVERSIBLE[file] || [];
      const named = calls.filter((name) => DELETE_NAME.test(name) && !allowed.includes(name));
      if (actions.length || named.length) findings.push({ kind: 'inline-confirm', line: line(node), what: [...actions, ...named].join(', ') });
    }
  });
  // A label swap: a button whose text is a condition between two words, one of them a deletion, on a flag that remembers a first press.
  visit(ast, (node) => {
    if (node.type !== 'JSXElement') return;
    for (const child of node.children) {
      if (child.type !== 'JSXExpressionContainer' || child.expression.type !== 'ConditionalExpression') continue;
      const text = code.slice(child.expression.consequent.range[0], child.expression.alternate.range[1]);
      const test = code.slice(child.expression.test.range[0], child.expression.test.range[1]);
      if (/删除|清空|移除|永久删除|[Dd]elete|[Cc]lear|[Rr]emove/.test(text) && /armed|again|twice|confirm|sure|second/i.test(test)) findings.push({ kind: 'label-swap', line: line(child), what: test });
    }
  });
  return findings;
}

test('the guard itself: it finds what the literal form missed, and leaves a reversible InlineConfirm alone', () => {
  const kinds = (code, file) => deletionFindings(code, file).map((finding) => finding.kind);
  // an aliased import, a nested `/>` in an icon prop, the title in a variable
  assert.deepEqual(kinds(`import { InlineConfirm as Ask } from './components/index.js';
    const title = ui('清掉？');
    export default () => <Ask icon={<Icon name="trash" />} title={title} onConfirm={() => call('note.delete', { id })} />;`), ['inline-confirm']);
  // the deletion behind a function of the file
  assert.deepEqual(kinds(`function wipe() { return act('mineru.history.clear', { confirm: true }); }
    export default () => <InlineConfirm title={t} onConfirm={wipe} />;`), ['inline-confirm']);
  assert.deepEqual(kinds(`export default () => <InlineConfirm title={t} onConfirm={() => removeEverything()} />;`), ['inline-confirm']);
  // a label swap that does not start with 确认
  assert.deepEqual(kinds(`export default () => <Button onClick={press}>{armed ? ui('再点一次就删除') : ui('删除')}</Button>;`), ['label-swap']);
  // reversible: clearing a group of fields in a form, merging courses, reloading over unsaved input
  assert.deepEqual(kinds(`export default () => <InlineConfirm title={ui('清空这组字段？')} onConfirm={() => setFields({})} />;`), []);
  assert.deepEqual(kinds(`export default () => <InlineConfirm title={t} onConfirm={reloadLatest} />;`), []);
  assert.deepEqual(kinds(`export default () => <InlineConfirm title={t} onConfirm={() => removeStep(id)} />;`, 'ui/Workflows.jsx'), [], 'the reviewed allow-list');
  assert.deepEqual(kinds(`export default () => <Button>{open ? ui('收起') : ui('展开')}</Button>;`), []);
});

test('no InlineConfirm confirms a deletion and no button swaps its label to ask twice, anywhere in ui/', () => {
  const offenders = files.flatMap((file) => deletionFindings(read(file), file).map((finding) => `${file}:${finding.line} ${finding.kind} (${finding.what})`));
  assert.deepEqual(offenders, []);
});

test('tier 2 pages delete through the shared undo, with no dialog of their own for it', () => {
  const later = {
    'ui/tasks/TaskConsole.jsx': /job\.dismiss|batchRun\('delete'/,
    'ui/BlogNotes.jsx': /note\.delete/,
    'ui/Workflows.jsx': /workflow\.session\.delete/,
    'ui/PdfConvertJob.jsx': /mineru\.history\.remove/,
    'ui/LiveClass.jsx': /live\.delete/,
    'ui/SkeletonDiagrams.jsx': /skeleton\.diagram\.remove/,
  };
  for (const [file, operation] of Object.entries(later)) {
    const source = read(file);
    assert.match(source, /useUndoable\(\)/, `${file} uses the shared undo`);
    assert.match(source, /commitLater\(/, `${file} sends its deletion when the 撤销 time is over`);
    assert.match(source, operation, `${file} still deletes through its own operation`);
  }
  // A kept annotation thread is deleted at once by its ids and 撤销 restores exactly those (an answer kept meanwhile on the same passage is never caught).
  const learning = read('ui/document-preview/DocumentLearning.jsx');
  assert.match(learning, /deleteKeptThread\(/);
  assert.match(learning, /restoreWith\(/);
  assert.doesNotMatch(learning, /commitLater\(/);
  assert.equal(existsSync('ui/tasks/DeleteTasksDialog.jsx'), false);
  assert.doesNotMatch(read('ui/LiveHistory.jsx'), /live-history-confirm|永久删除/);
  assert.doesNotMatch(read('ui/document-preview/AskThread.jsx'), /ConfirmDialog/);
  assert.doesNotMatch(read('ui/SkeletonDiagrams.jsx'), /ConfirmDialog/);
});

test('a draft asks once, in the one DeleteDraftDialog, from the draft page and from the 待发布 row', () => {
  const dialog = read('ui/DeleteDraftDialog.jsx');
  assert.match(dialog, /<ConfirmDialog/);
  assert.match(dialog, /draftVersion: draft\.draftVersion/, 'the version check stays');
  assert.match(dialog, /cancelLabel=\{ui\('保留'\)\}/);
  for (const file of ['ui/Draft.jsx', 'ui/study-map/HomeActivity.jsx']) assert.match(read(file), /<DeleteDraftDialog/, file);
  assert.doesNotMatch(read('ui/Draft.jsx'), /确认删除草稿（无法撤销）|deleteArmed/);
});

test('tier 1 is not loosened: sources and decks are deleted for good only from the archive, through PermanentDeleteDialog; an archive offers 撤销 and 永久删除…', () => {
  const sources = read('ui/Sources.jsx'), decks = read('ui/RemoveDeckDialog.jsx'), manage = read('ui/Manage.jsx');
  assert.match(sources, /<PermanentDeleteDialog/);
  assert.match(sources, /const blocked = item\.usedBy\.length > 0 \|\| !item\.archived/);
  assert.match(decks, /<PermanentDeleteDialog/);
  assert.match(decks, /const eligible = deck\.archived && !deck\.systemKind/);
  for (const [file, source] of [['ui/Sources.jsx', sources], ['ui/Manage.jsx', manage]]) {
    assert.match(source, /offerRestore\(toast/, `${file}: the archive says so with 撤销`);
    assert.match(source, /ui\(['"]永久删除…['"]\)/, `${file}: and offers the second step`);
  }
  assert.match(manage, /结束了 \{1\} 轮进行中的练习；撤销只恢复题组/, 'the deck archive says how many practice runs it ended, and that 撤销 does not reopen them');
  assert.match(manage, /closedRuns/, 'counted by the host');
});

test('the words: 永久删除 is irreversible, 移除 takes out of a container; the source dialog no longer mixes them', () => {
  const sources = read('ui/Sources.jsx');
  assert.doesNotMatch(sources, /从资料列表移除|不能移除|再移除资料|已移除「/);
  assert.match(sources, /已永久删除「\{0\}」/);
  for (const file of ['ui/tasks/TaskConsole.jsx', 'ui/tasks/CompactJobCard.jsx', 'ui/study-map/HomeActivity.jsx']) assert.doesNotMatch(read(file), /\{ui\(['"](全部)?知道了['"]\)\}/, `${file}: the archive button says 归档`);
  assert.match(read('ui/Skeleton.jsx'), /永久删除骨架「\{0\}」？/, 'an irreversible dialog that is not moved yet says 永久删除');
});
