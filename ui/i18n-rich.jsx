import React from 'react';
import { ui } from './i18n.js';

/**
 * A translated sentence with elements inside it: `uiRich('答对 {0} / {1} 道。', <strong>3</strong>, 5)`. The whole sentence is one
 * catalogue key, so the English can reorder it; the n-th value replaces its {n} (text or an element).
 */
export function uiRich(template, ...nodes) {
  return ui(template).split(/(\{\d+\})/).map((part, index) => {
    const hit = /^\{(\d+)\}$/.exec(part);
    return hit && Number(hit[1]) < nodes.length ? <React.Fragment key={index}>{nodes[Number(hit[1])]}</React.Fragment> : part;
  });
}
