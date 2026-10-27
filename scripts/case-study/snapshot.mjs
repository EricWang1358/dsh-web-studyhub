/* The committed copy of the structural facts (docs/case-study/facts.snapshot.json). The freshness test compares it with what the code says now. */
import { resolve } from 'node:path';
import { REPO } from './facts.mjs';

export const SNAPSHOT = resolve(REPO, 'docs/case-study/facts.snapshot.json');
export const snapshotText = (facts) => `${JSON.stringify(facts.structural, null, 2)}\n`;
