/* The key of a cell of 出题方式 ({ density, depth }, lib/contexts/generation/presets.js) wherever a cost is kept or looked up: alone, so the words of the costs
   (ui/presets/cost-words.js, in a chunk of their own) use it without reaching into lib/. */
export const cellKey = ({ density, depth }) => `${density}:${depth}`;
