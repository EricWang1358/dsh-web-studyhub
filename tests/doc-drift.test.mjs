import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import {
  MAX_ANNOTATIONS,
  discoverDocFiles,
  formatAnnotations,
  parseArgs,
  run,
  scanRepo,
} from '../scripts/doc-drift.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const cliPath = join(repoRoot, 'scripts', 'doc-drift.mjs');

function makeFixtureRepo(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'studyhub-doc-drift-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    if (Buffer.isBuffer(content)) writeFileSync(abs, content);
    else writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

function runCli(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    windowsHide: true,
  });
}

test('checks local markdown links including anchors, queries, reference links, and ignores external/placeholder/masked links', t => {
  const dir = makeFixtureRepo(t, {
    'README.md': [
      '# Demo',
      '- [Guide](docs/guide.md)',
      '- [Guide section](docs/guide.md#install)',
      '- [Guide query](docs/guide.md?lang=en#top)',
      '- [Spaces](<docs/with spaces.md>)',
      '- ![Diagram](docs/assets/arch.png)',
      '- [Missing doc](docs/removed.md)',
      '- [Escapes root](../../outside.md)',
      '- [Ref valid][ref-ok]',
      '- [Ref broken][ref-bad]',
      '- [External](https://example.com/404)',
      '- [HTTP](http://localhost:3000/test)',
      '- [Mail](mailto:dev@example.com)',
      '- [Phone](tel:+123456789)',
      '- [Data](data:text/plain;base64,SGVsbG8=)',
      '- [Same page](#demo)',
      '- [Template](docs/<topic>.md)',
      '- [Env template](docs/${DOC_NAME}.md)',
      '- [Generated](dist/bundle.js)',
      '- Masked in inline code: `[fake](docs/not-a-real-link.md)`',
      '<!-- [Commented out](docs/commented-missing.md) -->',
      '',
      '```markdown',
      '[Inside fence](docs/fenced-missing.md)',
      '```',
      '',
      '[ref-ok]: docs/guide.md',
      '[ref-bad]: docs/ref-missing.md',
    ].join('\n'),
    'docs/guide.md': '[Back](../README.md#demo)\n[Sibling broken](./missing-sibling.md)\n',
    'docs/with spaces.md': '# Spaces\n',
    'docs/assets/arch.png': 'png-bytes',
  });

  const report = scanRepo(dir);
  assert.equal(report.filesScanned, 3);
  const links = report.findings.filter(f => f.kind === 'link');
  assert.deepEqual(
    links.map(f => ({ file: f.file, line: f.line, target: f.target })),
    [
      { file: 'README.md', line: 7, target: 'docs/removed.md' },
      { file: 'README.md', line: 8, target: '../../outside.md' },
      { file: 'README.md', line: 28, target: 'docs/ref-missing.md' },
      { file: 'docs/guide.md', line: 2, target: './missing-sibling.md' },
    ],
  );
});

test('checks inline repo paths with line suffixes and package-local resolution without false positives', t => {
  const dir = makeFixtureRepo(t, {
    'scripts/build.mjs': 'export {};\n',
    'ui/review/QuestionRun.jsx': 'export {};\n',
    'lib/index.js': 'export {};\n',
    'docs/guide.md': '# Guide\n',
    'packages/pkg-a/src/cli.ts': 'export {};\n',
    'README.md': [
      '# Paths',
      'Valid: `scripts/build.mjs`, `scripts/build.mjs:42`, `scripts/build.mjs:10:4`, `ui/review/QuestionRun.jsx#L12-L20`, `docs/`, `./lib/index.js`, `scripts\\build.mjs`.',
      'Broken: `scripts/deleted.mjs`, `ui/review/Removed.jsx:18`, `lib/missing.js#L5`, `docs/missing-dir/`.',
      'Ignored globs: `scripts/*.mjs`, `lib/client*.js`, `tests/[a-z].mjs`.',
      'Ignored placeholders: `scripts/<name>.mjs`, `docs/{slug}.md`, `lib/.../index.js`, `docs/xxx/a.md`, `docs/your-doc.md`, `docs/example-flow.md`.',
      'Ignored runtime/build: `dist/app.js`, `node_modules/yaml/index.js`, `build/out.js`, `lib/client.js`, `output/shot.png`.',
      'Ignored external/absolute/shorthand: `https://example.com/a.js`, `/etc/hosts`, `~/notes.md`, `C:\\Users\\me\\a.js`, `ui/review`.',
    ].join('\n'),
    'packages/pkg-a/README.md': [
      '# Package A',
      'Local valid: `src/cli.ts` and root valid `scripts/build.mjs`.',
      'Local broken: `src/removed.ts`.',
    ].join('\n'),
  });

  const report = scanRepo(dir);
  const paths = report.findings.filter(f => f.kind === 'path');
  assert.deepEqual(
    paths.map(f => ({ file: f.file, line: f.line, target: f.target })),
    [
      { file: 'README.md', line: 3, target: 'docs/missing-dir/' },
      { file: 'README.md', line: 3, target: 'lib/missing.js#L5' },
      { file: 'README.md', line: 3, target: 'scripts/deleted.mjs' },
      { file: 'README.md', line: 3, target: 'ui/review/Removed.jsx:18' },
      { file: 'packages/pkg-a/README.md', line: 3, target: 'src/removed.ts' },
    ],
  );
});

