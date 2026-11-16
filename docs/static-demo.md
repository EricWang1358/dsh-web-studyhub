# Static Interactive Demo

[中文](static-demo.zh-CN.md)

Public demo: [StudyHub Interactive Demo](https://daily-flashcard-demo.ziangw1358.chatgpt.site) (Sites project ID: `appgprj_6ab9f86def1481918e0fe901197f372c` — reuse this project on subsequent deployments).

`npm run build:demo` builds `output/static-demo-site/dist`. Deploy that directory to any static hosting service — no runtime API, backend server, or API key is required. Open it over HTTP(S) rather than double-clicking the HTML file directly.

The demo mounts the real `ui/App.jsx` components and styles, reusing `lib/service.js` for grading and FSRS-6 scheduling. `web-demo/` supplies only browser `localStorage` persistence, public sample fixtures, precompiled cross-discipline **Interactive Companions**, and prerecorded AI adapters.

- **English by default** on first visit; the sidebar **Language** switch is shared with the plugin and saved in `localStorage`.
- Switching interface language changes UI copy, notifications, and new preset AI responses without translating existing cards, options, citations, or user notes.
- Ships 7 English questions on **Memento / Bridge** (with live **Open slide N in companion** deep-links on revealed cards), **3 precompiled cross-discipline Interactive Companions** playable directly in the browser (**Physics & ODEs** 1D/2D phase-portrait quiver sandbox with regime presets, **Moral Philosophy & Algorithmic Guardrails** `predictBeforeReveal` counterexample matrix & modal logic MathML, and **Software Design Patterns** closed-loop observer/backpressure & Memento/Bridge stage), 44 sample review attempts, 2 weak cards, 2 editable notes, a 5-node knowledge outline, a complete learning flow, 1 pending draft, 3 inbox messages, and 3 board tasks — all clearly disclosed as sample data in the top banner.
- **Reset demo** clears local sample progress while keeping your chosen interface language.
- Local PDF/file paths, host chat tools, cross-workspace notebooks, live audio transcription, custom companion authoring, and unscripted AI generation require the installed DSH plugin.

Verification: `npm run verify` and `tests/language-demo.test.mjs`.
