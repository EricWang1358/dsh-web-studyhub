/* The names of the one-pass write styles and the default, alone: the settings (lib/generation-settings.js) and the presets (lib/contexts/generation/presets.js) validate
   and name a style without carrying its wording, so the first load of the workspace does not bring the write prompts. The wording of each name is
   lib/one-pass/write-style.js (WRITE_STYLES has exactly these keys: tests/one-pass-write-style.test.mjs). */
export const WRITE_STYLE_NAMES = Object.freeze(['scenario', 'quick']);
export const DEFAULT_WRITE_STYLE = 'scenario';