test('checks npm run and node commands in inline code and shell blocks including --prefix, -w, cd, and Windows shells', t => {
  const dir = makeFixtureRepo(t, {
    'package.json': JSON.stringify({
      name: 'fixture-root',
      scripts: { build: 'node scripts/build.mjs', lint: 'eslint .' },
    }),
    'scripts/build.mjs': 'console.log("ok");\n',
    'tests/unit.test.mjs': 'console.log("ok");\n',
    'packages/pkg-a/package.json': JSON.stringify({
      name: '@fixture/pkg-a',
      scripts: { 'pkg:build': 'node scripts/pkg-build.mjs', typecheck: 'tsc --noEmit' },
    }),
    'packages/pkg-a/scripts/pkg-build.mjs': 'console.log("ok");\n',
    'packages/pkg-a/tests/pkg.test.mjs': 'console.log("ok");\n',
    'README.md': [
      '# Commands',
      'Inline valid: `npm run build`, `npm --prefix packages/pkg-a run pkg:build`, `npm --prefix=packages/pkg-a run typecheck`, `npm run typecheck --prefix packages/pkg-a`, `npm -w @fixture/pkg-a run pkg:build`, `npm --workspace pkg-a run typecheck`.',
      'Inline broken: `npm run ghost`, `npm --prefix packages/pkg-a run nope`, `npm --prefix packages/missing-pkg run build`, `node scripts/missing.mjs`.',
      'Inline ignored: `node -e "console.log(1)"`, `node --eval="1+1"`, `node -p "process.version"`, `node -`, `node >= 22.19`, `node dist/app.js`, `node scripts/<name>.mjs`, `node scripts/*.mjs`, `npm run <script>`.',
      '',
      '```bash',
      '# valid root commands',
      'FOO=1 node --env-file .env scripts/build.mjs > out.log',
      'node --test \\',
      '  --test-name-pattern "unit" \\',
      '  tests/unit.test.mjs',
      'node --test tests/unit.test.mjs tests/missing.test.mjs',
      'cd packages/pkg-a',
      'npm run pkg:build',
      'npm run build',
      'node scripts/pkg-build.mjs',
      'node scripts/not-there.mjs',
      '```',
      '',
      '```powershell',
      'node .\\packages\\pkg-a\\scripts\\pkg-build.mjs --flag',
      'node .\\packages\\pkg-a\\scripts\\gone.mjs',
      'cd ~\\external-repo',
      'npm run external-only',
      'node scripts/external.mjs',
      '```',
      '',
      '```bash',
      'cd ~/other-repo',
      'npm run other-script',
      'node scripts/other.mjs',
      '```',
      '',
      '```js',
      '// Non-shell fence must not be scanned as shell commands',
      'const cmd = "npm run totally-fake && node scripts/nonexistent.mjs";',
      '```',
      '',
      '## Package A section',
      'Run the following from `packages/pkg-a`.',
      '- Valid in section: `node --test tests/pkg.test.mjs` (merged in `packages/pkg-a/tests/pkg.test.mjs`).',
      '- Broken in section: `node --test tests/does-not-exist.test.mjs`.',
      '',
      '## Next section resets hint',
      '- Back at root so pkg-only path fails: `node --test tests/pkg.test.mjs`.',
    ].join('\n'),
    'packages/pkg-a/README.md': [
      '# Pkg A',
      '```bash',
      'cd packages/pkg-a',
      'npm run pkg:build',
      'node --test tests/pkg.test.mjs',
      '```',
    ].join('\n'),
  });

  const report = scanRepo(dir);
  const commands = report.findings.filter(f => f.kind === 'command');
  assert.deepEqual(
    commands.map(f => ({ file: f.file, line: f.line, target: f.target })),
    [
      { file: 'README.md', line: 3, target: 'node scripts/missing.mjs' },
      { file: 'README.md', line: 3, target: 'npm --prefix packages/missing-pkg run build' },
      { file: 'README.md', line: 3, target: 'npm --prefix packages/pkg-a run nope' },
      { file: 'README.md', line: 3, target: 'npm run ghost' },
      { file: 'README.md', line: 12, target: 'node --test tests/unit.test.mjs tests/missing.test.mjs' },
      { file: 'README.md', line: 15, target: 'npm run build' },
      { file: 'README.md', line: 17, target: 'node scripts/not-there.mjs' },
      { file: 'README.md', line: 22, target: 'node .\\packages\\pkg-a\\scripts\\gone.mjs' },
      { file: 'README.md', line: 42, target: 'node --test tests/does-not-exist.test.mjs' },
      { file: 'README.md', line: 45, target: 'node --test tests/pkg.test.mjs' },
    ],
  );
});

