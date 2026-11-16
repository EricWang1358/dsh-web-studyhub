import { compileMathInLesson } from './mathml.js';
import { LESSON_TEMPLATE_CSS } from './template-styles.js';
import { buildLessonTemplateRuntimeJs } from './template-runtime.js';
import { normalizeLessonSpec, validateLessonSpec } from './validate.js';

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Serialize JSON safely for embedding inside `<script id="lesson-data" type="application/json">`.
 * Escapes `<`, `>`, `&`, U+2028, and U+2029 as standard JSON `\uXXXX` sequences so strings like
 * `"</script><script>alert(1)</script>"` round-trip via `JSON.parse` with 100% fidelity and zero tag breakout.
 */
export function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Compile a `studyhub-lesson/1` specification into a zero-dependency, self-contained HTML document.
 * Works across disciplines (CS, mathematics, philosophy, mechanical engineering, economics, sciences).
 */
export function compileLessonHtml(rawLesson, { strictPedagogy = false } = {}) {
  const normalized = normalizeLessonSpec(rawLesson);
  const validation = validateLessonSpec(normalized, { strictPedagogy });
  if (!validation.ok) {
    const err = new Error(`Invalid interactive lesson specification:\n- ${validation.errors.join('\n- ')}`);
    err.code = 'companion-lesson-invalid';
    err.issues = validation.errors;
    throw err;
  }
  const withMath = compileMathInLesson(normalized);
  const langAttr = withMath.language === 'en' ? 'en' : 'zh-CN';
  const html = `<!doctype html>
<html lang="${langAttr}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(normalized.title)}</title>
<script>try{var t=localStorage.getItem("lesson-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}</script>
<style>
${LESSON_TEMPLATE_CSS}
</style>
</head>
<body>
<header class="top">
  <div class="top__title" id="title"></div>
  <nav class="beats" id="beats"></nav>
  <div class="top__tools">
    <span class="num" id="count"></span>
    <div class="notes"><button class="tool" id="notes" type="button"></button><ul class="notes__list" id="notes-list" hidden></ul></div>
    <button class="tool" id="theme" type="button"></button>
  </div>
</header>
<main class="stage" id="stage"></main>
<footer class="voice">
  <div class="voice__inner">
    <div><p class="voice__line" id="line" aria-live="polite"></p><p class="voice__key" id="key" hidden></p></div>
    <div class="voice__nav">
      <button class="btn" id="prev" type="button">←</button>
      <button class="btn btn--primary" id="next" type="button">→</button>
    </div>
  </div>
</footer>
<script type="application/json" id="lesson-data">${safeJsonForScript(withMath)}</script>
<script>
${buildLessonTemplateRuntimeJs(withMath.language)}
</script>
</body>
</html>`;

  return {
    html,
    lesson: normalized,
    validation,
  };
}
