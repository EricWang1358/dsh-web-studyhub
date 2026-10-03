# 大教材：先转换，再按章节选或检索

[English](large-documents.md)

StudyHub 读取 PDF 的文字层，按页保存，并把你选中的页面交给模型。讲义和单章没问题；一本一千页的教材放不进去，StudyHub 自己也不建检索索引。大教材最多分三步用：

1. **转换**：把 PDF 变成带页码和标题的文字。StudyHub 会替你运行 MinerU，扫描件、公式、表格和中文都能处理。整本书作为一份文档导入。
2. **按章节选**：出题时只勾选要学的章节。
3. **检索**（可选）：整本书出题时，检索扩展会找出与主题相关的页面，只把这些页面发给模型。

哪些要你自己装，哪些由 StudyHub 做：

- StudyHub 不会替你安装任何转换工具。本地 `mineru` 由你自己安装；云端解析用的是你自己的 MinerU 令牌。
- 检索扩展只在你点「安装检索扩展」时才安装。
- 手动路线的工具（MinerU 桌面客户端、Docling、RAGFlow、手动配置的检索服务器）都由你自己安装和运行。
- 只有 DeepSeek Harness（DSH）确实报告了某个检索工具，StudyHub 才会说它可用。

**云端暂不可用，优先使用本地 MinerU 和下载的模型。** 先自行安装，再在设置里确认模型下载；已保存云端令牌不会自动选择云端解析。桌面客户端目前也反馈不可用，保留为恢复后的高级备选。

## 什么时候会给出建议

| 限制 | 数值 | 在哪里看到建议 |
|---|---|---|
| PDF 文件大小 | 8 MB（Word 和 PowerPoint 为 40 MB） | 「添加资料」：文件下方的「大教材建议」卡片 |
| PDF 页数 | 200 页 | 「添加资料」：同一张卡片 |
| 单个文件提取出的文字 | 60 万字符 | 「添加资料」：同一张卡片 |
| 一次出题送出的文字 | 60 万字符，按 6 万字符一段切开 | 「创建题组」：资料列表下方的「大教材建议」卡片。缩小选择，或选好检索工具并写下主题之前，「生成并检查题组」不可点 |
| 超过 300 页的文档 | 仅提示 | 「资料」页：这本书下方折叠的「这份资料有 450 页，建议按章节使用」（页数以实际为准） |

转换后的书导入时没有页数和字数上限，只看文件大小（Markdown、TXT 最大 8 MB，JSON 最大 40 MB）。60 万字符的上限针对一次送去出题的内容，不针对你保存的内容。

## 使用大教材

1. **转换 PDF。** 在「添加资料」的「文件」标签里点「用 MinerU 解析」。如果某个 PDF 刚因为太大没能导入，它下方的「大教材建议」卡片也能直接转换这个文件。本地 `mineru` 就绪就优先用它，否则用你自己的 MinerU 令牌。超过 200 页的书会分段处理再合并，详见[用 MinerU 转换 PDF](mineru-conversion.zh-CN.md)。
2. **或者导入你自己转换好的文件。** 把导出的文件拖进「添加资料」。StudyHub 按内容识别转换结果，每页保存为一份资料，并按标题把书分成章节；每一页都保留页码，引用可以回到原页。手动路线在「高级：其他方式（桌面客户端、命令行、Docker）」里。
3. **选择章节。** 在「创建题组」的资料列表里找到这本书，点「选择章节」，勾选要学的章节。一章就是一组页面；也可以点「改为按页选择」。
4. **整本书检索（可选）。**
   1. 点「安装检索扩展」（卡片上或「设置 › 检索扩展」里都有）。
   2. 点「为这门课建立检索索引」。
   3. 在「这次想练什么？」写下主题。

   选好检索工具并写了主题后，超过 15 万字符的选择会缩小到工具找到的页面，最多约 12 万字符。点「预览会用到的页面」可以先勾选或取消页面；「只用勾选的页面」会把你的选择换成这些页。任务进度里会写明用了哪些页面。

## 分步出题

所选资料太大、一次生成效果不好时（超过 15 万字符，或超过约 20 页），「创建题组」会显示「分步生成路径」：按书的顺序把所选内容切成若干步。2.5.8 起：

