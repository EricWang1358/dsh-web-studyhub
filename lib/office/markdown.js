// Small Markdown helpers shared by the DOCX and PPTX extractors.

/** One table cell: single line, pipes escaped. */
export const tableCell = text => String(text ?? '').replace(/\s*[\r\n]+\s*/g, ' ').replace(/\|/g, '\\|').trim();

/** Rows of cell text to a Markdown table; the first row is the header. Short rows are padded. */
export function markdownTable(rows) {
  const width = Math.max(0, ...rows.map(cells => cells.length));
  if (!width || rows.every(cells => cells.every(cell => !String(cell).trim()))) return '';
  const line = cells => `| ${Array.from({ length: width }, (_, index) => tableCell(cells[index] ?? '')).join(' | ')} |`;
  return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

/** 1 -> a, 27 -> aa. */
export function letters(number) {
  let value = '', n = Math.max(1, number);
  while (n > 0) { n -= 1; value = String.fromCharCode(97 + (n % 26)) + value; n = Math.floor(n / 26); }
  return value;
}

/** 4 -> iv (lower case). */
export function roman(number) {
  const table = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let n = Math.min(3999, Math.max(1, number)), value = '';
  for (const [size, symbol] of table) while (n >= size) { value += symbol; n -= size; }
  return value;
}

/** A document title worth showing: not empty, not an application default, not just the file name. */
export function meaningfulTitle(title, filename = '') {
  const value = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!value) return undefined;
  if (/^(?:microsoft(?: office)?(?: word| powerpoint)?\b.*|powerpoint presentation|presentation\d*|document\d*|untitled\b.*|slide\s*\d*|word document|文档\s*\d*|演示文稿\s*\d*|幻灯片\s*\d*|新建.*|无标题.*)$/i.test(value)) return undefined;
  const name = String(filename).replace(/^.*[\\/]/, '');
  const stem = name.replace(/\.[^.]+$/, '');
  if (value.toLowerCase() === name.toLowerCase() || value.toLowerCase() === stem.toLowerCase()) return undefined;
  return value;
}
