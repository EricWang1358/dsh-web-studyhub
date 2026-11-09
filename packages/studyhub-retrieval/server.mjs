import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBatchRAGServer } from './batch-server.js';

try {
  const entry = process.argv[2] || createRequire(import.meta.url).resolve('mcp-local-rag');
  const require = createRequire(entry), dist = dirname(entry);
  const [{ RAGServer }, { resolveServerConfig }, { parseIngestDataInput }, sdk] = await Promise.all([
    import(pathToFileURL(join(dist, 'server/index.js')).href),
    import(pathToFileURL(join(dist, 'server-main.js')).href),
    import(pathToFileURL(join(dist, 'server/tool-input.js')).href),
    import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/types.js')).href),
  ]);
  const Server = createBatchRAGServer(RAGServer, { parseIngestDataInput,
    invalidInput: message => new sdk.McpError(sdk.ErrorCode.InvalidParams, message) });
  const config = await resolveServerConfig(process.env, process.cwd());
  if (config.configWarnings?.length) console.error('Configuration warnings:', config.configWarnings.join(' | '));
  const server = new Server(config);
  await server.initialize();
  await server.run();
} catch (error) {
  console.error('Failed to start StudyHub search server:', error);
  process.exit(1);
}
