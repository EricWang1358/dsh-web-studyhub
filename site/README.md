# StudyHub introduction site & architecture explorer

This directory builds both the dark evidence-thread product landing page (`index.html` / `en.html`) and the Ink-desk interactive Tech Stack & Architecture Explorer (`explorer.html` / `explorer-en.html`). `package.json.version` supplies the built version at build time.

From the repository root:

```sh
node scripts/site-build.mjs
node scripts/site-server.mjs --port=4322
node scripts/site-qa.mjs
```

Open `http://127.0.0.1:4322/` for Chinese (`/en.html` for English), or `/explorer.html` (`/explorer-en.html` for English) to inspect the interactive architecture explorer. The preview builds first, binds to loopback only, and opens no study library or model. Use another port if an older preview is still running.

The deployable static directory is `output/site-dist/`: four pages (`index.html`, `en.html`, `explorer.html`, `explorer-en.html`), their local assets (`assets/site-demo.js` and screenshots), and `build-manifest.json`. Copy the whole directory to a static host when publication is authorised; no backend, environment variables or model keys are needed. Nothing in this work publishes it.

- `content.mjs` and `index.html` render the bilingual product introduction page.
- `explorer-content.mjs` and `explorer.html` render the bilingual Tech Stack & Architecture Explorer using the real `ui/tokens.css` Ink-desk dark and light palettes, covering the component/tool/context map (`1` workbench + `6` capability plugins + `1` retrieval package + `7` DSH tools + `19` `StudyRuntime` contexts), the 5-stage reliable generation pipeline, the live FSRS-6 & mastery simulator, and the deterministic offline test & LPT sharding harness.
- `demo.mjs` bundles only the product's pure `lib/sm2.js` FSRS-6 scheduler and `lib/mastery.js` mastery rules for in-browser simulation.

`node scripts/site-artifact.mjs output/site/intro-fragment.html` creates an optional local Chinese HTML fragment of the landing page with its demo and images embedded (`--lang=en` for English).

The real-browser report and screenshots are written under `output/site/qa-2.5.10/`. Checks cover all four pages across five viewport widths (`360, 420, 768, 1280, 1680`), dark and light Ink-desk themes on the explorer, interactive walkthroughs of all four explorers, live FSRS-6 parity against `lib/sm2.js`, keyboard focus and activation, reduced motion, 200% text enlargement, readable no-JavaScript progressive enhancement, disk existence of every GitHub `blob/main/...` source link, and zero external runtime requests.

See [content audit](content-audit.md) for the landing-page claim audit and [explorer audit](explorer-audit.md) for the exact `v4.7.4` file and line references backing every architectural figure on `explorer.html`.
