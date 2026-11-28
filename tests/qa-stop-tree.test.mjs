import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootDsh, stopTree } from "../scripts/qa/dsh-e2e.mjs";
import { until } from "./helpers/wait.mjs";

/* stopTree ends the DSH host the QA scripts boot. On Windows it asks taskkill, which needs WMI; when WMI errors (HRESULT 0x80041032) taskkill
   answers "ERROR: Unspecified error", the host survived, the script never exited (the host's piped stdio kept Node's event loop alive) and the
   restart on the same port hit EADDRINUSE. These tests drive real child processes with an injected failing taskkill and an injected platform. */

const NODE = process.execPath;
const failingTaskkill = async () => ({ status: 1, output: "ERROR: Unspecified error" });
const hungTaskkill = () => new Promise(() => {});
const exited = (child) => child.exitCode !== null || child.signalCode !== null;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const killPid = (pid) => { if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } };

/** A Node child with piped stdio that runs until it is ended, resolved once it says it is ready (handlers installed). */
async function startChild(t, code = "") {
  const child = spawn(NODE, ["-e", `${code};process.stdout.write("ready\\n");setInterval(()=>{},1000)`], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  t.after(() => { killPid(child.pid); child.stdout?.destroy(); child.stderr?.destroy(); });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  await until(() => out.includes("ready") || exited(child), "the child to start", { timeoutMs: 60_000 });
  assert.ok(!exited(child), "the child is running");
  return child;
}

for (const platform of ["win32", "linux"]) {
  test(`stopTree (${platform} path) resolves only once the child has really exited`, async (t) => {
    const child = await startChild(t);
    const lines = [];
    const result = await stopTree(child, { platform, taskkill: failingTaskkill, log: (line) => lines.push(line) });
    assert.ok(exited(child), "the child has exited when stopTree resolves");
    assert.equal(result.stopped, true);
    assert.equal(result.pid, child.pid);
    if (platform === "win32") {
      assert.equal(result.fallback, true, "a failing taskkill falls back to child.kill()");
      assert.equal(lines.length, 1, `one line about the fallback: ${JSON.stringify(lines)}`);
      assert.match(lines[0], new RegExp(`PID ${child.pid}\\b`));
      assert.match(lines[0], /descendants may/);
      assert.match(lines[0], /Unspecified error/, "the line says what taskkill answered");
    } else {
      assert.equal(result.fallback, false);
      assert.deepEqual(lines, []);
    }
    assert.ok(child.stdout.destroyed && child.stderr.destroyed, "the parent's ends of the child's pipes are released");
  });
}

test("stopTree falls back when taskkill hangs, within its time limit", async (t) => {
  const child = await startChild(t);
  const lines = [];
  const started = Date.now();
  const result = await stopTree(child, { platform: "win32", taskkill: hungTaskkill, taskkillTimeoutMs: 300, log: (line) => lines.push(line) });
  assert.ok(exited(child));
  assert.equal(result.stopped, true);
  assert.equal(result.fallback, true);
  assert.match(lines.join("\n"), /no answer within 300 ms/);
  assert.ok(Date.now() - started < 60_000, "bounded");
});

test("taskkill that ends the host but answers non-zero (a descendant could not be ended) is no fallback", async (t) => {
  // taskkill /T /F can kill the host and still exit 128 for a descendant; the host's exit has not been handled yet when it answers.
  const child = await startChild(t);
  const lines = [];
  const killsThenFails = async () => { child.kill(); return { status: 128, output: `ERROR: The process with PID 1 (child process of PID ${child.pid}) could not be terminated.` }; };
  const result = await stopTree(child, { platform: "win32", taskkill: killsThenFails, log: (line) => lines.push(line) });
  assert.ok(exited(child));
  assert.equal(result.stopped, true);
  assert.equal(result.fallback, false, "taskkill did end the host");
  assert.deepEqual(lines, [], "no fallback line for a host taskkill ended");
});

test("bootDsh stops the host it started when the host never prints its URL", async (t) => {
  // Before, the rejected boot never handed the child back: nobody stopped it and its piped stdio kept the script alive.
  const dir = await mkdtemp(join(tmpdir(), "boot-dsh-"));
  const pidFile = join(dir, "pid");
  let pid = 0;
  t.after(async () => { killPid(pid); await rm(dir, { recursive: true, force: true }).catch(() => {}); });
  const bin = join(dir, "fake-dsh.mjs");
  await writeFile(bin, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write("starting, but never ready");
setInterval(() => {}, 1000);
`);
  // A loaded machine may not even start the fake within the time limit; then the case is not exercised, so give it longer and try again.
  for (const readyTimeoutMs of [1500, 10_000, 40_000]) {
    await assert.rejects(bootDsh(bin, { env: process.env, cwd: dir, patch: join(dir, "none.yml"), port: 1, readyTimeoutMs }), /did not print its URL/);
    pid = Number(await readFile(pidFile, "utf8").catch(() => 0));
    if (pid) break;
  }
  assert.ok(pid > 0, "the fake host started");
  assert.ok(!alive(pid), `the host ${pid} was stopped when the boot failed`);
});

test("stopTree escalates when the child ignores SIGTERM (POSIX path)", async (t) => {
  // On Windows every signal is TerminateProcess, so this exercises the escalation only on POSIX; it must stop the child either way.
  const child = await startChild(t, 'process.on("SIGTERM",()=>{})');
  const lines = [];
  const result = await stopTree(child, { platform: "linux", exitWaitMs: 5000, log: (line) => lines.push(line) });
  assert.ok(exited(child));
  assert.equal(result.stopped, true);
  if (process.platform !== "win32") assert.match(lines.join("\n"), new RegExp(`PID ${child.pid} did not stop on SIGTERM.*sent SIGKILL`));
});

test("stopTree with this machine's own way (real taskkill on Windows, SIGTERM elsewhere) stops a real child", async (t) => {
  const child = await startChild(t);
  const lines = [];
  const result = await stopTree(child, { log: (line) => lines.push(line) });
  assert.ok(exited(child), lines.join("\n"));
  assert.equal(result.stopped, true);
  // A WMI error on this machine may make taskkill fail: then the fallback line is the only one, and the child is still gone.
  assert.ok(lines.every((line) => /taskkill could not stop/.test(line)), lines.join("\n"));
});

test("stopTree on a child that has already exited, or none, resolves at once and stopped", async (t) => {
  assert.deepEqual(await stopTree(undefined), { pid: null, stopped: true, fallback: false });
  const child = spawn(NODE, ["-e", ""], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  t.after(() => killPid(child.pid));
  await new Promise((done) => child.once("exit", done));
  const result = await stopTree(child, { taskkill: () => assert.fail("no kill for an exited child"), log: () => assert.fail("nothing to say") });
  assert.equal(result.stopped, true);
});

test("a child that cannot be ended: stopTree resolves in bounded time, says it is still running and releases the pipes", async (t) => {
  const child = await startChild(t);
  child.kill = () => true; // a host nothing here can end: the signal is "sent" (child.killed would say so) but nothing happens
  const lines = [];
  const started = Date.now();
  const result = await stopTree(child, { platform: "win32", taskkill: failingTaskkill, exitWaitMs: 500, log: (line) => lines.push(line) });
  assert.ok(Date.now() - started < 60_000, "bounded");
  assert.equal(result.stopped, false);
  assert.ok(alive(child.pid), "the process is really still there");
  assert.match(lines.at(-1), new RegExp(`PID ${child.pid} is still running`));
  assert.ok(child.stdout.destroyed && child.stderr.destroyed, "the pipes are released so the script can still exit and report it");
});

test("a script that uses stopTree exits even when a grandchild keeps the host's stdio pipes open", async (t) => {
  // runner → child (piped stdio) → middle (inherits it, exits) → grandchild (inherits it, keeps running, orphaned: outside the child's tree)
  // (detached: on Windows a non-detached grandchild sits in the middle process job object and dies with it)
  const dir = await mkdtemp(join(tmpdir(), "stop-tree-"));
  let grandchild = 0, middleHost = 0, runner;
  t.after(async () => {
    killPid(grandchild);
    killPid(middleHost);
    if (runner && !exited(runner)) killPid(runner.pid);
    runner?.stdout?.destroy();
    runner?.stderr?.destroy();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  const grandchildCode = "setInterval(()=>{},1000)";
  const middleCode = `const g=require("child_process").spawn(process.execPath,["-e",${JSON.stringify(grandchildCode)}],{stdio:"inherit",windowsHide:true,detached:true});process.stdout.write("grandchild "+g.pid+"\\n");g.unref();`;
  const childCode = `const m=require("child_process").spawn(process.execPath,["-e",${JSON.stringify(middleCode)}],{stdio:"inherit",windowsHide:true});m.on("exit",()=>process.stdout.write("ready\\n"));setInterval(()=>{},1000);`;
  const runnerPath = join(dir, "runner.mjs");
  await writeFile(runnerPath, `import { spawn } from "node:child_process";
import { stopTree } from ${JSON.stringify(new URL("../scripts/qa/dsh-e2e.mjs", import.meta.url).href)};
const child = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
process.stdout.write("CHILD " + child.pid + "\\n");
let out = "";
await new Promise((done) => child.stdout.on("data", (chunk) => {
  out += chunk;
  const match = /grandchild (\\d+)/.exec(out);
  if (match && out.includes("ready")) { process.stdout.write("GRANDCHILD " + match[1] + "\\n"); done(); }
}));
const result = await stopTree(child, { platform: "win32", taskkill: async () => ({ status: 1, output: "ERROR: Unspecified error" }), log: (line) => process.stdout.write("LOG " + line + "\\n") });
process.stdout.write("RESULT " + JSON.stringify(result ?? null) + "\\n");
`);
  runner = spawn(NODE, [runnerPath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "", err = "";
  let runnerClosed = false;
  runner.stdout.on("data", (chunk) => {
    out += chunk;
    const match = /GRANDCHILD (\d+)/.exec(out); if (match) grandchild = Number(match[1]);
    const host = /^CHILD (\d+)/m.exec(out); if (host) middleHost = Number(host[1]);
  });
  runner.stderr.on("data", (chunk) => { err += chunk; });
  runner.once("close", () => { runnerClosed = true; });
  const ended = await until(() => exited(runner) || null, "the runner to exit", { timeoutMs: 60_000 }).catch(() => false);
  assert.ok(grandchild > 0, `the runner saw the grandchild: ${out} ${err}`);
  assert.ok(ended, `the runner exited although the grandchild ${grandchild} still holds the pipes:\n${out}\n${err}`);
  assert.equal(runner.exitCode, 0, err);
  assert.ok(alive(grandchild), "the grandchild really survived, so this is the hang case");
  // 'exit' can come before the last of the runner's output: wait for its RESULT line (or its pipes to close) before reading it.
  await until(() => /RESULT .*\n/.test(out) || runnerClosed, "the runner's RESULT line", { timeoutMs: 60_000 });
  const line = /RESULT (.*)/.exec(out);
  assert.ok(line, `the runner printed its RESULT:\n${out}\n${err}`);
  const result = JSON.parse(line[1]);
  assert.equal(result.stopped, true);
  assert.equal(result.fallback, true);
  assert.match(out, /LOG .*descendants may/);
});
