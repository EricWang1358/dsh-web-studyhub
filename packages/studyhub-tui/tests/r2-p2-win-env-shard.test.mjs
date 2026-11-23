// Unit tests for LPT `--shard` partitioning, Windows `npm.cmd`/`npx.cmd` & path helpers,
// `sanitizedTestEnv` secret scrubbing, and 0-network guard:
// `node --test tests/r2-p2-win-env-shard.test.mjs`
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { describe, test } from 'node:test';
import { tsImport } from 'tsx/esm/api';
import {
  assertZeroExternalNetwork,
  installNoNetworkGuard,
  isLoopbackUrl,
  pkgRoot,
  resolveNpmCommand,
  sanitizedTestEnv,
} from './helpers/virtual-tty.mjs';

const runnerScript = join(pkgRoot, 'scripts', 'run-tests.mjs');
const testsDir = join(pkgRoot, 'tests');

const [{ cleanPathInput }, { truncatePathMiddle }] = await Promise.all([
  tsImport('../src/host/sample-actions.ts', import.meta.url),
  tsImport('../src/views/settings/WorkspaceTab.tsx', import.meta.url),
]);

function runRunner(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [runnerScript, ...args], {
      cwd: pkgRoot,
      env: sanitizedTestEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    });
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
        files: stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean),
      });
    });
  });
}

describe('P2 #9: LPT --shard partitioning in scripts/run-tests.mjs', () => {
  test('1) --list --shard=1/3, 2/3, 3/3 partition all TUI test files with zero duplicates and zero omissions', async () => {
    const expectedFiles = (await readdir(testsDir))
      .filter((name) => name.endsWith('.test.mjs'))
      .sort()
      .map((name) => `tests/${name}`);

    const [allRes, s1, s2, s3] = await Promise.all([
      runRunner(['--list']),
      runRunner(['--list', '--shard=1/3']),
      runRunner(['--list', '--shard=2/3']),
      runRunner(['--list', '--shard=3/3']),
    ]);

    assert.equal(allRes.code, 0, `--list failed: ${allRes.stderr}`);
    assert.deepEqual([...allRes.files].sort(), expectedFiles);

    for (const [idx, res] of [
      [1, s1],
      [2, s2],
      [3, s3],
    ]) {
      assert.equal(res.code, 0, `--shard=${idx}/3 failed: ${res.stderr}`);
      assert.ok(res.files.length >= 1, `shard ${idx}/3 must not be empty`);
    }

    const combined = [...s1.files, ...s2.files, ...s3.files];
    assert.equal(
      new Set(combined).size,
      combined.length,
      'shards must not contain duplicate test files',
    );
    assert.deepEqual(
      combined.sort(),
      expectedFiles,
      'union of shards 1/3, 2/3, 3/3 must match all test files',
    );

    const maxCount = Math.max(s1.files.length, s2.files.length, s3.files.length);
    const minCount = Math.min(s1.files.length, s2.files.length, s3.files.length);
    assert.ok(maxCount - minCount <= 4, `LPT shards unbalanced: ${s1.files.length}, ${s2.files.length}, ${s3.files.length}`);
  });

  test('2) invalid --shard specs exit 2 with diagnostic error', async () => {
    for (const bad of ['--shard=0/3', '--shard=4/3', '--shard=bad']) {
      const res = await runRunner(['--list', bad]);
      assert.equal(res.code, 2, `${bad} must exit 2`);
      assert.match(res.stderr, /--shard needs index\/count/);
      assert.deepEqual(res.files, []);
    }
  });
});

