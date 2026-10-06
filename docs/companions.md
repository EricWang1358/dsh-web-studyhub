# Works well with other tools

[中文](companions.zh-CN.md)

StudyHub covers the study side: sources, questions, practice, review. For jobs that are heavy and already done well elsewhere, it recommends a proven open-source tool and gives it a clean way in and out. It does not copy or rebuild those tools, and it has no partnership with their authors. This page lists them.

## Archify: interactive diagrams of your outline

[Archify](https://github.com/tt-a1i/archify) is an open-source (MIT licence) agent skill by tt-a1i. You describe something, or point it at a plan or a repository, and it writes **one self-contained interactive HTML file**: architecture, workflow, sequence, data-flow and lifecycle diagrams, and learning maps. The file opens offline in a browser (links inside it need a network). See the [project page](https://tt-a1i.github.io/archify/) and the [live examples](https://tt-a1i.github.io/archify/gallery.html).

**Why we recommend it.** The outline view inside StudyHub (the **Knowledge outline** page, with **Learning spine** and **Structure diagram**) shows how your concepts connect, but it is a plain structure view. Archify draws richer diagrams that you can click through. So StudyHub points you to it, and accepts what it makes.

### Install

Archify's own README lists the DeepSeek Harness plugin. In a terminal:

```
dsh plugin --profile web add @tt-a1i/archify-dsh@1.0.0
```

`web` is the name of a DSH profile. Use the profile you run: in the browser it is `web`, in the desktop app it is usually `desktop`. The same card on the **Knowledge outline** page shows this command with a **Copy** button. To remove it: `dsh plugin --profile web remove @tt-a1i/archify-dsh`. Other agents use `npx skills add tt-a1i/archify -g`. Check Archify's README for the current version; `1.0.0` is the one this page was written against.

### How the hand-off works

1. Open **Knowledge outline** and open a saved outline.
2. Click **Draw this outline with Archify**. StudyHub puts a short prompt in your DSH chat (or copies it when the chat has no input box). You read it and send it.
3. The assistant reads the outline with `skeleton.get`, then uses the `archify` skill. It picks the diagram type that fits: concepts as nodes, prerequisites as arrows, contrasts and causes as labelled relations. The outline carries which questions each concept has, not mastery, so the diagram shows coverage at most.
4. The assistant writes the HTML into your workspace (for example `diagrams/<title>.html`) and registers it with `skeleton.diagram.attach {id, path, title?}`.
5. StudyHub copies the file into your library and lists it under **Interactive diagrams** on the outline: title, date, size, and **The outline changed; this diagram may be out of date** when the outline was edited after the diagram was made.
6. **Open** shows it inside StudyHub. **Delete** removes the library's copy (not the file in your workspace).

If the `archify` skill is not installed, the assistant says so and gives you the install command above. It does not draw something else in its place.

### Where the file is kept, and what StudyHub does with it

- The copy is `<library>/skeleton-diagrams/<outline id>/<diagram id>.html`; a small record (title, date, size, a SHA-256 of the file, the outline revision it was drawn from) is kept on the outline. Both are in the full library backup and come back on restore (a file that has gone missing is left out, and the entry says so when opened).
- At most **8 diagrams per outline**. The ninth replaces the oldest, and the assistant is told which one. Attaching the very same file again changes nothing.
- StudyHub **never runs, edits or sends** the file. It is not read by any model call. It stays in your library.
- Archify has an optional update reminder that may fetch a fixed manifest; that request is Archify's own, made when you use Archify, and StudyHub neither makes nor sees it.

### Threat note: showing an HTML file an AI wrote

The file may contain any script. StudyHub treats it as untrusted.

**What attaching accepts.** Only a regular file whose real path (links resolved) is inside the session workspace or the library; at most 5 MB; one UTF-8 document that starts like an HTML page (`<!doctype html>` or `<html>`). A path outside those folders, a link that leads out of them, a folder, a binary, a JSON file or anything larger is refused with the reason. The session workspace is set by StudyHub, never by the request.

**What opening does.**

- The document is shown in an `iframe` with `sandbox="allow-scripts"` and nothing else. Its scripts run (that is what makes it interactive), but it has an opaque origin: it cannot read StudyHub's page, storage or cookies, cannot navigate the page, submit forms, open windows, download files or show dialogs. `parent.document` throws inside it.
- It is passed as `srcdoc`, not a URL, with `referrerpolicy="no-referrer"` and a `csp` that stops `fetch`, WebSocket and form posts. A diagram that loads an image or a font from the network can still do so; that request carries nothing of yours.
- One small script is added at the top of the head so that clicking a link leaves the diagram where it is (links to other pages are not followed in-app; `#` links inside the page work). That is a courtesy, not the protection: the sandbox is.
- A banner says the diagram was made outside StudyHub and is shown in an isolated window.

What this does not do: it cannot stop a page from using your CPU, or from drawing something misleading. Delete a diagram you do not trust.

## More companions

Placeholder: other tools StudyHub may recommend later (heavy PDF conversion and retrieval already link to their own guides: [large textbooks](large-documents.md) and [MinerU conversion](mineru-conversion.md)). Each will get the same shape: what it is, why, how to install, how the hand-off works, and what stays in your library.
