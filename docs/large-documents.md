# Large textbooks: convert, then choose by chapter or search

[中文](large-documents.zh-CN.md)

StudyHub reads a PDF's text layer, saves it page by page and sends the pages you select to the model. That works for lecture notes and chapters; a 1,000-page textbook does not fit. StudyHub does **not** build a search index of its own. Instead it recommends third-party tools for the two jobs a big book needs, and provides the interfaces to use them:

1. **Convert** the PDF to text with page numbers (and headings), with a converter that handles scanned pages, formulas, tables and Chinese. Import the result into StudyHub as one document.
2. **Search** (optional): a retrieval tool that DSH connects. Question generation, the guided learning flow and the picker then use only the pages that match your topic.

You install these tools yourself; StudyHub never downloads or runs them, and it says a tool is available only when DSH exposes it.

## Limits that trigger the advice

| Limit | Value | Where you see the advice |
|---|---|---|
| PDF file size | 8 MB (Word and PowerPoint 40 MB) | Add material: a card under the file |
| PDF length | 200 pages | Add material |
| Extracted text of one file | 600,000 characters | Add material |
| Selection for one generation | 600,000 characters, cut into 60,000-character chunks | Create deck: card above the button; generating is off until you narrow the selection or choose a search tool |
| A document of more than 300 pages | advice only | Materials: a folded 大教材建议 under the book |

A converted book has **no import limit** (apart from 8 MB for Markdown and 40 MB for JSON files); the 600,000-character limit applies to what you send to generation, not to what you keep.

## Steps

1. Convert the PDF with **MinerU, run by StudyHub itself**: choose **Convert with MinerU** under Add material (the local `mineru` when it is ready, otherwise your own free MinerU token pasted once into Settings). Books over 200 pages are cut into pieces, converted one at a time and merged; see [Convert a PDF with MinerU](mineru-conversion.md). The MinerU desktop client, the `mineru parse --pages` command line and Docling are the manual alternatives (under Advanced): export JSON with page numbers and drag it in.
2. **Add material**, drop the exported file. StudyHub recognises converter output by its content, saves one source per page, and splits the book into chapters by its headings. Each page keeps its page number for citations.
3. **Create deck**: open the book, choose **Choose chapters**, tick the chapters to study. A chapter is a group of pages; **Choose by page instead** is still available.
4. For whole-book questions, click **Install the search extension** (on the card, or in **Settings → Extensions: conversion and search**), then **Build the search index for this course**, and write the topic under **What do you want to practise?**. With the extension's index built, a selection above 150,000 characters is narrowed to the pages the tool finds (at most about 120,000 characters). **Preview the pages that will be used** lets you tick or untick pages before generating; **Use only the ticked pages** replaces the selection with them. The job's execution view says which pages were used.

## Recommended converters

Checked on 2026-10-01 against each project's own pages. Licences and features can change; the projects' pages are authoritative.

