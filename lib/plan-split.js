/* 备考计划's one way of cutting a list of points into days of about the same cost (lib/plan-schedule.js, lib/plan-weekly.js). Pure. */

const total = (list, cost) => list.reduce((sum, item) => sum + cost(item), 0);

/** `list` (in the order to take it) cut into `count` days of about the same cost; `preload`: what the first day already carries (done today). */
export function split(list, count, cost, preload = 0) {
  const out = [], rest = [...list];
  for (let k = 0; k < count; k += 1) {
    const left = count - k;
    if (left === 1) { out.push(rest.splice(0)); break; }
    let load = k === 0 ? preload : 0;
    const target = (total(rest, cost) + load) / left, chunk = [];
    // A day with nothing on it yet always takes the next point; otherwise a point is taken while its middle fits under the day's share.
    while (rest.length && ((!chunk.length && load === 0) || load + cost(rest[0]) / 2 <= target)) { load += cost(rest[0]); chunk.push(rest.shift()); }
    out.push(chunk);
  }
  return out;
}
