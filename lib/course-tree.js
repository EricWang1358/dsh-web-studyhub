/* Courses may contain courses (owner request, 2.2.3). Pure, no I/O: the backend and the UI share it.

   The hierarchy lives in the NAME and nowhere else, so nothing is migrated and a stored name stays exactly as
   typed. A name is a path of segments:
   - " / " (a slash with a space on either side) always separates:  "Cloud Native Solution Design / 05 Kubernetes"
   - a slash WITHOUT spaces separates only when the text before it is the name of a known course:
     "Cloud Native Solution Design/01 …" is a child of that course, "TCP/IP" and "I/O" stay one name.
   Whitespace is trimmed and collapsed (and compared NFKC, as course ids are) for COMPARISON only.

   Containment is for reading and filtering, never for writing: a scope S contains the course C when C is S or
   one of its descendants, on whole segments ("Cloud" does not contain "Cloud Native"). `*` is everything and
   `''` is uncategorised (a parent scope never matches an item without a course). Everything that scopes by
   course goes through `courseScope` / `courseWithin`; exact identity (a source's own course list, an
   expectedCourses check, a stored name) keeps comparing exact names. */

const squash = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const fold = value => squash(value).normalize('NFKC');
const SLASHES = new Set(['/', '／']);
const SEPARATOR = ' / ';

/** The segments of a course name, trimmed. `known` are the library's course names (for the no-space slash rule). */
export function courseSegments(name, known = []) {
  const text = squash(name);
  if (!text) return [];
  return segmentsOf(text, knownKeys(known));
}

/* A parent nobody filed anything under is as known as one that exists: "Design / 05 x" makes "Design" known. */
function knownKeys(known) {
  if (known instanceof Set) return known;
  const keys = new Set();
  for (const item of known || []) {
    if (typeof item !== 'string') continue;
    const text = squash(item);
    keys.add(fold(text));
    for (let i = 0; i < text.length; i++) {
      if (!SLASHES.has(text[i]) || (text[i - 1] !== ' ' && text[i + 1] !== ' ')) continue;
      if (text.slice(0, i).trim() && text.slice(i + 1).trim()) keys.add(fold(text.slice(0, i)));
    }
  }
  return keys;
}

function segmentsOf(text, keys) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!SLASHES.has(text[i])) continue;
    const head = text.slice(start, i).trim(), rest = text.slice(i + 1).trim();
    if (!head || !rest) continue;
    const spaced = text[i - 1] === ' ' || text[i + 1] === ' ';
    if (spaced || keys.has(fold(text.slice(0, i)))) { parts.push(head); start = i + 1; }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

const pathOf = (name, keys) => segmentsOf(squash(name), keys).map(fold).join(SEPARATOR);

/**
 * A matcher for "is this course inside `scope`", prepared once for a loop.
 * `scope`: `*` / undefined / null (all), `''` (uncategorised) or a course name. The result carries `all` and
 * `uncategorised` for callers that want to skip work.
 */
export function courseScope(scope, known = []) {
  const keys = knownKeys(known);
  const all = scope === undefined || scope === null || scope === '*';
  const none = !all && typeof scope === 'string' && !squash(scope);
  const wanted = all || none || typeof scope !== 'string' ? '' : pathOf(scope, keys);
  const cache = new Map();
  const within = course => {
    if (all) return true;
    const text = typeof course === 'string' ? squash(course) : '';
    if (none) return !text;
    if (!text || !wanted) return false;
    let path = cache.get(text);
    if (path === undefined) cache.set(text, path = pathOf(text, keys));
    return path === wanted || path.startsWith(wanted + SEPARATOR);
  };
  return Object.assign(within, { all, uncategorised: none });
}

/** Is `course` the scope itself or one of its descendants? (`known`: the library's course names.) */
export function courseWithin(scope, course, known = []) {
  return courseScope(scope, known)(course);
}

/** The parent path of a course (the stored name of an existing parent when there is one), or null for a top-level name. */
export function courseParent(name, known = []) {
  const keys = knownKeys(known);
  const segments = segmentsOf(squash(name), keys);
  if (segments.length < 2) return null;
  const parent = segments.slice(0, -1);
  const wanted = parent.map(fold).join(SEPARATOR);
  const stored = (Array.isArray(known) ? known : []).find(item => typeof item === 'string' && squash(item) && pathOf(item, keys) === wanted);
  return stored !== undefined ? squash(stored) : parent.join(SEPARATOR);
}

/** The course names prepared once for loops (every function here also accepts the plain list). */
export const courseKnown = names => knownKeys(names);

/** The comparison path of a course: its segments, NFKC, joined by " / ". Two spellings of one course share it. */
export function coursePath(name, known = []) {
  return pathOf(name, knownKeys(known));
}

/** The comparison paths from the top-level course down to `name` itself (for adding up a subtree). */
export function courseAncestors(name, known = []) {
  const segments = segmentsOf(squash(name), knownKeys(known)).map(fold);
  return segments.map((_, index) => segments.slice(0, index + 1).join(SEPARATOR));
}

const collate = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** A comparator that puts a parent before its chapters and chapters in natural order ("01" before "10"). */
export function courseOrder(known = []) {
  const keys = knownKeys(known);
  return (a, b) => {
    const left = segmentsOf(squash(a), keys), right = segmentsOf(squash(b), keys);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const order = collate(left[i], right[i]);
      if (order) return order;
    }
    return left.length - right.length;
  };
}

const natural = (a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Course names as a tree, flattened in display order (each parent, then its children in natural order, so "01" comes
 * before "10"); top-level names keep the order given (pickers pass them ranked). A parent nobody filed anything under is
 * included as an implicit row. Row: `{ key, name, names, label, depth, implicit, parent, childCount }`
 * - `name`: what choosing the row fills in (the stored name as typed, or the path of an implicit parent);
 * - `names`: every stored spelling that is this node (two spellings of one path are one row);
 * - `label`: the last segment; `parent`: the parent's `name` or null.
 * `known` adds names for the no-space slash rule (the given names are always known).
 */
export function courseTree(names = [], known = names) {
  const list = (names || []).filter(name => typeof name === 'string' && squash(name) && name !== '*');
  const keys = knownKeys([...(known || []), ...list]);
  const nodes = new Map(), roots = [];
  for (const raw of list) {
    const segments = segmentsOf(squash(raw), keys);
    let parent = null;
    segments.forEach((segment, index) => {
      const key = segments.slice(0, index + 1).map(fold).join(SEPARATOR);
      let node = nodes.get(key);
      if (!node) {
        node = { key, name: segments.slice(0, index + 1).join(SEPARATOR), names: [], label: segment, depth: index, implicit: true, parentNode: parent, children: [] };
        nodes.set(key, node);
        (parent ? parent.children : roots).push(node);
      }
      parent = node;
    });
    if (!parent.names.length) parent.name = squash(raw);
    if (!parent.names.includes(squash(raw))) parent.names.push(squash(raw));
    parent.implicit = false;
  }
  const rows = [];
  const walk = node => {
    rows.push({ key: node.key, name: node.name, names: node.names, label: node.label, depth: node.depth, implicit: node.implicit,
      parent: node.parentNode ? node.parentNode.name : null, childCount: node.children.length });
    for (const child of [...node.children].sort(natural)) walk(child);
  };
  roots.forEach(walk);
  return rows;
}
