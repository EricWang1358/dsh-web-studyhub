/* Windows spends much of a worker's startup walking package scopes for the same explicit relative imports.
   All regular .js siblings have the same nearest package.json. Learn each directory's format from Node itself.
   The original source and URL are preserved for Node's ESM loader, debugging and coverage. */
import * as nodeModule from 'node:module';
import { readTestSources } from './test-source-cache.mjs';

const library = new URL('../../lib/', import.meta.url).href;

export function cacheLocalImports(sourceFor) {
  const resolutions = new Map();
  const esmDirectories = new Set();
  return (specifier, context, nextResolve) => {
    if (!(specifier.startsWith('./') || specifier.startsWith('../')) || !specifier.endsWith('.js') || /[?#%\\]/.test(specifier)
        || !context.parentURL?.startsWith('file:') || !context.conditions?.includes('import')
        || Object.keys(context.importAttributes || {}).length) {
      return nextResolve(specifier, context);
    }
    const url = new URL(specifier, context.parentURL).href;
    if (!url.startsWith(library)) return nextResolve(specifier, context);
    const known = resolutions.get(url);
    if (known) return known;

    const directory = url.slice(0, url.lastIndexOf('/') + 1);
    // Only a verified regular file in the canonical tree captured by the parent can take this shortcut.
    if (esmDirectories.has(directory) && sourceFor?.(url) !== undefined) {
      const canonical = { url, format: 'module', shortCircuit: true };
      resolutions.set(url, canonical);
      return canonical;
    }
    const resolved = nextResolve(specifier, context);
    if (resolved.url === url && resolved.format === 'module') {
      esmDirectories.add(directory);
      resolutions.set(url, { ...resolved, shortCircuit: true });
    }
    return resolved;
  };
}

const customLoader = /(?:^|\s)(?:--(?:experimental-)?loader|--experimental-test-module-mocks)(?:=|\s|$)/;
const customPreload = /(?:^|\s)(?:--import|--require|-r)(?:=|\s|$)/;
if (process.platform === 'win32' && process.env.STUDY_TEST_SOURCE_CACHE && typeof nodeModule.registerHooks === 'function'
    && process.env.STUDY_BUILD_CACHE !== '0' && !customPreload.test(process.env.NODE_OPTIONS || '')
    && !customLoader.test([process.env.NODE_OPTIONS, ...process.execArgv].join(' '))) {
  const sourceFor = readTestSources(process.env.STUDY_TEST_SOURCE_CACHE);
  nodeModule.registerHooks({
    resolve: cacheLocalImports(sourceFor),
    load(url, context, nextLoad) {
      if (context.format === 'module' && url.startsWith(library) && !Object.keys(context.importAttributes || {}).length) {
        const source = sourceFor(url);
        if (source !== undefined) return { source, format: 'module', shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
