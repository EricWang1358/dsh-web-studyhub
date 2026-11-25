// Regression & Security Guardrail tests for #1441 (Companion local HTML openExternal allowlist)
// and #1442 (Assistant plain-explanation saved followup question title).
// Run: CI=1 node --test tests/issue-1441-1442.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, test } from 'node:test';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

describe('#1441: openExternal & app.open local HTML path allowlist inside study library', () => {
  test('1. resolveAllowedLocalHtmlUrl allows .html/.htm inside library root and refuses outside, traversal, symlinks, non-HTML, and missing files', async () => {
    const mod = await import('../src/host/tui-host.ts');
    assert.equal(typeof mod.resolveAllowedLocalHtmlUrl, 'function', 'tui-host must export resolveAllowedLocalHtmlUrl');

    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-1441-lib-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-1441-out-'));
    try {
      const compDir = path.join(rootDir, 'companions');
      fs.mkdirSync(compDir, { recursive: true });
      const goodHtml = path.join(compDir, 'lesson-1.html');
      const goodHtm = path.join(compDir, 'lesson-2.HTM');
      const badTxt = path.join(compDir, 'notes.txt');
      const badSh = path.join(compDir, 'run.sh');
      const outsideHtml = path.join(outsideDir, 'evil.html');
      const siblingPrefixDir = `${rootDir}-evil`;
      fs.mkdirSync(siblingPrefixDir, { recursive: true });
      const siblingHtml = path.join(siblingPrefixDir, 'escape.html');

      fs.writeFileSync(goodHtml, '<html><body>ok</body></html>', 'utf8');
      fs.writeFileSync(goodHtm, '<html><body>ok</body></html>', 'utf8');
      fs.writeFileSync(badTxt, 'plain text', 'utf8');
      fs.writeFileSync(badSh, '#!/bin/sh\necho hi', 'utf8');
      fs.writeFileSync(outsideHtml, '<html><body>outside</body></html>', 'utf8');
      fs.writeFileSync(siblingHtml, '<html><body>prefix trick</body></html>', 'utf8');

      // Symlink inside library pointing outside library
      const symlinkEscape = path.join(compDir, 'symlink-escape.html');
      fs.symlinkSync(outsideHtml, symlinkEscape);

      // Valid local HTML/HTM inside library root -> allowed!
      const resolved1 = mod.resolveAllowedLocalHtmlUrl(pathToFileURL(goodHtml).href, [rootDir]);
      assert.ok(resolved1 && resolved1.startsWith('file://'), 'valid .html inside library root must be allowed');
      const resolved2 = mod.resolveAllowedLocalHtmlUrl(pathToFileURL(goodHtm).href, [rootDir]);
      assert.ok(resolved2 && resolved2.startsWith('file://'), 'valid .HTM inside library root must be allowed');

      // Outside library root -> refused!
      assert.equal(mod.resolveAllowedLocalHtmlUrl(pathToFileURL(outsideHtml).href, [rootDir]), null, 'HTML outside library root must be refused');
      // Prefix-collision sibling directory (e.g., /tmp/lib-evil vs /tmp/lib) -> refused!
      assert.equal(mod.resolveAllowedLocalHtmlUrl(pathToFileURL(siblingHtml).href, [rootDir]), null, 'prefix-collision sibling dir must be refused');
      // Traversal URL -> refused!
      const traversalUrl = `${pathToFileURL(compDir).href}/../../${path.basename(outsideDir)}/evil.html`;
      assert.equal(mod.resolveAllowedLocalHtmlUrl(traversalUrl, [rootDir]), null, 'path traversal must be refused');
      // Symlink escaping library root -> refused!
      assert.equal(mod.resolveAllowedLocalHtmlUrl(pathToFileURL(symlinkEscape).href, [rootDir]), null, 'symlink escaping library root must be refused');
      // Non-HTML files inside library -> refused!
      assert.equal(mod.resolveAllowedLocalHtmlUrl(pathToFileURL(badTxt).href, [rootDir]), null, '.txt inside library must be refused');
      assert.equal(mod.resolveAllowedLocalHtmlUrl(pathToFileURL(badSh).href, [rootDir]), null, '.sh inside library must be refused');
      // Non-existent HTML inside library -> refused!
      assert.equal(mod.resolveAllowedLocalHtmlUrl(pathToFileURL(path.join(compDir, 'missing.html')).href, [rootDir]), null, 'missing HTML file must be refused');
      // Remote host file:// URL -> refused!
      assert.equal(mod.resolveAllowedLocalHtmlUrl('file://evil.example/share/lesson.html', [rootDir]), null, 'remote file:// host must be refused');
      // Directory itself -> refused!
      assert.equal(mod.resolveAllowedLocalHtmlUrl(pathToFileURL(compDir).href, [rootDir]), null, 'directory URL must be refused');

      fs.rmSync(siblingPrefixDir, { recursive: true, force: true });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('2. createTuiHost app.open allows local companion HTML inside libraryRoot and refuses outside file://', async () => {
    const { createTuiHost } = await import('../src/host/tui-host.ts');
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-1441-host-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-1441-host-out-'));
    const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-1441-home-'));
    const openedUrls = [];

    const htmlInside = path.join(rootDir, 'companions', 'demo.html');
    fs.mkdirSync(path.dirname(htmlInside), { recursive: true });
    fs.writeFileSync(htmlInside, '<!doctype html><html><body>demo</body></html>', 'utf8');
    const htmlOutside = path.join(outsideDir, 'outside.html');
    fs.writeFileSync(htmlOutside, '<!doctype html><html><body>outside</body></html>', 'utf8');

    const host = await createTuiHost({
      libraryRoot: rootDir,
      env: { ...process.env, DSH_HOME: dshHome, DISPLAY: '', WAYLAND_DISPLAY: '' },
      skipAutoProbe: true,
      onOpenExternal: (url) => openedUrls.push(url),
    });
    try {
      const okRes = await host.call('app.open', { url: pathToFileURL(htmlInside).href });
      assert.equal(okRes.ok, true, `app.open should allow local HTML inside library root, got: ${JSON.stringify(okRes)}`);
      assert.equal(openedUrls.length, 1);
      assert.ok(openedUrls[0].startsWith('file://'));

      const deniedRes = await host.call('app.open', { url: pathToFileURL(htmlOutside).href });
      assert.equal(deniedRes.ok, false, 'app.open must refuse local HTML outside library root');
      assert.equal(deniedRes.error?.code, 'link-refused');
    } finally {
      await host.dispose();
      fs.rmSync(rootDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
      fs.rmSync(dshHome, { recursive: true, force: true });
    }
  });

  test('3. CompanionsModal app.open call does not pass unused path parameter', () => {
    const src = fs.readFileSync(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/views/sources/CompanionsModal.tsx'),
      'utf8',
    );
    assert.ok(!src.includes("tryAction(host, 'app.open', { url: openTarget, path: rawPath })"), 'CompanionsModal must not pass unused path param to app.open');
  });
});

describe('#1442: Plain explanation saved followup uses learner-friendly title instead of raw command', () => {
  test('1. resolvePlainExplainQuestionTitle maps generic commands to learner-friendly title and keeps specific learner questions', async () => {
    const mod = await import('../src/shell/assistant-intent.ts');
    assert.equal(typeof mod.resolvePlainExplainQuestionTitle, 'function', 'assistant-intent must export resolvePlainExplainQuestionTitle');

    // Generic command inputs -> learner-friendly title
    assert.equal(mod.resolvePlainExplainQuestionTitle('通俗讲解', 'zh'), '通俗讲解');
    assert.equal(mod.resolvePlainExplainQuestionTitle('讲解新增通俗讲解', 'zh'), '通俗讲解');
    assert.equal(mod.resolvePlainExplainQuestionTitle('用大白话讲一下这题', 'zh'), '通俗讲解');
    assert.equal(mod.resolvePlainExplainQuestionTitle('换个例子讲讲这道题', 'zh'), '通俗讲解');
    assert.equal(mod.resolvePlainExplainQuestionTitle('plain explain', 'en'), 'Plain Explanation');
    assert.equal(mod.resolvePlainExplainQuestionTitle('add plain explanation', 'en'), 'Plain Explanation');

    // Specific learner questions -> preserve the actual question without command prefix
    assert.equal(
      mod.resolvePlainExplainQuestionTitle('通俗讲解：为什么缺页率上升会引发抖动？', 'zh'),
      '为什么缺页率上升会引发抖动？',
    );
    assert.equal(
      mod.resolvePlainExplainQuestionTitle('用大白话讲一下 TLB 命中率怎么算', 'zh'),
      'TLB 命中率怎么算',
    );
    assert.equal(
      mod.resolvePlainExplainQuestionTitle('plain explain: why does Belady anomaly happen?', 'en'),
      'why does Belady anomaly happen?',
    );
  });

  test('2. AssistantPanel uses resolvePlainExplainQuestionTitle for card.followup.add question field', () => {
    const src = fs.readFileSync(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/shell/AssistantPanel.tsx'),
      'utf8',
    );
    assert.match(src, /question:\s*resolvePlainExplainQuestionTitle\(/, 'AssistantPanel must pass resolvePlainExplainQuestionTitle() to card.followup.add');
  });
});
