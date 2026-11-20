/* Entry orchestrator for StudyHub interactive companion runtime. */

import { STRINGS_EN } from "./i18n-en.js";
import { PROOF_KEYWORDS_ZH, STRINGS_ZH } from "./i18n-zh.js";
import { createDomRuntime } from "./dom.js";
import { registerCoreBlocks } from "./blocks-core.js";
import { registerSandboxBlock } from "./math-sandbox.js";
import { registerVisualBlocks } from "./blocks-visual.js";
import { createCompanionBridge } from "./bridge.js";
import { createStageRenderer } from "./renderer.js";

function readJsonScript(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  try { return JSON.parse(el.textContent); } catch { return null; }
}

export function bootLessonRuntime() {
  const lesson = JSON.parse(document.getElementById("lesson-data").textContent);
  const boot = readJsonScript("sh-companion-boot");
  const isEn = lesson.language === "en";
  const T = isEn ? STRINGS_EN : (STRINGS_ZH || STRINGS_EN);
  const extraProofKeywords = isEn ? "" : (PROOF_KEYWORDS_ZH || "");

  const { L, h, svgEl } = createDomRuntime({ lesson, boot, T, extraProofKeywords });

  let stageRef = null;
  const bridge = createCompanionBridge({
    boot,
    lesson,
    h,
    T,
    root: document.documentElement,
    paintTheme: () => stageRef?.paintTheme?.(),
    getCurrentContext: (q) => stageRef?.currentContext?.(q) || {},
    onGoto: (s, m) => stageRef?.go?.(s, m),
  });
  L.postHost = bridge.postHost;

  registerCoreBlocks({ L, h, svgEl, T, lesson, postHost: bridge.postHost });
  registerSandboxBlock({ L, h, svgEl, T });
  registerVisualBlocks({ L, h, svgEl, T });

  const memory = L.memory("lesson:" + lesson.id);
  stageRef = createStageRenderer({ lesson, boot, L, h, T, memory, postHost: bridge.postHost });

  bridge.mount();
  stageRef.bootInitialSlide();
  bridge.announceReady();
}
