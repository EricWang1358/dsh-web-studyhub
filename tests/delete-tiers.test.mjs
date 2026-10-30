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

/* An operation that deletes: a host action named *.delete / *.remove / *.clear / *.dismiss (a literal or the end of a template), or a function whose name says
   remove / delete / clear. */
const DELETE_ACTION = /\.(delete|remove|clear|dismiss)$/;
const DELETE_NAME = /^(remove|delete|clear|wipe|purge|drop)/i;
const DELETE_WORD = /删除|清空|移除|永久删除|[Dd]elete|[Cc]lear|[Rr]emove/;
/* A second press asked for: the words of a confirmation, or a flag named like one. */
const CONFIRM_WORD = /确认|再点|再按|again|sure|无法撤销|不能撤销|[Cc]onfirm/;
const CONFIRM_FLAG = /armed|again|twice|confirm|sure|second|pending|asked?/i;
const HELPER_DEPTH = 3;
/* Reviewed InlineConfirm uses that delete nothing for good: { file: [handler names] }. Each needs a reason. */
const REVERSIBLE = {
  // 移除这一步: takes a step out of the flow being edited (unsaved form state); nothing is stored until 保存.
  'ui/Workflows.jsx': ['removeStep',
    // 载入最新版本: replaces the unsaved input of the form with the stored flow (and drops the browser's copy of that input); nothing stored is deleted.
    'reloadLatest'],
};

/** The deletions an InlineConfirm in `code` would confirm, and the "tap twice" label swaps: [{ kind, line, what }]. `file` picks the allow-list. */
export function deletionFindings(code, file = '') {
  const ast = parse(code), findings = [];
  const line = (node) => code.slice(0, node.range[0]).split('\n').length;
  const inlineNames = new Set(['InlineConfirm']), functions = new Map();
  visit(ast, (node, parent) => {
    if (node.type === 'ImportSpecifier' && node.imported.name === 'InlineConfirm') inlineNames.add(node.local.name);
    if (node.type === 'ImportDefaultSpecifier' && /InlineConfirm(\.jsx?)?$/.test(parent?.source?.value || '')) inlineNames.add(node.local.name);
    if (node.type === 'FunctionDeclaration' && node.id) functions.set(node.id.name, node);
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && /Function/.test(node.init?.type || '')) functions.set(node.id.name, node.init);
    // an object's methods (`actions = { remove: (item) => … }`), found by their property name
    if (node.type === 'Property' && !node.computed && node.key.type === 'Identifier' && /Function/.test(node.value?.type || '')) functions.set(node.key.name, node.value);
  });
  const nameOf = (callee) => (callee?.type === 'Identifier' ? callee.name : callee?.type === 'MemberExpression' && !callee.computed ? callee.property.name : '');
  const actionText = (arg) => (arg?.type === 'Literal' && typeof arg.value === 'string' ? arg.value
    : arg?.type === 'TemplateLiteral' ? arg.quasis.map((quasi) => quasi.value.cooked).join('*') : '');
  // What a handler does: the host actions it names and the functions it calls, following functions of this file up to HELPER_DEPTH deep.
  const effects = (expression, depth = 0, seen = new Set()) => {
    const out = { actions: [], calls: [] };
    const follow = (name) => {
      if ((REVERSIBLE[file] || []).includes(name)) return; // a reviewed handler is not looked into
      if (depth >= HELPER_DEPTH || !functions.has(name) || seen.has(name)) return;
      const inner = effects(functions.get(name), depth + 1, new Set([...seen, name]));
      out.actions.push(...inner.actions);
      out.calls.push(...inner.calls);
    };
    visit(expression, (node) => {
      if (node.type !== 'CallExpression') return;
      const callee = nameOf(node.callee);
      if (callee) { out.calls.push(callee); follow(callee); }
      const text = actionText(node.arguments[0]);
      if (DELETE_ACTION.test(text)) out.actions.push(text);
    });
    const direct = nameOf(expression);
    if (direct) { out.calls.push(direct); follow(direct); }
    return out;
  };
  const isInlineConfirm = (name) => (name.type === 'JSXIdentifier' && inlineNames.has(name.name))
    || (name.type === 'JSXMemberExpression' && name.property.name === 'InlineConfirm'); // <C.InlineConfirm> of `import * as C`
  visit(ast, (node) => {
    if (node.type !== 'JSXOpeningElement' || !isInlineConfirm(node.name)) return;
    const confirm = node.attributes.find((attr) => attr.type === 'JSXAttribute' && attr.name.name === 'onConfirm');
    const expression = confirm?.value?.expression;
    if (!expression) return;
    const { actions, calls } = effects(expression);
    const allowed = REVERSIBLE[file] || [];
    const named = calls.filter((name) => DELETE_NAME.test(name) && !allowed.includes(name));
    if (actions.length || named.length) findings.push({ kind: 'inline-confirm', line: line(node), what: [...new Set([...actions, ...named])].join(', ') });
  });
  // A label swap: any condition between two words (literals, ui()/uiFormat() of literals, or a condition that IS the first argument of ui()/uiFormat()), one of them
  // a deletion, that asks for a second press: the words of a confirmation, or a flag named like one. Wherever it sits: a button's child, a variable, ui()'s argument.
  const words = (branch) => (branch?.type === 'Literal' && typeof branch.value === 'string' ? branch.value
    : branch?.type === 'TemplateLiteral' ? branch.quasis.map((quasi) => quasi.value.cooked).join('')
      : branch?.type === 'CallExpression' && ['ui', 'uiFormat'].includes(nameOf(branch.callee)) ? words(branch.arguments[0])
        // a nested condition (armed ? (busy ? A : B) : (busy ? C : D)) stands for both of its words
        : branch?.type === 'ConditionalExpression' && words(branch.consequent) !== null && words(branch.alternate) !== null ? `${words(branch.consequent)}|${words(branch.alternate)}` : null);
  visit(ast, (node) => {
    if (node.type !== 'ConditionalExpression') return;
    const yes = words(node.consequent), no = words(node.alternate);
    if (yes === null || no === null || yes === no) return;
    if (!DELETE_WORD.test(yes) && !DELETE_WORD.test(no)) return;
    const test = code.slice(node.test.range[0], node.test.range[1]);
    if (CONFIRM_WORD.test(yes) !== CONFIRM_WORD.test(no) || (CONFIRM_FLAG.test(test) && DELETE_WORD.test(yes) && DELETE_WORD.test(no)))
      findings.push({ kind: 'label-swap', line: line(node), what: test });
  });
  return findings;
}

