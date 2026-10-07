import { parse } from 'espree';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/* The card fields the 任务 console reads, derived from its code and not written down by hand: every property path read from a job's CONTRACT (`contract.status`, `contract.progress.percent`,
   `contract.detail.run.running` ...) or from one of its calls in ui/tasks/**. A new field read by the console shows up here the next time the matrix runs.
   The scan is by name: the variables the console binds to a contract (`contract`, or the result of `contractOf(...)`/`jobContract(...)`), to a call (`call`) and to an event (`event`),
   with optional chaining and destructuring followed. A field read through a helper that is passed the contract is found where the helper reads it (the helpers are in the same folder). */

// `event` is left out: in the console it is mostly a DOM event (`event.key`, `event.target`); the events a job carries are read through `contract.events` and are checked as such.
const ROOTS = { contract: 'contract', call: 'calls[]' };
// A read that ends in an array or string method reads the value it is called on (`contract.calls.filter` reads `contract.calls`).
const METHODS = new Set(['filter', 'find', 'map', 'some', 'every', 'forEach', 'slice', 'reduce', 'includes', 'at', 'join', 'flatMap', 'sort', 'indexOf', 'length', 'trim', 'toFixed', 'startsWith',
  'endsWith', 'toLowerCase', 'toString', 'concat', 'findLast', 'keys', 'values', 'entries']);
const clean = path => { const parts = path.split('.'); while (parts.length > 1 && METHODS.has(parts.at(-1))) parts.pop(); return parts.join('.'); };

const chainOf = node => {
  if (node.type === 'ChainExpression') return chainOf(node.expression);
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'MemberExpression') {
    const base = chainOf(node.object);
    if (!base) return null;
    return [...base, node.computed ? (node.property.type === 'Literal' ? String(node.property.value) : '[]') : node.property.name];
  }
  return null;
};

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'range') continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

/** The set of property paths one file reads, relative to the contract (`status`, `progress.percent`, `calls[].stepKey`, ...). */
export function fieldsOfSource(source) {
  const found = new Set();
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true });
  // which local names stand for the contract (or a part of it)
  const alias = new Map(Object.entries(ROOTS).map(([name, path]) => [name, path]));
  walk(tree, node => {
    if (node.type === 'VariableDeclarator' && node.init) {
      const init = node.init.type === 'CallExpression' && ['contractOf', 'jobContract'].includes(node.init.callee.name) ? ['contract'] : chainOf(node.init);
      const base = init && (alias.get(init[0]) !== undefined) ? [alias.get(init[0]), ...init.slice(1)].join('.').replace(/\.\[\]/g, '[]') : null;
      if (!base) return;
      if (node.id.type === 'Identifier') alias.set(node.id.name, base);
      if (node.id.type === 'ObjectPattern') for (const property of node.id.properties) if (property.type === 'Property' && property.key.type === 'Identifier') {
        const path = `${base}.${property.key.name}`;
        found.add(path);
        if (property.value.type === 'Identifier') alias.set(property.value.name, path);
        if (property.value.type === 'AssignmentPattern' && property.value.left.type === 'Identifier') alias.set(property.value.left.name, path);
      }
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression')
      for (const parameter of node.params) {
        if (parameter.type === 'Identifier' && ROOTS[parameter.name]) alias.set(parameter.name, ROOTS[parameter.name]);
        if (parameter.type === 'ObjectPattern') for (const property of parameter.properties) if (property.type === 'Property' && property.key.type === 'Identifier' && ROOTS[property.key.name])
          alias.set(property.value.type === 'Identifier' ? property.value.name : property.key.name, ROOTS[property.key.name]);
      }
  });
  walk(tree, node => {
    if (node.type !== 'MemberExpression') return;
    const chain = chainOf(node);
    if (!chain || alias.get(chain[0]) === undefined) return;
    const path = [alias.get(chain[0]), ...chain.slice(1)].join('.').replace(/\.\[\]/g, '[]');
    found.add(path);
  });
  return new Set([...found].map(clean));
}

/** Every path the console reads, per root (`contract`, `calls[]`), with the files that read it. Only the leaves and the paths a child is read under are kept. */
export async function consoleFields(root) {
  const directory = join(root, 'ui/tasks'), byPath = new Map();
  for (const name of (await readdir(directory)).filter(item => /\.(?:js|jsx)$/.test(item))) {
    for (const path of fieldsOfSource(await readFile(join(directory, name), 'utf8'))) (byPath.get(path) ?? byPath.set(path, new Set()).get(path)).add(name);
  }
  const paths = [...byPath.keys()].sort();
  // a path that has a longer one under it is a branch (`contract.progress` when `contract.progress.percent` is read): keep the reads that end there
  const leaves = paths.filter(path => !paths.some(other => other.startsWith(`${path}.`) || other.startsWith(`${path}[]`)));
  return { paths, leaves, files: Object.fromEntries(paths.map(path => [path, [...byPath.get(path)].sort()])) };
}
