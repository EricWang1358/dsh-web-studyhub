# 用 Marker 直接解析 PDF

在 **添加资料 → 文件** 中选择原 PDF，再选择 **MinerU** 或 **Marker**。Marker 调用已安装的程序，后台转换后自动按页导入资料。两种工具共用进度、取消、失败后继续和解析历史流程。

打开 **设置 → PDF 转换（MinerU / Marker）→ Marker**，保存并检测 `marker_single` 程序。虚拟环境中的程序需要填写完整路径，例如 `C:\工具\marker-env\Scripts\marker_single.exe`。留空时使用 `MARKER_BIN` 或系统搜索路径；请填写可执行文件路径，不要填写带参数的命令。

程序检测确认命令能运行并支持所需选项，不代表模型与 OCR 后端已经就绪。完成下面的安装配置后，直接在添加资料窗口选择 PDF 并开始解析，无需下载脚本或寻找输出文件。程序运行在 StudyHub 服务所在的电脑上。

已完成的片段会缓存，失败后继续或重新导入同一份 PDF 可以复用；Marker 与 MinerU 的缓存独立。取消会停止当前转换进程。首次转换可能下载模型，缺失依赖或后端无法连接会显示在任务错误中，修复环境后可以继续。

## 一键安装

在 **设置 → PDF 转换 → Marker** 点 **一键安装 Marker**。点之前不会安装任何东西。面板先做只读检查：有没有 3.10 及以上的 Python、磁盘空间够不够（估算：Windows 约 4 GB，macOS 约 3.5 GB，Linux 约 8 GB）、安装位置能不能写，并列出将要运行的命令。然后后台任务创建一个独立的虚拟环境并安装 `marker-pdf`，分四步：创建环境、安装、验证（`marker_single --help` 必须支持 StudyHub 用到的选项）、把程序路径写进 Marker 设置，所以路径框会自动填好。进度、**取消**、**重试** 和折叠的 pip 原始日志都在面板里，重启后结果仍在。

- 位置：默认 `<DSH 主目录>/studyhub/marker`（例如 `~/.dsh/studyhub/marker`）。**更改位置** 使用宿主的文件夹选择器；宿主没有时输入完整路径。环境放在 `venv` 子文件夹，旁边有一个很小的 `.studyhub-marker.json` 标记文件。里面已有其他文件的文件夹不会被安装进去：改为在其中新建 `StudyHub-Marker` 文件夹。
- 下载源：清华 PyPI 镜像（大陆可直连）或官方 PyPI（需要海外网络），面板上各有标注。
- 运行的命令（用你自己的用户身份，不需要管理员权限）：`python -m venv <文件夹>/venv`，然后 `<文件夹>/venv/Scripts/python.exe`（Windows）或 `<文件夹>/venv/bin/python`（macOS / Linux）`-m pip install --disable-pip-version-check --no-input --progress-bar off --timeout 60 [--index-url <镜像>] marker-pdf`，最后 `<文件夹>/venv/Scripts/marker_single.exe --help`（Windows）或 `<文件夹>/venv/bin/marker_single --help`。Windows 上依次找 `py -3`、`python`、`python3`，macOS / Linux 上依次找 `python3`、`python3.12`、`python3.11`、`python3.10`、`python`。
- 没有 Python 或版本太旧：不算失败。面板会列出获取渠道（先给大陆可直连的镜像，再给 python.org），装好后点 **重新检测** 即可启用按钮。Debian 类 Linux 还需要 `python3-venv` 和 `python3-pip`。
- 卸载与迁移：**卸载**（确认后）只删除安装器创建的 `venv` 文件夹和标记文件，并在程序路径指向它时清空路径。**安装到其他位置…** 会在新环境通过检测后才删除旧环境。你自己装的 Marker 不会被动。
- 状态保存在 `<DSH 主目录>/study/marker-install.json`（保留最近 200 行日志）。助手不能启动或删除安装，只能由你点击。

第一次解析仍会下载 Marker 的模型；做 OCR 还可能需要下面说明的推理后端，只装 Python 包并不会准备好它们。

## 手动安装与运行条件

先查看 [Marker 官方安装说明](https://github.com/datalab-to/marker#installation)、[推理后端要求](https://github.com/datalab-to/marker#inference-backend-prerequisites)和 [PyPI 安装包](https://pypi.org/project/marker-pdf/)。想手动安装时，以下命令在你自己打开的终端中执行。

需要 Python 3.10 或以上及 Marker 所需的 PyTorch 环境。建议使用独立虚拟环境，避免影响其他项目。Windows PowerShell：

```powershell
py -m venv .venv-marker
.\.venv-marker\Scripts\python.exe -m pip install marker-pdf
.\.venv-marker\Scripts\marker_single.exe --help
```

macOS / Linux：

```sh
python3 -m venv .venv-marker
.venv-marker/bin/python -m pip install marker-pdf
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
