import { ui } from '../i18n.js';

/* The names of 写法, the depths of lib/contexts/generation/presets.js (DEPTHS), alone. They name the writing method itself, never a preset of 出题方式: the two
   stand on one page, so they share no words (#1686). The main path (ui/presets/copy.js) and the words that arrive later (ui/presets/depth-copy.js,
   ui/presets/cost-words.js) all say them, and this file imports nothing but ui(), so the chunk of 更多选项 does not reach into lib/. */
const DEPTH_LABELS = { quick: '直接问', scenario: '短情境', blueprint: '先设计再写' };

/** A depth in words; an unknown depth is the default. */
export const depthLabel = (depth) => ui(DEPTH_LABELS[depth] || DEPTH_LABELS.scenario);
