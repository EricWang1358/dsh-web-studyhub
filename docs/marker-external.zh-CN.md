# 用 Marker 直接解析 PDF

在 **添加资料 → 文件** 中选择原 PDF，再选择 **MinerU** 或 **Marker**。Marker 调用已安装的程序，后台转换后自动按页导入资料。两种工具共用进度、取消、失败后继续和解析历史流程。

打开 **设置 → PDF 转换（MinerU / Marker）→ Marker**，检测并保存 `marker_single` 程序：输入框里的路径先检测，通过才保存，没有通过的路径不会替换已保存的路径；输入框留空只检测当前正在使用的程序。虚拟环境中的程序需要填写完整路径，例如 `C:\工具\marker-env\Scripts\marker_single.exe`。留空时使用 `MARKER_BIN` 或系统搜索路径；请填写可执行文件路径，不要填写带参数的命令。

程序检测确认命令能运行并支持所需选项，不代表模型与 OCR 后端已经就绪。完成下面的安装配置后，直接在添加资料窗口选择 PDF 并开始解析，无需下载脚本或寻找输出文件。程序运行在 StudyHub 服务所在的电脑上。

已完成的片段会缓存，失败后继续或重新导入同一份 PDF 可以复用；Marker 与 MinerU 的缓存独立。取消会停止当前转换进程。首次转换可能下载模型，缺失依赖或后端无法连接会显示在任务错误中，修复环境后可以继续。

## 一键安装

在 **设置 → PDF 转换 → Marker** 点 **一键安装 Marker**。点之前不会安装任何东西。面板先做只读检查：有没有 3.10 及以上的 Python、磁盘空间够不够（估算：Windows 约 4 GB，macOS 约 3.5 GB，Linux 约 8 GB）、安装位置能不能写，并列出将要运行的命令。然后后台任务创建一个独立的虚拟环境并安装 `marker-pdf`，分四步：创建环境、安装、验证（`marker_single --help` 必须支持 StudyHub 用到的选项）、把程序路径写进 Marker 设置，所以路径框会自动填好。进度、**取消**、**重试** 和折叠的 pip 原始日志都在面板里，重启后结果仍在。

- 位置：默认 `<DSH 主目录>/studyhub/marker`（例如 `~/.dsh/studyhub/marker`）。**更改位置** 使用宿主的文件夹选择器；宿主没有时输入完整路径。环境放在 `venv` 子文件夹，旁边有一个很小的 `.studyhub-marker.json` 标记文件。里面已有其他文件的文件夹不会被安装进去：改为在其中新建 `StudyHub-Marker` 文件夹。
- 下载源：清华 PyPI 镜像（大陆可直连）或官方 PyPI（需要海外网络），面板上各有标注。
- 运行的命令（用你自己的用户身份，不需要管理员权限）：`python -m venv <文件夹>/venv`，然后 `<文件夹>/venv/Scripts/python.exe`（Windows）或 `<文件夹>/venv/bin/python`（macOS / Linux）`-m pip install --disable-pip-version-check --no-input --progress-bar off --timeout 60 [--index-url <镜像>] "marker-pdf>=1.10,<2"`，最后 `<文件夹>/venv/Scripts/marker_single.exe --help`（Windows）或 `<文件夹>/venv/bin/marker_single --help`。Windows 上依次找 `py -3`、`python`、`python3`，macOS / Linux 上依次找 `python3`、`python3.12`、`python3.11`、`python3.10`、`python`。
- 没有 Python 或版本太旧：不算失败。面板会列出获取渠道（先给大陆可直连的镜像，再给 python.org），装好后点 **重新检测** 即可启用按钮。Debian 类 Linux 还需要 `python3-venv` 和 `python3-pip`。
- 卸载与迁移：**卸载**（确认后）只删除安装器创建的 `venv` 文件夹和标记文件，并在程序路径指向它时清空路径。**安装到其他位置…** 会在新环境通过检测后才删除旧环境。你自己装的 Marker 不会被动。
- 状态保存在 `<DSH 主目录>/study/marker-install.json`（保留最近 200 行日志）。助手不能启动或删除安装，只能由你点击。

