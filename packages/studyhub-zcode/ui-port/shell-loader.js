/* global document, window */
// The StudyHub panel shell loader, inlined into dist/ui/panel.html by scripts/build-zcode.mjs.
// Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).
//
// It makes the page's ONE ext-apps connection, reads the manifest, the styles and every chunk from StudyHub's MCP
// server, registers an import map (chunk name -> blob URL) and imports the entry (ui/zcode.jsx). The app finds the
// connection on window.__studyShell and never makes a second one. ZCode caps one resource read at 8 MiB, which is why
// the app arrives in chunks.
import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';

const BASE = 'ui://studyhub/';
// eslint-disable-next-line no-undef -- defined by the build
const app = new App({ name: 'studyhub-panel', version: STUDYHUB_VERSION }, {}, { autoResize: false });

const readText = async (uri) => {
  const result = await app.readServerResource({ uri });
  const content = result?.contents?.find((entry) => entry.uri === uri) ?? result?.contents?.[0];
  if (!content || typeof content.text !== 'string') throw new Error(`面板资源不可读 / panel resource unreadable: ${uri}`);
  return content.text;
};

const fail = (error) => {
  const boot = document.getElementById('studyhub-boot');
  if (boot) boot.textContent = `StudyHub 面板没能打开 / The StudyHub panel could not open: ${error?.message || error}`;
  console.error('[studyhub] panel boot failed', error);
};

const ready = (async () => {
  await app.connect();
  // ZCode reports "fullscreen" for a docked side-pane tab; its main-area full view is host chrome (Ctrl+Shift+F). Ask
  // anyway (a host with a larger container may honour it) and log what the panel really got, for support reports.
  const context = app.getHostContext?.();
  console.info('[studyhub] host display context', JSON.stringify({ displayMode: context?.displayMode,
    availableDisplayModes: context?.availableDisplayModes, viewport: { width: window.innerWidth, height: window.innerHeight } }));
  if (typeof app.requestDisplayMode === 'function' && context?.availableDisplayModes?.includes('fullscreen')) {
    try { await app.requestDisplayMode({ mode: 'fullscreen' }); } catch (error) { console.warn('[studyhub] requestDisplayMode(fullscreen) failed:', error); }
  }

  const manifest = JSON.parse(await readText(`${BASE}manifest.json`));
  for (const sheet of manifest.css) {
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: await readText(BASE + sheet) }));
  }
  // About a hundred chunks: read them with bounded parallelism instead of one round trip at a time.
  const imports = {}, queue = [...manifest.chunks], errors = [];
  const worker = async () => {
    for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
      try { imports[chunk] = URL.createObjectURL(new Blob([await readText(BASE + chunk)], { type: 'text/javascript' })); }
      catch (failure) { errors.push(`${chunk}: ${failure?.message ?? failure}`); }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  if (errors.length) throw new Error(`分片读取失败 / chunks unreadable — ${errors.slice(0, 3).join('; ')}`);
  const map = document.createElement('script');
  map.type = 'importmap';
  map.textContent = JSON.stringify({ imports });
  document.head.appendChild(map);

  const entry = URL.createObjectURL(new Blob([await readText(BASE + manifest.entry)], { type: 'text/javascript' }));
  await import(/* @vite-ignore */ entry);
  document.getElementById('studyhub-boot')?.remove();
  return app;
})();
ready.catch(fail);

// The panel nonce the server wrote into this page (host/entry.mjs); ui/zcode.jsx sends it with every study_call.
const nonce = document.querySelector('meta[name="studyhub-panel-nonce"]')?.getAttribute('content') || '';
window.__studyShell = { app, ready, nonce };
