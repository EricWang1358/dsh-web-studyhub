import { CMAP_GROUPS, decodeBase64 } from './pdf-assets.js';

/* 看原页: the real loaders behind pdf-assets.js's factory. Every asset is its own lazily loaded chunk (assets/*.js, base64 text made
   by scripts/pdf-assets.mjs): the wasm decoder of one image format, the standard fonts, or the CMaps of one script. A chunk is fetched
   the first time pdf.js asks for something in it, and never for a page that does not need it. The literal import() calls are what let
   the bundler split them. */

const WASM = { jbig2: () => import('./assets/wasm-jbig2.js'), openjpeg: () => import('./assets/wasm-openjpeg.js') };
const CMAPS = { gb: () => import('./assets/cmaps-gb.js'), cns: () => import('./assets/cmaps-cns.js'), japan: () => import('./assets/cmaps-japan.js'), korea: () => import('./assets/cmaps-korea.js') };

export const peekAssetLoaders = {
  async wasm({ name }) { return decodeBase64((await WASM[name]()).default); },
  async font({ name }) { const { default: fonts } = await import('./assets/fonts.js'); return decodeBase64(fonts[name]); },
  async cmap({ name, group }) {
    if (!CMAP_GROUPS.includes(group)) throw new Error(`no CMap group ${group}`);
    const { default: maps } = await CMAPS[group]();
    if (!maps[name]) throw new Error(`CMap ${name} is not shipped`);
    return decodeBase64(maps[name]);
  },
};
