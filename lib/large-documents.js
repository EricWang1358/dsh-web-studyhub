/* Large textbooks (WP28): when StudyHub recommends a converter or a retrieval
   tool, and what it recommends. Pure data and predicates, shared by the import
   hub, the generate page, Settings and the docs. Nothing here says a tool is
   installed: detection belongs to the host (lib/retrieval.js, retrieval.status). */

const MB = 1024 * 1024;

/** The limits the importer and generation enforce (mirrors lib/documents.js, lib/batch.js). */
export const LARGE_DOCUMENT_LIMITS = Object.freeze({ pdfBytes: 8 * MB, pdfPages: 200, selectionChars: 600000, advisePages: 300 });

/** A selection above this many characters is narrowed by retrieval when a provider is chosen (generation and the page agree on it). */
export const RETRIEVE_ABOVE_CHARS = 150_000;

/** The day the catalogue's facts and links were last checked against the official pages (UTC). */
export const VERIFIED_AT = '2026-10-01';

/* ---------- catalogue ----------
   role: converter (PDF -> Markdown/JSON that StudyHub imports) | retrieval (a search tool DSH exposes).
   channel kinds: official (the project's own site or documentation), source (its code host),
   package (a package registry), mainland (reachable from mainland China without a VPN: a China-hosted
   official page, a model hub, or a registry mirror). */
const channel = (kind, label, url) => Object.freeze({ kind, label, url });

/** The search extension StudyHub installs in one click (a companion bundle; see packages/studyhub-retrieval). */
export const EXTENSION = Object.freeze({ package: '@ericwang1358/studyhub-retrieval', name: 'StudyHub 检索扩展', server: 'mcp-local-rag' });

/* needs: what a route asks of the learner. download: install a normal app; command-line: a terminal;
   docker: Docker; manual: editing a DSH configuration file; token: paste a free token once (the cloud route StudyHub runs itself).
   `download` and `token` are for everyone. */
