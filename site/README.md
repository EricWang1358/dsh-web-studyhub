# StudyHub introduction site

This preserves the existing dark evidence-thread design. It describes the local 2.5.10 release candidate, not a published release or any proposed application redesign.

From the repository root:

```sh
node scripts/site-build.mjs
node scripts/site-server.mjs --port=4322
node scripts/site-qa.mjs
```

Open `http://127.0.0.1:4322/` for Chinese or `/en.html` for English. The preview builds first, binds to loopback only, and opens no study library or model. Use another port if an older preview is still running.

The deployable static directory is `output/site-dist/`: two pages, their local assets, and `build-manifest.json`. `package.json.version` supplies the built version. Copy the whole directory to a static host when publication is authorised; no backend, environment variables or model keys are needed. Nothing in this work publishes it. Download links intentionally go to the latest published release; do not advertise a 2.5.10 download before that release exists.

`content.mjs` contains both languages. `index.html` retains the original design and interactions, with the current Chinese content as a readable standalone source; the builder renders both languages from `content.mjs`. `demo.mjs` exposes only the product's pure SM-2 and mastery rules. Screenshots are existing sample-library assets and are labelled as such; they are not promises that every 2.5.10 interface detail is identical. Source captures under `assets/_src/` and `assets/shots/` are not needed in the deployed site.

`node scripts/site-artifact.mjs output/site/intro-fragment.html` creates an optional local Chinese HTML fragment with its demo and images embedded. Add `--lang=en` for English. This is an export, not a publication action.

The real-browser report and screenshots are under `output/site/qa-2.5.10/`. Checks cover both languages at five widths, actual interactions, default scheduler results, keyboard activation, visible focus, reduced motion, 200% text enlargement, readable no-JavaScript content, images, section targets and locally available documentation links. External runtime requests are blocked. External destinations are linked, but their live availability is not asserted by these offline checks.

See [content audit](content-audit.md) for the factual changes and their local evidence. Deployment domain, public URL, release timing and any canonical URL metadata remain decisions for the integrating maintainer.
