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
2. CI is green on `main` (ubuntu and windows `verify`), and `npm run verify` passes locally on the commit to be released.
3. The changelog (English and 简体中文) describes what a user will notice, and says what is not fixed. Read what the release will add with `npm run changelog:preview -- <version>` (and `--lang=zh-CN`) and fix the wording in the fragments. The release commit sets the version in `package.json` and runs `npm run changelog:release -- <version> <YYYY-MM-DD>`, which writes `## <version> — <date>` with the fragments into both changelogs (in the order they were added), deletes them and seals both changelogs. An upgrade step or a known issue is a note fragment (`<slug>.note.en.md`, `<slug>.note.zh-CN.md`), or is written into that section in the same commit followed by `npm run changelog:seal`.
4. The real-environment check, on the experience channel, with the real library and a real model. Tick what applies to the changes in the release:
   - [ ] A question run, a top-up, and a draft published; the 资料 rows and the reader show the same counts.
   - [ ] An audio import (several files), a restart in the middle, the tasks still in the console, an archived task still readable.
   - [ ] A scanned book page in 看原页, and the reader's footnotes and formulas on a long book.
   - [ ] The model path the changes touch: the reasoning level on the models in use, finished calls in 实时输出.
   - [ ] The Jobs console at a narrow and a wide window, in light and dark.
5. Build and pack from a worktree detached at `origin/main` (`node scripts/build.mjs`, `npm run release:pack`), compare the asset list with the previous release (11 assets), publish with the changelog section as the notes (`npm run -s changelog:preview -- <version>` prints it), and check that the remote `SHA256SUMS` and the main package hash equal the local ones.

## After a release

- Update the desktop profile with the one-click update, restart DSH, and look at the first screen of each page the release touched.
- Close the pull requests the release included, with a comment pointing to the release.
