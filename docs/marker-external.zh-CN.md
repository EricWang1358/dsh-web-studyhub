# 用外部 Marker 转换 PDF

在 **添加资料 → 文件** 中，MinerU 和 Marker 是并列的 PDF 解析方案。Marker 的 **选择转换结果** 用于导入分页 Markdown，**安装与使用设置** 跳转到 **设置 → PDF 转换（MinerU / Marker）** 的 Marker 区域，查看安装说明并下载转换脚本。StudyHub 只生成脚本和读取你选中的结果，不安装、启动或捆绑 Marker 及其模型。

## 安装与运行条件

先查看 [Marker 官方安装说明](https://github.com/datalab-to/marker#installation)、[推理后端要求](https://github.com/datalab-to/marker#inference-backend-prerequisites)和 [PyPI 安装包](https://pypi.org/project/marker-pdf/)。以下命令在你自己打开的终端中执行，StudyHub 不会代为执行。

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

## 下载并运行脚本

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
4. 回到 **添加资料 → 文件**，在 Marker 方案中点击 **选择转换结果**，选择打印路径中的分页 `.md`。也可以拖入普通文件区域。当前专用入口不接收原 PDF 或 Marker 原生 JSON。

如果不使用脚本，也可以自己运行：

```text
marker_single "教材.pdf" --output_format markdown --paginate_output --output_dir "新建的结果目录"
```

## 导入后检查

分页 Markdown 中应有 Marker 的 `{0}` 加短横线页分隔标记；StudyHub 把 0 起始页号转换成 1 起始页号，按页保存。没有分页标记时，专用入口会提示重新转换，避免把整本书当成单页。Markdown 文件导入上限为 8 MB，过大时请分段转换并检查页码。

先选好课程，再导入结果。检查预览中的阅读顺序、页码、公式与表格；OCR 的错误不会因导入自动纠正。然后按页或章节选择资料出题。转换结果不会自动变成题组，也不保留可回看的原 PDF 页面；引用指向导入的文本页。本次不导入 Marker 单独导出的图片资源。

## 许可

Marker 的代码采用 Apache-2.0，模型权重采用另行约定的修改版 OpenRAIL-M，使用与分发条件不同。请阅读 [官方商业使用说明](https://github.com/datalab-to/marker#commercial-usage)及 [MODEL_LICENSE](https://github.com/datalab-to/marker/blob/master/MODEL_LICENSE)。用户自行安装、通过脚本调用，不免除相应许可义务。StudyHub 不附带 Marker 的源代码、安装包或模型权重。

外部说明核对日期：2026-10-04。安装版本的官方文档和许可为准；脚本兼容性测试使用模拟命令，不代表所有硬件上的真实 OCR 效果都已验证。
