# Convert a PDF with MinerU (on this computer)

[中文](mineru-conversion.zh-CN.md)

StudyHub can run MinerU for you to turn a PDF into pages of text. Use it for scanned PDFs, books with many formulas or tables, Chinese textbooks and books over 200 pages. You do not install a desktop client, type commands, drag files around or type page ranges.

MinerU runs **on this computer**. Nothing is uploaded and no token is needed. StudyHub installs MinerU for you with one button.

MinerU conversion belongs to the **StudyHub · Audio** component. When that component is off, only the manual routes under **Advanced** are available.

## One-click install

Open **Settings › PDF conversion (MinerU)** and click **One-click install**. That is the whole setup. The same card also appears inside the import dialog when you pick a PDF and MinerU is not ready yet, so you can install it there without leaving the dialog.

The install runs six steps, one after the other. The card shows the step in hand ("Step 2 of 6: Prepare Python"), a progress bar, the last line the step printed and the list of steps:

1. **Prepare the installer**: StudyHub downloads a pinned `uv` (a small Python package manager) and checks its sha256.
2. **Prepare Python**: `uv` downloads its own Python 3.12 into the install folder. A Python already on the computer is not used unless you choose it under **More**.
3. **Install MinerU**: `mineru>=4.0,<5`, the base package (no PyTorch on Windows).
4. **Download the models** for the chosen tier.
5. **Enable the local service** with that tier.
6. **Check it works**: the service must answer that it can parse with that tier.

- It needs no administrator rights and nothing installed beforehand, and it changes no system setting.
- Everything goes into one folder: the program, Python, the models and MinerU's own settings (`MINERU_HOME`). Nothing is written to `~/.mineru`.
- Download about 1.3 GB, about 4 GB on disk, about 10–30 minutes (estimates; they depend on the network and the computer).
- You can leave the page: the install is also listed in **Tasks**. Do not close StudyHub while it runs.
- **Cancel** keeps what was downloaded. **Continue installing** starts again from the step that stopped; finished steps are skipped.

## Install location (not the system drive by default)

The default folder is `X:\StudyHub\MinerU` on the fixed drive, other than the system drive, with the most free space, for example `D:\StudyHub\MinerU`. The hint under the folder says why ("the non-system drive with the most free space (D:, 118 GB free); C: is not used").

- When the computer has only the system drive, the hint says so and the install goes there.
- **Choose location** opens the list of drives, each with its would-be folder and free space. The recommended one is marked, the system drive is marked **System drive**, and a drive without enough room is marked **Not enough space**. Choosing a drive applies it at once.
- **Other folder…** opens the folder picker of the host when it has one; otherwise type the full path and click **Use this location**.
- A folder that already holds other files is not touched: StudyHub installs into a new `StudyHub-MinerU` folder inside it.
- The button stays off, with the reason, when the folder cannot be written, the drive has too little space (with the numbers), or the path is longer than 80 characters (Windows cannot load deep Python packages from long paths). A path with Chinese or special characters gets a warning: some components may fail to load from it.
- On macOS and Linux the install goes into the StudyHub data folder in the DSH home.

