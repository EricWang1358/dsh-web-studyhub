/* Where StudyHub's own code is. In a release the plugin carries lib/, skills/, references/, locale/ and presets/ next to
   host/ (copied from the same commit by scripts/release-zcode.mjs); in the repository this package sits in
   packages/studyhub-zcode and uses the repository's lib/ directly. There is no vendored copy. */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const plugin = new URL('../', import.meta.url);
/** The folder that holds lib/ (the plugin itself in a release, the repository root in development). */
export const studyhubRoot = existsSync(new URL('lib/service.js', plugin)) ? plugin : new URL('../../', plugin);
export const studyhubPath = fileURLToPath(studyhubRoot);
/** The plugin's own folder (host/, hooks/, dist/ui). */
export const pluginPath = fileURLToPath(plugin);
/** Import one module of lib/. */
export const importLib = (name) => import(new URL(`lib/${name}`, studyhubRoot).href);
