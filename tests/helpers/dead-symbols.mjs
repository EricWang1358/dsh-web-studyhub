import { parse } from 'espree';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

/* The call graph of S6-2, as a tool: which top-level declarations of lib/ does nothing in production reach? A symbol is LIVE when anything refers to it (in its own file, from another
   production file when it is exported, or through a namespace/`export *`), whatever a migration switch says: the analysis does not look at switch values, so a symbol reached only when
   a switch is off counts as live (the original path is the default), and one reached only when it is on counts as live too. DEAD is therefore dead under every value of every switch.
   The search repeats until nothing more falls: a helper used only by a dead function is dead as well. Tests are not users. */

const PRODUCTION = ['lib', 'ui', 'scripts', 'packages'];
const SKIP = new Set(['node_modules', 'dist', '.local', '.git']);
const IMPORT = /\bimport\s*(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+))?\s*from\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\bexport\s*(?:\{([^}]*)\}|\*)\s*from\s*['"]([^'"]+)['"]/g;

async function listFiles(root, directory, found = []) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true }).catch(() => [])) {
    if (SKIP.has(entry.name)) continue;
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await listFiles(root, file, found);
    else if (/\.(?:js|mjs|jsx|cjs)$/.test(entry.name) && !entry.name.startsWith('client.')) found.push(file);
  }
  return found;
}
const names = pattern => pattern.type === 'Identifier' ? [pattern.name] : pattern.type === 'ObjectPattern' ? pattern.properties.flatMap(item => names(item.value ?? item.argument))
  : pattern.type === 'ArrayPattern' ? pattern.elements.filter(Boolean).flatMap(names) : pattern.type === 'AssignmentPattern' ? names(pattern.left) : pattern.type === 'RestElement' ? names(pattern.argument) : [];
function walk(node, visit, parents = []) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node, parents);
  const next = node.type ? [...parents, node] : parents;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'range') continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit, next);
    else if (value && typeof value === 'object') walk(value, visit, next);
  }
}

/** `{ file#name }` of every dead top-level declaration of `lib/` (files given by `scope` only, when it is given). */
export async function deadSymbols(root, scope = () => true) {
  const files = (await Promise.all(PRODUCTION.map(directory => listFiles(root, directory)))).flat(), known = new Set(files);
  const target = (from, spec) => {
    if (!spec.startsWith('.')) return null;
    const base = relative(root, resolve(root, dirname(from), spec)).replaceAll('\\', '/');
    return [base, `${base}.js`, `${base}.mjs`, `${base}.jsx`, `${base}/index.js`].find(candidate => known.has(candidate)) ?? null;
  };
  const importedBy = new Map(), namespace = new Set();
  for (const file of files) {
    for (const match of (await readFile(join(root, file), 'utf8')).matchAll(IMPORT)) {
      const imported = target(file, match[4] ?? match[5] ?? match[7] ?? ''); if (!imported) continue;
      const add = name => (importedBy.get(`${imported}#${name}`) ?? importedBy.set(`${imported}#${name}`, new Set()).get(`${imported}#${name}`)).add(file);
      if (match[1]) add('default');
      if (match[3] || match[5] || (match[7] && !match[6])) namespace.add(imported);
      for (const group of [match[2], match[6]]) for (const part of group ? group.split(',') : []) { const name = part.trim().split(/\s+as\s+/)[0].trim(); if (name) add(name); }
    }
  }
  const model = new Map();
  for (const file of files.filter(item => item.startsWith('lib/') && !item.endsWith('.jsx'))) {
    let tree; try { tree = parse(await readFile(join(root, file), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' }); } catch { continue; }
    const declarations = new Map(), exported = new Set();
    for (const node of tree.body) {
      if (node.type === 'ExportDefaultDeclaration') { exported.add('default'); if (node.declaration.id) declarations.set(node.declaration.id.name, node.declaration); continue; }
      if (node.type === 'ExportNamedDeclaration' && !node.declaration) { for (const item of node.specifiers) exported.add(item.local.name); continue; }
      const inner = node.type === 'ExportNamedDeclaration' ? node.declaration : node, isExport = node.type === 'ExportNamedDeclaration';
      if (inner.type === 'FunctionDeclaration' || inner.type === 'ClassDeclaration') { declarations.set(inner.id.name, inner); if (isExport) exported.add(inner.id.name); }
      else if (inner.type === 'VariableDeclaration') for (const declarator of inner.declarations) for (const name of names(declarator.id)) { declarations.set(name, declarator); if (isExport) exported.add(name); }
    }
    const references = new Map();
    walk(tree, (node, parents) => {
      if (node.type !== 'Identifier' || !declarations.has(node.name)) return;
      const parent = parents.at(-1);
      if ((parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) || (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand)
        || (parent?.type === 'MethodDefinition' && parent.key === node) || (['FunctionDeclaration', 'ClassDeclaration'].includes(parent?.type) && parent.id === node)
        || (parent?.type === 'VariableDeclarator' && parent.id === node) || ['ImportSpecifier', 'ImportDefaultSpecifier', 'ExportSpecifier'].includes(parent?.type)) return;
      const from = parents.map(item => [...declarations].find(([, declaration]) => declaration === item)?.[0]).find(Boolean) ?? '<top>';
      if (from !== node.name) (references.get(node.name) ?? references.set(node.name, new Set()).get(node.name)).add(from);
    });
    model.set(file, { declarations, references, exported });
  }
  const dead = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const [file, { declarations, references, exported }] of model) for (const name of declarations.keys()) {
      const key = `${file}#${name}`;
      if (dead.has(key)) continue;
      const live = [...(references.get(name) ?? [])].some(from => from === '<top>' || !dead.has(`${file}#${from}`));
      const outside = exported.has(name) && (namespace.has(file) || [...(importedBy.get(key) ?? [])].some(user => user !== file));
      if (!live && !outside) { dead.add(key); changed = true; }
    }
  }
  return [...dead].filter(key => scope(key.split('#')[0])).sort();
}
