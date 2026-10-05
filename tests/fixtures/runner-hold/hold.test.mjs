import test from 'node:test';
import { appendFileSync } from 'node:fs';

/* A fixture suite for tests/test-runner-lock.test.mjs: it says it is running, then holds for STUDY_FIXTURE_HOLD_MS. */
if (process.env.STUDY_FIXTURE_LOG) appendFileSync(process.env.STUDY_FIXTURE_LOG, `start ${Date.now()}\n`);
test('hold', async () => { await new Promise(resolve => setTimeout(resolve, Number(process.env.STUDY_FIXTURE_HOLD_MS || 100))); });
if (process.env.STUDY_FIXTURE_LOG) process.on('exit', () => appendFileSync(process.env.STUDY_FIXTURE_LOG, `end ${Date.now()}\n`));