Only one small file is written outside the folder: `<DSH home>/study/mineru-install.json` (the install's state, under 10 KB).

## Download source

There are two download sources, and **Auto** picks one:

| Part | Mainland mirror (direct in mainland China) | Official overseas source (needs an overseas connection) |
|---|---|---|
| The installer (`uv` wheel) | Tsinghua PyPI mirror `pypi.tuna.tsinghua.edu.cn` | `pypi.org` |
| Python 3.12 | npmmirror `registry.npmmirror.com` | GitHub releases |
| Python packages | Tsinghua PyPI mirror | `pypi.org` |
| Models | ModelScope (`--source modelscope`) | Hugging Face (`--source huggingface`) |

- **Auto** sends a few unauthenticated HEAD requests (3 seconds each) to both groups, only while the card plans an install. When the overseas group does not answer it picks the mainland mirror; when the mainland group does not answer, the overseas source; otherwise the faster one, and the mainland mirror on a tie. The badge next to the source says which one and why.
- You can choose a source yourself under **More › Download source**. A repair or a change of tier reuses the source of the install.
- Two network failures in a row on the same source turn the fix button into **Retry with the other download source**.

## Status

The card always says where MinerU stands, in one line:

| Status | What it means | What to do |
|---|---|---|
| **Checking** | StudyHub is reading the state. | Nothing. |
| **Not installed** | No usable MinerU on this computer. | **One-click install**. |
| **Installing** | "Step n of 6" and the step's name. | Wait, or **Cancel**. |
| **Installed · service not running** | MinerU is there; its local service is not running (after a reboot, for example). | Nothing: a conversion starts it. Or **Start the service**. |
| **Ready** | MinerU, its version, the tier and the folder. | Convert. |
| **Error** | The reason, and exactly one fix button. | Click it (see below). |

**Check again** reads the state once more. The state is also read again every 30 seconds while the card is open and MinerU is installed.

## Service and restarts (started automatically)

MinerU parses through a local service that runs in the background. It stops when the computer restarts, and may stop when StudyHub closes.

- A conversion that finds the service stopped starts it first: the card says "Starting the local MinerU service (about a minute the first time)", then converts. This is local and spends no tokens.
- If the service cannot be started, the conversion fails with the reason, and **Resume** tries again.
- **More › Stop the service** stops it (it uses memory while it runs); it is refused while a MinerU conversion runs.

## Change the tier

- `basic` (the default): CPU only, models about 0.8 GB, about 1.6 seconds per page (estimate). It suits books that are mostly text, formulas and tables.
- `standard`: better layout understanding, models about 2 GB, about 2.5 seconds per page (estimate), 16 GB of memory recommended (the card shows this computer's memory).

Choose it under **More › Model tier** before installing, or later with **Switch to {tier}**: only the model, service and check steps do real work.

The speeds were measured once, on one laptop using only its CPU, and are always labelled as estimates.

## Uninstall and move

- **More › Uninstall** asks first. It stops the local service, then removes what StudyHub created in the folder: `tools`, `python`, `venv`, `home`, `cache`, `tmp` and the marker file `.studyhub-mineru.json`, then the folder and the parents it created, each only if empty. Files StudyHub did not create are not touched, and converted materials are not affected. It is refused while a MinerU conversion runs.
- **More › Install in another location…** installs into a new folder (copying the models when they verify) and removes the old one only after the new one passes the check. If it fails, the old one stays usable.
- StudyHub only ever deletes inside a folder carrying its own marker file; it never deletes a folder recursively.

## When something goes wrong

Each failure shows where it stopped, the reason, and one button:

| Problem | Button | What it does |
|---|---|---|
| Network or checksum | **Retry** | Continues from the step that stopped; nothing downloaded is fetched again. |
| Network, twice in a row | **Retry with the other download source** | The same, with the other download source. |
| Cancelled, or StudyHub was closed during the install | **Continue installing** | Continues from the step that stopped. |
| Not enough space, folder not writable, folder in use, bad or too long path | **Choose another location** | Opens the location list. |
| The package, models or check failed | **Repair** | Each step checks itself again; only what is missing runs. |
| The service did not start | **Restart the service** | Stops and starts it. |
| Another MinerU holds the port | **Stop the other MinerU and retry** | Stops that one's service, then starts this one. |
| The Microsoft VC++ runtime is missing | **Download the VC++ runtime** | Opens Microsoft's installer (`aka.ms/vs/17/release/vc_redist.x64.exe`); then click **Retry**. |
| The state cannot be read | **Check again** | Reads it again. |

**More** also has the install log (the last 200 lines) and the commands the install runs.

## A MinerU you installed yourself

When `MINERU_BIN` is set, or `mineru` is on the search path, StudyHub uses it and says **Ready · installed by you**. It only calls it and never changes its settings. StudyHub's own install comes first when both exist; **More** then lists the other one. If both services want the same port, the error offers to stop the other one.

## No more cloud route

The MinerU cloud route (a MinerU token, uploading the PDF) was removed in 3.5.5: its entry had stopped working. Old cloud rows still show in the conversion history, but cannot be resumed: choose the PDF again to convert it on this computer. A conversion request that asks for the cloud is refused with that message.

A token saved by an older version stays in `<DSH home>/study/mineru.json`. Nothing reads it any more; you can delete the file by hand. `MINERU_API_KEY` is ignored.

## Convert a PDF

1. Open **Add source** and drop the PDF on the **Files** tab. If it has no readable text (a scan) or is over 8 MB, its row says so and the converter is shown right under it, with that file already read on this computer: go to step 3. To convert a PDF on purpose (many formulas, or a Chinese textbook), open the folded **PDF conversion** section and click **Choose a PDF to convert…**.
2. The file is read on this computer only. StudyHub shows its pages and size, how the book will be cut, and the estimated time.
3. The tool is **MinerU**; choose Marker under **Conversion tool** to use it instead. If MinerU is not installed, the install card is right there: click **One-click install** and wait for **Ready**.
4. Click **Start local conversion**. The dialog closes, and the conversion runs in the background as a job. Nothing runs before that click.
5. Follow it on the **Sources** page. When it ends, a letter arrives in the **Inbox** (unless you stopped it yourself).

The result is imported like any converted document: one source per page, chapters from the headings, and the same citations as a MinerU file you drag in by hand. StudyHub keeps the text and image captions; the pictures themselves are not imported.

To convert by hand instead, open **Advanced: desktop client and command line** and drag the result into **Add source**. See [Large textbooks](large-documents.md) for the formats StudyHub reads.

## Follow a conversion

The conversion is one job in the same list as audio imports, with its card on the **Sources** page.

- **Buttons.**
  - **Stop (pieces already converted are kept)**.
  - **Resume (finished pieces are not redone)**. When the service had stopped, Resume starts it first.
  - **Archive** puts the card away: the task goes under Jobs › Archived (nothing is deleted, **Undo** in the notice brings it back); deleting it there removes the record only: the temporary pieces of the conversion stay until the 7-day sweep clears them, and until then a restart can list the conversion again (as failed, ready to continue).
- **Progress.** The piece in hand (its pages, how long it has run and how long it should take), the finished pieces with their times, and the size of the next piece. A piece shows no finer progress while it runs; that does not mean it is stuck.
- **Time left.** It is hidden until a piece has finished, then says "about". It is one figure when the pieces agree, and a range ("About 15 min to 40 min left") while the speed is not steady.
- **Many pieces.** A card with more than eight pieces shows a summary, such as "Piece 13 · 12 done", and a **Show all windows** toggle. The list wraps inside the card.
- **Environment.** The card and every history row can show an **Environment** block, captured read-only when the conversion starts: the mineru version; the tier and what it means; the model folder of that tier as the tool names it (for example `MinerU-4_models_onnx`); a device only if `mineru server status` or `mineru config show` reports one; how pieces are sized; and whether the local service is running. The live card also says where the models live; a history row never shows that location.
- **Service state, honestly.**
  - "Running" is shown after the read-only check before work starts and after each finished piece.
  - "Stopped" is shown after a piece found the service stopped; **Resume** starts it again.
  - "Cannot confirm" is shown after an app restart, until you resume.

### While a piece runs

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

### When a conversion goes wrong

- **Restart.** The state of each piece is saved in the DSH home (`study/tmp/pdf-convert/…`), not in your study library. After a restart, an interrupted conversion shows as a failed job that you can resume.
- **Cancelling.** A cancelled conversion removes its temporary files but keeps each finished piece's result, small and keyed by the file's hash. Converting the same PDF again does not convert those pieces twice. Unfinished work and kept pieces are removed after 7 days.
- **A piece that fails** or times out is retried at half the size (20, then 10, then 5 pages), and the run goes on when a smaller piece works. At the minimum size the job stops with the reason, and **Resume** retries only that piece.
- **A password-protected PDF** cannot be read: save a copy without the password first.

## Conversion history

Every conversion leaves a record that survives dismissing the card and restarting the app. Open it with **Conversion history** in the folded **PDF conversion** section of **Add source**. It also appears on the **Sources** page, under the running cards.

- **A row shows:**
  - the file name, its size and pages, and the tool (MinerU with its tier, or Marker; old rows may say cloud);
  - the status: **In progress**, **Completed**, **Did not finish**, **Cancelled** or **Interrupted**;
  - when it ended and how long it took ("3 minutes ago · took 4 min 20 s"); a conversion that is still running, or was interrupted, shows when it started;
  - the result: the title it was imported as and its page count.
- **Completed means imported.** A conversion counts as **Completed** only when the document was really imported. One whose import failed **Did not finish** at the saving stage. A conversion that a restart or crash cut off is **Interrupted**, with no end time and no duration, because nobody measured it.
- **What you can do from a row:**
  - open the imported material;
  - **Resume** a failed or interrupted conversion: only unfinished pieces are redone while their cached results exist, and the row stays the same record and counts its attempts (an old cloud row cannot be resumed);
  - see the progress of a running one;
  - **Delete record**, or **Clear history**: neither asks; the rows leave at once and a notice offers **Undo** for about 8 seconds, and the records are forgotten when that notice leaves.

  Deleting a record or clearing the history **never deletes an imported document**.
- **Where it is kept:**
  - One small file per conversion in `<library>/conversion-history/`, next to `audio-batches/`, the library's other job records.
  - Not in the DSH home's `study/tmp` (which is cleaned), and not in the library's exported state or backups (job records are not part of those).
- **What a record holds:** the file name and size, page counts, the tool and tier, times, the status, a plain reason and the stage where a failure happened, the id and title of the imported document, the environment, the pieces of the book with their pages, state and measured seconds, and the pace of this computer. It never holds document text, a folder or a temporary path.
- **How long:** the latest 50 records and everything younger than 90 days, whichever is more. Older ones are removed when a new record is written.

## How a book is converted

1. **Plan.** Nothing leaves your computer. The PDF is read to count its pages. The default plan says that pieces follow the computer's speed; a fixed plan (a seam of tests and previews) lists its pieces.
2. **One piece at a time.** StudyHub runs `mineru parse --tier <tier> --pages a-b --wait <seconds> --json -o <file> --force`.
   - `--pages` is always given, because the command line converts only the first 10 pages by default.
   - The Markdown's `<!-- page N of TOTAL -->` markers are checked: as many as the piece has pages, each inside it, and TOTAL equal to the PDF's page count. They are then read into the same page model.
3. **Merge.**
   - Each piece's pages move to their place in the book (`page_idx + start − 1`).
   - Image names get a per-piece prefix so they cannot collide, and reading order is kept.
   - The book keeps its **original page count**. A missing piece is a clear message naming its pages.
4. **Import** through the ordinary document import, as a converted document.

### How pieces are sized

StudyHub does not cut the book up in advance. It decides one piece at a time, from the speed this computer actually has.

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

- **The install** is `lib/mineru-install.js` (the stages, the plan, `mineruEnv`, `effectiveMineru`) on the shared engine `lib/tool-install.js` (folders, the marker file, state, cancel, uninstall), with `lib/install-drives.js`, `lib/install-sources.js` and `lib/uv-bootstrap.js`. Its operations are `mineru.install.plan|start|status|cancel|uninstall` and `mineru.local.status|start|stop`. The assistant cannot install, uninstall or stop the service: those are Settings-only.
- **In the task console** the install is one row of type `local-install` (default), or a Job of kind `mineru-install` with the runtime pilot switch `mineruInstall` on.
- **Tests** run with no network: a local index serves the `uv` wheel, `tests/helpers/fake-uv.mjs` stands in for `uv`, and `tests/helpers/fake-mineru-cli.mjs` for `mineru` and `mineru-kit`.
- **Seams for tests and previews.**
  - `limits.windowPages` restores the old behaviour: fixed pieces of that many pages, decided up front and never halved. The manifest's `plan` says which plan a job follows: `{kind: 'adaptive', firstPages, rampPages, targetSeconds, minPages, maxPages}` or `{kind: 'fixed', windowPages}`.
  - `limits.livenessMs: 0` switches off the questions to the service.
  - The numbers live in `LOCAL` in `lib/mineru-local.js` (`livenessMs`, `livenessFirstMs`, `silentMs`, `idleProbes` and the sizing values) and `MINERU_INSTALL` in `lib/mineru-install.js`.
- **Not verified against a real install** (estimates or assumptions until measured): the download and disk sizes, that `MINERU_HOME` keeps the models and the service state inside the folder, the `mineru-kit models download|verify` flags, the `config set` keys, whether the npmmirror Python mirror and the Tsinghua `uv` wheel work with the pinned `uv`, and whether a fresh Windows needs the VC++ runtime.
- **Not verified against a real CLI:**
  - that the read-only liveness commands are safe to run while the CLI parses;
  - the exact field names beyond `workers.parse_running`, `parse_queue_length`, `parse_server.local.healthy/starting` and `parses[].tier/page_range/status`, as found in a first investigation.