第一次解析仍会下载 Marker 的模型；做 OCR 还可能需要下面说明的推理后端，只装 Python 包并不会准备好它们。

## Marker 2.x 与 Docker

marker-pdf 2.x（2.0.0，2026 年 7 月）把 OCR 模型放在单独的推理服务里运行，默认用 **Docker** 启动这个服务（`surya.inference.backends`）。这台电脑没有 Docker 或 Docker 没有运行时，每个需要 OCR 的分段都会以 `SpawnError: docker run failed: ... dockerDesktopLinuxEngine ...` 退出；`marker_single --help` 看不出这一点。1.x 直接在 Marker 自己的进程里用 PyTorch 跑模型，所以：

- 一键安装让 pip 装 `marker-pdf>=1.10,<2`（写这份说明时是 1.10.2，它会固定 `surya-ocr<0.18` 和 `transformers<5`）。
- **检测并保存** 和 Marker 卡片从环境里的 `marker_pdf-<版本>.dist-info` 文件夹读出已安装的版本（不启动任何程序）。是 2.x 时再运行一次 `docker version --format {{.Server.Version}}`（最多等 8 秒）。Docker 有回应：Marker **已就绪**（2.x 配 Docker 是正当的用法）。Docker 没有运行或没有安装：状态是 **needs-docker**，卡片并列给出两条路：启动 Docker Desktop，等它显示正在运行后点 **重新检测**（失败的转换任务点 **接着做** 继续）；或者点 **修复安装（改装 1.x）**，它在同一个位置按 1.x 的要求重新跑一遍一键安装（同样的步骤和日志，不删除别的东西）。你自己装的 Marker 也有这两条路，只是没有修复按钮，改为在它自己的环境里运行 `pip install "marker-pdf>=1.10,<2"`。Docker 在时限内没有回应时不拦任何操作，由转换本身说明结果。
- 状态是 needs-docker 时，新的导入会被拒绝（给出同一句说明）。因此失败的转换会在阶段、日志和转换详情里说明原因，把 **前往设置** 放在第一位，**接着做** 放在第二位：启动 Docker（或修复安装）后点接着做，已完成的分段不会重做。

## 转换日志

任务的 **日志** 标签实时讲述这次转换（原有路径和统一运行时写的是同样的行）：

- 开始：用的工具（Marker / MinerU，本机或云端）、哪一个 Marker 程序（StudyHub 安装的、设置里填写的，或在搜索路径里找到的；从不写出路径本身）、Marker 版本和 StudyHub 安装时记录的 Python 版本、页数和分段方式；
- 复用了之前转换好的页；每段开始一行（第 a–b 页），结束一行（用时、已完成多少页、按目前速度预计还需多久）；没有完成的分段，以及 MinerU 自适应分段把它拆成两半重试；
- Marker 自己的输出，逐行写成纯文本：进度条（tqdm 会反复重画同一行）只记成 **一行**，即它最后的状态；每段最多保留开头 12 行和最后 8 行，中间的只计数（「中间省略 N 行输出」）；Marker 正在画的进度条实时显示在转换详情里，不写进日志；
- 合并、保存（页数和字数）、没有文字的页、提醒，以及一行总结（资料页数、标题、分段数、重试次数、字数、总用时）；
- 失败：一行错误，带原因和 Marker 最后输出的几行（最多 12 行、2000 字，保留输出的 **末尾**：Python 报错的最后一行才是异常本身）。转换详情的 **失败原因** 显示同样的内容，可以选中，并有 **复制诊断信息**。分段自己的错误和任务阶段都把原因放在最前面：`Marker 退出码 1：torch.OutOfMemoryError: CUDA out of memory ...`。

日志和失败原因里不会出现这台电脑的文件夹：路径只保留最后一段（`File "vllm.py", line 195`），临时任务文件夹、资料库和程序路径都会去掉，像令牌的内容也会删除。日志有上限（原有路径每个任务 200 行，统一运行时 300 行）。

## 手动安装与运行条件

