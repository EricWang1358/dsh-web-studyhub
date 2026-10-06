// Manual companion: actual installed DSH Agent/jobs plus current production modules,
// with an explicitly local fake HTTP provider. No installed plugin is replaced.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function probeProviderPermits({ ctx, parent, sourceRoot, until }) {
  const source = file => import(pathToFileURL(join(sourceRoot, file)).href);
  const [{ createProviderResources }, { createJobLifecycle }, { createRuntimeWork }, { dshJobExecutor }, { GeminiTiers }, { longFetch }] = await Promise.all([
    'lib/jobs/resources.js', 'lib/jobs/lifecycle.js', 'lib/runtime/work.js', 'lib/jobs/executor.js', 'lib/gemini.js', 'lib/http.js',
  ].map(source));
  const owner = Symbol('S1-3 isolated host audit'), held = [], nativeIds = [], pending = [];
  const hub = createProviderResources({ owner, scopeId: 'audio.v1', sharedProviderQuota: true, queueTimeoutMs: 5000,
    bindings: [{ resourceRef: 'provider', quotaDomainRef: 'explicit-loopback', limit: 1, routes: ['free', 'paid'], providerObservation: 'external-request' }] });
  const resources = hub.scoped(owner, 'audio.v1'), legacyStop = new AbortController(), lease = resources.open(legacyStop.signal);
  const lifecycle = createJobLifecycle('/isolated-provider-probe', createRuntimeWork());
  let requests = 0, active = 0, peak = 0, current;
  const server = createServer((request, response) => {
    request.resume(); requests++; active++; peak = Math.max(peak, active);
    response.once('close', () => { active--; });
    const send = () => { if (!response.destroyed) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'local probe' }] } }] })); } };
    if ([1, 3].includes(requests)) held.push(send);
    else if (requests === 5) { response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0.05' }); response.end('{"error":{}}'); }
    else send();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/probe`;
  const fetch = (_url, init) => longFetch(endpoint, init);
  const legacy = new GeminiTiers({ keys: { free: 'local-fake-key' }, fetch, resources: lease.resources });
  const port = lifecycle.scoped({ owner, domain: 'audio.v1', executor: dshJobExecutor(ctx, parent), resourceScope: resources });
  lifecycle.register(ctx, 'audio.v1', { kind: 's13-http-permit', version: 1, run: async context => {
    current = context;
    const client = new GeminiTiers({ keys: { paid: 'local-fake-key' }, fetch, resources: context.resources });
    await client.complete('local-alias', 'system', 'probe', { signal: context.signal }); return { refs: [] };
  } });
  const submit = async () => { const job = await port.submit('s13-http-permit', {}); nativeIds.push(port.status(job.jobId).runtime.attempts[0].executor.handleId); return job; };
  try {
    const old = legacy.complete('local-alias', 'system', 'probe'); pending.push(old.catch(() => {}));
    await until(() => requests === 1, 'held legacy HTTP request');
    const first = await submit();
    await until(() => current, 'actual native resource execution');
    assert.equal(requests, 1); assert.equal(ctx.get('jobs').get(nativeIds[0], parent.id).status, 'running');
    held.shift()(); await old; assert.equal((await port.wait(first.jobId)).status, 'complete');
    assert.equal(requests, 2);
    const cancelled = await submit();
    await until(() => requests === 3, 'native HTTP before cancellation');
    await port.control(cancelled.jobId, 'cancel');
    assert.equal(current.signal.aborted, true);
    assert.equal((await port.wait(cancelled.jobId)).status, 'cancelled');
    await until(() => active === 0, 'loopback response cleanup');
    assert.equal(await legacy.complete('local-alias', 'system', 'after cancellation'), 'local probe');
    const limited = await legacy.json(endpoint, 'local-fake-key', {}, undefined, 1000, undefined, 'free');
    assert.equal(limited.status, 429);
    const at = Date.now(); const cooled = await submit(); assert.equal((await port.wait(cooled.jobId)).status, 'complete');
    const elapsedMs = Date.now() - at;
    assert.ok(elapsedMs >= 40, 'observed Retry-After must delay the next native request');
    assert.equal(requests, 6); assert.equal(peak, 1);
    await lease.finish(); await hub.disable(); assert.equal(hub.enabled, false);
    const files = ['lib/audio-pool.js', 'lib/jobs/resources.js', 'lib/jobs/lifecycle.js', 'lib/jobs/executor.js', 'lib/gemini.js', 'lib/http.js'];
    const fingerprints = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(sourceRoot, file))).digest('hex')])));
    return { realDshAgent: parent.id, nativeJobs: nativeIds.length, localFakeHttpRequests: requests, peakClientRequests: peak,
      observedCooldownMs: elapsedMs, cancelledNativeJob: true, drainedBeforeBaseline: true, sourceRoot, fingerprints,
      limits: 'New modules loaded from the task worktree; installed plugin/config not replaced. Local HTTP cleanup is observed, not remote model cancellation or quality.' };
  } finally {
    legacyStop.abort(); for (const release of held) release(); server.closeAllConnections();
    await lifecycle.dispose(); await Promise.allSettled(pending); await lease.finish(); await hub.dispose();
    for (const id of nativeIds) { await ctx.get('jobs').wait(id, 10000, parent.id); ctx.get('jobs').remove(id, parent.id); }
    await new Promise(resolve => server.close(resolve));
  }
}