describe('P2 #10: sanitizedTestEnv & 0-network guard', () => {
  test('1) sanitizedTestEnv scrubs provider API keys, tokens, secrets while preserving OS vars and overrides', () => {
    const secretKeys = {
      OPENAI_API_KEY: 'sk-openai-secret',
      DEEPSEEK_API_KEY: 'sk-deepseek-secret',
      GITHUB_TOKEN: 'ghp_secret_token',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-key',
      GEMINI_API_KEY: 'gm-secret',
      MINERU_TOKEN: 'mineru-secret',
      ANTHROPIC_API_KEY: 'ant-secret',
      CUSTOM_SECRET: 'custom-secret',
    };
    const prev = {};
    for (const [k, v] of Object.entries(secretKeys)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }

    try {
      const scrubbed = sanitizedTestEnv({ DSH_HOME: '/tmp/test-dsh-home', CUSTOM_FLAG: '1' });
      for (const key of Object.keys(secretKeys)) {
        assert.equal(key in scrubbed, false, `sanitizedTestEnv must scrub ${key}`);
      }
      assert.equal(scrubbed.DSH_HOME, '/tmp/test-dsh-home');
      assert.equal(scrubbed.CUSTOM_FLAG, '1');
      const hostPath = process.env.PATH ?? process.env.Path;
      const scrubbedPath = scrubbed.PATH ?? scrubbed.Path;
      if (hostPath !== undefined) {
        assert.equal(scrubbedPath, hostPath);
      }
      const hostHome = process.env.HOME ?? process.env.USERPROFILE;
      const scrubbedHome = scrubbed.HOME ?? scrubbed.USERPROFILE;
      if (hostHome !== undefined) {
        assert.equal(scrubbedHome, hostHome);
      }

      const withExplicitKey = sanitizedTestEnv({ OPENAI_API_KEY: 'explicit-override' });
      assert.equal(withExplicitKey.OPENAI_API_KEY, 'explicit-override');
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('2) installNoNetworkGuard & assertZeroExternalNetwork block non-loopback fetch and allow 127.0.0.1', async () => {
    assert.equal(isLoopbackUrl('http://127.0.0.1:8080/api'), true);
    assert.equal(isLoopbackUrl('http://localhost:3000/test'), true);
    assert.equal(isLoopbackUrl('http://[::1]:3000/test'), true);
    assert.equal(isLoopbackUrl('https://api.openai.com/v1/chat/completions'), false);

    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const originalFetch = globalThis.fetch;
    try {
      await assertZeroExternalNetwork(async () => {
        await assert.rejects(
          () => globalThis.fetch('https://api.openai.com/v1/chat/completions'),
          /0-network guard blocked outbound fetch/,
        );
        await assert.rejects(
          () => globalThis.fetch('https://example.com/health'),
          /0-network guard blocked outbound fetch/,
        );
        const localRes = await globalThis.fetch(`http://127.0.0.1:${port}/ping`);
        assert.equal(localRes.status, 200);
        const body = await localRes.json();
        assert.deepEqual(body, { ok: true });
      });
      assert.equal(globalThis.fetch, originalFetch, 'assertZeroExternalNetwork must restore globalThis.fetch');

      const restore = installNoNetworkGuard();
      try {
        await assert.rejects(
          () => globalThis.fetch('https://api.deepseek.com/v1/models'),
          /0-network guard blocked outbound fetch/,
        );
      } finally {
        restore();
      }
      assert.equal(globalThis.fetch, originalFetch, 'restore() must restore globalThis.fetch');
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });
});

describe('P2 #8: Simulated win32 npm.cmd/npx.cmd & Windows long path handling', () => {
  test('1) resolveNpmCommand resolves npm.cmd / npx.cmd with shell:true on win32 and bare names on linux', () => {
    const winNpm = resolveNpmCommand('npm', 'win32');
    assert.equal(winNpm.command, 'npm.cmd');
    assert.deepEqual(winNpm.options, { shell: true, windowsHide: true });

    const winNpx = resolveNpmCommand('npx', 'win32');
    assert.equal(winNpx.command, 'npx.cmd');
    assert.deepEqual(winNpx.options, { shell: true, windowsHide: true });

    const linuxNpm = resolveNpmCommand('npm', 'linux');
    assert.equal(linuxNpm.command, 'npm');
    assert.deepEqual(linuxNpm.options, { shell: false, windowsHide: true });
  });

  test('2) Windows long backslash paths, UNC paths, and npm pack path normalization behave cleanly', () => {
    const winLongPath = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\studyhub-tui-decks-abc123\\r55-e2e-zh-xyz789\\eigen-import.json';
    assert.equal(cleanPathInput(`"${winLongPath}"`), winLongPath);
    assert.equal(cleanPathInput(`& '${winLongPath}'`), winLongPath);

    const uncPath = '\\\\fileserver\\studyhub\\shared\\deck.json';
    assert.equal(cleanPathInput(uncPath), uncPath);

    const truncated = truncatePathMiddle(winLongPath, 42, '...');
    assert.ok(truncated.length <= 42, `truncated Windows path exceeded 42 chars: ${truncated}`);
    assert.ok(truncated.includes('...'));
    assert.ok(truncated.endsWith('eigen-import.json'), `tail must stay visible: ${truncated}`);

    // Simulate npm pack path list normalization on win32
    const winPackEntries = ['bin\\studyhub-tui.mjs', 'dist\\cli.mjs', 'docs\\KEYBINDINGS.md'];
    const normalized = winPackEntries.map((p) => p.replace(/\\/g, '/'));
    assert.deepEqual(normalized, ['bin/studyhub-tui.mjs', 'dist/cli.mjs', 'docs/KEYBINDINGS.md']);
    assert.equal(posix.basename(normalized[0]), 'studyhub-tui.mjs');
  });

  test('3) Static CI guard: every non-debug Ink render() in tests/*.test.mjs explicitly passes interactive: true', async () => {
    const files = (await readdir(testsDir)).filter((f) => f.endsWith('.test.mjs')).sort();
    const offenders = [];
    for (const file of files) {
      const src = await readFile(join(testsDir, file), 'utf8');
      for (const m of src.matchAll(/(?<![.\w])render\s*\(/g)) {
        let depth = 0;
        let i = m.index + m[0].length - 1;
        for (; i < src.length; i += 1) {
          if (src[i] === '(') depth += 1;
          else if (src[i] === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        const callText = src.slice(m.index, i + 1);
        const hasStreams = /\bstdout\b|\bstdin\b/.test(callText);
        const hasInteractive = /\binteractive\s*:/.test(callText);
        const hasDebug = /\bdebug\s*:\s*true/.test(callText);
        if (hasStreams && !hasInteractive && !hasDebug) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${file}:${line}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Found Ink render() calls omitting interactive: true (causes Ink to defer all frames under CI=true): ${offenders.join(', ')}`,
    );
  });
});
