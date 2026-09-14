// PDF content streams describe drawing order, not reading order. Keep visible
// lines and wide column gaps without claiming to reconstruct table/diagram semantics.
export function pageText(items, viewport) {
  const fragments = items.filter((item) => typeof item.str === "string" && item.str.trim()).map((item) => {
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const height = Math.max(1, item.height * viewport.scale);
    return { text: item.str, x, y, width: item.width * viewport.scale, height, dir: item.dir,
      rotated: Math.abs(item.transform[1]) > Math.abs(item.transform[0]) * 0.2 };
  });
  fragments.sort((a, b) => a.y - b.y || a.x - b.x);
  const origin = fragments.reduce((minimum, f) => Math.min(minimum, f.x), Infinity);
  const sizes = fragments.map((f) => f.height).sort((a, b) => a - b);
  const columnWidth = Math.max(3, (sizes[Math.floor(sizes.length / 2)] || 12) * 0.5);
  const lines = [];
  for (const fragment of fragments) {
    // Nearby baselines can differ slightly when an inline word changes font.
    const line = lines.findLast((l) => Math.abs(l.y - fragment.y) <= Math.min(l.height, fragment.height) * 0.25);
    if (line) { line.items.push(fragment); line.height = Math.max(line.height, fragment.height); }
    else lines.push({ y: fragment.y, height: fragment.height, items: [fragment] });
  }
  let wideGaps = 0;
  const text = lines.map((line, index) => {
    const rtl = line.items.filter((i) => i.dir === "rtl").length > line.items.length / 2;
    line.items.sort((a, b) => rtl ? b.x - a.x : a.x - b.x);
    // Leading indentation is essential: a continuation in the right cell must
    // not be presented as a new left-column label after coordinate sorting.
    let result = " ".repeat(Math.min(200, Math.max(0, Math.round((line.items[0].x - origin) / columnWidth)))), previous;
    for (const item of line.items) {
      if (previous) {
        const gap = rtl ? previous.x - item.x - item.width : item.x - previous.x - previous.width;
        const size = Math.min(previous.height, item.height);
        if (gap > size * 1.5) {
          result += " ".repeat(Math.min(200, Math.max(3, Math.round(gap / columnWidth))));
          wideGaps++;
        }
        else if (!/\s$/.test(result) && !/^\s/.test(item.text) && gap > size * 0.12)
          result += " ";
      }
      result += item.text;
      previous = item;
    }
    const paragraph = index > 0 && line.y - lines[index - 1].y > Math.max(line.height, lines[index - 1].height) * 1.8;
    return (paragraph ? "\n" : "") + result.trimEnd();
  }).join("\n").trimEnd();
  const warnings = [];
  if (wideGaps) warnings.push("Page contains separated text regions: verify columns, tables and diagrams against the PDF; text order does not establish relationships.");
  if (viewport.rotation || fragments.some((f) => f.rotated)) warnings.push("Page contains rotated text; reading order needs visual verification.");
  return { text, warnings };
}
