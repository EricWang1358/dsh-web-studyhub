import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
const result = await build({
  entryPoints: ["ui/host.jsx"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  external: ["react"],
  loader: { ".css": "text" },
  jsx: "transform",
  minify: false,
});
// DSH supplies React via its classic-module loader; do not bundle a second copy.
await writeFile(
  "lib/client.js",
  `window.__ModuleLoader__.load({id:'@ericwang1358/dsh-daily-flashcard',factory:function(require){var module={exports:{}};var exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});\n`,
);
await build({
  entryPoints: ["ui/dev.jsx"],
  bundle: true,
  outdir: "dist",
  entryNames: "app",
  platform: "browser",
  format: "iife",
  loader: { ".css": "css" },
  minify: false,
});
console.log("Built DSH client and standalone preview");
