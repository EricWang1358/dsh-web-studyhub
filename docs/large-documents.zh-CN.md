# 大教材：先转换，再按章节选或检索

[English](large-documents.md)

StudyHub 读取 PDF 的文字层，按页保存，并把你选中的页面交给模型。讲义和单章没问题；一本一千页的教材放不进去。StudyHub **不会**自己建检索索引，而是把大教材需要的两件事交给第三方工具，并提供使用它们的接口：

1. **转换**：用能处理扫描件、公式、表格和中文的转换工具，把 PDF 变成带页码（和标题）的文字，再把结果作为一份文档导入 StudyHub。
2. **检索**（可选）：由 DSH 连接的检索工具。出题、AI 带学和资料选择只会用到与主题相关的页面。

这些工具由你自己安装；StudyHub 不会下载或运行它们，也只在 DSH 确实提供了某个工具时才说它可用。

## 哪些情况会给出建议

| 限制 | 数值 | 在哪里看到建议 |
|---|---|---|
| PDF 文件大小 | 8 MB（Word 和 PowerPoint 为 40 MB） | 添加资料：文件下方的卡片 |
| PDF 页数 | 200 页 | 添加资料 |
| 单个文件提取出的文字 | 60 万字符 | 添加资料 |
| 一次出题所选资料 | 60 万字符，按 6 万字符一段切开 | 创建题组：按钮上方的卡片；缩小选择或选好检索工具之前不能生成 |
| 超过 300 页的文档 | 仅提示 | 资料页：这本书下面折叠的「大教材建议」 |

转换后的书**没有导入上限**（Markdown 文件最大 8 MB，JSON 文件最大 40 MB）；60 万字符的上限针对送去出题的内容，不针对你保存的内容。

## 步骤

1. 用 **StudyHub 自己运行的 MinerU** 转换 PDF：在「添加资料」里选**用 MinerU 解析**（本地 `mineru` 就绪就用它，否则用你自己的免费 MinerU 令牌，只需在设置里粘贴一次）。超过 200 页的书会自动分段、逐段转换、再合并，详见[用 MinerU 转换 PDF](mineru-conversion.zh-CN.md)。MinerU 桌面客户端、`mineru parse --pages` 命令行和 Docling 是手动的备选（在「高级」里）：导出带页码的 JSON 再拖进来。
2. 在**添加资料**里拖进导出的文件。StudyHub 按内容识别转换结果，一页保存为一份资料，并按标题把书分成章节。每一页保留页码，引用可以回到原页。
3. 在**创建题组**里展开这本书，点**选择章节**，勾选要学的章节。一章就是一组页面；也可以点**改为按页选择**。
4. 需要整本书出题时，点**安装检索扩展**（在卡片上，或在**设置 › 扩展：文档转换与检索**里），再点**为这门课建立检索索引**，然后在**这次想练什么？**写下主题。扩展的索引建好后，超过 15 万字符的选择会缩小到工具找到的页面（最多约 12 万字符）。点**预览会用到的页面**可以在生成前勾选或取消页面；**只用勾选的页面**会把选择换成这些页面。任务的执行过程里会写明用了哪些页面。

## 推荐的转换工具

2026-10-01 对照各项目自己的页面核对。协议和功能可能变化，以项目页面为准。

