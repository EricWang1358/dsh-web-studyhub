// Run after mvn package: node src/test/resources/packaged-sync-smoke.mjs <exec.jar> [relay.jar]
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME,'bin',process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
const jar = await realpath(process.argv[2]), relayJar = process.argv[3] ? await realpath(process.argv[3]) : jar;
const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(parent,'studyhub-packaged-sync-')));
const token = randomBytes(32).toString('base64url');
const clientEnv = { ...process.env, STUDYHUB_SYNC_TOKEN:token, STUDYHUB_SYNC_KEY:randomBytes(32).toString('base64'),
  STUDYHUB_SYNC_VAULT:randomUUID() };
const server = spawn(java,['--enable-preview','-jar',relayJar,'--studyhub.mode=sync','--server.port=0'],{
  env:{...process.env,STUDYHUB_SYNC_TOKEN:token,STUDYHUB_SYNC_DATA_DIR:join(root,'relay')},
  windowsHide:true, stdio:['ignore','pipe','pipe'],
});
const exit = once(server,'exit');
const peer = fileURLToPath(new URL('node-backup-peer.mjs',import.meta.url));
async function run(device,...args) {
  const {stdout} = await exec(java,['--enable-preview','-jar',jar,'--studyhub.mode=sync-client',...args],{
    env:{...clientEnv,STUDYHUB_SYNC_DEVICE:device,STUDYHUB_SYNC_DB:join(root,device+'.sqlite')},
    timeout:45000,windowsHide:true,maxBuffer:2*1024*1024,
  });
  return stdout.split(/\r?\n/);
}
let output = '';
server.stdout.on('data',b => {output = (output+b).slice(-32000);});
server.stderr.on('data',b => {output = (output+b).slice(-32000);});
try {
  const expires = Date.now()+60000;
  while (!/Tomcat started on port (\d+)/.test(output)) {
    if (Date.now()>expires || server.exitCode!==null) throw new Error('Relay failed to start: '+output);
    await new Promise(done=>setTimeout(done,100));
  }
  clientEnv.STUDYHUB_SYNC_URL = 'http://127.0.0.1:'+output.match(/Tomcat started on port (\d+)/)[1];
  assert.equal((await fetch(clientEnv.STUDYHUB_SYNC_URL+'/actuator/health')).status,200);
  const id = randomUUID();
  await run('west','attempt','library','course','card','5',id,'2026-01-01T12:00:00Z','UTC');
  await run('west','sync');
  await run('east','sync');
  const view = JSON.parse((await run('east','show','library','course','card')).find(line=>line.startsWith('{"deleted"')));
  assert.deepEqual(view.attempts,[id]);
  await exec(process.execPath,[peer,'export',root]);
  const backup = (await run('west','backup-put',join(root,'export.json'))).find(line=>/^[0-9a-f-]{36}$/.test(line));
  assert.ok(backup);
  await run('east','backup-get',backup,join(root,'restored.json'));
  await exec(process.execPath,[peer,'restore',root]);
  console.log('Packaged relay, two client processes, native offline review and exact Node Store restore passed.');
} finally {
  server.kill();
  await exit;
  if (dirname(root) === parent && root.startsWith(join(parent,'studyhub-packaged-sync-'))) await rm(resolve(root),{recursive:true,force:true});
}