| Tool | Licence | Platforms | MCP | Output StudyHub reads | Notes |
|---|---|---|---|---|---|
| **MinerU** (recommended, run by StudyHub: cloud with your own token, or the local `mineru`; the desktop client and command line are the manual routes) | MinerU Open Source License: Apache-2.0 with extra conditions (a separate licence above 100 million monthly active users or USD 20 million monthly revenue; attribution for online services) | Windows, macOS, Linux (Python 3.10–3.14 for the library) | none from the project (community servers call its cloud API) | `content_list.json` (v1, flat, `page_idx`; v2, grouped by page), Markdown has no page markers | Handles scanned pages, formulas, tables and Chinese. Its website offers a desktop client for Windows and macOS (Apple silicon and Intel): [mineru.net/client](https://mineru.net/client). Whether the client parses locally or in the cloud is not stated on that page: check before uploading private material. The GitHub README documents the command line, SDK and WebUI rather than a client. CPU works (2 GB RAM for the basic tier); a GPU is optional. |
| **Docling** (Advanced: needs a command line) | MIT | Windows, macOS, Linux | `docling-mcp` (MIT; stdio, SSE, streamable HTTP) | JSON (`DoclingDocument`, `prov.page_no`, 1-based); Markdown | Run it from a command line or Python: `docling file.pdf --to json`; OCR engines include RapidOCR, EasyOCR and Tesseract (`--ocr-engine`, `--ocr-lang`). No desktop app. |

Also checked and **not** recommended:

- **Marker**: code is Apache-2.0, but the model weights use a modified OpenRAIL-M licence that limits commercial use (free for research, personal use and startups under USD 5M). Its `--paginate_output` Markdown is read by StudyHub (below), so existing output works.
- **MarkItDown** (Microsoft, MIT): converts many formats to Markdown for language models, but its documentation does not describe page markers, and scanned PDFs depend on a vision-model plug-in or a cloud service. Not suitable for page-cited textbooks.

### Download channels

| Tool | Official | Source | Package | Mainland China |
|---|---|---|---|---|
| MinerU | [mineru.net](https://mineru.net/client) · [docs](https://opendatalab.github.io/MinerU/) | [GitHub](https://github.com/opendatalab/MinerU) | [PyPI](https://pypi.org/project/mineru/) | [ModelScope (OpenDataLab)](https://www.modelscope.cn/organization/OpenDataLab) · [PyPI Tsinghua mirror](https://pypi.tuna.tsinghua.edu.cn/simple/mineru/) |
| Docling | [docs](https://docling-project.github.io/docling/) | [GitHub](https://github.com/docling-project/docling) · [docling-mcp](https://github.com/docling-project/docling-mcp) | [PyPI](https://pypi.org/project/docling/) | [PyPI Tsinghua mirror](https://pypi.tuna.tsinghua.edu.cn/simple/docling/) |
| mcp-local-rag | | [GitHub](https://github.com/shinpr/mcp-local-rag) | npm | [npmmirror](https://registry.npmmirror.com/mcp-local-rag) |
| RAGFlow | [ragflow.io](https://ragflow.io/) · [MCP](https://ragflow.io/docs/use_ragflow_as_mcp_server) | [GitHub](https://github.com/infiniflow/ragflow) | Docker image | [Gitee](https://gitee.com/infiniflow/ragflow) |

Mainland channels are China-hosted pages, the model hub ModelScope, or registry mirrors (the Tsinghua PyPI mirror, npmmirror: DSH's own plugin manager falls back to npmmirror). Model files that a tool downloads from Hugging Face may need a mirror from your network provider; this guide does not recommend an unofficial one.

## The search extension (one click)

**Settings → Extensions: conversion and search**, and the Large textbooks card, offer **Install the search extension**. No file is edited, no command is typed, and no Node, Python or Docker has to be installed.

- **What it is.** A small companion bundle, `@ericwang1358/studyhub-retrieval`, published as a release asset of the same StudyHub version (`ericwang1358-studyhub-retrieval-<version>.tgz`, with its SHA-256 in `SHA256SUMS-<version>.txt`). It carries one DSH plugin that mounts DSH's own MCP client for the local search server [mcp-local-rag](https://github.com/shinpr/mcp-local-rag) (MIT, pinned to an exact version), which is the bundle's npm dependency.
- **How it installs.** The same way StudyHub updates itself: StudyHub downloads the asset from the project's GitHub release, checks the checksum, keeps the verified file under `<DSH home>/study/updates` and hands it to DSH's plugin manager (`ctx.pluginManager.installBundle`). pnpm then fetches the server and its components from the package registry (DSH falls back to the npmmirror registry when the default is unreachable). pnpm holds back some components' install scripts; StudyHub lists them and asks before allowing them. A fresh install is live at once; replacing an installed copy needs a DSH restart, and the page says so.
- **How it runs without anything else installed.** The plugin starts the server with the Node that DSH itself runs on (`process.execPath`; under DSH Desktop that is Electron in Node mode, so it also sets `ELECTRON_RUN_AS_NODE=1`) and finds the server's entry file next to its own package. The server needs Node 22 or newer; the plugin checks and, if DSH's Node is older, does not start it and logs why.
- **Build the index.** **Build the search index for this course** hands the course's pages to the server one by one under their own id (`studyhub://source/<id>`), so every hit names its page exactly. Only new or changed pages are sent, pages that left the library are removed, and the build runs in the background with progress and a stop button. The first build downloads the embedding model: about 90 MB, once (the server's documentation); the page says so before you start. It works offline afterwards.
- **Search quality.** The server's default model is aimed at English; Chinese textbooks are still searched (it adds keyword matching) but semantic matching is weaker. No multilingual model is documented by the project, so none is bundled or recommended.
- **If the model cannot be downloaded.** The server's documentation describes `HF_ENDPOINT` for a download address other than the default. **Advanced → Model download address** stores one (https only) and the extension passes it on when DSH starts it, so a change needs a DSH restart. No mirror address is suggested: the project documents the variable, not a mirror.
- **Where things live.** Index and model cache: `<DSH home>/study/retrieval`; what StudyHub indexed: `<DSH home>/study/retrieval/manifests`; the choice of provider: `<DSH home>/study/retrieval.json`. Uninstalling removes the bundle and keeps these.
- **Choosing it.** Once an index exists, the extension becomes the provider automatically unless you chose another one yourself.

## Advanced: other retrieval tools

StudyHub talks to retrieval through DSH: DSH's MCP client registers every tool of a configured MCP server as `mcp__<server>__<tool>`, and StudyHub lists the ones that look like search tools (a text argument and a name or description with *search*, *query*, *retrieve*, *find*, *lookup*, *recall* or *rag*). You choose one in **Settings → Extensions: conversion and search**; **Test** runs it once and reports how many passages matched pages of your material.

| Tool | Licence | Needs | Notes |
|---|---|---|---|
| **mcp-local-rag** (what the extension runs for you; by hand: needs Node.js and a configuration file) | MIT | Node.js 22+ (`npx`) | Local embeddings and vector store; reads PDF, Word, Markdown and text; semantic search with a keyword boost (`RAG_HYBRID_WEIGHT`). The default embedding model (`Xenova/all-MiniLM-L6-v2`) favours English: for Chinese textbooks choose a multilingual embedding model with `MODEL_NAME` (it must be a Hugging Face model compatible with mean pooling and normalisation; check its README). Results carry the passage text and file path but no page number, so StudyHub matches them to pages by the passage text: put the converted Markdown in the folder it reads. |
| **RAGFlow** (full knowledge base) | Apache-2.0 | Docker; 4 CPU cores, 16 GB RAM and 50 GB disk recommended | A web application with Chinese-first document parsing and an MCP interface (streamable HTTP at `/api/v1/mcp`). Create a knowledge base from your converted books first. The shared API key stays on the RAGFlow side (`mcp.host_api_key` in its settings), so the DSH configuration holds no key. Tool name and result fields are not documented on the pages checked: StudyHub reads the schema DSH reports and matches results by text. |

### Adding one by hand in DSH

Only if you do not want the one-click extension: DSH has no screen for adding an MCP server, it is a plugin entry. Add this to the `cordis.patch.yml` in your DSH home (after any existing content; DSH applies it without a restart when live reload is on). The Settings section and the card offer the same text with a **Copy configuration** button.

```yaml
- insert:
    - id: study-books
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: books
        transport: stdio
        command: npx
        args: ["-y", "mcp-local-rag"]
        env:
          BASE_DIR: "/path/to/converted-books"
```

For RAGFlow use `transport: streamable-http` and `url: "http://127.0.0.1:9380/api/v1/mcp"` instead of `command`, `args` and `env`. Only servers configured for the whole DSH profile are visible to StudyHub; a server mounted inside one agent preset is not.

## What StudyHub reads (converter output)

Dropping the file in **Add material** is enough; the format is detected from the content. Pages are numbered from 1.

| Format | Detected by | Pages |
|---|---|---|
| Markdown with page markers | `<!-- page: N -->` | The text after marker N is page N; text before the first marker joins the first page. |
| Marker `--paginate_output` Markdown | a line `{N}` followed by 20 or more dashes | The text after `{N}...` is page N+1 when the numbers start at 0 (Marker's page ids), else page N. Check that your first page is under `{0}`. |
| MinerU `content_list.json` v1 | a flat list whose items have `type` and `page_idx` | `page_idx` is 0-based. Headings come from `text_level`; tables (HTML), equations (LaTeX), code, lists and image captions are kept as text; headers, footers and page numbers are dropped. |
| MinerU content list v2 | a list of pages, each a list of blocks | The N-th list is page N. The block layout is read tolerantly (title blocks become headings, text in `content` fields is kept); the pages checked did not publish a field-level schema for v2, so prefer v1 if a page looks wrong. |
| Docling JSON | `schema_name: DoclingDocument` | The body tree in reading order; `prov[].page_no` (1-based) places each item. Section headers become headings (a document title is level 1, sections start at level 2), tables become Markdown tables; page headers and footers are dropped. |

Headings in the converted text (`#` lines) become the book's outline. Chapters are the shallowest heading level with at least two headings (a lone book title does not count); a chapter runs to the page before the next one starts. Pages without text are skipped and reported. A JSON file that is neither MinerU nor Docling output is refused with a pointer to the question-deck import.

Imported converted books have no original file: the pages are the evidence, and citations point at them. Importing the same file again adds nothing.

## Interfaces for plugin and tool authors

### The retrieval provider contract

```
retrieve({ query, sourceIds?, course?, limit, signal? })
  -> [{ sourceId?, page?, document?, text, score }]
```

- `query`: the learner's topic (for the guided flow, the goal sentence).
- `sourceIds`: the StudyHub sources (one per page) the answer may come from; `course` the course name when there is one; `limit` at most 40.
- `sourceId`: a StudyHub source id, the best answer. A provider that indexes its own copy may give `document` (file name or title) and `page`, or only `text`: StudyHub matches by source id, then document name and page, then a bare page number when one paged document is selected, then by the passage's own words.
- `score`: higher is better; without scores the order is the rank.

### Another plugin as a provider

Register the cordis service **`studyRetrieval`**; StudyHub reads it with `ctx.get('studyRetrieval')`:

```js
ctx.provide('studyRetrieval', { async retrieve({ query, sourceIds, course, limit, signal }) { return [{ sourceId, text, score }] } })
```

It is listed in Settings as `studyRetrieval` and used when the learner chooses it.

### An MCP tool as a provider

StudyHub reads the tool's JSON schema from DSH (`ctx.tools.schemas()`), fills the text argument (`query`, `q`, `question`, `search`, `search_query`, `text`, `keywords`, `prompt`, `input`, or the only string argument) with the query and a numeric argument (`limit`, `top_k`, `k`, `n`, `max_results`, `num_results`, `count`) with the limit, runs it with `ctx.tools.execute({ callId, name, arguments, signal })` and reads the result `{ content: [...], structuredContent? }`: structured content or a JSON text block holding a list (or an object with `results`, `items`, `passages`, `hits`, `matches` or `chunks`), `<entry><content>…</content><metadata>{…}</metadata></entry>` blocks, or plain text (a `第 N 页` / `page N` hint becomes the page). A required argument StudyHub cannot fill makes the tool unusable, and Settings says so.

### Actions

| Action | Purpose |
|---|---|
| `retrieval.status` | `{ selected, effective, missing?, explicit, hfEndpoint?, companion: { id, running }, extension: { canInstall, installed, enabled, version?, desktop }, hostCanSearch, providers, otherTools, limits }` (`extension` is added by the host handler; when the extension holds an index and nothing was chosen explicitly it becomes `effective`) |
| `retrieval.extension.install { approvedBuilds? }` | `{ status: 'installed', restartRequired, application, version }` or `{ status: 'needs-approval', pending }` (call again with `approvedBuilds`); errors `extension-no-installer`, `extension-download`, `extension-checksum`, `extension-install` |
| `retrieval.extension.uninstall` | removes the bundle; a chosen extension provider falls back to `builtin` |
| `retrieval.index.plan { course? }` | `{ course, pages, toIndex, unchanged, toRemove, chars, firstRun, modelMb, canIndex }` |
| `retrieval.index.start { course? }` / `.status` / `.cancel` | background build: `{ runId, course, status: running\|complete\|failed\|cancelled, stage: preparing\|model\|indexing, done, total, added, removed, unchanged, failed, failedCount, firstRun, error?, errorCode? }`; one build per library at a time |
| `retrieval.endpoint.set { endpoint }` | the extension's model download address (https, or empty for the default) |
| `retrieval.set { provider, queryArg?, limitArg? }` | `provider`: `builtin`, `service` or `mcp:<tool>`; stored in `$DSH_HOME/study/retrieval.json` (no secrets) |
| `retrieval.test { query? }` | one harmless call; `{ ok, hits, matched, unresolved }` |
| `retrieval.preview { sourceIds, query, course?, limit? }` | `{ provider, pages: [{ sourceId, title, page, score, snippet }], unresolved, hits }` |
| `materials.document.import` | now also takes converter output (`.json`, or Markdown/TXT with page markers) |
| `generate` | narrows a selection above 150,000 characters when a provider is chosen and `focus` is set; the job records `retrieval: { provider, query, selected, used: [{ sourceId, title, page, score }], truncated, unresolved }` or `retrieval.error` |

Over 600,000 characters with no provider, `generate` still fails with the original message and `code: 'selection-too-large'`; with a provider but no topic, `retrieval-needs-topic`. A provider that fails on a selection that still fits does not stop generation: the selection is sent unchanged and the job records why.

The guided learning flow uses the same provider to find the topics whose cards cite the pages a goal matches. Coach evidence is already limited to windows around each card's own citations, so it never sends a whole document and needs no retrieval.
