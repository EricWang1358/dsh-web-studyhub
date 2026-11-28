#!/usr/bin/env node
/* Publish a GitHub release only when everything it announces can be downloaded.

   Pushing a vX.Y.Z tag starts two workflows at once: release.yml (the plugin packages, a few minutes) and release-desktop.yml
   (the Windows installers and the Tauri updater manifest latest.json, about twenty). Both create or fill the release as a DRAFT.
   A draft is not what GitHub calls "latest", so neither the plugin's update check (api.github.com …/releases/latest) nor the
   desktop updater (…/releases/latest/download/latest.json) sees the new version while assets are still missing. Each workflow
   runs this script after its own upload; whichever finishes last finds all assets and publishes. Nothing else in the release
   pipeline may publish (tests/release-publish.test.mjs pins it).

   usage: node scripts/release-publish.mjs --tag vX.Y.Z [--repo owner/name]
   Exit 0: published now, already published (left alone), or still waiting for the other workflow (the release stays a draft).
   Exit 1: the tag is not a release tag, gh failed, or the published release did not verify. */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const PLUGIN_ARCHIVES = ['dsh-daily-flashcard', ...['runtime', 'materials', 'bank', 'study', 'generation', 'audio'].map(domain => `dsh-study-${domain}`), 'studyhub-retrieval'];

/** Every asset a release carries: 11 from release.yml (npm run release:pack) and 8 from release-desktop.yml. */
export function releaseAssetNames(version) {
  const plugin = [
    ...PLUGIN_ARCHIVES.map(name => `ericwang1358-${name}-${version}.tgz`),
    `SHA256SUMS-${version}.txt`,
    `StudyHub-${version}-Setup.html`,
    `StudyHub-${version}-Setup.zh-CN.html`,
  ];
  const desktop = [
    `StudyHub-Desktop-${version}-win-x64-setup.exe`,
    `StudyHub-Desktop-${version}-win-x64-setup.exe.sig`,
    `StudyHub-Desktop-${version}-win-x64.msi`,
    `StudyHub-Desktop-${version}-win-x64.zip`,
    'latest.json',
    `SHA256SUMS-Desktop-${version}.txt`,
    `StudyHub-Desktop-Retrieval-${version}-win-x64.zip`,
    `SHA256SUMS-Desktop-Retrieval-${version}.txt`,
  ];
  return { plugin, desktop, all: [...plugin, ...desktop] };
}

/** What to do with the release `gh release view --json isDraft,assets` answered: 'published' (leave it), 'wait' or 'publish'. */
export function publishDecision(release, version) {
  const have = new Set((Array.isArray(release?.assets) ? release.assets : []).map(asset => asset?.name));
  const missing = releaseAssetNames(version).all.filter(name => !have.has(name));
  if (release?.isDraft === false) return { action: 'published', missing };
  return { action: missing.length ? 'wait' : 'publish', missing };
}

const parseVersionTag = tag => (/^v(\d+\.\d+\.\d+)$/.exec(String(tag || '')) || [])[1] || null;

/** One run of the CLI; `gh(args)` answers gh's stdout and throws when gh fails. Answers the outcome for the log. */
export async function runPublish({ tag, repo, gh, log = console.log }) {
  const version = parseVersionTag(tag);
  if (!version) throw new Error(`Expected a vX.Y.Z release tag, got: ${tag}`);
  const scope = repo ? ['-R', repo] : [];
  const view = async () => JSON.parse(await gh(['release', 'view', tag, ...scope, '--json', 'isDraft,assets,url']));
  const decision = publishDecision(await view(), version);
  if (decision.action === 'published') {
    log(`${tag} is already published; left as it is.${decision.missing.length ? ` Missing assets: ${decision.missing.join(', ')}` : ''}`);
    return decision;
  }
  if (decision.action === 'wait') {
    log(`${tag} stays a draft until every asset is attached; still missing ${decision.missing.length}: ${decision.missing.join(', ')}`);
    return decision;
  }
  await gh(['release', 'edit', tag, ...scope, '--draft=false', '--latest']);
  const after = publishDecision(await view(), version);
  if (after.action !== 'published' || after.missing.length) {
    throw new Error(`${tag} did not verify after publishing: ${JSON.stringify(after)}`);
  }
  log(`${tag} published as latest with all ${releaseAssetNames(version).all.length} assets.`);
  return { action: 'publish', missing: [] };
}

function argValue(argv, name) {
  const at = argv.indexOf(name);
  if (at >= 0) return argv[at + 1];
  return argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

const run = promisify(execFile);
async function ghCli(args) {
  const { stdout } = await run('gh', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  runPublish({ tag: argValue(argv, '--tag'), repo: argValue(argv, '--repo') || process.env.GITHUB_REPOSITORY, gh: ghCli })
    .catch(error => { console.error(error?.stderr || error?.message || error); process.exit(1); });
}
