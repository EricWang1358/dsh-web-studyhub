import { parse } from 'espree';

const key = node => node?.type === 'Identifier' ? node.name : node?.type === 'Literal' ? String(node.value) : '';
const member = node => node?.type === 'ChainExpression' ? member(node.expression) : node?.type === 'Identifier' ? node.name
  : node?.type === 'MemberExpression' ? `${member(node.object)}.${key(node.property)}` : '';
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const [name, value] of Object.entries(node)) {
    if (name === 'parent') continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
const tree = source => parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
// `….gateway.step(key, policy).complete(…)` is the managed model path itself, never a bypass.
const isGatewayStep = node => node?.type === 'CallExpression' && /(?:^|\.)gateway\.step$/.test(member(node.callee));
// …and so is a call on a name the module bound to such a step (`const step = gateway.step(…); step.complete(…)`).
const gatewayStepNames = root => {
  const names = new Set();
  walk(root, node => { if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && isGatewayStep(node.init)) names.add(node.id.name); });
  return names;
};
const gatewayStepCall = (node, names) => node.callee?.type === 'MemberExpression'
  && (isGatewayStep(node.callee.object) || (node.callee.object?.type === 'Identifier' && names.has(node.callee.object.name)));
const providerUrl = value => typeof value === 'string' && /^https:\/\/(?:generativelanguage\.googleapis\.com|api\.groq\.com|api\.siliconflow\.(?:cn|com))\//.test(value);

export function hasDefinition(source) {
  let found = false;
  walk(tree(source), node => { if (node.type === 'ObjectExpression') {
    const names = node.properties.map(property => key(property.key));
    if (['kind', 'version', 'run'].every(name => names.includes(name))) found = true;
  } });
  return found;
}

/** Inventory actual call-expression boundaries, not strings/comments or every fetch.
 * This is a review guard, not whole-program taint analysis or an authority check. */
export function inspectCalls(source) {
  const counts = new Map();
  const record = name => counts.set(name, (counts.get(name) || 0) + 1);
  const root = tree(source), steps = gatewayStepNames(root);
  walk(root, node => {
    const binding = node.type === 'VariableDeclarator' ? key(node.id) : node.type === 'Property' ? key(node.key) : '';
    const value = node.type === 'VariableDeclarator' ? node.init : node.type === 'Property' ? node.value : null;
    if (/(?:jobs|tasks|queues|queue)$/i.test(binding) && (value?.type === 'ArrayExpression' || value?.type === 'NewExpression' && ['Map', 'Set'].includes(key(value.callee))))
      record(`collection:${binding}:${value.type === 'ArrayExpression' ? 'Array' : key(value.callee)}`);
    if (node.type !== 'CallExpression' || gatewayStepCall(node, steps)) return;
    const callee = member(node.callee), last = callee.split('.').at(-1);
    if ((last === 'complete' && node.arguments.length >= 2) || /(?:^|\.)llm\.stream$/.test(callee) ||
        (last === 'fetch' && providerUrl(node.arguments[0]?.value))) record(callee);
  });
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([callee, count]) => ({ callee, count }));
}

export function auditManagedModule(source) {
  const violations = inspectCalls(source).map(item => `model-bypass:${item.callee}`);
  walk(tree(source), node => {
    if (node.type === 'ImportDeclaration' && /(?:gemini|groq|siliconflow|model-completion|host-capabilities)\.js$/.test(node.source.value)) violations.push('provider-import');
    if (node.type === 'VariableDeclarator' && /^(?:jobs|tasks|queue|queues|jobTable|taskTable)$/.test(key(node.id)) &&
      (node.init?.type === 'ArrayExpression' || node.init?.type === 'NewExpression' && ['Map', 'Set'].includes(key(node.init.callee)))) violations.push('second-job-table-or-queue');
    if (node.type === 'CallExpression' && /(?:^|\.)(?:jobs|tasks|queue|queues)\.(?:set|push|add)$/.test(member(node.callee))) violations.push('direct-job-write');
    if (node.type === 'AssignmentExpression' && /^(?:contract|job\.contract)\.(?:status|attemptId|finishedAt|calls|events)$/.test(member(node.left))) violations.push('direct-lifecycle-write');
  });
  return violations;
}