test('excludes historical archive docs and handles malformed/binary/symlink inputs gracefully', t => {
  const dir = makeFixtureRepo(t, {
    'package.json': '{ malformed json',
    'CHANGELOG.md': '[Old broken](docs/ancient.md) `npm run ancient`\n',
    'changes/unreleased/sample.en.md': '- **Added.** `scripts/gone.mjs`\n',
    'docs/plans/old-plan.md': '[Broken plan link](./missing.md)\n',
    'docs/agent-lessons/note.md': '`scripts/never-existed.mjs`\n',
    'docs/binary.md': Buffer.from([0x23, 0x20, 0x00, 0x01, 0x02]),
    'docs/malformed.md': '[unclosed link(docs/missing.md\n```bash\nnpm run broken-unclosed\n',
    'README.md': 'Valid doc without broken refs.\n',
  });

  // Create a broken symlink inside docs/ when permitted (Windows without Developer Mode throws EPERM/EACCES).
  try {
    symlinkSync(join(dir, 'docs', 'nonexistent-target.md'), join(dir, 'docs', 'dangling-link.md'));
  } catch (err) {
    if (err?.code !== 'EPERM' && err?.code !== 'EACCES') throw err;
  }

  const files = discoverDocFiles(dir);
  assert.deepEqual(files, ['README.md', 'docs/binary.md', 'docs/malformed.md']);

  const report = scanRepo(dir);
  assert.equal(report.filesScanned, 3);
  assert.equal(report.findingsCount, 1);
  assert.equal(report.findings[0].file, 'docs/malformed.md');
  assert.equal(report.findings[0].kind, 'command');
});

test('CLI supports --root, --json, --strict exit codes, capped --annotations, and GITHUB_STEP_SUMMARY', t => {
  const brokenLines = Array.from({ length: MAX_ANNOTATIONS + 5 }, (_, idx) => `- [Broken ${idx + 1}](docs/missing-${idx + 1}.md)`);
  const brokenDir = makeFixtureRepo(t, {
    'README.md': ['# Many broken links', ...brokenLines].join('\n'),
  });
  const cleanDir = makeFixtureRepo(t, {
    'README.md': '# Clean\n- [Guide](docs/guide.md)\n',
    'docs/guide.md': '# Guide\n',
  });

  // --json with `--root <dir>` (space-separated)
  const jsonRes = runCli(['--root', brokenDir, '--json']);
  assert.equal(jsonRes.status, 0, jsonRes.stderr);
  const parsed = JSON.parse(jsonRes.stdout);
  assert.equal(parsed.filesScanned, 1);
  assert.equal(parsed.findingsCount, MAX_ANNOTATIONS + 5);
  assert.equal(parsed.findings.length, MAX_ANNOTATIONS + 5);
  assert.deepEqual(Object.keys(parsed.findings[0]).sort(), ['file', 'kind', 'line', 'message', 'target']);

  // --strict exits 1 on findings, 0 on clean repo
  const strictFail = runCli([`--root=${brokenDir}`, '--strict']);
  assert.equal(strictFail.status, 1);
  const strictPass = runCli([`--root=${cleanDir}`, '--strict']);
  assert.equal(strictPass.status, 0, strictPass.stderr);

  // --annotations caps warning lines at MAX_ANNOTATIONS, emits zero ::error, and writes GITHUB_STEP_SUMMARY
  const summaryFile = join(brokenDir, 'step-summary.md');
  const annRes = runCli(['--root', brokenDir, '--annotations'], {
    env: { GITHUB_STEP_SUMMARY: summaryFile },
  });
  assert.equal(annRes.status, 0, annRes.stderr);
  const warningLines = annRes.stdout.split(/\r?\n/).filter(line => line.startsWith('::warning '));
  assert.equal(warningLines.length, MAX_ANNOTATIONS);
  assert.match(warningLines[0], /^::warning file=README\.md,line=2,title=doc-drift \(link\)::/);
  assert.doesNotMatch(annRes.stdout, /::error /);
  assert.match(annRes.stdout, /omitted 5 additional annotation\(s\)/);

  const summary = readFileSync(summaryFile, 'utf8');
  assert.match(summary, /## Doc drift check \(advisory, non-blocking\)/);
  assert.match(summary, /\| `README\.md` \| 2 \| link \|/);

  // Advisory mode gracefully handles unwritable GITHUB_STEP_SUMMARY (directory path)
  const logs = [];
  const advisoryResult = run(['--root', cleanDir], {
    log: line => logs.push(line),
    env: { GITHUB_STEP_SUMMARY: cleanDir },
  });
  assert.equal(advisoryResult.exitCode, 0);
  assert.ok(logs.some(line => line.includes('could not append to GITHUB_STEP_SUMMARY')));

  // formatAnnotations helper respects custom cap and escaping
  const escaped = formatAnnotations({
    findings: [{ file: 'docs/a:b,c.md', line: 3, kind: 'link', message: 'bad 100%\nnext' }],
  });
  assert.equal(escaped[0], '::warning file=docs/a%3Ab%2Cc.md,line=3,title=doc-drift (link)::bad 100%25%0Anext');

  // Unknown flags fail loudly
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
  assert.throws(() => parseArgs(['--root']), /--root requires a directory path/);
});

test('real repository smoke test scans cleanly and package.json exposes doc:drift script', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['doc:drift'], 'node scripts/doc-drift.mjs');

  const report = scanRepo(repoRoot);
  assert.ok(report.filesScanned > 50, `expected >50 active docs scanned, got ${report.filesScanned}`);
  assert.equal(report.findingsCount, report.findings.length);
  for (const finding of report.findings) {
    assert.equal(typeof finding.file, 'string');
    assert.equal(typeof finding.line, 'number');
    assert.ok(['link', 'path', 'command'].includes(finding.kind));
    assert.equal(typeof finding.target, 'string');
    assert.equal(typeof finding.message, 'string');
  }
});

