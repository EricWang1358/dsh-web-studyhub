# Convert PDFs with external Marker

Open **Add material → Files → Marker: convert outside StudyHub** for installation guidance, a downloadable conversion script, and a picker for existing results. StudyHub generates the script and imports the file you choose. It does not install, launch or bundle Marker or its models. MinerU remains available.

## Install separately

Read the [official installation guide](https://github.com/datalab-to/marker#installation), [inference prerequisites](https://github.com/datalab-to/marker#inference-backend-prerequisites) and [PyPI package page](https://pypi.org/project/marker-pdf/). Run these commands in your own terminal. Python 3.10+ and a compatible PyTorch environment are required; use a separate virtual environment.

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

## Generate the conversion script

1. Select **Download Marker conversion script** and save `studyhub-marker-convert.py`.
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
4. Return to StudyHub and select **Choose Marker output file**. Choose the paginated `.md` at the printed location, or drop it into the ordinary file area. The dedicated picker accepts neither the original PDF nor Marker JSON.

Alternatively, run Marker yourself:

```text
marker_single "book.pdf" --output_format markdown --paginate_output --output_dir "new-output-directory"
```

## Inspect the import

Marker paginated Markdown contains page separators starting with `{0}` followed by dashes. StudyHub converts zero-based page IDs to one-based pages and saves separate text sources. The dedicated picker rejects missing pagination rather than treating the book as one page. Markdown has an 8 MB import limit; split larger conversions and check their page numbering.

Choose a course before importing. Inspect reading order, page numbers, equations and tables: importing does not correct OCR errors. Then select pages or chapters for generation. Conversion does not automatically create a question deck. Imported results do not retain the original PDF for original-page viewing; citations point to the imported text pages. Separate extracted images are not imported in this flow.

## Licensing

Marker code uses Apache-2.0. Model weights have separate modified OpenRAIL-M terms. Read the [commercial-use description](https://github.com/datalab-to/marker#commercial-usage) and [model licence](https://github.com/datalab-to/marker/blob/master/MODEL_LICENSE). External installation or script invocation does not waive applicable obligations. StudyHub includes no Marker source, installer or model weights.

External documentation checked on 2026-10-04. The documentation and terms for your installed version govern. Compatibility tests use a fake command; real OCR quality on every hardware configuration has not been validated.
