import { spawnSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageRuntime } from '../../../packages/studyhub-desktop/scripts/stage-runtime.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const target = join(moduleDir, 'target', 'packaging');
const windows = process.platform === 'win32';
const type = process.argv[2] || 'app-image';
const supported = windows ? ['app-image', 'msi', 'exe'] : ['app-image', 'deb', 'rpm'];
if (!supported.includes(type)) throw new Error('Expected one of ' + supported.join(', '));
if (!process.env.JAVA_HOME) throw new Error('Set JAVA_HOME to a JDK 21 installation');
const jdk = await realpath(process.env.JAVA_HOME);
if (!/^JAVA_VERSION="21(?:\.|")/m.test(await readFile(join(jdk, 'release'), 'utf8')))
  throw new Error('jpackage requires JDK 21 for the Java 21 preview bytecode');

const javaTool = name => join(jdk, 'bin', name + (windows ? '.exe' : ''));
function run(command, args, env = process.env) {
  const child = spawnSync(command, args, { stdio: 'inherit', env, windowsHide: true });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(basename(command) + ' exited ' + child.status);
}
await mkdir(target, { recursive: true });
const output = await mkdtemp(join(target, type + '-'));
const name = 'StudyHub Spring';
const parentPom = await readFile(join(moduleDir, '../pom.xml'), 'utf8');
const reactorVersion = parentPom.match(/<artifactId>studyhub-spring<\/artifactId>\s*<version>([^<]+)<\/version>/)?.[1];
if (!reactorVersion) throw new Error('Missing reactor version');
const version = process.argv.find(arg => arg.startsWith('--app-version='))?.slice('--app-version='.length)
  ?? reactorVersion.split('-')[0];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a three-part installer version');
const packageFlags = format => ['--type', format, '--name', name, '--dest', output, '--app-version', version, '--vendor', 'StudyHub'];
const existing = process.argv.find(arg => arg.startsWith('--app-image='))?.slice('--app-image='.length);
let options;
if (existing) {
  if (type === 'app-image') throw new Error('Choose an installer format for an existing app-image');
  options = ['--app-image', await realpath(existing)];
} else {
  const input = join(output, 'input');
  const runtimeDir = join(input, 'compatibility');
  await mkdir(input);
  const apiTarget = join(moduleDir, '../studyhub-sync-api/target');
  await copyFile(join(apiTarget, 'studyhub-sync-api-' + reactorVersion + '-exec.jar'), join(input, 'studyhub.jar'));
  // runtimeDir is newly allocated under this invocation's packaging directory.
  await stageRuntime({ outdir: runtimeDir, nodePath: process.execPath });
  const node = windows ? 'node.exe' : 'node';
  if (!windows) await chmod(join(runtimeDir, node), 0o755);
  const runtime = join(output, 'jre');
  const modules = 'java.base,java.desktop,java.logging,java.management,java.naming,java.net.http,java.security.jgss,java.sql,java.xml,java.instrument,jdk.crypto.ec,jdk.unsupported,jdk.management,jdk.jfr,jdk.zipfs';
  run(javaTool('jlink'), ['--add-modules', modules, '--strip-debug', '--no-header-files', '--no-man-pages', '--compress=2', '--output', runtime]);
  const jvm = ['--enable-preview', '--enable-native-access=ALL-UNNAMED', '-Dstudyhub.desktop.enabled=true', '-Dstudyhub.ai.enabled=true',
    '-Dstudyhub.sidecar-entry=$APPDIR/compatibility/packages/studyhub-desktop/entry/sidecar.mjs',
    '-Dstudyhub.node=$APPDIR/compatibility/' + node];
  if (windows) {
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(moduleDir, 'windows/build-webview.ps1'), '-OutputDir', input]);
    jvm.push('-Dstudyhub.webview=$APPDIR/StudyHub.WebView.exe');
  }
  options = ['--input', input, '--main-jar', 'studyhub.jar', '--main-class', 'org.springframework.boot.loader.launch.JarLauncher',
    '--runtime-image', runtime, ...jvm.flatMap(flag => ['--java-options', flag])];
}
// An installed jpackage launcher can discover the first directory named
// "runtime" in the package-manager listing, including the Node library's.
// Pin the bundled JVM location relative to the native launcher.
if (!windows) {
  let appImage = existing ? await realpath(existing) : join(output, name);
  if (!existing) run(javaTool('jpackage'), [...packageFlags('app-image'), ...options]);
  const configPath = image => join(image, 'lib', 'app', name + '.cfg');
  const cfg = await readFile(configPath(appImage), 'utf8');
  const runtimeLine = 'app.runtime=$BINDIR/../lib/runtime';
  if (!cfg.split(/\r?\n/).includes(runtimeLine)) {
    if (!cfg.startsWith('[Application]\n') || /^app\.runtime=/m.test(cfg)) throw new Error('Unexpected Linux launcher configuration');
    if (existing) {
      const copy = join(output, name);
      await cp(appImage, copy, { recursive: true, verbatimSymlinks: true });
      appImage = copy;
    }
    await writeFile(configPath(appImage), cfg.replace('[Application]\n', '[Application]\n' + runtimeLine + '\n'));
  }
  options = ['--app-image', appImage];
}
if (type === 'msi' || type === 'exe') options.push('--win-per-user-install', '--win-menu', '--win-shortcut', '--win-upgrade-uuid', '5be4e226-41f7-421c-9b42-2fd52ec447de');
if (type === 'deb' || type === 'rpm') options.push('--linux-package-name', 'studyhub-spring', '--linux-shortcut');
if (type === 'deb') options.push('--resource-dir', join(moduleDir, 'linux', 'deb'));
const env = { ...process.env };
if (windows && env.WIX_BIN) env.PATH = env.WIX_BIN + delimiter + env.PATH;
if (windows || type !== 'app-image') run(javaTool('jpackage'), [...packageFlags(type), ...options], env);
console.log('Output directory: ' + output);
