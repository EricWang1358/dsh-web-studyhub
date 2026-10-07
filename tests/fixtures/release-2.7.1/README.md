# Validators of release 2.7.1

`contract.js` and `store.js` are the job-contract and manifest validators exactly as release 2.7.1 shipped them (tag `v2.7.1`, 47f13281);
only the store's `atomic-json` import is re-pointed. `tests/unified-runtime-rollback-shape.test.mjs` checks that every manifest the current
runtime writes is still accepted by them, so that switching the runtime off and going back to 2.7.1 keeps every library readable.

When rollback to 2.7.1 is no longer supported (a later release becomes the rollback target), replace these files with that release's own and
say so in the release notes. Never edit them to make a failing check pass: a failure means the current code writes something the old release
cannot read.

`shape-baseline.json` records the key paths of the manifest the current runtime writes over a Job's whole life (the shapes these validators were checked against).
`tests/unified-runtime-boundaries.test.mjs` fails when the written shape and that file differ, and the failure points back here: change a persisted shape only together with
this folder. Check first that `tests/unified-runtime-rollback-shape.test.mjs` passes for the new shape, then regenerate the baseline in the same commit with
`node tests/fixtures/release-2.7.1/make-shape-baseline.mjs`.
