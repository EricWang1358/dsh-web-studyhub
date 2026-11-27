// Use the same standalone React entry and bundler as npm run build. Its default
// command also writes DSH plugin chunks into lib/, outside the Track S boundary.
import { buildPreview } from '../../../scripts/build.mjs';
import { resolve } from 'node:path';

await buildPreview({ outdir: resolve(process.argv[2]), production: true });
