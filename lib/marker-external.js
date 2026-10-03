/** A user-run helper only: importing this module never installs or executes Marker. */
export const MARKER_SCRIPT_FILENAME = 'studyhub-marker-convert.py';

export function createMarkerConversionScript() {
  return String.raw`#!/usr/bin/env python3
# StudyHub external Marker helper. Marker and its weights are not included.
# Install Marker separately in your chosen Python environment, then run:
#   python studyhub-marker-convert.py "path/to/material.pdf"
# Without a path, a local file picker opens when tkinter is available.
# Running Marker may download model weights on first use (network required).
# No LLM/cloud conversion flags are enabled by this helper.
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")


def choose_pdf():
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        try:
            return filedialog.askopenfilename(
                title="Choose a PDF for local Marker conversion",
                filetypes=[("PDF files", "*.pdf"), ("All files", "*")],
            )
        finally:
            root.destroy()
    except Exception:
        raise RuntimeError(
            "File picker unavailable. Run: python studyhub-marker-convert.py "
            "\"path/to/material.pdf\""
        )


def find_marker_command():
    # Prefer the environment running this helper, then an explicitly installed PATH tool.
    executable_dir = Path(sys.executable).resolve().parent
    directories = [executable_dir, executable_dir / "Scripts"]
    names = ["marker_single.exe", "marker_single"] if os.name == "nt" else ["marker_single"]
    for directory in directories:
        for name in names:
            candidate = directory / name
            if candidate.is_file() and os.access(str(candidate), os.X_OK):
                return [str(candidate)]
    installed = shutil.which("marker_single")
    if installed:
        return [installed]
    raise RuntimeError(
        "marker_single is not installed in this Python environment or PATH. "
        "Follow the Marker installation guide, then run this helper using that environment's Python."
    )


def main():
    parser = argparse.ArgumentParser(description="Convert a PDF locally with separately installed Marker.")
    parser.add_argument("pdf", nargs="?", help="PDF path; omit to choose a file")
    args = parser.parse_args()
    selected = args.pdf if args.pdf is not None else choose_pdf()
    if not selected:
        print("Cancelled. No conversion was started.")
        return 0
    pdf = Path(selected).expanduser().resolve()
    if not pdf.is_file() or pdf.suffix.lower() != ".pdf":
        raise RuntimeError("Choose an existing PDF file: " + str(pdf))
    with pdf.open("rb") as source:
        if b"%PDF-" not in source.read(1024):
            raise RuntimeError("The selected file does not have a PDF header: " + str(pdf))
    command = find_marker_command()
    # A fresh directory beside the PDF preserves all previous conversion outputs.
    output = Path(tempfile.mkdtemp(prefix="studyhub-marker-", dir=str(pdf.parent)))
    print("Local conversion; first use may download model weights. No LLM flags enabled.", flush=True)
    print("Output directory: " + str(output), flush=True)
    result = subprocess.run(
        command + [str(pdf), "--output_format", "markdown", "--paginate_output", "--output_dir", str(output)],
        shell=False,
    )
    if result.returncode != 0:
        print("Marker failed (exit code " + str(result.returncode) + "). Output kept at: " + str(output), file=sys.stderr)
        return result.returncode if result.returncode > 0 else 1
    markdown = []
    for path in sorted(output.rglob("*.md")):
        if path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(output.resolve()):
            text = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
            page_separator = r"^\{\d+\}-{20,}[ \t]*$"
            if re.search(page_separator, text, re.MULTILINE) and re.sub(page_separator, "", text, flags=re.MULTILINE).strip():
                markdown.append(path)
    if not markdown:
        raise RuntimeError("Marker produced no non-empty paginated Markdown file. Check --paginate_output support and inspect: " + str(output))
    print("Conversion complete. In StudyHub, import the paginated Markdown file:")
    for path in markdown:
        print(str(path.resolve()))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("Cancelled.", file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        print("Conversion failed: " + str(error), file=sys.stderr)
        sys.exit(1)
`;
}
