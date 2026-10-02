# Convert a PDF with MinerU (cloud or local)

[中文](mineru-conversion.zh-CN.md)

StudyHub can turn a PDF into pages of text (scanned pages, formulas, tables and Chinese included) by running MinerU itself. You do not install a desktop client, drag files around or type page ranges.

| | Local `mineru` | Cloud (your own MinerU token) |
|---|---|---|
| Cost | free | free **for now**; MinerU's rules may change |
| Leaves your computer | nothing | **the PDF is uploaded to MinerU's cloud** (StudyHub says so and asks once before the first use) |
| Needs | `mineru` installed (`uv tool install "mineru>=4.0,<5"`), models downloaded | a token created at <https://mineru.net/apiManage/docs>, pasted once into **Settings → MinerU cloud conversion** |
| Big books | page windows of 50 (`--pages a-b`), no cutting of the PDF | pieces of at most 200 pages and 180 MB, cut at chapter bookmarks when the PDF has them |
| Progress | pieces done ("piece 3 of 9"); no fake percentage inside a window | pages MinerU reports as extracted, over the pages of the book |

**Add material → Convert with MinerU** shows both. The local route leads when it is ready; otherwise the cloud route leads when a token is set; otherwise the same entry shows the setup. Nothing is uploaded and nothing is started until you set a route up and press the start button. The desktop client and the `mineru parse --pages` command line stay available under **Advanced** (the result goes in through the ordinary import).

## What happens to a book

1. **Plan** (nothing leaves your computer): the PDF is read to count its pages, and StudyHub tells you *how many pieces* the book will be processed in.
2. **Cloud**, for each piece, one at a time: cut (pdf-lib; a PDF that already fits is not rewritten) → ask for an upload address → upload → poll every few seconds → download → keep the piece's `content_list.json`. A piece whose file is over 180 MB is halved until it fits; one page that is too big on its own is a named error.
   **Local**, for each window: `mineru parse --tier <tier> --pages a-b --wait <seconds> --json -o <file> --force`. `--pages` is always given (the CLI's default is only the first 10 pages). The Markdown's `<!-- page N of TOTAL -->` markers are checked (as many as the window has pages, each inside it, TOTAL equal to the PDF's page count) and read into the same page model.
3. **Merge**: each piece's pages are moved to their place in the book (`page_idx + start − 1`), image names get a per-piece prefix so they cannot collide, reading order is kept, and the book keeps the **original page count** (a missing piece is a clear message naming its pages).
4. **Import** through the ordinary document import, as a converted document: one source per page, chapters from the headings, the same citations as a MinerU file dragged in by hand.

It is one job in the same list as audio imports: real progress, **Stop**, **Resume** (a finished piece is never uploaded or parsed again), **Got it** (removes the card and its temporary files), and a letter in the inbox when it ends.

## Resilience

- Per-piece state is saved in the DSH home (`study/tmp/pdf-convert/…`), not in your study library. A restart shows an interrupted conversion as a failed job you can resume.
- A cancelled conversion removes its temporary files but keeps each finished piece's result (small, keyed by the file's hash), so importing the same PDF again does not convert those pieces twice. Pieces and files are forgotten after 7 days.
- Rate limits are waited out, short network failures are retried with growing waits, a queue that stays long is shown as "slower than usual, not a failure". An invalid or expired token stops the job at once and points to Settings. A stopped local service is named, with a **Restart the local service** button.
- The token is stored in `<DSH home>/study/mineru.json` (or `MINERU_API_KEY`), never in the study library, an export, a backup or a snapshot, and appears in no log. Settings show only its last four characters.

## Conversion history

Every conversion, cloud or local, leaves a record that survives the job card being dismissed and the app being restarted. It is in **Add material → "Convert with MinerU" → Conversion history** (also the **Conversion history** link beside it) and on the **Sources** page under the running cards.

- **A row says**: the file name, its size and pages, the route (cloud, or local with its tier), the status (running / finished / did not finish / cancelled / interrupted), when it ended and how long it took ("3 minutes ago · took 4 min 20 s"), and the result ("Imported as “…” · 448 pages"). A conversion is **finished only when the document was really imported**; one whose import step failed is "did not finish" at the *save* stage. A conversion a restart or crash cut off is **interrupted**, with no end time and no duration, because nobody measured it.
- **What you can do from a row**: open the imported material (it jumps to it); **Resume** a failed or interrupted conversion (only the unfinished pieces are redone, while their cached results exist; the row stays the same record and counts its attempts); see a running one (it scrolls to its live card); **Delete record**; **Clear history** (asks first). Deleting a record or clearing the history **never deletes an imported document**.
- **Where it is kept**: one small file per conversion in `<library>/conversion-history/` (next to `audio-batches/`, the library's other job records), not in the DSH home's cleaned `study/tmp`, and not in the library's exported state or backups (job records are not part of those). A record holds the file name and size, page counts, route and tier, times, status, a plain reason and the stage a failure happened in, the id and title of the imported document, the environment (below), and the pieces of the book with their pages and state. It never holds document text, the token, a folder or a temporary path.
- **How long**: the latest 50 records and everything younger than 90 days, whichever is more; older ones are removed when a new record is written.

## What is doing the work

The live card and every history row can show an **Environment** block, captured when the conversion starts (read-only) and kept with the record.

- **Local**: the mineru version, the tier and what it means (`standard`: better layout understanding, a little slower; `basic`: faster), the model folder of that tier (as the real tool names it, for example `MinerU-4_models_onnx` or `MinerU2.5-Pro-…-GGUF`), where the models live (a folder that is a link to another drive says where it really is), a **device only if `mineru server status` or `mineru config show` reports one** (otherwise no GPU/CPU label), how pages are worked on ("50 pages at a time; progress moves when a window is done"), and whether the local service is up.
- **Cloud**: MinerU, the model version (`vlm`) and the language, that your saved token is used (it is never shown), the limits a piece is cut to (200 pages / 180 MB) and the size of the book.
- **The service state is honest, not polled**: *running* is shown after the read-only check before the work starts and after each finished window; *stopped* after a window found it stopped (with the existing **Restart the local service and resume** button); *not known* after an app restart, until you resume. Nothing is asked of the command line while a window runs, and **a conversion never starts, stops or reconfigures the service by itself**.
- A card with more than eight windows shows "window 3/12 · 2 done" and a **Show all windows** toggle; the list wraps inside the card.

## Setting up the local mineru

StudyHub detects it with read-only calls (`mineru --version`, `mineru config get …`, `mineru server status`) and reports one state: not installed / needs models / service stopped / ready. It never installs anything. **Start the local service** runs `mineru server start` when you press it. **Download the models and switch on local conversion** shows the size first (about 800 MB for `basic`, about 1.2 GB for `standard`), downloads only after you confirm, can be cancelled, and then sets the tier and `managed` mode and starts the service. The speeds shown (about 1.6 s per page for `basic`, about 2.5 s for `standard`) were measured once on one CPU-only laptop and are always labelled estimates.

## Checking the cloud route with a real token

`MINERU_API_KEY=<token> node scripts/mineru-live-check.mjs` makes one real round trip with a tiny generated PDF and reports each assumption StudyHub makes about the API; `--check-only` only checks the token. Without the variable it does nothing.
