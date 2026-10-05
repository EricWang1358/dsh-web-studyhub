import test from 'node:test';
import { appendFileSync } from 'node:fs';

/* A fixture suite for tests/test-runner-schedule.test.mjs: it records that it started, then takes a known time. */
if (process.env.STUDY_FIXTURE_LOG) appendFileSync(process.env.STUDY_FIXTURE_LOG, 'b\n');
test('b', async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
