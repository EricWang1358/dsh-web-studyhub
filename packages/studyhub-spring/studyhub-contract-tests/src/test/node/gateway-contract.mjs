import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { composeDesktopSidecar } from '../../../../../../packages/studyhub-desktop/entry/sidecar.mjs';
import { parseSseFrames } from '../../../../../../ui/desktop/events.js';
import { launchChromium } from '../../../../../../scripts/qa/browser.mjs';
import { revealNavRow } from '../../../../../../scripts/qa/nav-reveal.mjs';
import { openPage } from '../../../../../../scripts/qa/layout-late.mjs';

const [gatewayUrl, temporary, realModel] = process.argv.slice(2);
assert.ok(gatewayUrl && temporary, 'JUnit supplies an isolated server and temporary directory');
const course = '随机过程 / Stochastic processes';

async function rpc(endpoint, body, headers = {}) {
  const response = await fetch(endpoint.baseUrl + '/api/call', {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', 'X-Study-Token': endpoint.token, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function checkHttp(reference, gateway) {
  const cases = [
    ['missing token', {}, { 'X-Study-Token': '' }, 403, 'forbidden'],
    ['foreign origin', {}, { Origin: 'https://foreign.invalid' }, 403, 'forbidden-origin'],
    ['wrong media type', {}, { 'Content-Type': 'text/plain' }, 415, 'unsupported-media-type'],
    ['invalid JSON', '{', {}, 400, 'invalid-json'],
    ['missing action', {}, {}, 400, 'invalid-request'],
    ['unknown action', { action: 'trackS.unknown' }, {}, 200],
    ['model capability', { action: 'webGemini.status' }, {}, 200],
    ['empty course list', { action: 'course.list' }, {}, 200],
  ];
  for (const [label, body, headers, status, code] of cases) {
    const native = await rpc(reference, body, headers);
    assert.equal(native.status, status, label);
    if (code) assert.equal(native.json.code, code, label);
    assert.deepEqual(await rpc(gateway, body, headers), native, label);
  }
  for (const endpoint of [reference, gateway]) {
    const health = await fetch(endpoint.baseUrl + '/health', { signal: AbortSignal.timeout(5_000) });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const forbidden = await fetch(endpoint.baseUrl + '/api/events', { signal: AbortSignal.timeout(5_000) });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).code, 'forbidden');
    const saved = await rpc(endpoint, { action: 'course.save', args: { name: course } });
    assert.equal(saved.json.ok, true, JSON.stringify(saved.json));
    const found = await rpc(endpoint, { action: 'course.list' });
    assert.ok(found.json.value.courses.some(row => row.name === course), JSON.stringify(found.json));
  }
}

async function* frames(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    const parsed = [];
    buffer = parseSseFrames(buffer + decoder.decode(chunk, { stream: true }), frame => parsed.push(frame));
    for (const frame of parsed) yield { event: frame.event, data: JSON.parse(frame.data) };
  }
}

async function observeChange(endpoint) {
  const cancel = new AbortController();
  const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(30_000)]);
  const response = await fetch(endpoint.baseUrl + '/api/events', {
    headers: { 'X-Study-Token': endpoint.token }, signal,
  });
  const events = frames(response.body);
  try {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type'), /^text\/event-stream/);
    assert.deepEqual((await events.next()).value, { event: 'ready', data: { ok: true } });
    const args = { reason: 'spring-contract', changedAreas: ['courses'] };
    const reply = await rpc(endpoint, { action: 'library.notifyChanged', args });
    assert.equal(reply.json.value.notified, true);
    for await (const { event, data } of events) {
      if (data.reason !== args.reason) continue;
      assert.equal(event, 'study:library-changed');
      assert.equal(data.type, event);
      assert.deepEqual(data.changedAreas, args.changedAreas);
      assert.equal(await realpath(data.root), await realpath(endpoint.library));
      assert.equal(data.stamp, reply.json.value.stamp);
      assert.equal(data.revision, reply.json.value.revision);
      assert.ok(Number.isFinite(data.at));
      // Times, manifest stamps and temp roots are local to each independent running engine.
      return { ...data, at: '<observed>', stamp: '<observed>', root: '<library>' };
    }
    assert.fail('SSE ended before the change arrived');
  } finally {
    cancel.abort();
    await events.return();
  }
}