- **每一步都很小。** 一步最多约 20 页，StudyHub 建议的题数最多 15 题。更长的章节会被均匀切开：81 页切成 17+16+16+16+16，而不是 20+20+20+20+1。
- **步的名字来自书的章节**（你保留的目录，或转换工具识别的标题）。只是半截词的名字不会用，例如单个字母（索引的字母标题）、末尾悬着的连字符或省略号、纯数字或罗马数字。没有可用名字的步就用页码命名（“第 69–137 页”）；名字只覆盖一步的一部分时，会补上页码范围。
- **前后附文可选。** 下面这些内容各自单独成步，默认不勾选，并用文字标明（“可选 · 默认跳过（索引）”）：
  - 标题为 Index、Colophon、About the Author、Acknowledgments、Table of Contents、Copyright、Dedication、Preface 或 Foreword、Appendix、Bibliography 的部分，以及对应的中文标题，如索引、版记、作者介绍、致谢、目录、版权页、前言、附录、参考文献；
  - 第一章之前的页面；
  - 后半本书里连续的单字母章节（索引），以及索引、版记或作者介绍标题之后的所有页面；
  - 书末的空白页。

  勾选就会包含这一步。选中的全是这类内容时，什么都不跳过。
- **每一步写明它覆盖的页**（PDF 页码，即页面标题里 “p.” 后面的数字），面板里和给对话 AI 的说明里都有。
- **路径上能做什么：**
  - 「只用这一步」：把这一步的页面和题数填进表单。
  - 「按路径逐步出题 · 5 步依次排队」（步数以实际为准）：每一步是一个独立的出题任务，按顺序排队；先完成的一步就可以先练。
  - 「让 AI 优化路径」：AI 可以改步的名字、写每一步要练什么、调整顺序，并为每一步建议 6–30 题；每一步覆盖的页面不会变。
  - 「和 AI 聊聊怎么学」：在主对话里和 AI 一起规划路径。
- **特别长的书**（超过 40 步，约 800 页以上）会放宽每一步，而不是丢掉页面；AI 会被告知把这样的步拆成几次出题。
- **两条消息之间，AI 看不到任务。** 你问的时候它才去查任务；它会等上一步结束再开始下一步，不会自己回来汇报。

## 检索扩展（一键安装）

「设置 › 检索扩展」和「大教材建议」卡片里都有「安装检索扩展」。不用改文件，不用输入命令，也不用另装 Node、Python 或 Docker。

