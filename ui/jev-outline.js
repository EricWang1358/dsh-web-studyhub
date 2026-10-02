/* EXPERIMENTAL 目录噪声判断, the reader-side half: a PURE function from outline entries and Jev's labels to the entries to show.
   No React, no I/O, no import from the reader: the reader (ui/document-preview/reader/outline.js) can call it at the one place where it
   has entries and, optionally, labels from the operation `jev.outline.classify`:

     const labels = (await call('jev.outline.classify', { entries })).labels;   // {} when Jev is off or failing
     const shown = applyOutlineLabels(entries, labels, { threshold });

   Entries are { id, level, title, page? }. Only a CONFIDENT label (probability >= threshold) changes anything:
   - 'running' (running header / footer): dropped ('demote' mode) or muted ('keep' mode);
   - 'label' (a small tag such as "English original"): one level deeper and muted;
   - 'chapter', 'other', anything unsure, and entries without a label: untouched.
   Order never changes, the input is never modified, and an outline is never emptied: if everything would be dropped, nothing is. */

/** @param {{id:string,level:number,title:string}[]} entries @param {Record<string,{label:string,probability:number}>|null} labels */
export function applyOutlineLabels(entries, labels, { threshold = 0.8, mode = 'demote' } = {}) {
  if (!labels || !Object.keys(labels).length) return entries;
  const noisy = entry => {
    const found = labels[entry.id];
    return found && found.probability >= threshold && (found.label === 'running' || found.label === 'label') ? found.label : null;
  };
  const kept = entries.filter(entry => !(mode === 'demote' && noisy(entry) === 'running'));
  const source = kept.length ? kept : entries;
  return source.map(entry => {
    const kind = noisy(entry);
    if (!kind) return entry;
    return kind === 'label' ? { ...entry, level: (Number(entry.level) || 1) + 1, muted: true } : { ...entry, muted: true };
  });
}
