/* The tones every status primitive (Badge, Chip, Hint, ProgressBar, JobRow…)
   shares. The names are the contract; their colours live in one block of
   feedback.css ([data-tone]), so a palette change is made there only. */
export const TONES = Object.freeze(['neutral', 'info', 'success', 'warning', 'error', 'accent']);
export const toneOf = (tone, fallback = 'neutral') => TONES.includes(tone) ? tone : fallback;
/** The icon that says the same thing as the colour (colour alone never carries meaning). */
export const TONE_ICONS = Object.freeze({ info: 'info', success: 'success', warning: 'warning', error: 'error' });
