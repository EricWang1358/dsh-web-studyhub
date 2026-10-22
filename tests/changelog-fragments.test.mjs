import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addedOrder, digest, ordered, readFragments, unsealed } from '../scripts/changelog.mjs';

/* The next release's changelog waits as fragments in changes/unreleased/ (one pair of files per change, see changes/README.md), so pull
   requests never edit the same lines of the changelogs. The release writes them in (scripts/changelog.mjs --release). */

const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('../scripts/changelog.mjs', import.meta.url));
const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' }).trim();
const headings = text => text.split(/\r?\n/).filter(line => line.startsWith('## '));

test('the fragments of the next release are well formed and in both languages', () => {
  const { changes, problems } = readFragments(root);
  assert.deepEqual(problems, [], 'npm run changelog:check says the same; changes/README.md says how to write one');
  for (const change of changes) assert.ok(change.text.en && change.text['zh-CN'], change.slug);
});

test('each changelog starts with the released version: a change goes into changes/unreleased, not into the changelog', () => {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const file of ['CHANGELOG.md', 'CHANGELOG.zh-CN.md']) {
    const all = headings(readFileSync(join(root, file), 'utf8'));
    assert.match(all[0] ?? '', /^## \d+\.\d+\.\d+\S* — \d{4}-\d{2}-\d{2}$/, `${file}: the top section is a release with its date`);
    assert.equal(all[0].split(' ')[1], version, `${file}: the top section is the version of package.json (the release commit sets both)`);
    assert.deepEqual(all.filter(line => /unreleased|未发布/i.test(line)), [], `${file}: no unreleased section; add a fragment instead`);
  }
});

test('the changelogs are as the last release wrote them: a pull request that edits one directly fails', () => {
  assert.deepEqual(unsealed(root), [], 'add a fragment under changes/unreleased instead (changes/README.md); only npm run changelog:release writes the changelogs');
  const sealed = JSON.parse(readFileSync(join(root, 'changes/released.json'), 'utf8')).files;
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  assert.equal(digest(changelog.replace(/\r?\n/g, '\r\n')), sealed['CHANGELOG.md'], 'a Windows checkout (CRLF) seals the same');
  const edited = changelog.replace(/^(- \*\*)/m, '- **Added by hand.** Text.\n$1');
  assert.notEqual(digest(edited), sealed['CHANGELOG.md'], 'one bullet added to a released section is caught');
});

test('a malformed fragment is named, and --check fails', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'changelog-bad-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const at = join(dir, 'changes', 'unreleased');
  await mkdir(at, { recursive: true });
  const files = {
    'fine.en.md': '- **Fine.** Text. Not verified: a real host.\n', 'fine.zh-CN.md': '- **好。** 文字。未验证：真实宿主。\n',
    'no-unverified.en.md': '- **Says nothing unchecked.** Text.\n', 'no-unverified.zh-CN.md': '- **没写没验证的。** 文字。Not verified: 英文的写法。\n',
    'only-english.en.md': '- **One language.** Text.\n',
    'no-bold.en.md': '- Plain text.\n', 'no-bold.zh-CN.md': '- **好。** 文字。\n',
    'two-bullets.en.md': '- **One.** Text.\n\n- **Two.** Text.\n', 'two-bullets.zh-CN.md': '- **一。** 文字。\n',
    'empty.en.md': '\n', 'empty.zh-CN.md': '- **空。**\n',
    'heading.en.md': '## 9.9.9\n- **Heading.** Text.\n', 'heading.zh-CN.md': '- **标题。** 文字。\n',
    'list.note.en.md': '- a bullet\n', 'list.note.zh-CN.md': '未验证：一段。\n',
    'Notes.txt': 'stray\n',
  };
  for (const [name, body] of Object.entries(files)) await writeFile(join(at, name), body, 'utf8');
  const { problems } = readFragments(dir);
  const about = name => problems.filter(problem => problem.includes(name));
  assert.equal(about('fine.').length, 0);
  assert.match(about('only-english.zh-CN.md').join(), /missing/);
  assert.match(about('no-bold.en.md').join(), /starts with "- \*\*"/);
  assert.match(about('two-bullets.en.md').join(), /one bullet/);
  assert.match(about('no-unverified.en.md').join(), /no "Not verified: \.\.\." line/);
  assert.match(about('no-unverified.zh-CN.md').join(), /no "未验证：\.\.\." line/, 'each language has its own wording');
  assert.equal(about('list.note.zh-CN.md').length, 0, 'a note needs no such line');
  assert.match(about('empty.en.md').join(), /empty/);
  assert.match(about('heading.en.md').join(), /no headings/);
  assert.match(about('list.note.en.md').join(), /paragraph, not a bullet/);
  assert.match(about('Notes.txt').join(), /not a fragment name/);
  const check = cli('--check', `--root=${dir}`);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /only-english\.zh-CN\.md: missing/);
});

