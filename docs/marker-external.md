# Parse PDFs directly with Marker

Choose the original PDF in **Add material → Files**, then select **MinerU** or **Marker**. Marker invokes the installed program and automatically imports its paginated result. Both converters share progress, cancellation, retry, and conversion history.

Open **Settings → PDF conversion (MinerU / Marker) → Marker** to check and save the `marker_single` executable: the path in the box is checked first and saved only if the check passes, so a path that does not work never replaces the saved one. A blank box only checks what StudyHub uses now. Enter its full path when it is installed in a virtual environment. An empty setting uses `MARKER_BIN` or the system search path. Enter an executable path, not a command with arguments.

The check confirms that the command runs and supports the required options; it does not verify every model or OCR backend. Once the environment is configured, choose a PDF and start parsing without downloading a script or finding an output file. The program runs on the StudyHub server's computer.

Completed ranges are cached for retry or another import of the same PDF. Marker and MinerU caches are separate. Cancellation stops the running conversion process. The first conversion may download models; missing dependencies and unreachable backends appear as task errors so you can fix the environment and resume.

## One-click install

In **Settings → PDF conversion → Marker**, press **One-click install Marker**. Nothing is installed until you press it. First the panel checks, read-only, that a Python 3.10+ is available, that the disk has room (estimates: about 4 GB on Windows, 3.5 GB on macOS, 8 GB on Linux) and that the folder is writable, and it lists the commands it will run. Then a background job creates a private virtual environment and installs `marker-pdf` in four stages: create the environment, install, verify (`marker_single --help` must support the options StudyHub uses) and write the program path into the Marker settings, so the path field is filled for you. Progress, **Cancel**, **Retry** and the raw pip log (folded) are in the panel, and the result survives a restart.

- Where: by default `<DSH home>/studyhub/marker` (for example `~/.dsh/studyhub/marker`). **Change location** uses the host's folder picker, or a typed full path when the host has none. The environment lives in the `venv` subfolder next to a small `.studyhub-marker.json` marker file. A folder that already holds other files is never installed into: a `StudyHub-Marker` folder is created inside it instead.
- Download source: the Tsinghua PyPI mirror (reachable in mainland China) or the official PyPI (needs an overseas network). The panel labels each one.
- Commands run, in your own user account and no administrator rights: `python -m venv <folder>/venv`, then `<folder>/venv/Scripts/python.exe` (Windows) or `<folder>/venv/bin/python` (macOS / Linux) `-m pip install --disable-pip-version-check --no-input --progress-bar off --timeout 60 [--index-url <mirror>] "marker-pdf>=1.10,<2"`, then `<folder>/venv/Scripts/marker_single.exe --help` (Windows) or `<folder>/venv/bin/marker_single --help`. Python is found as `py -3`, `python`, `python3` on Windows and `python3`, `python3.12`, `python3.11`, `python3.10`, `python` on macOS / Linux.
- No Python, or one that is too old: not an error. The panel lists where to get it (a mainland-reachable mirror first, then python.org) and enables the button after **Check again** finds it. On Debian-like Linux, install `python3-venv` and `python3-pip` too.
- Uninstall and move: **Uninstall** (after a confirmation) deletes only the `venv` folder and marker file the installer created, and clears the program path when it pointed there. **Install in another location…** installs elsewhere and removes the old environment only after the new one passes the check. A Marker you installed yourself is never touched.
- The state is kept in `<DSH home>/study/marker-install.json` (last 200 log lines). The assistant cannot start or remove an install; it is always your click.

The first conversion still downloads Marker's models and, for OCR, may need the inference backend described below. Installing the Python package alone does not prepare that.

## Marker 2.x and Docker

marker-pdf 2.x (2.0.0, July 2026) runs its OCR models through a separate inference server that it starts in **Docker** by default (`surya.inference.backends`). On a computer where Docker is missing or not running, every window that needs OCR exits with `SpawnError: docker run failed: ... dockerDesktopLinuxEngine ...`; `marker_single --help` cannot tell. The 1.x line runs the models inside Marker's own process with plain PyTorch, so:

- The one-click install asks pip for `marker-pdf>=1.10,<2` (1.10.2 at the time of writing; it pins `surya-ocr<0.18` and `transformers<5`).
- **检测并保存** and the Marker card read the installed version from the environment's `marker_pdf-<version>.dist-info` folder (no process is started). For a 2.x they also run `docker version --format {{.Server.Version}}` (8 s limit). Docker answers: the Marker is **ready** (2.x with Docker is a legitimate way to run it). Docker is not running or not installed: the state is **needs-docker**, and the card offers both ways out as equal choices: start Docker Desktop, wait until it says it is running, then **重新检测** (a failed conversion goes on with **接着做**); or **修复安装（改装 1.x）**, which runs the one-click install again in the same folder with the 1.x requirement (same stages and log; nothing else is removed). A Marker you installed yourself gets the same two choices, with `pip install "marker-pdf>=1.10,<2"` in its own environment instead of the repair button. If Docker gives no answer in time, nothing is blocked: the conversion itself will say.
- A new import is refused while the state is needs-docker (with the same sentence). A conversion that fails this way says so in its stage, its log and its 转换详情, puts **前往设置** first and keeps **接着做** second: after Docker is started (or the repair), 接着做 continues without redoing finished windows.