- **它是什么。** 一个很小的配套扩展包 `@ericwang1358/studyhub-retrieval`，作为同一 StudyHub 版本的发布附件提供（`ericwang1358-studyhub-retrieval-<版本>.tgz`，SHA-256 写在 `SHA256SUMS-<版本>.txt` 里）。里面是一个 DSH 插件，用 DSH 自带的 MCP 客户端连接本地检索服务器 [mcp-local-rag](https://github.com/shinpr/mcp-local-rag)（MIT，固定到确切版本），它是扩展包的 npm 依赖。
- **怎么安装。** 和 StudyHub 自己升级的方式一样：
  1. StudyHub 从项目的 GitHub 发布页下载附件，核对校验值。
  2. 把核对过的文件放在 `<DSH 主目录>/study/updates`，交给 DSH 的插件管理器。
  3. pnpm 从软件源取回服务器及其组件；默认源连不上时，DSH 会回退到 npmmirror。
  4. pnpm 会拦下部分组件的安装脚本，StudyHub 把它们列出来，经你同意（「允许并继续」）才放行。

  全新安装立即生效；替换已装的版本要重启 DSH，页面会说明。已装的扩展比 StudyHub 旧时，页面会提供「更新检索扩展」。
- **为什么不用另装别的。** 插件用 DSH 自己运行的 Node 启动服务器，并在自己的包旁边找到服务器的入口文件。服务器需要 Node 22 或以上；DSH 的 Node 太旧时，插件不会启动它，并在日志里说明原因。
- **建立索引。** 点「为这门课建立检索索引」，课程的页面会逐页交给服务器，每页用自己的 id，所以每条命中都能精确对应到页。
  - 只发送新的或改过的页；已不在学习库里的页会被移除。
  - 在后台进行，有进度和「停止」按钮；已建好的部分会保留，下次接着建。
  - 「资料」页和「创建题组」的资料列表里，每份文档都标出索引状态：「还没建索引」「正在建立索引」「索引建了一部分」「索引需要更新」（有页面改过）或「索引已建好」，并带页数。
  - 第一次建立会下载检索模型：约 90 MB，只下载一次（服务器文档如此说明），开始前页面会先告诉你；之后可以离线使用。
- **检索效果。** 服务器默认的模型针对英文。中文教材照样能检索（它还会结合关键词匹配），但语义匹配较弱。项目没有说明哪个多语言模型可用，所以 StudyHub 没有内置，也不推荐。
- **模型下载不了时。** 服务器文档说明可以用 `HF_ENDPOINT` 换下载地址。在「设置 › 检索扩展」的「高级」里填「模型下载地址」（只能是 https），DSH 启动扩展时会把它传过去，所以改动要重启 DSH 才生效。这里不给出镜像地址：项目只说明了这个变量，没有说明镜像。
- **数据放在哪里。**
  - 索引和模型缓存：`<DSH 主目录>/study/retrieval`
  - StudyHub 建过哪些索引：`<DSH 主目录>/study/retrieval/manifests`
  - 你选用的检索工具：`<DSH 主目录>/study/retrieval.json`

  「卸载检索扩展」只移除扩展包，这些数据都保留，重新安装后可以继续用。
- **自动选用。** 索引建好后，除非你自己选过别的检索工具，否则自动使用检索扩展。

「学习流」用同一个检索，找出卡片引用了目标相关页面的主题。「陪学」不需要检索：它的依据本来就只取每张卡片引用处周围的文字，不会发送整份文档。

## 推荐的转换工具

2026-10-01 对照各项目自己的页面核对。协议和功能可能变化，以项目页面为准。

| 工具 | 协议 | 平台 | MCP | StudyHub 读取的输出 | 说明 |
|---|---|---|---|---|---|
| **MinerU**（推荐；由 StudyHub 运行：优先使用本地 `mineru` 和下载的模型；云端暂不可用。桌面客户端和命令行是手动路线） | MinerU 开源许可证：Apache-2.0 加附加条件（月活超过 1 亿或月收入超过 2000 万美元需另行授权；在线服务需署名） | Windows、macOS、Linux（库需要 Python 3.10–3.14） | 项目本身没有（社区版服务调用它的云端 API） | `content_list.json`（v1 为平铺列表，带 `page_idx`；v2 按页分组）。它的 Markdown 不带 `<!-- page: N -->` 分页标记 | 能处理扫描件、公式、表格和中文。官网提供 Windows 和 macOS（Apple 芯片与 Intel）桌面客户端：[mineru.net/client](https://mineru.net/client)。该页没有说明客户端在本机解析还是在云端解析，处理私密资料前请先确认。GitHub 的 README 介绍的是命令行、SDK 和 WebUI，没有介绍客户端。CPU 即可运行（基础档 2 GB 内存），GPU 可选。 |
| **Docling**（高级：需要命令行） | MIT | Windows、macOS、Linux | `docling-mcp`（MIT；stdio、SSE、streamable HTTP） | JSON（`DoclingDocument`，`prov.page_no` 从 1 开始）；Markdown | 用命令行或 Python 运行：`docling file.pdf --to json`。OCR 引擎有 RapidOCR、EasyOCR、Tesseract（`--ocr-engine`、`--ocr-lang`）。没有桌面应用。 |

也核对过、但**不推荐**：

- **Marker**：代码是 Apache-2.0，但模型权重使用改良的 OpenRAIL-M 协议，限制商业使用（研究、个人和融资不超过 500 万美元的初创团队免费）。StudyHub 仍能读取它的 `--paginate_output` Markdown（见[StudyHub 读取的转换结果](#studyhub-读取的转换结果)），已有的输出照常可用。
- **MarkItDown**（微软，MIT）：把多种格式转成给大模型用的 Markdown，但文档没有说明分页标记，扫描件要靠视觉模型插件或云服务。不适合需要按页引用的教材。

### 下载渠道

| 工具 | 官方 | 源码 | 安装包 | 国内可用 |
|---|---|---|---|---|
| MinerU | [mineru.net](https://mineru.net/client) · [文档](https://opendatalab.github.io/MinerU/) | [GitHub](https://github.com/opendatalab/MinerU) | [PyPI](https://pypi.org/project/mineru/) | [mineru.net API 文档与令牌管理](https://mineru.net/apiManage/docs) · [ModelScope（OpenDataLab）](https://www.modelscope.cn/organization/OpenDataLab) · [PyPI 清华镜像](https://pypi.tuna.tsinghua.edu.cn/simple/mineru/) |
| Docling | [文档](https://docling-project.github.io/docling/) | [GitHub](https://github.com/docling-project/docling) · [docling-mcp](https://github.com/docling-project/docling-mcp) | [PyPI](https://pypi.org/project/docling/) | [PyPI 清华镜像](https://pypi.tuna.tsinghua.edu.cn/simple/docling/) |
| mcp-local-rag | | [GitHub](https://github.com/shinpr/mcp-local-rag) | npm | [npmmirror](https://registry.npmmirror.com/mcp-local-rag) |
| RAGFlow | [ragflow.io](https://ragflow.io/) · [MCP](https://ragflow.io/docs/use_ragflow_as_mcp_server) | [GitHub](https://github.com/infiniflow/ragflow) | Docker 镜像 | [Gitee](https://gitee.com/infiniflow/ragflow) |

「国内可用」一栏是中国境内托管的页面、模型库 ModelScope，或软件源镜像（清华 PyPI 镜像、npmmirror；DSH 自己的插件管理器也会回退到 npmmirror）。工具要从 Hugging Face 下载的模型文件，可能需要你所在网络提供的镜像；本文不推荐非官方镜像。

## 高级：其他检索工具

StudyHub 通过 DSH 使用检索工具。DSH 的 MCP 客户端会把已配置的 MCP 服务器的每个工具注册成 `mcp__<服务器>__<工具>`，StudyHub 列出其中像搜索的工具：有文字参数，名称或说明里带 *search*、*query*、*retrieve*、*find*、*lookup*、*recall* 或 *rag*。

要选用其中一个，打开「设置 › 检索扩展」的「高级」，在「用哪个工具检索」里选。「测试」会运行一次，并告诉你有多少段对应到了你资料里的页面。

| 工具 | 协议 | 需要 | 说明 |
|---|---|---|---|
| **mcp-local-rag**（检索扩展替你运行的就是它；手动使用需要 Node.js 和配置文件） | MIT | Node.js 22 或以上（`npx`） | 本地向量模型和向量库；读 PDF、Word、Markdown 和文本；语义检索加关键词加权（`RAG_HYBRID_WEIGHT`）。默认向量模型（`Xenova/all-MiniLM-L6-v2`）偏英文；中文教材请用 `MODEL_NAME` 换成多语言向量模型，它必须是兼容均值池化和归一化的 Hugging Face 模型（先看它的 README）。结果带段落文字和文件路径，没有页码，所以 StudyHub 靠段落文字对应到页：请把转换后的 Markdown 放进它读取的文件夹。 |
| **RAGFlow**（完整知识库） | Apache-2.0 | Docker；建议 4 核 CPU、16 GB 内存、50 GB 磁盘 | 带中文优先文档解析的网页应用，提供 MCP 接口（`/api/v1/mcp`，streamable HTTP）。先用转换后的书建一个知识库。共享的 API 密钥放在 RAGFlow 一侧（它设置里的 `mcp.host_api_key`），所以 DSH 配置里没有密钥。核对过的页面没有写明工具名和结果字段：StudyHub 读取 DSH 报告的参数说明，并按文字对应结果。 |

### 在 DSH 里手动添加检索服务器

只在你不想用一键扩展时才需要。DSH 没有添加 MCP 服务器的界面，它是一条插件配置。把下面这段加到 DSH 主目录的 `cordis.patch.yml`，接在已有内容后面；开启热重载时 DSH 不用重启就会生效。卡片和设置里的「高级：手动配置」有同样的文字和「复制配置」按钮。

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

RAGFlow 则用 `transport: streamable-http` 和 `url: "http://127.0.0.1:9380/api/v1/mcp"`，不写 `command`、`args`、`env`。StudyHub 只看得到为整个 DSH 配置档配置的服务器，看不到只挂在某个智能体预设里的服务器。

## StudyHub 读取的转换结果

把转换好的文件拖进「添加资料」即可，格式按内容识别。页码从 1 开始。

| 格式 | 识别依据 | 分页 |
|---|---|---|
| 带分页标记的 Markdown | `<!-- page: N -->` | 标记 N 之后的文字是第 N 页；第一个标记之前的文字并入第一页。 |
| Marker `--paginate_output` 的 Markdown | 一行 `{N}` 后面跟 20 个以上的短横线 | 页号从 0 开始（Marker 的页 id）时，`{N}...` 之后是第 N+1 页，否则是第 N 页。请确认第一页在 `{0}` 下面。 |
| MinerU `content_list.json` v1 | 平铺列表，条目有 `type` 和 `page_idx` | `page_idx` 从 0 开始。标题来自 `text_level`；表格（HTML）、公式（LaTeX）、代码、列表和图片说明保留为文字；页眉、页脚和页码丢弃。 |
| MinerU content list v2 | 页的列表，每页是块的列表 | 第 N 个列表是第 N 页。块的结构按宽松方式读取：标题块变成标题，`content` 字段里的文字保留。核对过的页面没有公布 v2 的字段级说明，某页看起来不对时请改用 v1。 |
| Docling JSON | `schema_name: DoclingDocument` | 按阅读顺序读 body 树，`prov[].page_no`（从 1 开始）决定每项所在页。章节标题变成标题（文档标题是一级，章节从二级开始），表格变成 Markdown 表格；页眉页脚丢弃。 |

- **章节。** 转换文字里的标题（`#` 行）构成这本书的目录。章节取“至少有两个标题的最浅一级”，所以只有一个书名标题不算；一章延续到下一章开始的前一页。
- **跳过的页。** 没有文字的页会跳过并提示。
- **其他 JSON。** 既不是 MinerU 也不是 Docling 输出的 JSON 会被拒绝，并提示去「导入 JSON 题组」。
- **没有原文件。** 导入的转换书不保留 PDF：页面本身就是依据，引用指向这些页。重复导入同一个文件不会新增内容。
- **`mineru parse` 写出的 Markdown。** MinerU 命令行（4.0.x）用 `<!-- page N of TOTAL -->` 标记分页，导入时不认这种写法；自己转换的文件需要改成 `<!-- page: N -->` 标记。「用 MinerU 解析」会自己读取命令行的标记。

## 给插件和工具作者的接口

### 检索提供方的约定

```
retrieve({ query, sourceIds?, course?, limit, signal? })
  -> [{ sourceId?, page?, document?, text, score }]
```

- `query`：学习者的主题（在「学习流」里是目标那句话）。
- `sourceIds`：答案可以来自的 StudyHub 资料（一页一份）；`course` 是课程名（如果有）；`limit` 最多 40。
- `sourceId`：StudyHub 资料 id，最理想的返回方式。自己索引一份副本的提供方可以给 `document`（文件名或标题）和 `page`，或只给 `text`。StudyHub 依次按资料 id、文档名加页码、只选了一份分页文档时的单独页码、段落本身的文字来对应。
- `score`：越高越好；没有分数时，按顺序当作名次。

### 另一个插件作为提供方

注册 cordis 服务 **`studyRetrieval`**；StudyHub 用 `ctx.get('studyRetrieval')` 读取：

```js
ctx.provide('studyRetrieval', { async retrieve({ query, sourceIds, course, limit, signal }) { return [{ sourceId, text, score }] } })
```

它在设置里显示为 `studyRetrieval`，学习者选了它才会使用。

### MCP 工具作为提供方

StudyHub 从 DSH 读取工具的 JSON 参数说明（`ctx.tools.schemas()`），并填两个参数：

- 文字参数填检索词：`query`、`q`、`question`、`search`、`search_query`/`searchQuery`、`text`、`keywords`、`prompt`、`input`，或唯一的字符串参数；
- 数字参数填条数：`limit`、`top_k`/`topK`、`k`、`n`、`max_results`/`maxResults`、`num_results`/`numResults` 或 `count`。

然后用 `ctx.tools.execute({ callId, name, arguments, signal })` 运行，结果 `{ content: [...], structuredContent? }` 可以是下面任一种：

- 结构化内容，或装着列表的 JSON 文本块，或带 `results`、`items`、`passages`、`hits`、`matches`、`chunks`、`documents`、`data` 的对象；
- `<entry><content>…</content><metadata>{…}</metadata></entry>` 块；
- 纯文本，其中的 `第 N 页`、`page N` 或 `p. N` 提示会成为页码。

有 StudyHub 填不了的必填参数时，这个工具不可用，设置页会说明。

### 动作

| 动作 | 用途 |
|---|---|
| `retrieval.status` | `{ selected, effective, missing?, queryArg?, limitArg?, explicit, hfEndpoint?, companion: { id, running }, extension: { canInstall, installed, enabled, version?, error?, desktop, outdated?, expected? }, hostCanSearch, providers, otherTools, limits }`（`extension` 由宿主处理器补上；扩展里有索引、且没有明确选过别的提供方时，它会成为 `effective`） |
| `retrieval.extension.install { approvedBuilds? }` | `{ status: 'installed', restartRequired, application, version }` 或 `{ status: 'needs-approval', pending }`（带上 `approvedBuilds` 再调用一次）；错误码 `extension-no-installer`、`extension-download`、`extension-checksum`、`extension-install` |
| `retrieval.extension.uninstall` | 移除扩展包；已选的扩展提供方回到 `builtin` |
| `retrieval.index.plan { course? }` | `{ course, pages, toIndex, unchanged, toRemove, chars, firstRun, modelMb, canIndex }` |
| `retrieval.index.coverage` | `{ indexed, stale, missing, hasIndex, canIndex, building }`：分别列出页面已在索引里、建索引后改过、还没建索引的资料 id；`building` 是正在进行的建立（如果有） |
| `retrieval.index.start { course? }` / `.status` / `.cancel` | 后台建立：`{ runId, course, status: running\|complete\|failed\|cancelled, stage: preparing\|model\|indexing, done, total, added, removed, unchanged, failed, failedCount, firstRun, error?, errorCode? }`；每个学习库同一时间只建一个 |
| `retrieval.endpoint.set { endpoint }` | 扩展的模型下载地址（https，留空为默认） |
| `retrieval.set { provider, queryArg?, limitArg? }` | `provider`：`builtin`、`service` 或 `mcp:<工具>`；保存在 `$DSH_HOME/study/retrieval.json`（不含密钥） |
| `retrieval.test { query? }` | 无害地调用一次；`{ ok, hits, matched, unresolved }` |
| `retrieval.preview { sourceIds, query, course?, limit? }` | `{ provider, pages: [{ sourceId, title, page, score, snippet }], unresolved, hits }` |
| `materials.document.import` | 也接受转换结果（`.json`，或带分页标记的 Markdown / TXT） |
| `generate` | 选好提供方并写了 `focus` 时，把超过 15 万字符的选择缩小；任务记录 `retrieval: { provider, query, selected, used: [{ sourceId, title, page, score }], truncated, unresolved }` 或 `retrieval.error` |

- 超过 60 万字符又没有提供方时，`generate` 仍以原来的消息失败，并带 `code: 'selection-too-large'`；有提供方但没写主题时是 `retrieval-needs-topic`。
- 提供方在仍然放得下的选择上出错，不会阻止生成：选择原样发送，任务记录原因。

### 扩展的内部细节

- 插件用 `process.execPath` 启动服务器；在 DSH 桌面版里它是以 Node 模式运行的 Electron，所以还会设置 `ELECTRON_RUN_AS_NODE=1`。
- 安装时把核对过的扩展包交给 `ctx.pluginManager.installBundle`。
- 页面以 `studyhub://source/<id>` 建立索引。

### 分步生成路径

路径由 `lib/generation-path.js` 规划，由 `ui/GenerationPath.jsx` 显示。每一步是一个出题任务，也可以先和对话 AI 商量整条路径。

- 一次 generate 大约 `CALL_PAGES`（20）页、`CALL_QUESTIONS`（15）题以内写得好、审得好；这两个常量和 `STEP_CHARS`（15 万）放在一起，`STEP_PAGES` 等于 `CALL_PAGES`。
- 设计取舍：没有降低每一步的字符预算，也没有再加一个规划器；页数上限只是同一遍“切开再合并”里多出的一个界限。
- `MAX_STEPS`（40）仍然有意义：书需要更多步时，字符上限和页数上限一起放宽，不丢页面。
- 给 AI 的说明里写了怎么取一段自定义页码的 sourceIds：`source.list`，`groupBy: "document"`，再加 `memberOffset`/`memberLimit`。
- 给 AI 的说明把没有勾选的步（前后附文）列为要跳过的步。
- `job.status { jobId? }` 只读、立即返回：状态、阶段、`finished`、已存和要求的题数、草稿；不带 `jobId` 时列出这个学习库的任务。`job.wait` 仍是一次有上限的等待，最多 60 秒。
