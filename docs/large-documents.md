# Large textbooks: convert, then choose by chapter or search

[中文](large-documents.zh-CN.md)

StudyHub reads a PDF's text layer, saves it page by page and sends the pages you select to the model. That works for lecture notes and single chapters. A 1,000-page textbook does not fit, and StudyHub builds no search index of its own. A big book takes up to three steps:

1. **Convert** the PDF into text with page numbers and headings. StudyHub runs MinerU for you, which also reads scanned pages, formulas, tables and Chinese. The book is imported as one document.
2. **Choose by chapter** when you generate questions.
3. **Search** (optional), for questions from the whole book: the search extension finds the pages that match your topic, and only those are sent to the model.

What you install yourself and what StudyHub does:

- StudyHub never installs a converter. The local `mineru` is yours to install; the cloud route uses your own MinerU token.
- The search extension is installed only when you click **Install the search extension**.
- The manual tools (MinerU desktop client, Docling, RAGFlow, a hand-configured search server) are yours to install and run.
- StudyHub says a search tool is available only when DeepSeek Harness (DSH) reports it.

**Cloud conversion is temporarily unavailable. Use local MinerU and downloaded models first.** Install the tool yourself, then confirm model downloads in Settings. A saved cloud token does not select cloud conversion automatically. The desktop client is also currently reported unavailable; it remains an advanced option for when it recovers.

## When StudyHub suggests this

