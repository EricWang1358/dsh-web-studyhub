/* Test-only adapter over the baseline QA driver. No tracked source is changed.
 * Requires a private profile already provisioned by scripts/qa/dsh-e2e.mjs.
 * Skips the obsolete chat/Study selectors and waits for the companion report.
 */
import { readFile, access, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ownDirectory = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const take = name => {
  const at = argv.indexOf(name);
  if (at < 0 || !argv[at + 1]) throw new Error(`${name} is required`);
  return resolve(argv.splice(at, 2)[1]);
};
const repoRoot = take('--repo');
const dshBin = take('--dsh-bin');
const out = take('--out');
const variantAt = argv.indexOf('--variant');
const variant = variantAt < 0 ? 'bare' : argv.splice(variantAt, 2)[1];
if (!['bare', 'official-jobs-preset'].includes(variant)) throw new Error('--variant must be bare or official-jobs-preset');
const bindingAt = argv.indexOf('--studyhub-binding');
const auditStudyHub = bindingAt >= 0;
if (auditStudyHub) argv.splice(bindingAt, 1);
if (auditStudyHub && variant !== 'official-jobs-preset') throw new Error('--studyhub-binding requires the explicit official-jobs-preset variant');
const runtimeAt = argv.indexOf('--runtime-lifecycle');
const auditRuntime = runtimeAt >= 0;
if (auditRuntime) argv.splice(runtimeAt, 1);
if (auditRuntime && !auditStudyHub) throw new Error('--runtime-lifecycle requires --studyhub-binding');
const resourceAt = argv.indexOf('--resource-scope');
const auditResources = resourceAt >= 0;
if (auditResources) argv.splice(resourceAt, 1);
if (auditResources && variant !== 'official-jobs-preset') throw new Error('--resource-scope requires official-jobs-preset');
const permitsAt = argv.indexOf('--provider-permits');
const auditPermits = permitsAt >= 0;
if (auditPermits) argv.splice(permitsAt, 1);
if (auditPermits && variant !== 'official-jobs-preset') throw new Error('--provider-permits requires official-jobs-preset');
const gatewayAt = argv.indexOf('--model-gateway');
const auditGateway = gatewayAt >= 0;
if (auditGateway) argv.splice(gatewayAt, 1);
if (auditGateway && variant !== 'official-jobs-preset') throw new Error('--model-gateway requires official-jobs-preset');
const inspectionAt = argv.indexOf('--executor-inspection');
const auditInspection = inspectionAt >= 0;
if (auditInspection) argv.splice(inspectionAt, 1);
if (auditInspection && variant !== 'official-jobs-preset') throw new Error('--executor-inspection requires official-jobs-preset');
const qaRoot = join(repoRoot, 'output/qa');
const hostRoot = resolve(dirname(dshBin), '..');
const sdkRoot = dirname(hostRoot);
// Resolve existing ancestors too: a new report directory may sit below a junction.
const canonical = async target => {
  let candidate = target;
  const suffix = [];
  for (;;) {
    try { return resolve(await realpath(candidate), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      suffix.unshift(basename(candidate));
      candidate = parent;
    }
  }
};
const inside = (parent, child) => {
  const tail = relative(parent, child);
  return !!tail && tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
};
const [qaCanonical, outCanonical, ...protectedRoots] = await Promise.all([
  qaRoot, out, ...['dsh-home', 'dsh-documents', 'host-probe-tmp', 'dsh-cli', 'dsh-pack'].map(name => join(qaRoot, name)), sdkRoot,
].map(canonical));
if (!inside(qaCanonical, outCanonical)) throw new Error('--out must be strictly inside this worktree output/qa');
if (protectedRoots.some(root => relative(root, outCanonical) === '' || inside(root, outCanonical) || inside(outCanonical, root))) {
  throw new Error('--out must not overlap the private profile, workspace, temporary files, packages, or supplied DSH SDK');
}
const manifest = JSON.parse(await readFile(join(hostRoot, 'package.json'), 'utf8'));
if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== '0.2.0-rc.2') throw new Error('--dsh-bin must be the isolated rc.2 lib/bin.js');
await access(join(qaRoot, 'dsh-home/profiles/studyhub-e2e'));
const { scrubProcessEnv } = await import(pathToFileURL(join(repoRoot, 'scripts/qa/env.mjs')).href);
scrubProcessEnv();

const originalPath = join(repoRoot, 'scripts/qa/dsh-e2e.mjs');
let source = await readFile(originalPath, 'utf8');
const sha256 = createHash('sha256').update(source).digest('hex');
// Same inspected driver with Windows CRLF or the repository's Linux LF checkout.
// Keep exact byte hashes: a source change must still stop this manual adapter.
const expected = new Set(['a2b148c28b53cccd8fe67b2668527d09b1908f483286f910ff6693de5ad66246',
  'eb5b1597686203b6ee28c2ad9debd36a19818dc29aa465c8ecd1f6cc087c096c',
  // main #261: inspected UI-only additions inside the deliberately skipped UI segment.
  '2ef268acab93c279580bc0863f28346ce89c2df09748b05926ae95a44a0aa32d', 'a024d46f50911c9e064d3c7d697b51a2fc303b93901de3326dc37ea53d9cff8c']);
if (!expected.has(sha256)) throw new Error('Baseline QA source changed; inspect before adapting it');
const once = (needle, replacement) => {
  if (source.split(needle).length !== 2) throw new Error(`QA adapter anchor not unique: ${needle.slice(0, 100)}`);
  source = source.replace(needle, replacement);
};
const range = (from, to, replacement) => {
  const begin = source.indexOf(from), end = source.indexOf(to, begin);
  if (begin < 0 || end < 0) throw new Error('QA adapter range anchor missing');
  source = source.slice(0, begin) + replacement + source.slice(end);
};
const url = path => JSON.stringify(pathToFileURL(path).href);
once('const repoRoot = fileURLToPath(new URL("../../", import.meta.url));', `const repoRoot = ${JSON.stringify(repoRoot)};`);
once('import YAML from "yaml";', `import YAML from ${url(createRequire(join(repoRoot, 'package.json')).resolve('yaml'))};`);
for (const relativePath of ['./env.mjs', './browser.mjs', './fake-openai.mjs']) {
  once(`from "${relativePath}"`, `from ${url(resolve(repoRoot, 'scripts/qa', relativePath))}`);
}
// Absolute import URLs ensure no project/global Cordis copy is mixed into the host.
const config = { qaRoot, workspace: join(qaRoot, 'dsh-documents/deepseek-harness/default-workspace'),
  reportPath: join(out, 'host-capabilities.json'), sdkRoot,
  waitModule: join(repoRoot, 'tests/helpers/wait.mjs'), provider: 'studyhub-qa-fake', model: 'fake-tutor', variant, auditStudyHub, auditRuntime, auditResources,
  auditPermits, auditGateway, auditInspection, sourceRoot: resolve(ownDirectory, '../../..') };
const companionRows = [{ id: 'studyhub-s10-host-probe', name: pathToFileURL(join(ownDirectory, 'host-probe.mjs')).href, config }];
if (variant === 'official-jobs-preset') companionRows.unshift({
  id: 's10-jobs-only-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: 's10-jobs-only', order: 99,
    plugins: [{ id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs',
      config: { completionDelivery: 'quiet', waitTimeoutMs: 1000, maxWaitTimeoutMs: 10_000 } }] },
});
once('    { id: "workspace-controller", config: { documentsDirectory } },',
  `    { id: "workspace-controller", config: { documentsDirectory } },\n    { insert: ${JSON.stringify(companionRows)} },`);
