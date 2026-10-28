/* The placeholder scripts/build-zcode.mjs writes into panel.html, which host/entry.mjs replaces with its process's panel
   nonce each time it serves that resource, and the shell loader reads back from the page. */
export const NONCE_PLACEHOLDER = '__STUDYHUB_PANEL_NONCE__';
export const NONCE_META = 'studyhub-panel-nonce';