test('CI workflows wire doc-drift as strictly non-blocking advisory checks without gating verify', t => {
  const verify = parseYaml(readFileSync(join(repoRoot, '.github', 'workflows', 'verify.yml'), 'utf8'));
  const standalone = parseYaml(readFileSync(join(repoRoot, '.github', 'workflows', 'doc-drift.yml'), 'utf8'));

  const lintSteps = verify.jobs.lint.steps;
  const driftIndex = lintSteps.findIndex(
    step => typeof step.run === 'string' && step.run.includes('scripts/doc-drift.mjs'),
  );
  assert.ok(driftIndex >= 0, 'verify.yml lint job must run scripts/doc-drift.mjs');
  const driftStep = lintSteps[driftIndex];
  assert.equal(driftStep['continue-on-error'], true, 'verify.yml doc-drift step must be non-blocking');
  assert.match(driftStep.run, /--annotations\b/, 'verify.yml doc-drift step must emit warning annotations');
  assert.doesNotMatch(driftStep.run, /--strict\b/, 'verify.yml doc-drift step must not run in blocking --strict mode');

  const gateIndex = lintSteps.findIndex(step => typeof step.run === 'string' && step.run.includes('--gate-from='));
  assert.ok(gateIndex > driftIndex, 'advisory doc-drift step must run before blocking test-audit gate');
  assert.equal(verify.jobs.verify.needs.includes('doc-drift'), false, 'verify job must not depend on a blocking doc-drift job');

  assert.equal('workflow_dispatch' in standalone.on, true, 'doc-drift.yml must provide workflow_dispatch manual trigger');
  assert.equal('pull_request' in standalone.on, false, 'doc-drift.yml must not duplicate pull_request annotations');
  assert.equal(standalone.permissions?.contents, 'read');
  const standaloneJob = Object.values(standalone.jobs)[0];
  assert.ok(standaloneJob['timeout-minutes'] <= 5);
  const standaloneStep = standaloneJob.steps.find(step => typeof step.run === 'string' && step.run.includes('scripts/doc-drift.mjs'));
  assert.ok(standaloneStep, 'doc-drift.yml must run scripts/doc-drift.mjs');
  assert.equal(standaloneStep['continue-on-error'], true, 'doc-drift.yml step must be non-blocking');
  assert.match(standaloneStep.run, /--annotations\b/);

  // Execute the exact verify.yml command against an isolated fixture repo with deliberate drift.
  const dir = makeFixtureRepo(t, {
    'README.md': '# Fixture\n- [Broken](docs/missing.md)\n',
  });
  const tokens = driftStep.run.trim().split(/\s+/);
  assert.equal(tokens[0], 'node');
  const summaryFile = join(dir, 'summary.md');
  const res = spawnSync(process.execPath, [...tokens.slice(1), `--root=${dir}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
    windowsHide: true,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /::warning file=README\.md,line=2,title=doc-drift \(link\)::/);
  assert.doesNotMatch(res.stdout, /::error /);
  assert.match(readFileSync(summaryFile, 'utf8'), /docs\/missing\.md/);
});