| 工具 | 协议 | 平台 | MCP | StudyHub 读取的输出 | 说明 |
|---|---|---|---|---|---|
| **MinerU**（推荐，由 StudyHub 自己运行：用你自己的令牌走云端，或用本地 `mineru`；桌面客户端和命令行是手动路线） | MinerU 开源许可证：Apache-2.0 加附加条件（月活超过 1 亿或月收入超过 2000 万美元需另行授权；在线服务需署名） | Windows、macOS、Linux（库需要 Python 3.10–3.14） | 项目本身没有（社区版服务调用它的云端 API） | `content_list.json`（v1 为平铺列表、带 `page_idx`；v2 按页分组）；Markdown 没有分页标记 | 能处理扫描件、公式、表格和中文。官网提供 Windows 和 macOS（Apple 芯片与 Intel）桌面客户端：[mineru.net/client](https://mineru.net/client)。该页没有说明客户端在本机解析还是在云端解析，处理私密资料前请先确认。GitHub 的 README 介绍的是命令行、SDK 和 WebUI，客户端在官网提供。CPU 即可运行（基础档 2 GB 内存），GPU 可选。 |
| **Docling**（高级：需要命令行） | MIT | Windows、macOS、Linux | `docling-mcp`（MIT；stdio、SSE、streamable HTTP） | JSON（`DoclingDocument`，`prov.page_no` 从 1 开始）；Markdown | 用命令行或 Python 运行：`docling file.pdf --to json`；OCR 引擎有 RapidOCR、EasyOCR、Tesseract（`--ocr-engine`、`--ocr-lang`）。没有桌面应用。 |

也核对过、但**不推荐**：

- **Marker**：代码是 Apache-2.0，模型权重使用改良的 OpenRAIL-M 协议，对商业使用有限制（研究、个人和融资不超过 500 万美元的初创团队免费）。它的 `--paginate_output` Markdown 可以被 StudyHub 读取（见下），已有的输出照常可用。
- **MarkItDown**（微软，MIT）：把多种格式转成给大模型用的 Markdown，但文档没有说明分页标记，扫描件要靠视觉模型插件或云服务。不适合需要按页引用的教材。

### 下载渠道

| 工具 | 官方 | 源码 | 安装包 | 中国大陆可用 |
|---|---|---|---|---|
| MinerU | [mineru.net](https://mineru.net/client) · [文档](https://opendatalab.github.io/MinerU/) | [GitHub](https://github.com/opendatalab/MinerU) | [PyPI](https://pypi.org/project/mineru/) | [ModelScope（OpenDataLab）](https://www.modelscope.cn/organization/OpenDataLab) · [PyPI 清华镜像](https://pypi.tuna.tsinghua.edu.cn/simple/mineru/) |
| Docling | [文档](https://docling-project.github.io/docling/) | [GitHub](https://github.com/docling-project/docling) · [docling-mcp](https://github.com/docling-project/docling-mcp) | [PyPI](https://pypi.org/project/docling/) | [PyPI 清华镜像](https://pypi.tuna.tsinghua.edu.cn/simple/docling/) |
| mcp-local-rag | | [GitHub](https://github.com/shinpr/mcp-local-rag) | npm | [npmmirror](https://registry.npmmirror.com/mcp-local-rag) |
| RAGFlow | [ragflow.io](https://ragflow.io/) · [MCP](https://ragflow.io/docs/use_ragflow_as_mcp_server) | [GitHub](https://github.com/infiniflow/ragflow) | Docker 镜像 | [Gitee](https://gitee.com/infiniflow/ragflow) |

「大陆可用」指中国境内托管的页面、模型库 ModelScope，或软件源镜像（清华 PyPI 镜像、npmmirror；DSH 自己的插件管理器也会回退到 npmmirror）。工具要从 Hugging Face 下载的模型文件，可能需要你所在网络提供的镜像；本文不推荐非官方镜像。

## 检索扩展（一键安装）

**设置 › 扩展：文档转换与检索**和「大教材建议」卡片里都有**安装检索扩展**。不用改任何文件，不用输入命令，也不用另装 Node、Python 或 Docker。

- **它是什么。**一个很小的配套扩展包 `@ericwang1358/studyhub-retrieval`，作为同一 StudyHub 版本的发布附件提供（`ericwang1358-studyhub-retrieval-<版本>.tgz`，SHA-256 写在 `SHA256SUMS-<版本>.txt` 里）。里面有一个 DSH 插件，用 DSH 自带的 MCP 客户端连接本地检索服务器 [mcp-local-rag](https://github.com/shinpr/mcp-local-rag)（MIT，固定到确切版本），它是这个扩展包的 npm 依赖。
- **怎么安装。**和 StudyHub 自己升级的方式一样：StudyHub 从项目的 GitHub 发布页下载附件，核对校验值，把核对过的文件放在 `<DSH 主目录>/study/updates`，再交给 DSH 的插件管理器（`ctx.pluginManager.installBundle`）。pnpm 随后从软件源取回服务器及其组件（默认源打不开时，DSH 会回退到 npmmirror）。pnpm 会拦下部分组件的安装脚本；StudyHub 把它们列出来，征得你同意后才放行。全新安装立即生效；替换已装的版本需要重启 DSH，页面会说明。
- **为什么不用另装别的就能跑。**插件用 DSH 自己运行所用的 Node（`process.execPath`；在 DSH 桌面版里它是以 Node 模式运行的 Electron，所以还会设置 `ELECTRON_RUN_AS_NODE=1`）启动服务器，并在自己旁边找到服务器的入口文件。服务器需要 Node 22 或更新；插件会检查，DSH 的 Node 太旧就不启动，并写日志说明原因。
- **建立索引。**点**为这门课建立检索索引**，课程的页面会逐页交给服务器，每页用自己的 id（`studyhub://source/<id>`），所以每条命中都能精确对应到页。只发送新的或改过的页，已不在资料库里的页会被移除；建立在后台进行，有进度和停止按钮。第一次建立会下载检索模型：约 90 MB，只下载一次（服务器文档如此说明），开始前页面会先告诉你；之后可以离线使用。
- **检索效果。**服务器默认的模型针对英文；中文教材照样能检索（它还会加关键词匹配），但语义匹配较弱。项目没有文档说明某个多语言模型，所以没有内置也不推荐。
- **模型下载不了时。**服务器文档用 `HF_ENDPOINT` 说明可以换下载地址。**高级 → 模型下载地址**保存一个地址（只能是 https），DSH 启动扩展时会传过去，所以改动要重启 DSH 才生效。这里不给出任何镜像地址：项目只说明了这个变量，没有说明镜像。
- **数据放在哪里。**索引和模型缓存在 `<DSH 主目录>/study/retrieval`；StudyHub 建过哪些索引记在 `<DSH 主目录>/study/retrieval/manifests`；检索提供方的选择在 `<DSH 主目录>/study/retrieval.json`。卸载只移除扩展包，这些数据保留。
- **自动选用。**索引建好后，除非你自己选过别的提供方，否则扩展会自动成为检索提供方。

## 高级：其他检索工具

StudyHub 通过 DSH 使用检索：DSH 的 MCP 客户端会把已配置的 MCP 服务器的每个工具注册成 `mcp__<服务器>__<工具>`，StudyHub 列出其中像搜索的工具（有文字参数，名称或说明里有 *search*、*query*、*retrieve*、*find*、*lookup*、*recall* 或 *rag*）。你在**设置 › 扩展：文档转换与检索**里选一个；**测试**会运行一次，并告诉你有多少段对应到了你资料里的页面。

| 工具 | 协议 | 需要 | 说明 |
|---|---|---|---|
| **mcp-local-rag**（扩展替你运行的就是它；手动用：需要 Node.js 和配置文件） | MIT | Node.js 22+（`npx`） | 本地向量模型和向量库；读 PDF、Word、Markdown 和文本；语义检索并加关键词加权（`RAG_HYBRID_WEIGHT`）。默认向量模型（`Xenova/all-MiniLM-L6-v2`）偏英文：中文教材请用 `MODEL_NAME` 换成多语言向量模型（须是兼容均值池化和归一化的 Hugging Face 模型，先看它的 README）。结果带段落文字和文件路径，没有页码，所以 StudyHub 靠段落文字对应到页：请把转换后的 Markdown 放进它读取的文件夹。 |
| **RAGFlow**（完整知识库） | Apache-2.0 | Docker；建议 4 核 CPU、16 GB 内存、50 GB 磁盘 | 带中文优先文档解析的网页应用，提供 MCP 接口（`/api/v1/mcp`，streamable HTTP）。先用转换后的书建一个知识库。共享的 API 密钥放在 RAGFlow 一侧（它设置里的 `mcp.host_api_key`），所以 DSH 配置里不含密钥。核对过的页面没有写明工具名和结果字段：StudyHub 读取 DSH 给出的参数说明，并按文字对应结果。 |

### 在 DSH 里手动添加

只在你不想用一键扩展时才需要：DSH 没有添加 MCP 服务器的界面，它是一条插件配置。把下面这段加到 DSH 主目录的 `cordis.patch.yml`（接在已有内容后面；开启热重载时 DSH 不用重启就会生效）。设置页和卡片里有同样的文字和**复制配置**按钮。

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

RAGFlow 则用 `transport: streamable-http` 和 `url: "http://127.0.0.1:9380/api/v1/mcp"`，不写 `command`、`args`、`env`。StudyHub 只看得到为整个 DSH 配置文件配置的服务器；只挂在某个智能体预设里的服务器看不到。

## 分步出题路径（2.5.8）

选择太大、一次生成不下时，应用按书的顺序把它切成若干步（`lib/generation-path.js`、`ui/GenerationPath.jsx`）；每一步是一个出题任务，也可以先和聊天里的 AI 一起商量整条路径。2.5.8 起：

- **一步既要字符少，也要页数少。** 一次 generate 大约 20 页、15 题以内写得好、审得好（`CALL_PAGES`、`CALL_QUESTIONS`，和 `STEP_CHARS` 放在一起；`STEP_PAGES` 等于 `CALL_PAGES`）。超过任一上限的章节或页段会被均匀切开（81 页切成 17+16+16+16+16，而不是 20+20+20+20+1），一步建议的题数最多 `CALL_QUESTIONS`。取舍：没有降低步的字符预算，也没有再做一套规划器；页数上限只是同一遍“切开再合并”里多一个界限。`MAX_STEPS`（40）仍然有意义：书太长、需要超过 40 步时（约 800 页以上），字符上限和页数上限一起放宽，不丢页面，brief 会让 AI 把这样的步拆成几次 generate。
- **步的名字来自目录**（文档的章节：学习者保留的目录，或转换器识别的标题）。被截断的名字（单个字母，比如索引的字母标题；末尾悬着的连字符或省略号；纯数字或罗马数字）绝不会用；没有可用名字的步就叫它的页码（“第 69–137 页”），名字只盖住一步的一部分时，会补上页码范围。
- **前后附文可选。** 标题是 Index、Colophon、About the Author、Acknowledgments、Table of Contents、Copyright、Dedication、Preface/Foreword、Appendix、Bibliography（和对应的中文，如索引、版记、作者介绍、致谢、目录、版权页、前言、附录、参考文献）的部分，第一章之前的页面，后半本书里连续的单字母章节（索引）以及索引/版记/作者介绍标题之后的所有页面，书末的空白页，各自单独成步。这些步默认不勾选，用文字标明（“可选 · 默认跳过（索引）”），勾上就包含；brief 里会写“建议跳过”。选中的全是附文时，什么都不跳过。
- **每一步写明它覆盖的页**（每本书按 PDF 页码连续成段；页面标题里 `p.` 后面的数字），面板里和给聊天 AI 的 brief 里都有；brief 还说明怎么取一段自定义页码的 sourceIds（`source.list`，`groupBy: "document"`，加 `memberOffset`/`memberLimit`）。
- **AI 能看到任务。** `job.status { jobId? }` 只读、马上返回（状态、阶段、`finished`、已存和要求的题数、草稿）；不带 `jobId` 时列出这个库的任务。`job.wait` 仍然是等一小会儿（最多 60 秒）。brief 让 AI 等上一步任务结束后再开始下一步，并且不要承诺之后自己汇报：两条消息之间它看不到任务。

## StudyHub 读取的转换结果

在**添加资料**里拖进文件即可，格式按内容识别。页码从 1 开始。

| 格式 | 识别依据 | 分页 |
|---|---|---|
| 带分页标记的 Markdown | `<!-- page: N -->` | 标记 N 之后的文字是第 N 页；第一个标记之前的文字并入第一页。 |
| Marker `--paginate_output` 的 Markdown | 一行 `{N}` 后面跟 20 个以上的短横线 | 页号从 0 开始（Marker 的页 id）时，`{N}...` 之后是第 N+1 页，否则是第 N 页。请确认第一页在 `{0}` 下面。 |
| MinerU `content_list.json` v1 | 平铺列表，条目有 `type` 和 `page_idx` | `page_idx` 从 0 开始。标题来自 `text_level`；表格（HTML）、公式（LaTeX）、代码、列表和图片说明保留为文字；页眉、页脚和页码丢弃。 |
| MinerU content list v2 | 页的列表，每页是块的列表 | 第 N 个列表是第 N 页。块的结构按宽松方式读取（标题块变成标题，`content` 字段里的文字保留）；核对过的页面没有公布 v2 的字段级说明，页面看起来不对时请改用 v1。 |
| Docling JSON | `schema_name: DoclingDocument` | 按阅读顺序读 body 树，`prov[].page_no`（从 1 开始）决定每项所在页。章节标题变成标题（文档标题是一级，章节从二级开始），表格变成 Markdown 表格；页眉页脚丢弃。 |

转换文字里的标题（`#` 行）成为这本书的目录。章节取「至少有两个标题的最浅一级」（只有书名一个标题不算）；一章延续到下一章开始的前一页。没有文字的页会跳过并提示。既不是 MinerU 也不是 Docling 输出的 JSON 会被拒绝，并指向题组导入。

导入的转换书没有原文件：页面本身就是依据，引用指向这些页。重复导入同一个文件不会新增内容。

## 给插件和工具作者的接口

### 检索提供方的约定

```
retrieve({ query, sourceIds?, course?, limit, signal? })
  -> [{ sourceId?, page?, document?, text, score }]
```

- `query`：学习者的主题（AI 带学里是目标那句话）。
- `sourceIds`：答案可以来自的 StudyHub 资料（一页一份）；`course` 是课程名（如果有）；`limit` 最多 40。
- `sourceId`：StudyHub 资料 id，最好的回答方式。自己索引一份副本的提供方可以给 `document`（文件名或标题）和 `page`，或只给 `text`：StudyHub 依次按资料 id、文档名加页码、选了单个分页文档时的纯页码、段落自己的文字来对应。
- `score`：越高越好；没有分数时按顺序当作名次。

### 另一个插件作为提供方

注册 cordis 服务 **`studyRetrieval`**；StudyHub 用 `ctx.get('studyRetrieval')` 读取：

```js
ctx.provide('studyRetrieval', { async retrieve({ query, sourceIds, course, limit, signal }) { return [{ sourceId, text, score }] } })
```

它在设置里显示为 `studyRetrieval`，学习者选了它才会使用。

### MCP 工具作为提供方

StudyHub 从 DSH 读取工具的 JSON 参数说明（`ctx.tools.schemas()`），把检索词填进文字参数（`query`、`q`、`question`、`search`、`search_query`、`text`、`keywords`、`prompt`、`input`，或唯一的字符串参数），把条数填进数字参数（`limit`、`top_k`、`k`、`n`、`max_results`、`num_results`、`count`），用 `ctx.tools.execute({ callId, name, arguments, signal })` 运行，并读取结果 `{ content: [...], structuredContent? }`：结构化内容、装着列表的 JSON 文本块（或带 `results`、`items`、`passages`、`hits`、`matches`、`chunks` 的对象）、`<entry><content>…</content><metadata>{…}</metadata></entry>` 块，或纯文本（`第 N 页` / `page N` 提示会成为页码）。有 StudyHub 填不了的必填参数时，这个工具不可用，设置页会说明。

### 动作

| 动作 | 用途 |
|---|---|
| `retrieval.status` | `{ selected, effective, missing?, explicit, hfEndpoint?, companion: { id, running }, extension: { canInstall, installed, enabled, version?, desktop }, hostCanSearch, providers, otherTools, limits }`（`extension` 由宿主处理器补上；扩展里有索引、且没有明确选过别的提供方时，它会成为 `effective`） |
| `retrieval.extension.install { approvedBuilds? }` | `{ status: 'installed', restartRequired, application, version }` 或 `{ status: 'needs-approval', pending }`（带上 `approvedBuilds` 再调用一次）；错误码 `extension-no-installer`、`extension-download`、`extension-checksum`、`extension-install` |
| `retrieval.extension.uninstall` | 移除扩展包；已选的扩展提供方回到 `builtin` |
| `retrieval.index.plan { course? }` | `{ course, pages, toIndex, unchanged, toRemove, chars, firstRun, modelMb, canIndex }` |
| `retrieval.index.start { course? }` / `.status` / `.cancel` | 后台建立：`{ runId, course, status: running\|complete\|failed\|cancelled, stage: preparing\|model\|indexing, done, total, added, removed, unchanged, failed, failedCount, firstRun, error?, errorCode? }`；每个资料库同一时间只有一个 |
| `retrieval.endpoint.set { endpoint }` | 扩展的模型下载地址（https，留空为默认） |
| `retrieval.set { provider, queryArg?, limitArg? }` | `provider`：`builtin`、`service` 或 `mcp:<工具>`；保存在 `$DSH_HOME/study/retrieval.json`（没有密钥） |
| `retrieval.test { query? }` | 无害地调用一次；`{ ok, hits, matched, unresolved }` |
| `retrieval.preview { sourceIds, query, course?, limit? }` | `{ provider, pages: [{ sourceId, title, page, score, snippet }], unresolved, hits }` |
| `materials.document.import` | 现在也接受转换结果（`.json`，或带分页标记的 Markdown / TXT） |
| `generate` | 选好提供方并写了 `focus` 时，把超过 15 万字符的选择缩小；任务记录 `retrieval: { provider, query, selected, used: [{ sourceId, title, page, score }], truncated, unresolved }` 或 `retrieval.error` |

超过 60 万字符又没有提供方时，`generate` 仍以原来的消息失败，并带 `code: 'selection-too-large'`；有提供方但没写主题时是 `retrieval-needs-topic`。提供方在仍然放得下的选择上出错，不会阻止生成：选择原样发送，任务记录原因。

AI 带学用同一个提供方，找出卡片引用了目标所匹配页面的主题。陪学的依据本来就只取每张卡片自己引用处周围的片段，不会发送整份文档，所以不需要检索。
