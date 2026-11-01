/* global window, document, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { build } from 'esbuild';
import { buildHostClient } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

const PACKAGE_ID = '@ericwang1358/dsh-daily-flashcard';

async function buildBrowserHarness() {
  const [clientBuild, hostBundle] = await Promise.all([
    buildHostClient({ write: false }),
    build({
      stdin: {
        contents: `
          import React from 'react';
          import ReactDOM from 'react-dom';
          import { createRoot } from 'react-dom/client';

          const packageId = ${JSON.stringify(PACKAGE_ID)};
          const factories = new Map();
          const cache = new Map();
          const pending = new Map();

          window.__ModuleLoader__ = {
            load({ id, chunk, factory }) {
              const key = chunk ? id + '/' + chunk : id;
              factories.set(key, factory);
            },
          };

          function importChunk(spec) {
            const name = spec.slice(2);
            const key = packageId + '/' + name;
            if (cache.has(key)) return Promise.resolve(cache.get(key));
            if (factories.has(key)) return Promise.resolve(materialize(key));
            if (pending.has(key)) return pending.get(key);
            const url = '/plugin/' + name;
            const load = new Promise((resolve, reject) => {
              const script = document.createElement('script');
              script.src = url;
              script.async = true;
              script.onload = () => {
                script.remove();
                try { resolve(materialize(key)); }
                catch (err) { reject(err); }
              };
              script.onerror = () => {
                script.remove();
                reject(new Error('Failed to load chunk ' + url));
              };
              document.head.appendChild(script);
            }).finally(() => {
              pending.delete(key);
            });
            pending.set(key, load);
            return load;
          }

          function materialize(id) {
            if (id === 'react') return React;
            if (id === 'react-dom') return ReactDOM;
            if (cache.has(id)) return cache.get(id);
            const factory = factories.get(id);
            if (!factory) throw new Error('Missing factory for ' + id);
            const req = spec => materialize(spec);
            req.async = importChunk;
            const exports = factory(req);
            cache.set(id, exports);
            return exports;
          }

          window.__dshHarness = {
            async boot() {
              await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = '/plugin/client.js';
                script.onload = () => { script.remove(); resolve(); };
                script.onerror = () => { script.remove(); reject(new Error('Failed to load client.js')); };
                document.head.appendChild(script);
              });
              const entry = materialize(packageId);
              const slots = [];
              const disposers = [];
              const dictionaries = {};
              const lang = () => localStorage.getItem('study-ui-language') === 'en' ? 'en' : 'zh';
              const services = {
                layout: { selectPanel() {} },
                uiWorkspace: { startSession() { window.__startedSessions = (window.__startedSessions || 0) + 1; } },
                connection: {
                  rpc: {
                    async call(_prefix, _method, payload) {
                      if (payload?.action === 'runtime.capabilities') return { ok: true, value: [{ api: 'materials.v1' }] };
                      if (payload?.action === 'panel.intent.next') return { ok: true, value: { intent: null } };
                      if (payload?.action === 'materials.document.get') return { ok: true, value: { id: 'doc-1', sources: [] } };
                      if (payload?.action === 'materials.links.list') return { ok: true, value: { links: [] } };
                      return { ok: true, value: {} };
                    },
                  },
                },
              };
              const ctx = {
                get: name => services[name],
                effect(fn) {
                  const dispose = fn();
                  if (typeof dispose === 'function') disposers.push(dispose);
                },
                locale: {
                  register(ns, dict) { dictionaries[ns] = dict; return () => {}; },
                  bind: ns => key => dictionaries[ns]?.[lang()]?.[key] ?? key,
                },
                slots: {
                  inject: (_name, fn) => fn(),
                  register(descriptor, component) {
                    slots.push({ descriptor, component });
                    return () => {};
                  },
                },
                sidebarRightTabs: { register: () => () => {} },
                documentPreviews: { register: () => () => {} },
                inject(_deps, fn) {
                  const dispose = fn(ctx);
                  if (typeof dispose === 'function') disposers.push(dispose);
                },
              };
              await entry.apply(ctx);
              const findSlot = (name, key) => slots.find(s => s.descriptor.name === name &&
                (key === undefined || s.descriptor.id === key || s.descriptor.key === key));
              const Glyph = findSlot('sidebar.panellist', 'studyhub').component;
              createRoot(document.getElementById('dsh-sidebar')).render(<Glyph size={16} active={false} />);
              let mountedRoot = null;
              window.__dshMount = (name, key, props = {}) => {
                mountedRoot?.unmount();
                mountedRoot = createRoot(document.getElementById('dsh-slot'));
                const Comp = findSlot(name, key).component;
                mountedRoot.render(<Comp {...props} />);
              };
              window.__dshDispose = () => {
                mountedRoot?.unmount();
                mountedRoot = null;
                while (disposers.length) disposers.pop()?.();
              };
              document.getElementById('dsh-chat').dataset.booted = 'true';
            },
          };
        `,
        resolveDir: process.cwd(),
        loader: 'jsx',
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      logLevel: 'silent',
    }),
  ]);
  const files = new Map(clientBuild.outputFiles.map(file => [basename(file.path), file.text]));
  const englishChunk = Object.entries(clientBuild.metafile.outputs).find(([, rec]) =>
    Object.keys(rec.inputs).some(input => /english-catalogue\.js$/.test(input)));
  const workspaceChunk = Object.entries(clientBuild.metafile.outputs).find(([, rec]) =>
    rec.entryPoint === 'ui/host/workspace.jsx');
  return {
    files,
    hostScript: hostBundle.outputFiles[0].text,
    englishChunkName: englishChunk ? basename(englishChunk[0]) : null,
    workspaceChunkName: workspaceChunk ? basename(workspaceChunk[0]) : null,
  };
}

const HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><style>:root { --dsh-composer-height: 140px; }</style></head>
  <body>
    <aside id="dsh-sidebar"></aside>
    <main id="dsh-chat">DSH Chat Ready</main>
    <section id="dsh-slot" style="height:480px"></section>
    <script src="/harness.js"></script>
  </body>
</html>`;

test('DSH chat boot requests zero StudyHub chunks, survives blocked chunks, and recovers on Retry (#630)', { timeout: 60000 }, async t => {
  const { files, hostScript, englishChunkName, workspaceChunkName } = await buildBrowserHarness();
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(String(error.message))) throw error;
    t.skip('Chromium unavailable'); return;
  }
  t.after(() => browser.close());

  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  const pageErrors = [];
  const requestedChunks = [];
  let blockChunks = false;
  let holdGate = null;

  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('http://dsh.test/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML });
      return;
    }
    if (pathname === '/harness.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: hostScript });
      return;
    }
    if (pathname.startsWith('/plugin/')) {
      const name = pathname.slice('/plugin/'.length);
      if (name !== 'client.js') {
        requestedChunks.push(name);
        if (holdGate) await holdGate.promise;
        if (blockChunks) {
          await route.abort('failed');
          return;
        }
      }
      await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: files.get(name) || '' });
      return;
    }
    await route.abort('failed');
  });

  await page.goto('http://dsh.test/');
  await page.evaluate(() => {
    window.localStorage.setItem('studyhub.welcomed.v1', '2026-10-01T00:00:00.000Z');
    window.localStorage.setItem('study-ui-language', 'zh');
  });

  // 1. Normal chat boot + left sidebar glyph -> 0 chunk requests.
  blockChunks = true;
  await page.evaluate(() => window.__dshHarness.boot());
  assert.equal(await page.getAttribute('#dsh-chat', 'data-booted'), 'true', 'DSH web boot succeeds even while chunks are unreachable');
  assert.equal(await page.locator('#dsh-sidebar svg').count(), 1, 'left sidebar renders StudyHub icon');
  assert.deepEqual(requestedChunks, [], 'zero sibling chunks requested during Chat boot');
  assert.deepEqual(pageErrors, []);

  // 2. Opening a StudyHub slot while chunks are blocked renders retryable fallback inside composer-safe frame without crashing host.
  await page.evaluate(() => window.__dshMount('conversation.view', 'study-workspace', { sessionId: undefined, openView() {} }));
  const alert = page.locator('#dsh-slot [role="alert"]');
  await alert.waitFor();
  const retryButton = alert.getByRole('button', { name: '重试' });
  await retryButton.waitFor();
  const paddingBottom = await page.locator('#dsh-slot .study-seat-frame[data-conversation-composer-overlay=""]').evaluate(el =>
    parseFloat(getComputedStyle(el).paddingBottom));
  assert.ok(paddingBottom >= 140, `composer overlay padding (${paddingBottom}px) keeps Retry clear of DSH's floating composer`);
  assert.deepEqual(pageErrors, []);

  // 3. Unblock chunks and click Retry -> missing chunks arrive and StudyHub renders.
  blockChunks = false;
  await retryButton.click();
  await page.evaluate(() => window.__dshMount('study-workspace.page', undefined, { sessionId: undefined }));
  const newSessionBtn = page.locator('#dsh-slot').getByRole('button', { name: '新建会话' });
  await newSessionBtn.waitFor();
  assert.ok(requestedChunks.length > 0, 'opening StudyHub fetches lazy chunks on demand');
  assert.deepEqual(pageErrors, []);

  // 4. Document preview lazy-loads native.jsx without pulling workspace.jsx, and recovers on Retry after a blocked chunk.
  const docPage = await context.newPage();
  const docChunks = [];
  const docErrors = [];
  let blockDoc = true;
  docPage.on('pageerror', error => docErrors.push(error.message));
  await docPage.route('http://dsh.test/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML });
    if (pathname === '/harness.js') return route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: hostScript });
    if (pathname.startsWith('/plugin/')) {
      const name = pathname.slice('/plugin/'.length);
      if (name !== 'client.js') {
        docChunks.push(name);
        if (blockDoc) return route.abort('failed');
      }
      return route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: files.get(name) || '' });
    }
    return route.abort('failed');
  });
  await docPage.goto('http://dsh.test/');
  await docPage.evaluate(() => {
    window.localStorage.setItem('studyhub.welcomed.v1', '1');
    window.localStorage.setItem('study-ui-language', 'zh');
  });
  await docPage.evaluate(() => window.__dshHarness.boot());
  assert.deepEqual(docChunks, []);
  await docPage.evaluate(() => window.__dshMount('sidebar.right.tab.document', 'study-html', {
    content: { kind: 'text', text: '<article><h2>Lecture 1</h2></article>' },
    resourceAddress: 'dsh-resource://file/session/s1/D:/lecture.html',
    sessionId: 's1',
  }));
  const docRetry = docPage.locator('#dsh-slot [role="alert"]').getByRole('button', { name: '重试' });
  await docRetry.waitFor();
  blockDoc = false;
  await docRetry.click();
  await docPage.locator('#dsh-slot .study-html-document h2', { hasText: 'Lecture 1' }).waitFor();
  if (workspaceChunkName) {
    assert.equal(docChunks.includes(workspaceChunkName), false, 'document preview loads native.jsx without pulling workspace.jsx');
  }
  await docPage.evaluate(() => window.__dshMount('sidebar.right.tab.document.actions', 'study-selection-learning', {
    sessionId: 's1', absolutePath: 'D:/lecture.md',
  }));
  await docPage.locator('#dsh-slot').getByRole('button', { name: '选段学习' }).waitFor();
  assert.deepEqual(docErrors, []);

  // 5. English interface (#563): holding the English catalogue chunk keeps the loading shell in English and paints English directly once released.
  const enContext = await browser.newContext({ locale: 'en-US' });
  const enPage = await enContext.newPage();
  const enErrors = [];
  let releaseEnglish = null;
  const englishHeld = new Promise(resolve => { releaseEnglish = resolve; });
  let holdingEnglish = Boolean(englishChunkName);
  enPage.on('pageerror', error => enErrors.push(error.message));
  await enPage.route('http://dsh.test/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML });
    if (pathname === '/harness.js') return route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: hostScript });
    if (pathname.startsWith('/plugin/')) {
      const name = pathname.slice('/plugin/'.length);
      if (holdingEnglish && name === englishChunkName) await englishHeld;
      return route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: files.get(name) || '' });
    }
    return route.abort('failed');
  });
  await enPage.goto('http://dsh.test/');
  await enPage.evaluate(() => {
    window.localStorage.setItem('studyhub.welcomed.v1', '2026-10-01T00:00:00.000Z');
    window.localStorage.setItem('study-ui-language', 'en');
  });
  await enPage.evaluate(() => window.__dshHarness.boot());
  await enPage.evaluate(() => window.__dshMount('study-workspace.page', undefined, { sessionId: undefined }));
  if (holdingEnglish) {
    const statusBox = enPage.locator('#dsh-slot [role="status"]');
    await statusBox.waitFor();
    const loadingText = await statusBox.textContent();
    assert.doesNotMatch(loadingText, /[\u3400-\u9fff]/, 'English loading state never flashes Chinese characters');
    holdingEnglish = false;
    releaseEnglish();
  }
  const enText = await enPage.locator('#dsh-slot .studyhub-page-empty h1').textContent();
  assert.doesNotMatch(enText, /[\u3400-\u9fff]/, 'first StudyHub frame on an English interface is already localized');
  assert.deepEqual(enErrors, []);

  // 6. Disposal while chunk load is in-flight does not leak <style> elements or throw INACTIVE_EFFECT.
  const disposePage = await enContext.newPage();
  const disposeErrors = [];
  disposePage.on('pageerror', error => disposeErrors.push(error.message));
  let releasePending;
  holdGate = { promise: new Promise(resolve => { releasePending = resolve; }) };
  await disposePage.route('http://dsh.test/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML });
    if (pathname === '/harness.js') return route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: hostScript });
    if (pathname.startsWith('/plugin/')) {
      const name = pathname.slice('/plugin/'.length);
      if (name !== 'client.js' && holdGate) await holdGate.promise;
      return route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: files.get(name) || '' });
    }
    return route.abort('failed');
  });
  await disposePage.goto('http://dsh.test/');
  await disposePage.evaluate(() => window.localStorage.setItem('studyhub.welcomed.v1', '1'));
  await disposePage.evaluate(() => window.__dshHarness.boot());
  const stylesBefore = await disposePage.evaluate(() => document.head.querySelectorAll('style').length);
  await disposePage.evaluate(() => window.__dshMount('study-workspace.page', undefined, { sessionId: undefined }));
  await disposePage.evaluate(() => window.__dshDispose());
  holdGate = null;
  releasePending();
  await disposePage.waitForTimeout(100);
  const stylesAfter = await disposePage.evaluate(() => document.head.querySelectorAll('style').length);
  assert.equal(stylesAfter, stylesBefore, 'no <style> elements leak when ctx disposes while chunk import is in-flight');
  assert.deepEqual(disposeErrors, []);
});