| Limit | Value | Where you see the advice |
|---|---|---|
| PDF file size | 8 MB (Word and PowerPoint: 40 MB) | **Add source**: a **Large textbooks** card under the file |
| PDF length | 200 pages | **Add source**: the same card |
| Text extracted from one file | 600,000 characters | **Add source**: the same card |
| Text sent to one generation | 600,000 characters, cut into 60,000-character chunks | **Create deck**: a **Large textbooks** card under the source list. **Generate & check deck** stays off until you narrow the selection, or choose a search tool and write a topic. |
| A document of more than 300 pages | advice only | **Sources**: a folded note under the book, **This material has 450 pages: use it by chapter** (with the book's own page count) |

A converted book has no page or character limit on import; only the file size counts (8 MB for Markdown or TXT, 40 MB for JSON). The 600,000-character limit applies to what you send to one generation, not to what you keep.

## Use a large textbook

1. **Convert the PDF.** In **Add source**, on the **Files** tab, click **Convert with MinerU**. If a PDF was refused as too large, the **Large textbooks** card under it offers the same conversion for that file. A ready local `mineru` is used first; otherwise your own MinerU token. Books over 200 pages are processed in pieces and merged. See [Convert a PDF with MinerU](mineru-conversion.md).
2. **Or import a converted file.** If you converted the book yourself, drop the exported file into **Add source**. StudyHub recognises converter output by its content, saves one source per page and splits the book into chapters by its headings. Every page keeps its page number for citations. The manual routes are under **Advanced: other ways (desktop client, command line, Docker)**.
3. **Choose chapters.** In **Create deck**, find the book in the source list, click **Choose chapters** and tick the chapters to study. A chapter is a group of pages; **Choose by page instead** is still there.
4. **Search the whole book (optional).**
   1. Click **Install the search extension**, on the card or in **Settings › Search extension**.
   2. Click **Build the search index for this course**.
   3. Write the topic under **What would you like to practise?**.

   With a search tool chosen and a topic written, a selection over 150,000 characters is narrowed to the pages the tool finds, about 120,000 characters at most. **Preview the pages that will be used** lets you tick or untick pages first; **Use only the ticked pages** replaces your selection with them. The job's progress view says which pages were used.

## Generate a big selection step by step

When a selection is too big to generate well in one go (more than 150,000 characters, or more than about 20 pages), **Create deck** shows a **Step-by-step path**: the selection cut into steps in book order. Since 2.5.8:

- **Steps are small.** One step covers at most about 20 pages, and StudyHub suggests at most 15 questions for it. A longer chapter is cut into balanced parts: 81 pages become 17+16+16+16+16, not 20+20+20+20+1.
- **Steps are named after the book's chapters**, from your outline or the converter's headings. A name that is only a cut-off word is never used, such as a single letter (an index heading), a dangling hyphen or ellipsis, or a bare number or roman numeral. A step without a usable name is called by its pages ("Pages 69–137"). A name that covers only part of a step gets the page range added.
- **Front and back matter is optional.** These parts form steps of their own, which are off by default and labelled in words ("Optional · skipped by default (Index)"):
  - headings such as Index, Colophon, About the Author, Acknowledgments, Table of Contents, Copyright, Dedication, Preface or Foreword, Appendix and Bibliography, and their Chinese equivalents;
  - the pages before the first chapter;
  - in the second half of the book, a run of one-letter chapters (an index) and everything after an index, colophon or author heading;
  - blank pages at the end.

  Tick a step to include it. If everything you selected is such matter, nothing is skipped.
- **Each step lists the pages it covers** (the PDF page numbers, as after "p." in a page title), both in the panel and in the brief for the chat assistant.
- **What you can do with the path:**
  - **Use only this step** puts that step's pages and question count into the form.
  - **Generate step by step · queue 5 steps in order** (with your number of steps) starts one generation job per step, in order. You can practise the first step as soon as it finishes.
  - **Let the AI refine the path** lets the AI rename the steps, say what each should practise, reorder them and suggest 6–30 questions each. The pages of a step never change.
  - **Talk it over with the AI** plans the path with the assistant in the main chat.
- **A very long book** (more than 40 steps, about 800 pages) gets wider steps instead of losing pages. The assistant is told to split such a step into several generation calls.
- **The assistant cannot watch a job between your messages.** It checks a job when you ask, and it is told to start the next step only after the previous one finished. It will not report back on its own.

## The search extension (one click)

**Install the search extension** is in **Settings › Search extension** and on the **Large textbooks** card. You edit no file, type no command and install no Node, Python or Docker.

- **What it is.** A small companion bundle, `@ericwang1358/studyhub-retrieval`, published as a release asset of the same StudyHub version (`ericwang1358-studyhub-retrieval-<version>.tgz`, with its SHA-256 in `SHA256SUMS-<version>.txt`). It holds one DSH plugin that mounts DSH's own MCP client for the local search server [mcp-local-rag](https://github.com/shinpr/mcp-local-rag) (MIT, pinned to an exact version), which is the bundle's npm dependency.
- **How it installs.** The same way StudyHub updates itself:
  1. StudyHub downloads the asset from the project's GitHub release and checks its checksum.
  2. It keeps the verified file under `<DSH home>/study/updates` and hands it to DSH's plugin manager.
  3. pnpm fetches the server and its components from the package registry. DSH falls back to the npmmirror registry when the default one is unreachable.
  4. pnpm holds back some components' install scripts. StudyHub lists them and asks before allowing them (**Allow and continue**).

  A fresh install works at once. Replacing an installed copy needs a DSH restart, and the page says so. When the installed extension is older than StudyHub, the page offers **Update the search extension**.
- **How it runs with nothing else installed.** The plugin starts the server with the Node that DSH itself runs on, and finds the server's entry file next to its own package. The server needs Node 22 or later. If DSH's Node is older, the plugin does not start it and logs why.
- **Build the index.** **Build the search index for this course** hands the course's pages to the server one at a time, each under its own id, so every hit names its page exactly.
  - Only new or changed pages are sent; pages that left the library are removed.
  - The build runs in the background, with progress and a **Stop** button. What was built is kept, and the next build continues from there.
  - Each document on **Sources** and in the **Create deck** source list shows its index state: **Not indexed yet**, **Building the index**, **Index partly built**, **Index needs an update** (pages edited since) or **Index built**, with page counts.
  - The first build downloads the embedding model: about 90 MB, once, according to the server's documentation. The page tells you before you start. After that it works offline.
- **Search quality.** The server's default model is aimed at English. Chinese textbooks can still be searched, since it adds keyword matching, but semantic matching is weaker. The project documents no multilingual model, so StudyHub bundles and recommends none.
- **If the model cannot be downloaded.** The server's documentation describes `HF_ENDPOINT` for a download address other than the default. **Settings › Search extension** › **Advanced** › **Model download address** stores one (https only), and the extension passes it on when DSH starts it, so a change needs a DSH restart. No mirror address is suggested: the project documents the variable, not a mirror.
- **Where things live.**
  - Index and model cache: `<DSH home>/study/retrieval`
  - What StudyHub indexed: `<DSH home>/study/retrieval/manifests`
  - Your choice of search tool: `<DSH home>/study/retrieval.json`

  **Uninstall the search extension** removes the bundle and keeps all of these, so a reinstall can use them again.
- **Choosing it.** Once an index exists, the extension is used automatically, unless you chose another search tool yourself.

The **Learning flow** page uses the same search to find the topics whose cards cite the pages that match your goal. The **Study coach** needs no search: its evidence is already limited to the text around each card's own citations, so it never sends a whole document.

## Recommended converters

Checked on 2026-10-01 against each project's own pages. Licences and features can change; the projects' pages are authoritative.

| Tool | Licence | Platforms | MCP | Output StudyHub reads | Notes |
|---|---|---|---|---|---|
| **MinerU** (recommended; StudyHub runs it: with local `mineru` and downloaded models first; cloud conversion is temporarily unavailable. The desktop client and the command line are the manual routes.) | MinerU Open Source License: Apache-2.0 with extra conditions (a separate licence above 100 million monthly active users or USD 20 million monthly revenue; attribution for online services) | Windows, macOS, Linux (Python 3.10–3.14 for the library) | none from the project (community servers call its cloud API) | `content_list.json` (v1: flat, with `page_idx`; v2: grouped by page). Its Markdown carries no `<!-- page: N -->` markers. | Handles scanned pages, formulas, tables and Chinese. Its website offers a desktop client for Windows and macOS (Apple silicon and Intel): [mineru.net/client](https://mineru.net/client). That page does not say whether the client parses locally or in the cloud: check before you upload private material. The GitHub README documents the command line, SDK and WebUI, not the client. A CPU is enough (2 GB RAM for the basic tier); a GPU is optional. |
| **Docling** (advanced: needs a command line) | MIT | Windows, macOS, Linux | `docling-mcp` (MIT; stdio, SSE, streamable HTTP) | JSON (`DoclingDocument`, `prov.page_no`, 1-based); Markdown | Run it from a command line or Python: `docling file.pdf --to json`. OCR engines include RapidOCR, EasyOCR and Tesseract (`--ocr-engine`, `--ocr-lang`). No desktop app. |

Also checked and **not** recommended:

- **Marker**: the code is Apache-2.0, but the model weights use a modified OpenRAIL-M licence that limits commercial use (free for research, personal use and startups under USD 5M). StudyHub still reads its `--paginate_output` Markdown (see [What StudyHub reads](#what-studyhub-reads)), so existing output works.
- **MarkItDown** (Microsoft, MIT): converts many formats to Markdown for language models, but its documentation describes no page markers, and scanned PDFs depend on a vision-model plug-in or a cloud service. It does not suit page-cited textbooks.

### Download channels

| Tool | Official | Source | Package | Works in mainland China |
|---|---|---|---|---|
| MinerU | [mineru.net](https://mineru.net/client) · [docs](https://opendatalab.github.io/MinerU/) | [GitHub](https://github.com/opendatalab/MinerU) | [PyPI](https://pypi.org/project/mineru/) | [mineru.net API docs and tokens](https://mineru.net/apiManage/docs) · [ModelScope (OpenDataLab)](https://www.modelscope.cn/organization/OpenDataLab) · [PyPI Tsinghua mirror](https://pypi.tuna.tsinghua.edu.cn/simple/mineru/) |
| Docling | [docs](https://docling-project.github.io/docling/) | [GitHub](https://github.com/docling-project/docling) · [docling-mcp](https://github.com/docling-project/docling-mcp) | [PyPI](https://pypi.org/project/docling/) | [PyPI Tsinghua mirror](https://pypi.tuna.tsinghua.edu.cn/simple/docling/) |
| mcp-local-rag | | [GitHub](https://github.com/shinpr/mcp-local-rag) | npm | [npmmirror](https://registry.npmmirror.com/mcp-local-rag) |
| RAGFlow | [ragflow.io](https://ragflow.io/) · [MCP](https://ragflow.io/docs/use_ragflow_as_mcp_server) | [GitHub](https://github.com/infiniflow/ragflow) | Docker image | [Gitee](https://gitee.com/infiniflow/ragflow) |

The last column lists China-hosted pages, the model hub ModelScope and registry mirrors (the Tsinghua PyPI mirror and npmmirror; DSH's own plugin manager also falls back to npmmirror). Model files that a tool downloads from Hugging Face may need a mirror from your network provider; this guide does not recommend an unofficial one.

## Advanced: other search tools

StudyHub reaches search tools through DSH. DSH's MCP client registers every tool of a configured MCP server as `mcp__<server>__<tool>`, and StudyHub lists the ones that look like search tools: a text argument, and *search*, *query*, *retrieve*, *find*, *lookup*, *recall* or *rag* in the name or description.

To choose one, open **Settings › Search extension** › **Advanced** and pick it under **Search with**. **Test** runs it once and reports how many passages matched pages of your material.

| Tool | Licence | Needs | Notes |
|---|---|---|---|
| **mcp-local-rag** (what the extension runs for you; by hand it needs Node.js and a configuration file) | MIT | Node.js 22 or later (`npx`) | Local embeddings and vector store; reads PDF, Word, Markdown and text; semantic search with a keyword boost (`RAG_HYBRID_WEIGHT`). The default embedding model (`Xenova/all-MiniLM-L6-v2`) favours English. For Chinese textbooks, choose a multilingual embedding model with `MODEL_NAME`; it must be a Hugging Face model compatible with mean pooling and normalisation (check its README). Results carry the passage text and the file path but no page number, so StudyHub matches them to pages by the passage text: put the converted Markdown in the folder it reads. |
| **RAGFlow** (full knowledge base) | Apache-2.0 | Docker; 4 CPU cores, 16 GB RAM and 50 GB disk recommended | A web application with Chinese-first document parsing and an MCP interface (streamable HTTP at `/api/v1/mcp`). Create a knowledge base from your converted books first. The shared API key stays on the RAGFlow side (`mcp.host_api_key` in its settings), so the DSH configuration holds no key. The pages checked do not document the tool name or the result fields: StudyHub reads the schema DSH reports and matches results by text. |

### Add a search server by hand in DSH

You need this only if you do not want the one-click extension. DSH has no screen for adding an MCP server; it is a plugin entry. Add the following to `cordis.patch.yml` in your DSH home, after any existing content. DSH applies it without a restart when live reload is on. **Advanced: manual setup**, on the card and in Settings, shows the same text with a **Copy configuration** button.

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

For RAGFlow, use `transport: streamable-http` and `url: "http://127.0.0.1:9380/api/v1/mcp"` instead of `command`, `args` and `env`. StudyHub sees only servers configured for the whole DSH profile, not a server mounted inside one agent preset.

## What StudyHub reads

Dropping a converted file into **Add source** is enough; the format is detected from the content. Pages are numbered from 1.

| Format | Detected by | Pages |
|---|---|---|
| Markdown with page markers | `<!-- page: N -->` | The text after marker N is page N; text before the first marker joins the first page. |
| Marker `--paginate_output` Markdown | a line `{N}` followed by 20 or more dashes | The text after `{N}...` is page N+1 when the numbers start at 0 (Marker's page ids), otherwise page N. Check that your first page is under `{0}`. |
| MinerU `content_list.json` v1 | a flat list whose items have `type` and `page_idx` | `page_idx` is 0-based. Headings come from `text_level`. Tables (HTML), equations (LaTeX), code, lists and image captions are kept as text; headers, footers and page numbers are dropped. |
| MinerU content list v2 | a list of pages, each a list of blocks | The N-th list is page N. Blocks are read tolerantly: title blocks become headings and text in `content` fields is kept. The pages checked publish no field-level schema for v2, so prefer v1 if a page looks wrong. |
| Docling JSON | `schema_name: DoclingDocument` | The body tree in reading order; `prov[].page_no` (1-based) places each item. Section headers become headings (a document title is level 1, sections start at level 2), and tables become Markdown tables. Page headers and footers are dropped. |

- **Chapters.** Headings in the converted text (`#` lines) become the book's outline. Chapters are the shallowest heading level with at least two headings, so a lone book title does not count. A chapter runs to the page before the next one starts.
- **Skipped pages.** Pages without text are skipped and reported.
- **Other JSON.** A JSON file that is neither MinerU nor Docling output is refused, with a pointer to **Import JSON deck**.
- **No original file.** An imported converted book keeps no PDF: the pages are the evidence, and citations point at them. Importing the same file again adds nothing.
- **Markdown from `mineru parse`.** The MinerU command line (4.0.x) marks pages as `<!-- page N of TOTAL -->`. The importer does not read that form, so a file you converted by hand needs `<!-- page: N -->` markers. **Convert with MinerU** reads the command line's markers itself.

## For plugin and tool authors

### The retrieval provider contract

```
retrieve({ query, sourceIds?, course?, limit, signal? })
  -> [{ sourceId?, page?, document?, text, score }]
```

- `query`: the learner's topic (for the Learning flow, the goal sentence).
- `sourceIds`: the StudyHub sources (one per page) the answer may come from. `course` is the course name when there is one. `limit` is at most 40.
- `sourceId`: a StudyHub source id, the best answer. A provider that indexes its own copy may give `document` (file name or title) and `page`, or only `text`. StudyHub matches by source id, then by document name and page, then by a bare page number when one paged document is selected, then by the passage's own words.
- `score`: higher is better; without scores, the order is the rank.

### Another plugin as a provider

Register the cordis service **`studyRetrieval`**; StudyHub reads it with `ctx.get('studyRetrieval')`:

```js
ctx.provide('studyRetrieval', { async retrieve({ query, sourceIds, course, limit, signal }) { return [{ sourceId, text, score }] } })
```

It is listed in Settings as `studyRetrieval` and used when the learner chooses it.

### An MCP tool as a provider

StudyHub reads the tool's JSON schema from DSH (`ctx.tools.schemas()`) and fills two arguments:

- the text argument with the query: `query`, `q`, `question`, `search`, `search_query`/`searchQuery`, `text`, `keywords`, `prompt`, `input`, or the only string argument;
- a numeric argument with the limit: `limit`, `top_k`/`topK`, `k`, `n`, `max_results`/`maxResults`, `num_results`/`numResults` or `count`.

It runs the tool with `ctx.tools.execute({ callId, name, arguments, signal })` and reads the result `{ content: [...], structuredContent? }` in any of these forms:

- structured content, or a JSON text block holding a list, or an object with `results`, `items`, `passages`, `hits`, `matches`, `chunks`, `documents` or `data`;
- `<entry><content>…</content><metadata>{…}</metadata></entry>` blocks;
- plain text, where a `第 N 页`, `page N` or `p. N` hint becomes the page.

A required argument StudyHub cannot fill makes the tool unusable, and Settings says so.

### Actions

| Action | Purpose |
|---|---|
| `retrieval.status` | `{ selected, effective, missing?, queryArg?, limitArg?, explicit, hfEndpoint?, companion: { id, running }, extension: { canInstall, installed, enabled, version?, error?, desktop, outdated?, expected? }, hostCanSearch, providers, otherTools, limits }` (`extension` is added by the host handler; when the extension holds an index and nothing was chosen explicitly, it becomes `effective`) |
| `retrieval.extension.install { approvedBuilds? }` | `{ status: 'installed', restartRequired, application, version }` or `{ status: 'needs-approval', pending }` (call again with `approvedBuilds`); errors `extension-no-installer`, `extension-download`, `extension-checksum`, `extension-install` |
| `retrieval.extension.uninstall` | removes the bundle; a chosen extension provider falls back to `builtin` |
| `retrieval.index.plan { course? }` | `{ course, pages, toIndex, unchanged, toRemove, chars, firstRun, modelMb, canIndex }` |
| `retrieval.index.coverage` | `{ indexed, stale, missing, hasIndex, canIndex, building }`: source ids whose page is in the index, was edited since it was indexed, or is not indexed; `building` is the running build, if any |
| `retrieval.index.start { course? }` / `.status` / `.cancel` | background build: `{ runId, course, status: running\|complete\|failed\|cancelled, stage: preparing\|model\|indexing, done, total, added, removed, unchanged, failed, failedCount, firstRun, error?, errorCode? }`; one build per library at a time |
| `retrieval.endpoint.set { endpoint }` | the extension's model download address (https, or empty for the default) |
| `retrieval.set { provider, queryArg?, limitArg? }` | `provider`: `builtin`, `service` or `mcp:<tool>`; stored in `$DSH_HOME/study/retrieval.json` (no secrets) |
| `retrieval.test { query? }` | one harmless call; `{ ok, hits, matched, unresolved }` |
| `retrieval.preview { sourceIds, query, course?, limit? }` | `{ provider, pages: [{ sourceId, title, page, score, snippet }], unresolved, hits }` |
| `materials.document.import` | also takes converter output (`.json`, or Markdown/TXT with page markers) |
| `generate` | narrows a selection above 150,000 characters when a provider is chosen and `focus` is set; the job records `retrieval: { provider, query, selected, used: [{ sourceId, title, page, score }], truncated, unresolved }` or `retrieval.error` |

- Over 600,000 characters with no provider, `generate` still fails with the original message and `code: 'selection-too-large'`. With a provider but no topic, the code is `retrieval-needs-topic`.
- A provider that fails on a selection that still fits does not stop generation: the selection is sent unchanged and the job records why.

### Extension internals

- The plugin starts the server with `process.execPath`. Under DSH Desktop that is Electron in Node mode, so it also sets `ELECTRON_RUN_AS_NODE=1`.
- The installer hands the verified bundle to `ctx.pluginManager.installBundle`.
- Pages are indexed under `studyhub://source/<id>`.

### The step-by-step path

The path is planned in `lib/generation-path.js` and shown by `ui/GenerationPath.jsx`. Each step becomes one generation job, or the whole plan is talked over with the chat assistant first.

- One generate call writes and reviews well up to about `CALL_PAGES` (20) pages and `CALL_QUESTIONS` (15) questions; these sit next to `STEP_CHARS` (150,000), and `STEP_PAGES` equals `CALL_PAGES`.
- Design choice: the step budget is not lowered and no second planner is added. The page limit is one more bound in the same cut-and-merge pass.
- `MAX_STEPS` (40) stays meaningful: when a book needs more steps, the character and the page limits are widened together instead of dropping pages.
- The brief tells the assistant how to get the sourceIds of a custom range: `source.list` with `groupBy: "document"` and `memberOffset`/`memberLimit`.
- The brief lists the steps that are switched off (front and back matter) as steps to skip.
- `job.status { jobId? }` is read-only and answers at once: state, stage, `finished`, saved and requested counts, and the draft. Without a `jobId`, it lists the library's jobs. `job.wait` still waits, at most 60 seconds, for one bounded wait.
