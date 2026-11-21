import { ui } from '../i18n.js';

/* The names of the depths of 出题方式 (lib/generation-presets.js DEPTHS), alone: the main path (ui/presets/copy.js) and the words that arrive later
   (ui/presets/depth-copy.js) both say them, and this file imports nothing but ui(), so the chunk of 更多选项 does not reach into lib/. */
const DEPTH_LABELS = { quick: '快问', scenario: '情境题', blueprint: '逐题精出' };

/** A depth (and the preset named after it) in words; an unknown depth is the default. */
export const depthLabel = (depth) => ui(DEPTH_LABELS[depth] || DEPTH_LABELS.scenario);