once('  const baseEnv = { ...scrubSecrets(process.env), DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1", SSH_TTY: "audit" };',
  '  const privateTemp = join(qaRoot, "host-probe-tmp");\n  await mkdir(privateTemp, { recursive: true });\n  const baseEnv = { ...scrubSecrets(process.env), TEMP: privateTemp, TMP: privateTemp, DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1", DSH_TOOLS_MODE: "native", SSH_TTY: "audit" };');
// This bounded run consumes the already-installed local profile. No build,
// package install, profile reset, or plugin-manager mutation is performed.
range('    const tgz = await step("pack-plugin",', '    model = await createFakeOpenAI',
  '    await step("existing-private-profile", async () => {\n      if (!await exists(join(home, "profiles", DSH_PROFILE))) throw new Error("Create the isolated baseline QA profile first");\n      await mkdir(workspace, { recursive: true });\n    });\n');
range('    await step("first-message",', '    summary.modelRequests = model.log.length;',
  `    await step("actual-host-capability-report", async () => {\n      const { until } = await import(${url(config.waitModule)});\n      const report = await until(async () => {\n        try { const value = JSON.parse(await readFile(${JSON.stringify(config.reportPath)}, "utf8")); return value.done ? value : false; }\n        catch (error) { if (["ENOENT", "SyntaxError"].includes(error.code || error.name)) return false; throw error; }\n      }, "the actual host capability report", { timeoutMs: 80_000, intervalMs: 50 });\n      summary.hostProbe = report;\n      summary.probeSource = { qaBaselineSha256: ${JSON.stringify(sha256)}, adaptation: "companion plugin; already provisioned profile; skip obsolete first-message/open-study selectors" };\n      if (!report.ok) throw new Error("S1-0 host probe failed: " + (report.error?.message || report.steps.find(item => item.status === "failed")?.error?.message || "see host-capabilities.json"));\n    });\n`);
// Importing a data module does not write a generated driver into the worktree.
const mainGuard = source.indexOf('if (process.argv[1] && resolve(process.argv[1])');
if (mainGuard < 0) throw new Error('QA main guard anchor missing');
source = source.slice(0, mainGuard);
const adapted = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const options = adapted.parseDshArgs([...argv, '--dsh-bin', dshBin, '--out', out, '--reuse-home']);
const summary = await adapted.runDshE2e(options);
for (const item of summary.steps) console.log(`${item.status === 'ok' ? 'ok  ' : 'FAIL'} ${item.name}${item.error ? ` — ${item.error.split('\n')[0]}` : ''}`);
console.log(`S1-0 actual host probe ${summary.ok ? 'passed' : 'FAILED'}: ${join(out, 'host-capabilities.json')}`);
process.exitCode = summary.ok ? 0 : 1;
