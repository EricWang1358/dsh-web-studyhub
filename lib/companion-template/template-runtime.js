/* Assembles the modular, ESLint-checked browser runtime files under `./runtime/` into a
   zero-dependency, single-file offline IIFE script embedded inside `studyhub-lesson/1` HTML.
   Uses only `node:fs` (no runtime `esbuild` dependency) so air-gapped domain bundles work out of the box. */

import { readFileSync } from 'node:fs';

export const RUNTIME_MODULE_FILES = Object.freeze([
  'i18n-en.js',
  'i18n-zh.js',
  'dom.js',
  'math-sandbox.js',
  'blocks-core.js',
  'blocks-visual.js',
  'bridge.js',
  'renderer.js',
  'index.js',
]);

function stripModuleSyntax(source) {
  return String(source)
    .replace(/\r\n/g, '\n')
    .replace(/^import\s+(?:[\s\S]*?)\s+from\s+['"][^'"]+['"];?\n?/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm, '')
    .trim();
}

function loadModuleSource(fileName) {
  const url = new URL(`./runtime/${fileName}`, import.meta.url);
  return stripModuleSyntax(readFileSync(url, 'utf8'));
}

function assembleRuntime({ includeChinese }) {
  const parts = [];
  if (!includeChinese) {
    parts.push('const STRINGS_ZH = null;\nconst PROOF_KEYWORDS_ZH = "";');
  }
  for (const fileName of RUNTIME_MODULE_FILES) {
    if (!includeChinese && fileName === 'i18n-zh.js') continue;
    parts.push(loadModuleSource(fileName));
  }
  const script = `(function () {\n"use strict";\n${parts.join('\n\n')}\n\nbootLessonRuntime();\n})();`;
  if (/<\/script/i.test(script)) {
    throw new Error('Assembled companion runtime script must not contain a raw </script tag');
  }
  return script;
}

export const LESSON_TEMPLATE_RUNTIME_JS = assembleRuntime({ includeChinese: true });
const EN_ONLY_RUNTIME_JS = assembleRuntime({ includeChinese: false });

export function buildLessonTemplateRuntimeJs(language = 'zh') {
  return language === 'en' ? EN_ONLY_RUNTIME_JS : LESSON_TEMPLATE_RUNTIME_JS;
}