先查看 [Marker 官方安装说明](https://github.com/datalab-to/marker#installation)、[推理后端要求](https://github.com/datalab-to/marker#inference-backend-prerequisites)和 [PyPI 安装包](https://pypi.org/project/marker-pdf/)。想手动安装时，以下命令在你自己打开的终端中执行。

需要 Python 3.10 或以上及 Marker 所需的 PyTorch 环境。建议使用独立虚拟环境，避免影响其他项目。Windows PowerShell：

```powershell
py -m venv .venv-marker
.\.venv-marker\Scripts\python.exe -m pip install "marker-pdf>=1.10,<2"
.\.venv-marker\Scripts\marker_single.exe --help
```

macOS / Linux：

```sh
python3 -m venv .venv-marker
.venv-marker/bin/python -m pip install "marker-pdf>=1.10,<2"
.venv-marker/bin/marker_single --help
```

这只是 Python 包的安装。按当前官方说明，OCR / VLM 推理可能还需要 NVIDIA GPU 路线的 Docker 与 NVIDIA Container Toolkit，或 CPU / Apple Silicon 路线的 `llama-server`（llama.cpp）；请按你安装版本的说明准备。只读纯文本层的模式与完整 OCR 能力不同，不能把它当作扫描件解析成功。

安装和首次运行可能联网下载依赖、模型，占用磁盘、内存与处理时间。只下载脚本不会发生这些操作。脚本不启用额外 LLM 增强、不设置 API Key，也不自动安装缺失依赖。运行会沿用你现有的 Marker / Surya 配置；如果配置了远程推理地址，内容可能发送到该地址，请先核对配置，不能仅凭“外部脚本”认定所有数据都留在本机。

## 在应用外转换（可选）

1. 在设置的 Marker 区域点击 **下载 Marker 转换脚本**，保存 `studyhub-marker-convert.py`。
2. 用安装 Marker 的 Python 环境运行脚本。无 PDF 参数时会打开文件选择框；没有图形界面或 Tk 支持时，直接传入路径：

   Windows PowerShell：

   ```powershell
   .\.venv-marker\Scripts\python.exe "C:\Users\你的用户名\Downloads\studyhub-marker-convert.py" "D:\课程资料\教材.pdf"
   ```

   macOS / Linux：

   ```sh
   .venv-marker/bin/python "$HOME/Downloads/studyhub-marker-convert.py" "/path/to/教材.pdf"
   ```

3. 脚本调用已安装的 `marker_single`，使用 `--output_format markdown --paginate_output`，在新的输出目录写入结果并打印 `.md` 的位置，不覆盖旧结果。转换失败或未找到有效结果时会明确报错。
4. 回到 **添加资料 → 文件**，把打印路径中的分页 `.md` 拖入普通文件区域。这是可选的外部转换流程，直接解析 PDF 不需要这一步。

如果不使用脚本，也可以自己运行：

```text
marker_single "教材.pdf" --output_format markdown --paginate_output --output_dir "新建的结果目录"
```

## 导入后检查

分页 Markdown 中应有 Marker 的 `{0}` 加短横线页分隔标记；StudyHub 把 0 起始页号转换成 1 起始页号，按页保存。直接解析会先检查分页标记再导入，避免把整本书当成单页。Markdown 文件导入上限为 8 MB，过大时请分段转换并检查页码。

先选好课程，再导入结果。检查预览中的阅读顺序、页码、公式与表格；OCR 的错误不会因导入自动纠正。然后按页或章节选择资料出题。转换结果不会自动变成题组，也不保留可回看的原 PDF 页面；引用指向导入的文本页。本次不导入 Marker 单独导出的图片资源。

## 许可

Marker 的代码采用 Apache-2.0，模型权重采用另行约定的修改版 OpenRAIL-M，使用与分发条件不同。请阅读 [官方商业使用说明](https://github.com/datalab-to/marker#commercial-usage)及 [MODEL_LICENSE](https://github.com/datalab-to/marker/blob/master/MODEL_LICENSE)。用户自行安装、通过脚本调用，不免除相应许可义务。StudyHub 不附带 Marker 的源代码、安装包或模型权重。

外部说明核对日期：2026-10-04。安装版本的官方文档和许可为准；脚本兼容性测试使用模拟命令，不代表所有硬件上的真实 OCR 效果都已验证。
