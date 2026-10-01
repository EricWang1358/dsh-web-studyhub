// npm run dev [-- --library=<dir>]: the study panel in a browser, served by
// scripts/preview-server.mjs through the real host handler.
//   PORT                 listen port (default 4178)
//   DSH_HOME             global study files (default output/preview-home, never ~/.dsh)
//   STUDY_FAKE_MODEL=1   deterministic fake model (scripts/fake-model.mjs);
//                        STUDY_FAKE_LATENCY_MS sets its delay (default 900)
//   STUDY_API_KEY        a real OpenAI-compatible model instead, with
//                        STUDY_BASE_URL (default DeepSeek) and STUDY_MODEL
// Run `npm run build` first: the page is dist/app.js and dist/app.css.
import { createPreviewServer, previewOptions } from "./preview-server.mjs";

const options = previewOptions();
const preview = await createPreviewServer(options);
const model = options.model === "fake" ? "fake model" : options.model ? `model ${options.model.model || "deepseek-chat"}` : "no model";
console.log(`Study preview: ${preview.url} (library ${preview.libraryRoot}; home ${preview.home}; ${model}; no sample data loaded automatically)`);
const stop = () => preview.close().finally(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