## The log of a conversion

The task's **日志** tab tells the run as it happens (the same lines on the original path and on the unified runtime):

- the start: the tool (Marker / MinerU, local or cloud), which Marker program (StudyHub's own install, the path saved in Settings, or one found on the search path; never the path itself), the Marker version and the Python version StudyHub's install recorded, the number of pages and the window plan;
- pages reused from an earlier attempt; one line when each window starts (pages a–b) and one when it ends (time taken, pages done of the total, time left estimated from the pace so far); a window that failed and, for MinerU's adaptive plan, the halves it is retried as;
- what Marker printed, as plain lines: a progress bar (tqdm redraws its line) becomes ONE line with its last state, at most the first 12 and the last 8 lines per window are kept and the rest is counted (「中间省略 N 行输出」); the bar Marker is drawing right now shows live in 转换详情, not in the log;
- the merge, the save (pages and characters), pages with no text, warnings, and a summary line (pages of material, its title, windows, retries, characters, total time);
- a failure: an error line with the cause and the last lines Marker printed (at most 12 lines, 2,000 characters, the END of the output: the last line of a Python traceback is its exception). 转换详情 shows the same under 失败原因, selectable, with **复制诊断信息**. The window's own error and the task's stage carry the cause first: `Marker 退出码 1：torch.OutOfMemoryError: CUDA out of memory ...`.

Nothing in the log or the failure names a folder of this computer: a path keeps only its last part (`File "vllm.py", line 195`), the temporary job folder, the library and the program path are removed, and anything shaped like a token is dropped. The log is bounded (200 lines per task on the original path, 300 on the runtime).

## Install separately

Read the [official installation guide](https://github.com/datalab-to/marker#installation), [inference prerequisites](https://github.com/datalab-to/marker#inference-backend-prerequisites) and [PyPI package page](https://pypi.org/project/marker-pdf/). To install by hand instead, run these commands in your own terminal. Python 3.10+ and a compatible PyTorch environment are required; use a separate virtual environment.

Windows PowerShell:

```powershell
py -m venv .venv-marker
.\.venv-marker\Scripts\python.exe -m pip install "marker-pdf>=1.10,<2"
.\.venv-marker\Scripts\marker_single.exe --help
```

macOS / Linux:

```sh
python3 -m venv .venv-marker
.venv-marker/bin/python -m pip install "marker-pdf>=1.10,<2"
.venv-marker/bin/marker_single --help
```

Installing the Python package alone may not prepare OCR inference. Current upstream instructions describe Docker and NVIDIA Container Toolkit for NVIDIA GPUs, or llama.cpp's `llama-server` for CPU / Apple Silicon. Follow the instructions for your installed version. Text-layer-only extraction is not equivalent to OCR of scanned pages.

Installation and initial execution may download dependencies and model files, and use disk, memory and processing time. Downloading the script does none of this. The script does not install missing dependencies, configure API keys or enable extra LLM enhancement. It inherits your existing Marker / Surya configuration: if you have configured a remote inference endpoint, document content may leave your computer. Check that configuration before processing private material.

## Convert outside the app (optional)

1. In the Marker settings section, select **Download Marker conversion script** and save `studyhub-marker-convert.py`.
2. Run it using the Python environment where you installed Marker. Without an input path, it opens a PDF picker. If a GUI or Tk is unavailable, provide the PDF path explicitly:

   Windows PowerShell:

   ```powershell
   .\.venv-marker\Scripts\python.exe "C:\Users\YourName\Downloads\studyhub-marker-convert.py" "D:\Course material\book.pdf"
   ```

   macOS / Linux:

   ```sh
   .venv-marker/bin/python "$HOME/Downloads/studyhub-marker-convert.py" "/path/to/book.pdf"
   ```

3. The script runs installed `marker_single` with `--output_format markdown --paginate_output`. It writes to a fresh output directory and prints the resulting `.md` paths without overwriting earlier output. A failed conversion or missing valid result produces an error.
4. Return to **Add material → Files** and drop the paginated `.md` into the ordinary file area. This optional external flow is separate from direct PDF parsing.

Alternatively, run Marker yourself:

```text
marker_single "book.pdf" --output_format markdown --paginate_output --output_dir "new-output-directory"
```

## Inspect the import

Marker paginated Markdown contains page separators starting with `{0}` followed by dashes. StudyHub converts zero-based page IDs to one-based pages and saves separate text sources. Direct parsing validates page markers before import. Markdown has an 8 MB import limit; split larger conversions and check their page numbering.

Choose a course before importing. Inspect reading order, page numbers, equations and tables: importing does not correct OCR errors. Then select pages or chapters for generation. Conversion does not automatically create a question deck. Imported results do not retain the original PDF for original-page viewing; citations point to the imported text pages. Separate extracted images are not imported in this flow.

## Licensing

Marker code uses Apache-2.0. Model weights have separate modified OpenRAIL-M terms. Read the [commercial-use description](https://github.com/datalab-to/marker#commercial-usage) and [model licence](https://github.com/datalab-to/marker/blob/master/MODEL_LICENSE). External installation or script invocation does not waive applicable obligations. StudyHub includes no Marker source, installer or model weights.

External documentation checked on 2026-10-04. The documentation and terms for your installed version govern. Compatibility tests use a fake command; real OCR quality on every hardware configuration has not been validated.
