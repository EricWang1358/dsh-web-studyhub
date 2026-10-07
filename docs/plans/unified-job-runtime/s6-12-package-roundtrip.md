# S6-12: actual package upgrade and rollback evidence

The private-library package roundtrip completed in segments on 2026-10-07:
**2.7.1 → 3.0.0 candidate → 2.7.1 → 3.0.0 candidate**. The first native
rollback command timed out; a bounded retry and the remaining public UI checks
then passed. This is **not an uninterrupted four-round pass** and is not evidence
for the final main package.

Machine-readable results, exact artifact hashes, and local artifact locations are
in [s6-12-package-roundtrip.json](evidence/s6-12-package-roundtrip.json).

## Package and host identity

| Input | SHA-256 |
| --- | --- |
| Actual 2.7.1 package | `64c6ffc27b3da2f93360ac240a15c077632aa41b3a7d1e7f79e2e30158f774f9` |
| 3.0.0 pre-release candidate | `56f78e4c55e9a235547eb8098336ed4a61829d4179102535a880c3f291a5c80e` |

The probe checked each tarball's manifest name/version and SHA before use. The
host was DSH `0.2.0-rc.2`, using its native plugin installation service and an
isolated `studyhub-e2e` profile. Both upgrades used the product's public update
dialog and real package bytes served by a loopback release feed. Rollback used
DSH's native CLI with the original 2.7.1 tarball; no package was relabelled.

This candidate includes the publication/storage, update-pending cleanup, model,
sidebar, U1 stop fixes, and PR #366. It predates the subsequent coach UI summary
and changelog link changes. Final main installation and public reads need a
separate smoke test against that package's exact hash.

## Results and interruption

| Stage | Result |
| --- | --- |
| Install/read original 2.7.1 | Passed; current and installed UI versions both 2.7.1 |
| Public UI upgrade to candidate | Passed in 15.326 s; both versions 3.0.0 after restart |
| Candidate publication into saved workflow | Passed; original workflow membership pinned and version advanced once |
| First native CLI rollback | Failed after 600.894 s; preserved first summary/logs |
| Native CLI retry, same profile/cache, `CI=true` | Exit 0 in 2.624 s; stdout/stderr retained |
| Public reads after rollback | Passed; both versions 2.7.1 and upgrade to 3.0.0 offered |
| Public UI upgrade again | Passed in 26.987 s; both versions 3.0.0 after restart |

The timed-out CLI left an identified pnpm descendant. After confirming its exact
parent, creation time, and old-tarball command, only that owned installation
subtree was stopped. No host listener was still running. The first wrapper did
not retain CLI stdout and stderr was empty: a TTY prompt is a hypothesis, not a
proven cause. The retry both used noninteractive mode and followed a partial
install, so its success does not establish which difference resolved the wait.

The continuation reused the original private library and update cache. Before
accepting its baseline, it checked source/card and workflow hashes against the
first attempt. No fixtures were reseeded and `update.json` was not deleted. Its
original release-check timestamp remained `2026-10-07T11:46:56.734Z`; the consumed
pending marker was absent, and the actual old UI offered an upgrade again.

## What remained readable

- Original source text, deck identity, and original card content had the same
  SHA-256 in all four rounds.
- The candidate added one card through public `draft.publish.quick`; both cards
  survived rollback and re-upgrade without duplication or content changes.
- The saved workflow retained its original card membership after publication,
  with version 2 and identical content through both subsequent restarts.
- One subtitle job completed and was archived on 2.7.1; another completed and was
  archived on the candidate. Both completed archive records and both source
  artifact text hashes survived rollback and re-upgrade.
- Installed package manifests and separate Settings current/installed fields
  matched each round. The rollback and final Settings screenshots were inspected.
- Both attempts recorded zero page errors and zero browser console errors. Six
  loopback fake-model requests occurred in the first attempt; none in continuation.
  Probe ports and owned probe Node processes were stopped afterward.

## Boundaries

This proves the recorded synthetic-library package compatibility paths for the
named candidate. It does not claim recovery of native in-memory tasks after
restart, real-provider quality, every storage shape, or a bug-free release.

No product code was changed for this probe. Credentials were scrubbed, all DSH
and CLI processes used private `DSH_HOME` and temporary directories, and no owner
library was accessed. The initial browser inherited ambient temporary-directory
settings; continuation explicitly used private browser temporary directories too.
The native DSH installer, public workspace APIs, and public update UI were reused;
no alternate installer, storage format, or retry layer was added to the product.

The release owner reviews and integrates this evidence. These checks do not
replace full verification or authorize publishing a different package hash.