async function checkBrowser(gateway) {
  const browser = await launchChromium();
  try {
    for (const options of [
      { lang: 'zh', theme: 'light', width: 1280 },
      { lang: 'en', theme: 'dark', width: 420 },
    ]) {
      const { page, context, errors } = await openPage(browser, null, options);
      try {
        const calls = new Set();
        page.on('response', response => {
          if (response.status() >= 400) errors.push(response.status() + ' ' + response.url());
          if (response.url() === gateway.baseUrl + '/api/call' && response.status() === 200) {
            calls.add(response.request().postDataJSON().action);
          }
        });
        const opened = await page.goto(gateway.baseUrl);
        assert.equal(opened.status(), 200);
        const materials = await revealNavRow(page, 'sources');
        await materials.click();
        await page.locator('.sources-page [data-tour="sources-list"]').first().waitFor();
        assert.equal(await page.locator('.study-app[data-usage-area]').getAttribute('data-usage-area'), 'sources');
        assert.ok(calls.has('snapshot'), 'UI fetched its snapshot through Spring Boot');
        assert.deepEqual(errors, [], JSON.stringify(options));
        console.log('Chromium opened materials', options.lang, options.theme, options.width);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

async function checkNativeSearch(gateway) {
  const scope = { libraryId: 'lib/1', courseId: '机械 工程', sourceId: 'page/2' };
  const endpoint = (path, params) => gateway.baseUrl + '/api/retrieval/' + path + '?' + new URLSearchParams(params);
  const headers = { 'X-Study-Token': gateway.token, 'Content-Type': 'text/plain' };
  const source = endpoint('source', scope);
  const opts = { method: 'PUT', headers, body: '汽车发动机通过燃烧燃料来驱动车轮。' };
  assert.equal((await fetch(source, { ...opts, headers: { 'Content-Type': 'text/plain' } })).status, 403);
  assert.equal((await fetch(source, { ...opts, body: 'a'.repeat(262145) })).status, 413);
  assert.deepEqual(await (await fetch(source, opts)).json(), { changed: true });
  assert.deepEqual(await (await fetch(source, opts)).json(), { changed: false });
  const query = { libraryId: scope.libraryId, courseId: scope.courseId, query: 'How does a car engine work?', limit: '1' };
  const search = async params => (await fetch(endpoint('search', params), { headers })).json();
  const [hit] = await search(query);
  assert.equal(hit.sourceId, scope.sourceId);
  assert.equal(hit.vectorRank, 1);
  assert.equal(hit.lexicalRank, null);
  assert.deepEqual(await search({ ...query, libraryId: 'other' }), []);
  assert.deepEqual(await (await fetch(source, { method: 'DELETE', headers })).json(), { deleted: true });
  assert.deepEqual(await search(query), []);
  console.log('Verified authenticated native retrieval with the pinned multilingual ONNX model');
}

const token = randomBytes(32).toString('hex');
const library = join(temporary, 'node', 'library');
const server = await composeDesktopSidecar({
  token, env: { ...process.env, DSH_HOME: join(temporary, 'node', 'home'), STUDYHUB_LIBRARY: library },
});
try {
  const html = await (await fetch(gatewayUrl, { signal: AbortSignal.timeout(5_000) })).text();
  const gatewayToken = html.match(/window\.STUDY_TOKEN\s*=\s*"([^"]+)"/)?.[1];
  assert.ok(gatewayToken, 'HTML provides a session token to the unchanged StudyHub browser bundle');
  const reference = { baseUrl: server.baseUrl, token, library };
  const gateway = { baseUrl: gatewayUrl, token: gatewayToken, library: join(temporary, 'spring', 'library') };
  await checkHttp(reference, gateway);
  assert.deepEqual(await observeChange(gateway), await observeChange(reference));
  console.log('Verified Node/Spring HTTP envelopes, course write/read and live SSE change');
  if (realModel === 'true') await checkNativeSearch(gateway);
  await checkBrowser(gateway);
} finally {
  await server.shutdown();
}
