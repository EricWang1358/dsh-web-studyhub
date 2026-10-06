import React from 'react';
import { highlightParts } from './option-list.js';

/* The pieces Select and Combobox share, with no Base UI in them (so the facades can draw a trigger before the popup code has loaded). */

/** A label with the matched parts of the typed text marked (<mark> is drawn underlined, not coloured). */
export function Highlighted({ text, query }) {
  const parts = highlightParts(text, query);
  if (parts.length === 1 && !parts[0].match) return parts[0].text;
  return parts.map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : <React.Fragment key={index}>{part.text}</React.Fragment>);
}

/** What a closed trigger shows: the chosen label with its hint beside it, or the placeholder in the faint colour. */
export function TriggerValue({ option, placeholder }) {
  if (!option) return <span className="sh-select__value sh-select__placeholder">{placeholder}</span>;
  return <span className="sh-select__value">{option.triggerLabel ?? option.label}{option.hint ? <small>{option.hint}</small> : null}</span>;
}

/** The option a closed trigger shows: the chosen one, else (a value that is no option, such as "new deck") `valueLabel` as plain text. */
export const chosenOption = (flat, value, valueLabel) => flat[indexOfValue(flat, value)] ?? (valueLabel ? { label: valueLabel } : undefined);

/** The index of `value` among the flat options: exact match first, then by text (a page may hold 150 where the option says "150"). */
export function indexOfValue(flat, value) {
  if (value === null || value === undefined) return flat.findIndex((option) => option.value === value);
  const exact = flat.findIndex((option) => option.value === value);
  return exact >= 0 ? exact : flat.findIndex((option) => String(option.value) === String(value));
}

/** The element a popup is drawn into: the open dialog the trigger sits in (a dialog is in the top layer, the app is not), else the study
    surface; the document body only outside both. The same host the Menu uses, so the interface zoom is the host's own. */
export const POPUP_HOST = 'dialog[open], .study-app, .study-seat';
export const popupHost = (trigger) => (typeof document === 'undefined' ? null : trigger?.closest?.(POPUP_HOST) || document.body);

export const mergeRefs = (...refs) => (node) => {
  for (const ref of refs) { if (typeof ref === 'function') ref(node); else if (ref) ref.current = node; }
};
