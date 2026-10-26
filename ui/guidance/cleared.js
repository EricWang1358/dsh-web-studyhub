/*
 * How many times THIS tab cleared a guidance item through 设置 › 引导 (ui/guidance/registry.js clearItem). A surface that also keeps a closing in memory
 * for the visit (the first-run line's 以后再说, a reader hint) stores this count with it and honours the memory only while the count is unchanged: an
 * explicit 再显示一次 or 重新显示全部提示 in this tab undoes it, while another tab's reset or cleared site data does not bring a closed item back in the
 * middle of a visit. Plain module state, no storage.
 */
const counts = new Map();

/** The clear count of item `id` in this tab (0 until it is cleared). */
export const clearCount = id => counts.get(id) || 0;

/** Count one clear of item `id` (registry.js calls it). */
export const noteCleared = id => { counts.set(id, clearCount(id) + 1); };
