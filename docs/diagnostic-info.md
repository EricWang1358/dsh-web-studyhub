# Copy diagnostic information

*Chinese version: [diagnostic-info.zh-CN.md](diagnostic-info.zh-CN.md).*

When something goes wrong, **Copy diagnostic information** gives you a short text to paste into a bug report instead of a screenshot. It is in **Settings › About & updates**, and on the notice a page shows when it fails to draw. **See what will be copied** shows the text before it goes to the clipboard.

Nothing is stored or sent: the text is built when you press the button and goes to your clipboard only.

## What the text holds

- StudyHub's version, the interface language and the page. The DSH version is left for you to fill in.
- On a failed page: the kind of error, the program's own short error phrase (any other error text is replaced by its length) and the names of the functions where it broke.
- The kind and status of the last 20 jobs, the number of sources, decks and questions, and whether experimental features are on.
- **Session performance** (since StudyHub was opened): how long switching to each page took (median and worst, in milliseconds), how many long tasks (over 50 ms) the page ran, and, for each library update that changed something, the size of the data and how long it took to apply (median and worst).

It never holds a title, a file name, a text, a question, a path or a key.

## The session numbers

They exist so that "it is slow" comes with facts. They are kept in memory only, as the last 60 page switches and the last 40 library updates, and are gone when you close the panel. The section is written in English; with a Chinese interface each label is followed by its Chinese words. They are not written to disk or to browser storage, not sent anywhere, and not shown anywhere else. They are separate from the [usage frequency record](usage-frequency.md): turning that record on or off changes nothing here.

- **Page switch**: from the moment the page is switched to the first frame the browser starts after the new page is in place (every page is timed, the to-do board included). The sidebar's leave animation is not counted, and neither is the browser's own drawing of that frame. A page that loads its code on demand counts to its loading notice, not to its content. If the window is hidden or shown again before that frame, the switch is left out rather than counted as the time you were away.
- **Long tasks**: counted with the browser's long-task observer. Where the webview does not offer it, the line says so instead of showing 0.
- **Library update**: the size is the length of the update's text (characters, not bytes), read from the text StudyHub already made to compare it with the last one. The time (printed as "diff and apply") covers that comparison and handing the data to the page, not drawing it.

## Development

The text is built by `ui/diagnostics.js` from a short allow-list, and every free-form value is redacted. The session numbers are kept by `ui/session-performance.js` and fed by `ui/use-session-performance.js`. Tests: `tests/diagnostic-text.test.mjs`, `tests/session-performance.test.mjs`, `tests/page-boundary-browser.test.mjs`.
