import test from 'node:test';
import { pickerSweep } from './helpers/picker-sweep.mjs';

// The en half of the #1084 sweep (tests/helpers/picker-sweep.mjs says what it checks); the other language is in generate-picker-sweep-browser.test.mjs.
test('#1084: over a sweep of title lengths no row moves after its first frame, the badge has one column at the end of the facts line, and no title loses width to it (en)', { timeout: 1200000 }, t => pickerSweep(t, 'en'));