export const TOOLS = Object.freeze([
  // The leading path for PDFs: MinerU's cloud conversion with the learner's own token (created for free at mineru.net, pasted once into
  // StudyHub), run by StudyHub itself: it cuts big books into pieces, converts them one at a time, merges and imports the result.
  // Currently free; the rules may change. The document is uploaded to MinerU's cloud, which is said before the first use.
  Object.freeze({
    id: 'mineru-cloud', role: 'converter', recommended: true, needs: 'token', name: 'MinerU 云端解析',
    license: 'MinerU 在线服务（目前免费，规则可能变化）',
    platforms: ['Windows', 'macOS', 'Linux'], mcp: false, studyhubFormat: 'mineru-content-list',
    outputs: ['content_list.json'],
    channels: [channel('mainland', 'mineru.net · API 文档与令牌管理', 'https://mineru.net/apiManage/docs'),
      channel('official', 'mineru.net 官网', 'https://mineru.net/')],
    licenseUrl: 'https://mineru.net/apiManage/docs',
  }),
  // The desktop client and the local `mineru` command line (`mineru parse --pages`) stay available, but are not the primary path.
  Object.freeze({
    id: 'mineru', role: 'converter', recommended: false, needs: 'download', name: 'MinerU 桌面客户端 / 本地命令行',
    license: 'MinerU Open Source License (Apache-2.0 with extra conditions)',
    platforms: ['Windows', 'macOS', 'Linux'], mcp: false, studyhubFormat: 'mineru-content-list',
    outputs: ['content_list.json', 'Markdown'],
    channels: [channel('official', 'mineru.net（桌面客户端 / 在线解析）', 'https://mineru.net/client'),
      channel('official', '文档 · Documentation', 'https://opendatalab.github.io/MinerU/'),
      channel('mainland', 'ModelScope · OpenDataLab', 'https://www.modelscope.cn/organization/OpenDataLab'),
      channel('source', 'GitHub', 'https://github.com/opendatalab/MinerU'),
      channel('package', 'PyPI', 'https://pypi.org/project/mineru/'),
      channel('mainland', 'PyPI · 清华镜像', 'https://pypi.tuna.tsinghua.edu.cn/simple/mineru/')],
    licenseUrl: 'https://github.com/opendatalab/MinerU/blob/master/LICENSE.md',
  }),
  Object.freeze({
    id: 'docling', role: 'converter', recommended: true, needs: 'command-line', name: 'Docling',
    license: 'MIT', platforms: ['Windows', 'macOS', 'Linux'], mcp: true, studyhubFormat: 'docling-json',
    outputs: ['JSON (DoclingDocument)', 'Markdown'],
    channels: [channel('official', 'Documentation', 'https://docling-project.github.io/docling/'),
      channel('source', 'GitHub', 'https://github.com/docling-project/docling'),
      channel('package', 'PyPI', 'https://pypi.org/project/docling/'),
      channel('mainland', 'PyPI · 清华镜像', 'https://pypi.tuna.tsinghua.edu.cn/simple/docling/')],
    licenseUrl: 'https://github.com/docling-project/docling/blob/main/LICENSE',
  }),
  Object.freeze({
    id: 'mcp-local-rag', role: 'retrieval', recommended: true, needs: 'manual', name: 'mcp-local-rag',
    license: 'MIT', platforms: ['Windows', 'macOS', 'Linux'], mcp: true,
    server: Object.freeze({ serverName: 'books', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-local-rag'] }),
    channels: [channel('source', 'GitHub', 'https://github.com/shinpr/mcp-local-rag'),
      channel('mainland', 'npm · npmmirror 镜像', 'https://registry.npmmirror.com/mcp-local-rag')],
    licenseUrl: 'https://github.com/shinpr/mcp-local-rag/blob/main/LICENSE',
  }),
  Object.freeze({
    id: 'ragflow', role: 'retrieval', recommended: true, needs: 'docker', name: 'RAGFlow',
    license: 'Apache-2.0', platforms: ['Windows', 'macOS', 'Linux (Docker)'], mcp: true,
    server: Object.freeze({ serverName: 'ragflow', transport: 'streamable-http', url: 'http://127.0.0.1:9380/api/v1/mcp' }),
    channels: [channel('official', 'ragflow.io', 'https://ragflow.io/'),
      channel('official', 'MCP 说明 · Use RAGFlow as an MCP server', 'https://ragflow.io/docs/use_ragflow_as_mcp_server'),
      channel('source', 'GitHub', 'https://github.com/infiniflow/ragflow'),
      channel('mainland', 'Gitee', 'https://gitee.com/infiniflow/ragflow')],
    licenseUrl: 'https://github.com/infiniflow/ragflow/blob/main/LICENSE',
  }),
]);

export const toolsFor = role => TOOLS.filter(tool => tool.role === role);

/* ---------- when to advise ---------- */

const text = value => String(value?.message ?? value ?? '');

/**
 * What kind of "too large" an import failure was: 'pdf-size' (over 8 MB),
 * 'pdf-pages' (over 200 pages), 'text-chars' (over 600,000 characters of text),
 * 'office-size' (over 40 MB), or null for any other failure.
 */
export function classifyImportFailure(error) {
  const message = text(error);
  if (!message) return null;
  if (/200\s*(?:页|pages)/i.test(message)) return 'pdf-pages';
  if (/600,000|60 万字/.test(message)) return 'text-chars';
  if (/\b40 MB/i.test(message)) return 'office-size';
  if (/\b8 MB/i.test(message)) return 'pdf-size';
  return null;
}

const charsOf = source => (typeof source?.text === 'string' ? source.text.length : Number(source?.chars) || 0);

/** Characters of the selected sources (snapshot sources may carry `chars` instead of `text`). */
export function selectionChars(sources, selectedIds) {
  const chosen = new Set(selectedIds || []);
  return (sources || []).filter(source => chosen.has(source.id)).reduce((sum, source) => sum + charsOf(source), 0);
}

/** { chars, limit } when the selection exceeds what one generation accepts, else null. */
export function selectionTooBig(sources, selectedIds, limit = LARGE_DOCUMENT_LIMITS.selectionChars) {
  const chars = selectionChars(sources, selectedIds);
  return chars > limit ? { chars, limit } : null;
}

/** Documents (groupSourcesByDocument items) longer than `pages` pages, by imported or declared length. */
export function bigDocuments(items, { pages = LARGE_DOCUMENT_LIMITS.advisePages } = {}) {
  return (items || []).filter(item => Math.max(item.pages?.length || 0, item.totalPages || 0) > pages);
}

/* ---------- configuration to hand to DSH ---------- */

const quote = value => JSON.stringify(String(value));

/**
 * The `cordis.patch.yml` entry that makes DSH's MCP client connect a retrieval
 * tool (the shape DSH documents for MCP configuration). `directory` is the folder
 * the tool reads the converted books from. No keys: RAGFlow's key stays on its own side.
 */
export function mcpConfigSnippet(toolId, { directory = '/path/to/converted-books' } = {}) {
  const tool = TOOLS.find(entry => entry.id === toolId);
  if (!tool?.server) throw new Error(`${toolId} has no MCP server to configure`);
  const { server } = tool;
  const lines = ['- insert:', `    - id: study-${server.serverName}`, `      name: '@deepseek-ai/dsh-mcp-client'`, '      config:',
    `        serverName: ${server.serverName}`, `        transport: ${server.transport}`];
  if (server.transport === 'stdio') lines.push(`        command: ${server.command}`, `        args: [${server.args.map(quote).join(', ')}]`,
    '        env:', `          BASE_DIR: ${quote(directory)}`);
  else lines.push(`        url: ${quote(server.url)}`);
  return `${lines.join('\n')}\n`;
}
