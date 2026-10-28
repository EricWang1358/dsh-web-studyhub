import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { libPackages, marketplaceOf, pluginManifest, STUDYHUB_PARTS, sumsName, zipName } from '../scripts/release-zcode.mjs';

/* The ZCode package of a release (scripts/release-zcode.mjs): its own assets next to main's, the plugin's version
   stamped from StudyHub's, StudyHub's lib/ dependencies carried at the versions StudyHub declares, nothing added to
   StudyHub's own runtime dependencies. The packed zip itself is checked by npm run release:zcode:check. */
const studyhub = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const own = JSON.parse(await readFile(new URL('../packages/studyhub-zcode/package.json', import.meta.url), 'utf8'));
const pluginJson = JSON.parse(await readFile(new URL('../packages/studyhub-zcode/.zcode-plugin/plugin.json', import.meta.url), 'utf8'));

test('the ZCode assets are two extra files of the same release', () => {
  assert.equal(zipName('3.8.0'), 'StudyHub-ZCode-3.8.0.zip');
  assert.equal(sumsName('3.8.0'), 'SHA256SUMS-ZCode-3.8.0.txt');
  assert.deepEqual(STUDYHUB_PARTS, ['lib', 'skills', 'references', 'locale', 'presets', 'LICENSE']);
  assert.ok(studyhub.scripts['release:zcode'] && studyhub.scripts['release:zcode:check'] && studyhub.scripts['build:zcode']);
});

test('the plugin carries StudyHub\'s version and the packages lib/ imports, at StudyHub\'s versions', async () => {
  const manifest = await pluginManifest(studyhub.version);
  assert.equal(manifest.version, studyhub.version);
  assert.equal(manifest.devDependencies, undefined, 'production dependencies only');
  for (const name of await libPackages()) {
    if (studyhub.peerDependenciesMeta?.[name]?.optional) { assert.equal(manifest.dependencies[name], undefined, `${name} stays optional`); continue; }
    assert.ok(manifest.dependencies[name], `${name} is carried`);
    if (!own.dependencies[name]) assert.equal(manifest.dependencies[name], studyhub.dependencies[name] ?? studyhub.devDependencies[name]);
  }
  for (const name of ['@modelcontextprotocol/sdk', 'zod', '@deepseek-ai/cordis']) assert.ok(manifest.dependencies[name], name);
  assert.ok(!(await libPackages()).some((name) => /\s|[(),]/.test(name)), 'only package names are read');
});

test('the ZCode-only packages stay out of StudyHub\'s runtime dependencies, and the development copies match the plugin\'s', () => {
  for (const name of ['@modelcontextprotocol/sdk', '@modelcontextprotocol/ext-apps', 'zod']) {
    assert.equal(studyhub.dependencies[name], undefined, `${name} is not a StudyHub runtime dependency`);
    assert.equal(studyhub.devDependencies[name], own.dependencies[name] ?? own.devDependencies[name], `${name}: one version in both package.json files`);
  }
});

test('the repository copies carry no release version; the manifest starts the MCP server from the plugin root', () => {
  assert.equal(own.version, '0.0.0-repo');
  assert.equal(pluginJson.version, '0.0.0-repo');
  assert.deepEqual(pluginJson.mcpServers.studyhub, { type: 'stdio', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/host/entry.mjs'] });
  assert.equal(pluginJson.ui.surfaces[0].resourceUri, 'ui://studyhub/panel.html');
  const market = marketplaceOf('3.8.0', pluginJson.description);
  assert.deepEqual([market.name, market.plugins[0].source, market.plugins[0].version], ['studyhub-bundle', './studyhub', '3.8.0']);
});