test('--release writes both changelogs in the order the changes were added, keeps their line ends, and deletes the fragments', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'changelog-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const at = join(dir, 'changes', 'unreleased');
  await mkdir(at, { recursive: true });
  await writeFile(join(at, '.gitkeep'), '', 'utf8');
  // The English changelog has CRLF line ends (a Windows checkout), the Chinese one LF.
  await writeFile(join(dir, 'CHANGELOG.md'), '# Changelog\r\n\r\nEnglish\r\n\r\n## 1.0.0 — 2026-01-01\r\n\r\n- **Old.** Text.\r\n', 'utf8');
  await writeFile(join(dir, 'CHANGELOG.zh-CN.md'), '# 更新日志\n\n## 1.0.0 — 2026-01-01\n\n- **旧的。** 文字。\n', 'utf8');
  const fragment = (slug, en, zh) => Promise.all([writeFile(join(at, `${slug}.en.md`), `${en}\n`, 'utf8'), writeFile(join(at, `${slug}.zh-CN.md`), `${zh}\r\n`, 'utf8')]);
  git(dir, 'init', '-q');
  await fragment('zeta', '- **Zeta came first.** Its commit is the oldest. Not verified: a real release.', '- **Zeta 最先。** 它的提交最早。未验证：真实发版。');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'zeta');
  await fragment('beta', '- **Beta.** Same commit as alpha. Not verified: a real release.\n  - a sub-bullet', '- **Beta。** 和 alpha 同一个提交。未验证：真实发版。\n  - 一个子项');
  await fragment('alpha', '- **Alpha.** Same commit as beta, so by name. Not verified: a real release.', '- **Alpha。** 和 beta 同一个提交，按名字。未验证：真实发版。');
  await fragment('upgrade.note', 'Upgrading: restart DSH.', '升级：重启 DSH。');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'alpha beta');
  await fragment('gamma', '- **Gamma is not committed yet.** Last. Not verified: a real release.', '- **Gamma 还没提交。** 排最后。未验证：真实发版。');

  const expectedEn = '## 1.1.0\n\n- **Zeta came first.** Its commit is the oldest. Not verified: a real release.\n- **Alpha.** Same commit as beta, so by name. Not verified: a real release.\n- **Beta.** Same commit as alpha. Not verified: a real release.\n  - a sub-bullet\n- **Gamma is not committed yet.** Last. Not verified: a real release.\n\nUpgrading: restart DSH.\n';
  const preview = cli('--preview', '1.1.0', `--root=${dir}`);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.stdout, expectedEn);
  assert.equal(cli('--preview', '1.1.0', `--root=${dir}`).stdout, expectedEn, 'the same order every time');
  assert.match(cli('--preview', '1.1.0', '--lang=zh-CN', `--root=${dir}`).stdout, /^## 1\.1\.0\n\n- \*\*Zeta 最先。\*\*.*\n- \*\*Alpha。\*\*.*\n- \*\*Beta。\*\*.*\n {2}- 一个子项\n- \*\*Gamma 还没提交。\*\*.*\n\n升级：重启 DSH。\n$/);

  const released = cli('--release', '1.1.0', '2026-02-02', `--root=${dir}`);
  assert.equal(released.status, 0, released.stderr);
  assert.equal(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), ['# Changelog', '', 'English', '', '## 1.1.0 — 2026-02-02', '',
    '- **Zeta came first.** Its commit is the oldest. Not verified: a real release.', '- **Alpha.** Same commit as beta, so by name. Not verified: a real release.', '- **Beta.** Same commit as alpha. Not verified: a real release.', '  - a sub-bullet',
    '- **Gamma is not committed yet.** Last. Not verified: a real release.', '', 'Upgrading: restart DSH.', '', '## 1.0.0 — 2026-01-01', '', '- **Old.** Text.', ''].join('\r\n'));
  assert.equal(readFileSync(join(dir, 'CHANGELOG.zh-CN.md'), 'utf8'), ['# 更新日志', '', '## 1.1.0 — 2026-02-02', '',
    '- **Zeta 最先。** 它的提交最早。未验证：真实发版。', '- **Alpha。** 和 beta 同一个提交，按名字。未验证：真实发版。', '- **Beta。** 和 alpha 同一个提交。未验证：真实发版。', '  - 一个子项',
    '- **Gamma 还没提交。** 排最后。未验证：真实发版。', '', '升级：重启 DSH。', '', '## 1.0.0 — 2026-01-01', '', '- **旧的。** 文字。', ''].join('\n'));
  assert.deepEqual(readdirSync(at), ['.gitkeep'], 'the fragments are gone, the folder stays');
  assert.deepEqual(unsealed(dir), [], 'the release seals what it wrote');
  await writeFile(join(dir, 'CHANGELOG.zh-CN.md'), `${readFileSync(join(dir, 'CHANGELOG.zh-CN.md'), 'utf8')}- **手改的。**\n`, 'utf8');
  assert.match(unsealed(dir).join(), /CHANGELOG\.zh-CN\.md: edited outside a release/);
  const check = cli('--check', `--root=${dir}`);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /CHANGELOG\.zh-CN\.md: edited outside a release/);
  assert.equal(cli('--seal', `--root=${dir}`).status, 0);
  assert.deepEqual(unsealed(dir), [], '--seal accepts a correction made in the release commit');

  assert.equal(cli('--preview', '1.1.0', `--root=${dir}`).stdout, `## 1.1.0 — 2026-02-02\n\n${expectedEn.split('\n\n').slice(1).join('\n\n')}`, 'after the release, the released section');
  const again = cli('--release', '1.2.0', '2026-03-03', `--root=${dir}`);
  assert.equal(again.status, 1, 'nothing to release');
  assert.equal(cli('--release', '1.2', '2026-03-03', `--root=${dir}`).status, 2, 'a version is x.y.z');
  assert.ok(existsSync(join(dir, 'CHANGELOG.md')));
});

test('the order depends only on the history and the names, not on how the files are listed', () => {
  const log = ['a'.repeat(40), '', 'changes/unreleased/b.en.md', 'changes/unreleased/b.zh-CN.md', '', 'c'.repeat(40), '', 'changes/unreleased/a.en.md',
    'changes/unreleased/a.zh-CN.md', 'changes/unreleased/c.zh-CN.md', '', 'd'.repeat(40), '', 'changes/unreleased/c.en.md', ''].join('\n');
  const order = addedOrder('.', log);
  assert.deepEqual([...order.values()], [0, 0, 1, 1, 1, 2]);
  const change = slug => ({ slug, note: false, files: { en: `changes/unreleased/${slug}.en.md`, 'zh-CN': `changes/unreleased/${slug}.zh-CN.md` } });
  const changes = ['d', 'c', 'b', 'a'].map(change);
  // b (commit 0), then a and c (commit 1: c counts from its earlier file), then d (not committed).
  assert.deepEqual(ordered(changes, order).map(item => item.slug), ['b', 'a', 'c', 'd']);
  assert.deepEqual(ordered([...changes].reverse(), order).map(item => item.slug), ['b', 'a', 'c', 'd']);
});
