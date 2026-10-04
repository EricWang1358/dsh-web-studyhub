# Parse PDFs directly with Marker

Choose the original PDF in **Add material → Files**, then select **MinerU** or **Marker**. Marker invokes the installed program and automatically imports its paginated result. Both converters share progress, cancellation, retry, and conversion history.

Open **Settings → PDF conversion (MinerU / Marker) → Marker** to save and check the `marker_single` executable. Enter its full path when it is installed in a virtual environment. An empty setting uses `MARKER_BIN` or the system search path. Enter an executable path, not a command with arguments.

The check confirms that the command runs and supports the required options; it does not verify every model or OCR backend. Once the environment is configured, choose a PDF and start parsing without downloading a script or finding an output file. The program runs on the StudyHub server's computer.

Completed ranges are cached for retry or another import of the same PDF. Marker and MinerU caches are separate. Cancellation stops the running conversion process. The first conversion may download models; missing dependencies and unreachable backends appear as task errors so you can fix the environment and resume.

## One-click install

In **Settings → PDF conversion → Marker**, press **One-click install Marker**. Nothing is installed until you press it. First the panel checks, read-only, that a Python 3.10+ is available, that the disk has room (estimates: about 4 GB on Windows, 3.5 GB on macOS, 8 GB on Linux) and that the folder is writable, and it lists the commands it will run. Then a background job creates a private virtual environment and installs `marker-pdf` in four stages: create the environment, install, verify (`marker_single --help` must support the options StudyHub uses) and write the program path into the Marker settings, so the path field is filled for you. Progress, **Cancel**, **Retry** and the raw pip log (folded) are in the panel, and the result survives a restart.

- Where: by default `<DSH home>/studyhub/marker` (for example `~/.dsh/studyhub/marker`). **Change location** uses the host's folder picker, or a typed full path when the host has none. The environment lives in the `venv` subfolder next to a small `.studyhub-marker.json` marker file. A folder that already holds other files is never installed into: a `StudyHub-Marker` folder is created inside it instead.
- Download source: the Tsinghua PyPI mirror (reachable in mainland China) or the official PyPI (needs an overseas network). The panel labels each one.
- Commands run, in your own user account and no administrator rights: `python -m venv <folder>/venv`, then `<folder>/venv/Scripts/python.exe` (Windows) or `<folder>/venv/bin/python` (macOS / Linux) `-m pip install --disable-pip-version-check --no-input --progress-bar off --timeout 60 [--index-url <mirror>] marker-pdf`, then `<folder>/venv/Scripts/marker_single.exe --help` (Windows) or `<folder>/venv/bin/marker_single --help`. Python is found as `py -3`, `python`, `python3` on Windows and `python3`, `python3.12`, `python3.11`, `python3.10`, `python` on macOS / Linux.
- No Python, or one that is too old: not an error. The panel lists where to get it (a mainland-reachable mirror first, then python.org) and enables the button after **Check again** finds it. On Debian-like Linux, install `python3-venv` and `python3-pip` too.
- Uninstall and move: **Uninstall** (after a confirmation) deletes only the `venv` folder and marker file the installer created, and clears the program path when it pointed there. **Install in another location…** installs elsewhere and removes the old environment only after the new one passes the check. A Marker you installed yourself is never touched.
- The state is kept in `<DSH home>/study/marker-install.json` (last 200 log lines). The assistant cannot start or remove an install; it is always your click.

The first conversion still downloads Marker's models and, for OCR, may need the inference backend described below. Installing the Python package alone does not prepare that.

## Install separately

Read the [official installation guide](https://github.com/datalab-to/marker#installation), [inference prerequisites](https://github.com/datalab-to/marker#inference-backend-prerequisites) and [PyPI package page](https://pypi.org/project/marker-pdf/). To install by hand instead, run these commands in your own terminal. Python 3.10+ and a compatible PyTorch environment are required; use a separate virtual environment.

Windows PowerShell:

```powershell
py -m venv .venv-marker
.\.venv-marker\Scripts\python.exe -m pip install marker-pdf
.\.venv-marker\Scripts\marker_single.exe --help
```

macOS / Linux:

```sh
python3 -m venv .venv-marker
.venv-marker/bin/python -m pip install marker-pdf
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
