import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shimJsxRuntime } from '../../scripts/host-react.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
let compiled;

// Keep the preview's real RPC, React app, and styles. Substitute only the host adapter
// so tests can observe the draft delivered to a composer, as in the DSH plugin.
const chatHost = {
  name: 'test-chat-host',
  setup(builder) {
    builder.onResolve({ filter: /^\.\/host\/preview\.js$/ }, () => ({ path: 'composer', namespace: 'test-host' }));
    builder.onLoad({ filter: /^composer$/, namespace: 'test-host' }, () => ({
      contents: `window.chatDrafts = [];
        export default {
          capabilities: { edition: 'plugin', chat: true, agentTasks: false, landing: false },
          askInChat(text) { window.chatDrafts.push(text); return 'filled'; }
        };`,
    }));
  },
};

export async function buildChatPreview({ outdir }) {
  compiled ??= build({
    absWorkingDir: root, entryPoints: ['ui/dev.jsx'], entryNames: 'app', outdir: 'dist',
    bundle: true, write: false, platform: 'browser', format: 'iife', plugins: [chatHost, shimJsxRuntime],
  });
  const { outputFiles } = await compiled;
  await Promise.all(outputFiles.map(file => writeFile(join(outdir, basename(file.path)), file.contents)));
}
