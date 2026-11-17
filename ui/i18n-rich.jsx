import React from 'react';
import { uiTemplate } from './i18n.js';

/**
 * A translated sentence with elements inside it: `uiRich('答对 {0} / {1} 道。', <strong>3</strong>, 5)`. The whole sentence is one
 * catalogue key, so the English can reorder it; the n-th value replaces its {n} (text or an element). A count in an element (`<b>{1}</b>`) picks the
 * English singular form like uiFormat does ("1 attempt", #1073 round 8).
 */
const countOf = (node) => typeof node === 'number' || typeof node === 'string' ? node : node?.props?.children;
export function uiRich(template, ...nodes) {
  return uiTemplate(template, nodes.map(countOf)).split(/(\{\d+\})/).map((part, index) => {
    const hit = /^\{(\d+)\}$/.exec(part);
    return hit && Number(hit[1]) < nodes.length ? <React.Fragment key={index}>{nodes[Number(hit[1])]}</React.Fragment> : part;
  });
}
