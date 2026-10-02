import { USAGE_AREA_IDS, USAGE_CLASS_HOOKS, TEXT_FIELD_KEY } from './registry.js';
import { canonicalName } from './names.js';

/* Which control was used, as a stable, language-independent key. Pure: it reads attributes and the tree above the control, never layout, never
   what the learner typed.

   Order: `data-usage` (set by hand on controls that cannot be keyed well; the registry lists them) → a class hook that belongs to one
   control (the registry) → the control's own data-tour / data-testid / a stable id → `<area>/<role>/<canonical name>` where the name is the
   app's own copy of the control's name (ui/usage/names.js: Chinese and English alike, numbers as N) → `<area>/<role>`. A text box, text area
   or editor is always "text field": nothing about it is read. Inside an element marked `data-usage-ignore` (the usage section itself)
   nothing is recorded. The area is the nearest `data-usage-area` above the control. */

const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password', '']);
const CONTROL_ROLES = new Set(['button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'checkbox', 'radio', 'link', 'option', 'treeitem', 'combobox', 'slider', 'spinbutton']);
const MAX_DEPTH = 80, MAX_TEXT_CHILDREN = 8;
const attr = (node, name) => (typeof node.getAttribute === 'function' ? node.getAttribute(name) : null);

function isTextField(node) {
  const tag = node.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return TEXT_TYPES.has(String(node.type || attr(node, 'type') || 'text').toLowerCase());
  const editable = attr(node, 'contenteditable');
  return editable !== null && editable !== 'false';
}
function isControl(node) {
  const tag = node.tagName;
  if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'SUMMARY' || tag === 'INPUT') return true;
  if (tag === 'A') return attr(node, 'href') !== null || attr(node, 'role') !== null;
  const role = attr(node, 'role');
  return role !== null && CONTROL_ROLES.has(role);
}
function roleOf(node) {
  const role = attr(node, 'role');
  if (role && CONTROL_ROLES.has(role)) return role === 'menuitemcheckbox' || role === 'menuitemradio' ? 'menuitem' : role;
  switch (node.tagName) {
    case 'A': return 'link';
    case 'SELECT': return 'select';
    case 'SUMMARY': return 'disclosure';
    case 'INPUT': { const type = String(node.type || attr(node, 'type') || '').toLowerCase(); return type === 'checkbox' || type === 'radio' || type === 'range' || type === 'file' ? type : type === 'submit' || type === 'button' || type === 'reset' ? 'button' : 'input'; }
    default: return 'button';
  }
}
const plainKey = value => typeof value === 'string' && value.length > 0 && value.length <= 80 && /^[a-z0-9][a-z0-9._-]*$/.test(value);
const stableId = value => typeof value === 'string' && /^[A-Za-z][A-Za-z_-]{3,59}$/.test(value);

/** The first of the control's own names that is the app's own copy, as a canonical string; null when none is. */
function nameOf(node) {
  const tag = node.tagName;
  const label = attr(node, 'aria-label');
  let canonical = label ? canonicalName(label) : null;
  if (canonical) return canonical;
  if (tag === 'INPUT' || tag === 'SELECT') {
    const text = node.labels?.[0]?.textContent;
    canonical = text ? canonicalName(text) : null;
    return canonical;
  }
  const children = node.childElementCount;
  if (!(typeof children === 'number' && children > MAX_TEXT_CHILDREN)) {
    const text = node.textContent;
    canonical = typeof text === 'string' && text.length <= 200 ? canonicalName(text) : null;
    if (canonical) return canonical;
  }
  const title = attr(node, 'title');
  return title ? canonicalName(title) : null;
}

/** The page (area) of an element: the nearest data-usage-area above it, else the fallback; unknown pages are `other`. */
export function usageAreaOf(node, fallbackArea = 'other') {
  let found = null;
  for (let at = node, depth = 0; at && depth < MAX_DEPTH && !found; at = at.parentElement, depth += 1) found = attr(at, 'data-usage-area');
  const area = found || fallbackArea;
  return USAGE_AREA_IDS.includes(area) ? area : 'other';
}

/**
 * The key a click on `target` is recorded under: { key, area, source } or null when it is not a control (or is inside the usage section).
 * `source` is how the key was found (usage | hook | tour | testid | id | name | role | text), for tests and the report's footnotes.
 */
export function resolveUsageControl(target, { fallbackArea = 'other' } = {}) {
  let start = target;
  if (start && start.nodeType === 3) start = start.parentElement;
  let control = null, textField = false, explicit = null, area = null;
  for (let node = start, depth = 0; node && depth < MAX_DEPTH; node = node.parentElement, depth += 1) {
    if (typeof node.hasAttribute === 'function' && node.hasAttribute('data-usage-ignore')) return null;
    if (!area) area = attr(node, 'data-usage-area');
    // The nearest data-usage above the click names it, even when the marked element is a small wrapper around the real control (a segmented switch).
    const usage = explicit === null ? attr(node, 'data-usage') : null;
    if (usage) explicit = usage;
    if (control) continue;
    if (isTextField(node)) { textField = true; control = node; }
    else if (usage || isControl(node)) control = node;
  }
  if (!control) return null;
  const where = USAGE_AREA_IDS.includes(area || fallbackArea) ? (area || fallbackArea) : 'other';
  if (textField) return { key: TEXT_FIELD_KEY, area: where, source: 'text' };
  if (explicit && plainKey(explicit)) return { key: explicit, area: where, source: 'usage' };
  for (const name of control.classList || []) if (Object.hasOwn(USAGE_CLASS_HOOKS, name)) return { key: USAGE_CLASS_HOOKS[name], area: where, source: 'hook' };
  const tour = attr(control, 'data-tour');
  if (plainKey(tour)) return { key: `tour.${tour}`, area: where, source: 'tour' };
  const testid = attr(control, 'data-testid');
  if (plainKey(testid)) return { key: `testid.${testid}`, area: where, source: 'testid' };
  const id = attr(control, 'id');
  if (stableId(id)) return { key: `id.${id}`, area: where, source: 'id' };
  const role = roleOf(control), name = nameOf(control);
  return name ? { key: `${where}/${role}/${name}`, area: where, source: 'name' } : { key: `${where}/${role}`, area: where, source: 'role' };
}
