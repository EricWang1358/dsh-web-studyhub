# Release policy and the two channels

English · [简体中文](release-policy.zh-CN.md)

StudyHub is used from two DSH profiles on the maintainer's machine. They deliberately follow different versions.

| Channel | DSH profile | What it runs | Moves when |
| --- | --- | --- | --- |
| **Stable** | desktop | the released `.tgz` (one-click update in StudyHub **Settings › About & updates**) | a release is published |
| **Experience** | web | a checkout that follows `main` (`link:` to a worktree) | `main` moves and `node scripts/sync-main.mjs` runs |

A change is tested on the experience channel as soon as it is merged. It reaches the stable channel only through a release.

## Set up the experience channel (once)

1. Make a worktree that only follows `main`. Do not use the checkout you develop in; `sync-main` refuses a checkout with uncommitted work.

   ```sh
   git worktree add --detach <dir> origin/main
   cd <dir>
   npm ci --legacy-peer-deps
   node scripts/build.mjs
   ```

2. In the web profile (`~/.dsh/profiles/web/package.json`), point the plugin at that worktree: `"@ericwang1358/dsh-daily-flashcard": "link:<dir>"`, and re-point the link in the profile's `node_modules/@ericwang1358/`. Restart DSH web.
3. Whenever `main` moved: run `npm run sync:main` inside `<dir>`, then reload the plugin or restart DSH web. It fetches, moves to the newest `main`, reinstalls dependencies only when they changed, builds, and prints the version and commit now in place.

`lib/client.js` and `dist/` are build output. A checkout that was switched without building runs stale client code.

## When to release

Releases are for people who use the stable channel, not a checkpoint after every pull request.

- **Batch.** Merge fixes and features to `main` as they are ready. Cut a release when there is a set worth installing: at most one minor release a week.
- **Hotfix.** Only for a defect that blocks use or loses data in the released version, with a fix that is small and tested. A hotfix is a patch release of the previous one.
- **Not a reason to release.** A pull request merged, a CI run finished, a change wanted for a demo.

## The changelog between releases

A pull request does not edit `CHANGELOG.md` or `CHANGELOG.zh-CN.md`. It adds one bullet per language under `changes/unreleased/` (`<slug>.en.md` and `<slug>.zh-CN.md`; [changes/README.md](../changes/README.md) says how to write one), so that pull requests never edit the same lines and merging one does not make the others conflict. `npm run changelog:check` checks the fragments; `tests/changelog-fragments.test.mjs` fails when a fragment is malformed, when the top section of a changelog is not the released version of `package.json`, or when a changelog no longer matches the seal the release wrote (`changes/released.json`): it was edited outside a release.

## Before a release

All of these, in this order. A box that cannot be ticked is written into the release notes as not verified.

1. `main` has run on the experience channel for at least a day of real use, and the problems found there are fixed or listed.
2. CI is green on `main` (ubuntu and windows sharded `verify`), and `npm run verify:fast` (`lint`, `typecheck`, `test:smart` over core guardrails + diff-affected suites, and `build`) passes locally on the commit to be released; run the full `npm run test:fast` or `npm test` locally only when investigating cross-cutting regressions or runner/storage changes.
3. The changelog (English and Simplified Chinese) describes what a user will notice, and says what is not fixed. Read what the release will add with `npm run changelog:preview -- <version>` (and `--lang=zh-CN`) and fix the wording in the fragments. The release commit sets the version in `package.json` and runs `npm run changelog:release -- <version> <YYYY-MM-DD>`, which writes `## <version> — <date>` with the fragments into both changelogs (in the order they were added), deletes them and seals both changelogs. An upgrade step or a known issue is a note fragment (`<slug>.note.en.md`, `<slug>.note.zh-CN.md`), or is written into that section in the same commit followed by `npm run changelog:seal`.
4. The real-environment check, on the experience channel, with the real library and a real model. Tick what applies to the changes in the release:
   - [ ] A question run, a top-up, and a draft published; the **Sources** rows and the reader show the same counts.
   - [ ] An audio import (several files), a restart in the middle, the tasks still in the console, an archived task still readable.
   - [ ] A scanned book page in **Original page**, and the reader's footnotes and formulas on a long book.
   - [ ] The model path the changes touch: the reasoning level on the models in use, finished calls in **Live output**.
   - [ ] The Jobs console at a narrow and a wide window, in light and dark.
5. Build and pack from a worktree detached at `origin/main` (`node scripts/build.mjs`, `npm run release:pack`), compare the asset list with the previous release (11 plugin assets; 19 once the desktop workflow has attached its 8), publish with the changelog section as the notes (`npm run -s changelog:preview -- <version>` prints it), and check that the remote `SHA256SUMS` and the main package hash equal the local ones.
   Pushing the `v<version>` tag starts `release.yml` (the 11 plugin assets, a few minutes) and `release-desktop.yml` (8 desktop assets: `Setup.exe`, its `.sig`, `.msi`, `.zip`, the Desktop Retrieval `.zip`, both `SHA256SUMS-Desktop-*` files and the updater manifest `latest.json`; about 20 minutes). Each workflow creates or fills the release as a **draft** and then runs `node scripts/release-publish.mjs --tag v<version>`, which publishes it and marks it latest only when all 19 assets are attached; whichever workflow finishes last publishes. A draft is not GitHub's "latest" release, so no StudyHub announces the version before its desktop installers and `latest.json` exist (5.4.2 offered the desktop update about 20 minutes too early, and its one-click update failed on the missing `latest.json`). If a workflow fails, the release stays a draft: re-run it (`release-desktop.yml` by `workflow_dispatch` with the tag and `publish_release` on), or, once the missing assets are uploaded by hand, run `node scripts/release-publish.mjs --tag v<version>` yourself; it refuses while an asset is missing. Publish a draft without the desktop assets (`gh release edit v<version> --draft=false --latest`) only when that is intended, and say so in the release notes: the desktop one-click update then fails until `latest.json` is attached.
6. The three names, and the channel that lags: check `npm view @ericwang1358/dsh-daily-flashcard version`. This workflow publishes the GitHub release only, so npm's `latest` tag stays on the previous version until npm is updated by hand; a lagging npm is therefore normal and not a failed release, and the install guide and the READMEs say the release page is the newest. If npm is updated in the same step, say so in the release notes.

## After a release

- Update the desktop profile with the one-click update, restart DSH, and look at the first screen of each page the release touched.
- Close the pull requests the release included, with a comment pointing to the release.
