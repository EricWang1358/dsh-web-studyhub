# Convert a PDF with MinerU (cloud or local)

[中文](mineru-conversion.zh-CN.md)

StudyHub can run MinerU for you to turn a PDF into pages of text. Use it for scanned PDFs, books with many formulas or tables, Chinese textbooks and books over 200 pages. You do not install a desktop client, drag files around or type page ranges.

MinerU conversion belongs to the **StudyHub · Audio** component. When that component is off, only the manual routes under **Advanced** are available.

## Choose a route

| | Local `mineru` | Cloud (your own MinerU token) |
|---|---|---|
| Cost | Uses your own machine | MinerU’s current account terms |
| What leaves your computer | Nothing | **The PDF is uploaded to MinerU's cloud.** StudyHub says so and asks once before the first use. |
| What you need | `mineru` installed (`uv tool install "mineru>=4.0,<5"`) and its models downloaded | A token from [mineru.net](https://mineru.net/apiManage/docs), pasted once into **Settings › PDF conversion (MinerU)** |
| How a big book is cut | Pieces of 5–50 pages, sized to this computer's measured speed. The PDF itself is not cut (`--pages a-b`). | Pieces of at most 200 pages and 180 MB, cut at chapter bookmarks when the PDF has them |
| Progress | Pieces done ("piece 3/9"); no made-up percentage inside a piece | Pages MinerU reports as converted, out of the book's pages |

When you convert, StudyHub picks the route to lead with:

1. the local route, when it is ready;
2. otherwise the cloud route, when a token is set;
3. otherwise the setup for the cloud route.

You can switch routes before you start. Nothing is uploaded and nothing starts until a route is set up and you click its start button.

## Convert a PDF

1. Open **Add source**. On the **Files** tab, next to "A scanned PDF, one with many formulas, or one over 200 pages?", click **Convert with MinerU**. If a PDF was refused as too large, the **Large textbooks** card under it offers the same conversion for that file.
2. Click **Choose a PDF**. The file is read on this computer only. StudyHub shows its pages and size and how the book will be cut, for example "This book will be processed in 3 pieces".
3. Under **How to convert it**, choose **Local mineru** or **Use MinerU cloud conversion**.
4. The first time you use the cloud route, tick "I understand the document is uploaded to MinerU's cloud, and I agree to use cloud conversion". You are asked once; you can withdraw the consent in Settings.
5. Click **Start local conversion** or **Start cloud conversion**. The dialog closes, and the conversion runs in the background as a job.
6. Follow it on the **Sources** page. When it ends, a letter arrives in the **Inbox** (unless you stopped it yourself).

The result is imported like any converted document: one source per page, chapters from the headings, and the same citations as a MinerU file you drag in by hand. There is no file to drag in. StudyHub keeps the text and image captions; the pictures themselves are not imported.

To convert by hand instead, open **Advanced: desktop client and command line** and drag the result into **Add source**. See [Large textbooks](large-documents.md) for the formats StudyHub reads.

## Set up the cloud route

1. Open **Settings › PDF conversion (MinerU)**. The section is called **MinerU cloud conversion**.
2. Under **Cloud (MinerU token)**, open MinerU's API management page and create a token. Check MinerU’s current account, region and billing requirements.
3. Paste the token and click **Save and verify**. Verifying sends one request that contains no document.

The answer says the token works, is invalid or has expired, or that MinerU could not be reached or is temporarily unavailable.

Where the token is kept:

- It is stored in `<DSH home>/study/mineru.json` (the home folder of DeepSeek Harness, DSH), or read from the `MINERU_API_KEY` environment variable when the file has none.
- It is never in the study library, an export, a backup or a snapshot, and it appears in no log.
- Settings show only its last four characters. **Clear the saved token** removes it.
- Never paste the token into the chat.

## Set up the local route

StudyHub never installs `mineru` for you.

1. In a terminal, run `uv tool install "mineru>=4.0,<5"`. You need uv first.
2. Open **Settings › PDF conversion (MinerU)**. Under **Local (mineru command line)**, click **Check again**. StudyHub reports one state: not installed, needs models, service stopped, or ready.
3. If the service is stopped, click **Start the local service**. Only then does StudyHub run `mineru server start`.
4. If models are missing, choose a tier under **Choose a tier**, then click **Download the models and switch on local conversion**.
   - The size is shown first: about 800 MB for `basic`, about 1.2 GB for `standard`.
   - Nothing downloads until you click **Confirm the download**. You can cancel at any time.
   - When it finishes, StudyHub sets the tier and `managed` mode and starts the service.

The tiers:

- `basic` is faster and suits books that are mostly text.
- `standard` understands layout better and is a little slower.

The speeds shown (about 1.6 seconds per page for `basic`, about 2.5 for `standard`) were measured once, on one laptop using only its CPU. They are always labelled as estimates.

StudyHub detects the local `mineru` with read-only calls: `mineru --version`, `mineru config get …` and `mineru server status`.

## Follow a conversion

The conversion is one job in the same list as audio imports, with its card on the **Sources** page.

- **Buttons.**
  - **Stop (pieces already converted are kept)**.
  - **Resume (finished pieces are not redone)**: a finished piece is never uploaded or converted again.
  - **Got it** removes the card and its temporary files.
- **Progress.** Cloud: pages converted out of the book's pages. Local: the piece in hand (its pages, how long it has run and how long it should take), the finished pieces with their times, and the size of the next piece. A local piece shows no finer progress while it runs; that does not mean it is stuck.
- **Time left.** It is hidden until a piece has finished, then says "about". It is one figure when the pieces agree, and a range ("About 15 min to 40 min left") while the speed is not steady.
- **Many pieces.** A card with more than eight pieces shows a summary, such as "Piece 13 · 12 done", and a **Show all windows** toggle. The list wraps inside the card.
- **Environment.** The card and every history row can show an **Environment** block, captured read-only when the conversion starts:
  - Local: the mineru version; the tier and what it means; and the model folder of that tier as the tool names it (for example `MinerU-4_models_onnx`). The live card also says where the models live (a folder that links to another drive says where it really is); a history row never shows that location.
  - Local, continued: a device only if `mineru server status` or `mineru config show` reports one, otherwise no GPU or CPU label; how pieces are sized; and whether the local service is running.
  - Cloud: MinerU, the model version (`vlm`) and the recognition language; that your saved token is used (it is never shown); the limits a piece is cut to (200 pages / 180 MB); and the size of the book.
- **Service state, honestly.**
  - "Running" is shown after the read-only check before work starts and after each finished piece.
  - "Stopped" is shown after a piece found the service stopped, with **Restart the local service and resume**.
  - "Cannot confirm" is shown after an app restart, until you resume.
  - A conversion never starts, stops or reconfigures the service by itself.

### While a local piece runs

`mineru parse --wait` prints nothing until it ends. A long piece can look stuck for minutes, especially the first piece of a scanned PDF: the model loads, and every page is read by text recognition. A slower computer takes proportionally longer.

So while a piece runs, StudyHub asks the **service**, never the parse itself, with read-only commands, one at a time:

- `mineru server status --json` reports the workers and the health of the parse server. When it says something is busy, `mineru list parses --status pending|parsing --json` is matched to the piece by tier and page range.
- It asks every 20 seconds, the first time after 5 seconds, and only while a piece runs.
- A question that fails means "unknown", never "stuck".

The card then shows one of these, with the time of the last signal:

- **Queued**
- **Converting**
- **The service is starting**
- **Converting (the service has not reported this piece yet)**
- **No response (nothing new for 3 min)**, with the real number of minutes
- **Service stopped**
- **Unknown (the service status cannot be read)**

**No response** appears only in two cases: the service reported nothing parsing or queued in three answers in a row and nothing was heard for two minutes, or the parse server reports itself unhealthy. A service busy with another parse, or a failed question, never leads to it.

What to do on **No response**: wait a little longer. If nothing changes, click **Stop**, then choose the same PDF again. Finished pieces are reused and only that piece is redone. StudyHub never stops anything by itself.

## When something goes wrong

- **Restart.** The state of each piece is saved in the DSH home (`study/tmp/pdf-convert/…`), not in your study library. After a restart, an interrupted conversion shows as a failed job that you can resume.
- **Cancelling.** A cancelled conversion removes its temporary files but keeps each finished piece's result, small and keyed by the file's hash. Converting the same PDF again does not convert those pieces twice. Unfinished work and kept pieces are removed after 7 days.
- **Cloud.**
  - Rate limits are waited out, and short network failures are retried with growing waits.
  - A queue that stays long is shown as "slower than usual", not as a failure.
  - An invalid or expired token stops the job at once and points to Settings (**Replace the token in Settings**).
- **Local.**
  - A piece that fails or times out is retried at half the size (20, then 10, then 5 pages), and the run goes on when a smaller piece works.
  - At the minimum size the job stops with the reason, and **Resume** retries only that piece.
  - A stopped service is named, with **Restart the local service and resume**.
- **The PDF itself.**
  - A password-protected PDF cannot be cut or uploaded: save a copy without the password first.
  - For the cloud, a single page over the size limit cannot be cut smaller: compress its images, or use the desktop client.

## Conversion history

Every conversion, cloud or local, leaves a record that survives dismissing the card and restarting the app. Open it with **Conversion history** next to **Convert with MinerU** in **Add source**. It also appears on the **Sources** page, under the running cards.

- **A row shows:**
  - the file name, its size and pages, and the route (cloud, or local with its tier);
  - the status: **In progress**, **Completed**, **Did not finish**, **Cancelled** or **Interrupted**;
  - when it ended and how long it took ("3 minutes ago · took 4 min 20 s"); a conversion that is still running, or was interrupted, shows when it started;
  - the result: the title it was imported as and its page count.
- **Completed means imported.** A conversion counts as **Completed** only when the document was really imported. One whose import failed **Did not finish** at the saving stage. A conversion that a restart or crash cut off is **Interrupted**, with no end time and no duration, because nobody measured it.
- **What you can do from a row:**
  - open the imported material;
  - **Resume** a failed or interrupted conversion: only unfinished pieces are redone while their cached results exist, and the row stays the same record and counts its attempts;
  - see the progress of a running one;
  - **Delete record**, or **Clear history** (it asks first).

  Deleting a record or clearing the history **never deletes an imported document**.
- **Where it is kept:**
  - One small file per conversion in `<library>/conversion-history/`, next to `audio-batches/`, the library's other job records.
  - Not in the DSH home's `study/tmp` (which is cleaned), and not in the library's exported state or backups (job records are not part of those).
- **What a record holds:** the file name and size, page counts, the route and tier, times, the status, a plain reason and the stage where a failure happened, the id and title of the imported document, the environment, the pieces of the book with their pages, state and measured seconds, and for a local conversion the pace of this computer. It never holds document text, the token, a folder or a temporary path.
- **How long:** the latest 50 records and everything younger than 90 days, whichever is more. Older ones are removed when a new record is written.

## How a book is converted

1. **Plan.** Nothing leaves your computer. The PDF is read to count its pages. For the cloud route and for fixed local pieces, StudyHub says how many pieces the book will be processed in; the default local plan says that pieces follow the computer's speed.
2. **Cloud, one piece at a time:**
   1. Cut the piece with pdf-lib; a PDF that already fits is not rewritten.
   2. Ask for an upload address, then upload.
   3. Poll every few seconds, then download the result.
   4. Keep the piece's `content_list.json`.

   A piece whose file is over 180 MB is halved until it fits; a single page that is too big on its own is a named error.
3. **Local, one piece at a time.** StudyHub runs `mineru parse --tier <tier> --pages a-b --wait <seconds> --json -o <file> --force`.
   - `--pages` is always given, because the command line converts only the first 10 pages by default.
   - The Markdown's `<!-- page N of TOTAL -->` markers are checked: as many as the piece has pages, each inside it, and TOTAL equal to the PDF's page count. They are then read into the same page model.
4. **Merge.**
   - Each piece's pages move to their place in the book (`page_idx + start − 1`).
   - Image names get a per-piece prefix so they cannot collide, and reading order is kept.
   - The book keeps its **original page count**. A missing piece is a clear message naming its pages.
5. **Import** through the ordinary document import, as a converted document.

### How local pieces are sized

The local route does not cut the book up in advance. It decides one piece at a time, from the speed this computer actually has.

- **Size.**
  - The first pieces are **10, 20 and 20 pages**, so the first progress, the first measured pace and the first estimate arrive quickly.
  - After that, each piece is sized to last about **75 seconds** at the pace measured on the latest pieces, never fewer than **5** and never more than **50** pages. A first piece that was much slower per page (it also loaded the model) is left out of the pace.
  - A slow computer or a scanned book keeps small pieces, so the bar moves about once a minute; a fast one grows to 50. The last piece takes the remainder, so the book never ends in a few lonely pages.
- **Retries.** A piece that fails or times out is retried halved (20 → 10 → 5 pages). Later pieces stay smaller than the one that failed. A stopped service, a missing command or your own Stop is never "fixed" by cutting the piece up.
- **No page is converted twice, whatever plan cut it.**
  - A piece's result is kept under the file's hash, the tier and the pages it covers, with the seconds it took, so a restored piece still tells the pace of this computer.
  - Resuming, or converting the same file again, reads those ranges from the cache and plans only what is left. A cached range that no longer reads is converted again; one that overlaps a longer finished range is ignored.
  - A result file in the job folder is named by its pages (`local-11-30.result.json`), not by its position.
- **The wait given to the command** grows with the computer:
  - at least 120 seconds;
  - 8 seconds per page, or three times the measured seconds per page when that is more;
  - 180 seconds more for the first piece of a run, while the model loads.

  Before any piece has been measured, nothing is known about the computer, so the first piece is not cut off by a guess: the liveness state and **Stop** decide, and only a 12-hour runaway guard applies.

## Development

- **Seams for tests and previews.**
  - `limits.windowPages` restores the old behaviour: fixed pieces of that many pages, decided up front and never halved. The manifest's `plan` says which plan a job follows: `{kind: 'adaptive', firstPages, rampPages, targetSeconds, minPages, maxPages}` or `{kind: 'fixed', windowPages}`.
  - `limits.livenessMs: 0` switches off the questions to the service.
  - The numbers live in `LOCAL` in `lib/mineru-local.js` (`livenessMs`, `livenessFirstMs`, `silentMs`, `idleProbes` and the sizing values).
- **Not verified against a real CLI:**
  - that these read-only commands are safe to run while the CLI parses;
  - the exact field names beyond `workers.parse_running`, `parse_queue_length`, `parse_server.local.healthy/starting` and `parses[].tier/page_range/status`, as found in a first investigation.
- **Check the cloud route with a real token.** `MINERU_API_KEY=<token> node scripts/mineru-live-check.mjs` makes one real round trip with a generated two-page PDF and reports each assumption StudyHub makes about the API. `--check-only` checks only the token. Without the variable, it does nothing.