test('the guard itself: it finds every shape the reviews named, and leaves reversible uses alone', () => {
  const kinds = (code, file) => deletionFindings(code, file).map((finding) => finding.kind);
  // an aliased import, a nested `/>` in an icon prop, the title in a variable
  assert.deepEqual(kinds(`import { InlineConfirm as Ask } from './components/index.js';
    const title = ui('清掉？');
    export default () => <Ask icon={<Icon name="trash" />} title={title} onConfirm={() => call('note.delete', { id })} />;`), ['inline-confirm']);
  // a namespace import and a default import of the component file
  assert.deepEqual(kinds(`import * as C from './components/index.js';
    export default () => <C.InlineConfirm title={t} onConfirm={() => call('note.delete', { id })} />;`), ['inline-confirm']);
  assert.deepEqual(kinds(`import Ask from './components/InlineConfirm.jsx';
    export default () => <Ask title={t} onConfirm={() => act('workflow.delete', { id })} />;`), ['inline-confirm']);
  // the deletion behind a function of the file, a member handler, an action in a template, helpers three levels deep
  assert.deepEqual(kinds(`function wipe() { return act('mineru.history.clear', { confirm: true }); }
    export default () => <InlineConfirm title={t} onConfirm={wipe} />;`), ['inline-confirm']);
  assert.deepEqual(kinds(`export default () => <InlineConfirm title={t} onConfirm={() => removeEverything()} />;`), ['inline-confirm']);
  assert.deepEqual(kinds(`const actions = { forget: (item) => call('live.delete', { id: item.id }) };
    export default () => <InlineConfirm title={t} onConfirm={actions.forget} />;`), ['inline-confirm']);
  assert.deepEqual(kinds(`export default () => <InlineConfirm title={t} onConfirm={() => call(\`\${kind}.delete\`, { id })} />;`), ['inline-confirm']);
  assert.deepEqual(kinds(`function a() { return b(); } function b() { return c(); } function c() { return call('note.delete', {}); }
    export default () => <InlineConfirm title={t} onConfirm={a} />;`), ['inline-confirm']);
  // label swaps: not starting with 确认, inside ui(), with a flag not named like one, kept in a variable
  assert.deepEqual(kinds(`export default () => <Button onClick={press}>{armed ? ui('再点一次就删除') : ui('删除')}</Button>;`), ['label-swap']);
  assert.deepEqual(kinds(`export default () => <Button onClick={press}>{ui(armed ? '确认删除（无法撤销）' : '删除')}</Button>;`), ['label-swap']);
  assert.deepEqual(kinds(`export default () => <Button onClick={press}>{ui(primed ? '确认删除' : '删除')}</Button>;`), ['label-swap']);
  assert.deepEqual(kinds(`export default () => <Button>{armed ? busy ? ui('确认删除并停止任务') : ui('确认删除') : busy ? ui('删除并停止任务') : ui('删除')}</Button>;`), ['label-swap'], 'nested');
  assert.deepEqual(kinds(`const label = asked ? ui('再按一次清空') : ui('清空'); export default () => <Button onClick={press}>{label}</Button>;`), ['label-swap']);
  // reversible / harmless: clearing a group of fields in a form, reloading over unsaved input, the reviewed allow-list, a plain toggle, two labels of a delete
  // button that say what else it does
  assert.deepEqual(kinds(`export default () => <InlineConfirm title={ui('清空这组字段？')} onConfirm={() => setFields({})} />;`), []);
  assert.deepEqual(kinds(`export default () => <InlineConfirm title={t} onConfirm={reloadLatest} />;`), []);
  assert.deepEqual(kinds(`export default () => <InlineConfirm title={t} onConfirm={() => removeStep(id)} />;`, 'ui/Workflows.jsx'), [], 'the reviewed allow-list');
  assert.deepEqual(kinds(`export default () => <Button>{open ? ui('收起') : ui('展开')}</Button>;`), []);
  assert.deepEqual(kinds(`export default () => <Button>{ui(daily ? '保存合集' : '保存草稿')}</Button>;`), []);
  assert.deepEqual(kinds(`export default () => <Button>{many ? ui('删除所选') : ui('删除')}</Button>;`), [], 'not a second press');
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
  // D2: every entry to 归档 (Manage, a deck row's menu, the Sources page) ends in the notice of ui/archive-entries.js: 撤销, then 永久删除… (one deck / one document)
  const entries = read('ui/archive-entries.js');
  for (const [file, source, call] of [['ui/Sources.jsx', sources, /offerDocumentsArchived\(/], ['ui/Manage.jsx', manage, /offerDeckArchived\(/], ['ui/StudyMap.jsx', read('ui/StudyMap.jsx'), /offerDeckArchived\(/]])
    assert.match(source, call, `${file}: the archive says so with 撤销 and the second step (ui/archive-entries.js)`);
  assert.match(entries, /offerRestore\(toast/, 'the archive says so with 撤销');
  assert.match(entries, /ui\(['"]永久删除…['"]\)/, 'and offers the second step');
  assert.match(entries, /结束了 \{1\} 轮进行中的练习；撤销只恢复题组/, 'the deck archive says how many practice runs it ended, and that 撤销 does not reopen them');
  assert.match(entries, /closedRuns/, 'counted by the host');
  // the keyboard way back: 撤销 focuses the archive button again; 永久删除… returns there when its dialog is closed (as Sources does)
  assert.match(manage, /focus: \(\) => document\.querySelector\("\.manage-page \[data-manage-archive\]"\)/);
  assert.match(manage, /returnFocus:/);
  assert.match(read('ui/app/AppModalHost.jsx'), /removingDeck\?\.returnFocus/);
  assert.match(sources, /closeRemoving/);
  // 撤销 of an archive is a plain call, never the single-flight act() (which drops it while another write runs, and 撤销 stays enabled then)
  assert.match(sources, /restore: async \(\) => \{ await call\('source\.archive'/);
  assert.match(manage, /restore: async \(\) => \{ await call\("deck\.archive"/);
  assert.match(read('ui/StudyMap.jsx'), /restore: async \(\) => \{ await call\("deck\.archive"/, 'the deck row menu\'s 撤销 is a plain call too');
  // archive-first stays: the deck row's menu archives (the entry is closer) but never deletes for good, and a system deck has no entry at all
  assert.doesNotMatch(read('ui/study-map/DeckRow.jsx'), /deck\.remove|ui\(['"]永久删除/);
  assert.match(entries, /if \(deck\.systemKind\) return null/);
});

test('the words: 永久删除 is irreversible, 移除 takes out of a container; the source dialog no longer mixes them', () => {
  const sources = read('ui/Sources.jsx');
  assert.doesNotMatch(sources, /从资料列表移除|不能移除|再移除资料|已移除「/);
  assert.match(sources, /已永久删除「\{0\}」/);
  for (const file of ['ui/tasks/TaskConsole.jsx', 'ui/tasks/CompactJobCard.jsx', 'ui/study-map/HomeActivity.jsx']) assert.doesNotMatch(read(file), /\{ui\(['"](全部)?知道了['"]\)\}/, `${file}: the archive button says 归档`);
  assert.match(read('ui/Skeleton.jsx'), /永久删除骨架「\{0\}」？/, 'an irreversible dialog that is not moved yet says 永久删除');
});
