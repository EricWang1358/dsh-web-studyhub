import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { controls, witnessFile } from './replacement-control-cases.mjs';
import { controlVerdict } from './replacement-control-reporter.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const reporter = new URL('./replacement-control-reporter.mjs', import.meta.url).href;
const harness = 'tests/helpers/react-harness.mjs';
const gateFiles = new Set([harness, witnessFile, 'scripts/qa/replacement-controls.mjs',
  'scripts/qa/replacement-control-cases.mjs', 'scripts/qa/replacement-control-reporter.mjs']);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const readAt = (revision, path) => git('show', revision + ':' + path).replaceAll('\r\n', '\n');
const commit = revision => git('rev-parse', '--verify', '--end-of-options', revision + '^{commit}').trim();

function focusedTests(code, pattern) {
  const source = ts.createSourceFile('test.mjs', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const tests = new Map();
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const { expression, arguments: args } = statement.expression;
    // Include test.skip/test.todo so disabling a replacement cannot remove its contract.
    const fn = ts.isPropertyAccessExpression(expression) ? expression.expression : expression;
    if (!ts.isIdentifier(fn) || fn.text !== 'test' || !args[0] || !ts.isStringLiteralLike(args[0])) continue;
    if (pattern.test(args[0].text)) tests.set(args[0].text, statement.getText(source));
  }
  return tests;
}

function select(all, base, head) {
  const changed = new Set(base ? git('diff', '--no-renames', '--name-only', '-z', base, head).split('\0') : []);
  const gateChanged = [...changed].some(path => gateFiles.has(path));
  const selected = [];
  for (const control of controls) {
    if (!all && !gateChanged && !changed.has(control.source) && !changed.has(control.test)) continue;
    const after = focusedTests(readAt(head, control.test), control.candidate);
    if (!after.size) throw Error(control.id + ': registered replacement test is missing; update its path or title.');
    let names = [];
    if (changed.has(control.test)) {
      const existed = git('ls-tree', '-z', base, '--', control.test).length > 0;
      const before = existed ? focusedTests(readAt(base, control.test), control.candidate) : new Map();
      names = [...after].filter(([name, body]) => before.get(name) !== body).map(([name]) => name);
      if (!names.length && [...before.keys()].some(name => !after.has(name))) {
        throw Error(control.id + ': removed or renamed registered replacement; register its new test name.');
      }
    }
    if (all || gateChanged || changed.has(control.source) || names.length) selected.push({ control, names });
  }
  return selected;
}

function restoreDefect(source, control) {
  let result = source.replaceAll('\r\n', '\n');
  for (const [fixed, broken] of control.edits) {
    if (result.split(fixed).length !== 2) throw Error(control.id + ': defect no longer applies exactly once; update its control.');
    result = result.replace(fixed, () => broken);
  }
  return result;
}

const escapeName = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function execute(dir, file, names) {
  const pattern = '^(?:' + names.map(escapeName).join('|') + ')$';
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=' + reporter, '--test-name-pattern=' + pattern, file], {
    cwd: dir, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, STUDY_BUILD_CACHE: '0' },
  });
  if (result.error) throw result.error;
  const cases = (result.stdout || '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { status: result.status, cases, stderr: result.stderr };
}

function verifyPair(label, names, red, green, message) {
  const active = row => names.includes(row.name) && !row.skipped;
  const failures = red.cases.filter(row => !row.passed && active(row));
  const verdict = controlVerdict(names, red, green, message);
  if (verdict === 'CAUGHT') {
    console.log('CAUGHT  ' + label + '  ' + failures.find(row => row.code === 'ERR_ASSERTION').name + ' (assertion failed with defect, passed after restoration)');
    return true;
  }
  console.error(verdict + '  ' + label + '  ' + names.join(' | '));
  if (verdict === 'INVALID') {
    console.error('Broken run:', red.status, red.cases.filter(row => !row.passed || active(row)), red.stderr);
    console.error('Restored run:', green.status, green.cases.filter(row => !row.passed || active(row)), green.stderr);
  }
  return false;
}

function runControl(dir, control, names, archivedHarness) {
  const target = join(dir, control.source);
  const fixed = readFileSync(target, 'utf8');
  const broken = restoreDefect(fixed, control);
  // Historical candidate tests use their own harness. Only the independent witness uses
  // the runner's observer, which is needed to count calls to setters after unmount.
  const trial = (file, titles, code) => {
    writeFileSync(target, code);
    return execute(dir, file, titles);
  };
  copyFileSync(join(root, harness), join(dir, harness));
  const witness = [control.witness];
  const red = trial(witnessFile, witness, broken);
  const green = trial(witnessFile, witness, fixed);
  let ok = verifyPair(control.id + '/reference', witness, red, green, control.message);
  writeFileSync(join(dir, harness), archivedHarness);
  if (names.length) {
    const candidateRed = trial(control.test, names, broken);
    const candidateGreen = trial(control.test, names, fixed);
    ok = verifyPair(control.id + '/replacement', names, candidateRed, candidateGreen) && ok;
  }
  return ok;
}

const { values } = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' }, all: { type: 'boolean' } } });
if (!values.all && !values.base) throw Error('Usage: node scripts/qa/replacement-controls.mjs --base=REV [--head=REV] or --all');
const head = commit(values.head || 'HEAD');
const selected = select(values.all, values.base && commit(values.base), head);
if (!selected.length) {
  console.log('No registered replacement or production behavior changed.');
} else {
  // The checkout sits in the repository's ignored tmp/ folder so that Node and esbuild find the installed packages by walking up to
  // <repo>/node_modules. No link to node_modules is made: removing a linked folder recursively could delete the real one.
  mkdirSync(join(root, 'tmp'), { recursive: true });
  const scratch = mkdtempSync(join(root, 'tmp', 'replacement-'));
  const checkout = join(scratch, 'source');
  try {
    mkdirSync(checkout);
    const archive = join(scratch, 'source.tar');
    const testInputs = selected.map(({ control }) => control.test);
    git('archive', '--format=tar', '--output=' + archive, head, 'package.json', 'ui', 'lib', 'scripts', 'tests/helpers', 'locale', 'presets', 'references', ...testInputs);
    execFileSync('tar', ['-xf', archive, '-C', checkout]);
    copyFileSync(join(root, witnessFile), join(checkout, witnessFile));
    const archivedHarness = readFileSync(join(checkout, harness));
    for (const { control, names } of selected) {
      if (!runControl(checkout, control, names, archivedHarness)) process.exitCode = 1;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
