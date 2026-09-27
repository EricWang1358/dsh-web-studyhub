// Dev preview with an isolated global home, so screenshots taken from it never
// contain the operator's real notebooks, board cards or workspace paths.
// The global directory (notebooks.json, board.json) lives under DSH_HOME.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const home = resolve(process.env.SITE_DSH_HOME || 'output/preview-home');
mkdirSync(home, { recursive: true });
process.env.DSH_HOME = home;
process.env.PORT = process.env.PORT || '4179';

await import('./dev.mjs');
