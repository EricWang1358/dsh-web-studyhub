/* The schema dialect of the public operations (lib/runtime.js `register`, `invoke`), and the one validator of it (#842). A small subset of JSON Schema:
   every keyword it lists is ENFORCED, and `checkSchema` refuses a schema that uses any other keyword when a context registers, so a constraint a schema
   declares is never silently ignored.

   Enforced: type (object, array, string, number, integer, boolean, null), enum, const, oneOf (exactly one option matches), required, properties,
   additionalProperties (false, true, or a schema for the keys `properties` does not name), items (one schema), minimum, maximum (numbers), minItems, maxItems
   (arrays), minLength, maxLength (strings, counted in characters). A constraint applies to a value of its own kind only: a minimum says nothing of a string.
   Annotations (description, title, default, examples, $comment) are allowed and carry no rule. */

const TYPES = {
  object: v => v && typeof v === 'object' && !Array.isArray(v), array: Array.isArray,
  string: v => typeof v === 'string', number: v => typeof v === 'number' && Number.isFinite(v),
  integer: Number.isInteger, boolean: v => typeof v === 'boolean', null: v => v === null,
};
/** The keywords that carry a rule, all enforced by `validate`. */
export const SCHEMA_KEYWORDS = Object.freeze(['type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items', 'oneOf',
  'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength']);
/** The keywords that only describe. */
const ANNOTATIONS = Object.freeze(['description', 'title', 'default', 'examples', '$comment']);

const isCount = value => Number.isInteger(value) && value >= 0;
const isSchema = value => !!value && typeof value === 'object' && !Array.isArray(value);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const lengthOf = text => [...text].length;

/** Throws when `value` breaks `schema`; `path` names the value in the message. A missing schema accepts anything. A constraint whose value has the wrong shape
    (`maxLength: null`) is skipped: it is what registration warns about for an outside plugin (warnSchema), never a reason to refuse a value. */
export function validate(value, schema, path = 'arguments') {
  if (!schema) return;
  if (schema.oneOf) {
    const accepted = schema.oneOf.filter(option => { try { validate(value, option, path); return true; } catch { return false; } });
    if (accepted.length !== 1) throw new Error(`${path} does not match exactly one schema`);
  }
  if (schema.type && !TYPES[schema.type]?.(value)) throw new Error(`${path} must be ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} is not an allowed value`);
  if (Object.hasOwn(schema, 'const') && value !== schema.const) throw new Error(`${path} has an unexpected value`);
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) throw new Error(`${path} must be at least ${schema.minimum}`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) throw new Error(`${path} must be at most ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (isCount(schema.minLength) && lengthOf(value) < schema.minLength) throw new Error(`${path} must have at least ${plural(schema.minLength, 'character')}`);
    if (isCount(schema.maxLength) && lengthOf(value) > schema.maxLength) throw new Error(`${path} must have at most ${plural(schema.maxLength, 'character')}`);
  }
  if (Array.isArray(value)) {
    if (isCount(schema.minItems) && value.length < schema.minItems) throw new Error(`${path} must have at least ${plural(schema.minItems, 'item')}`);
    if (isCount(schema.maxItems) && value.length > schema.maxItems) throw new Error(`${path} must have at most ${plural(schema.maxItems, 'item')}`);
  }
  if (schema.type === 'object') {
    for (const key of schema.required || []) if (value[key] === undefined) throw new Error(`${path}.${key} is required`);
    for (const [key, next] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(next, schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key} is not supported`);
      else if (isSchema(schema.additionalProperties)) validate(next, schema.additionalProperties, `${path}.${key}`);
    }
  }
  if (schema.type === 'array' && schema.items) value.forEach((next, i) => validate(next, schema.items, `${path}[${i}]`));
}

const joinPath = (base, step) => (base ? `${base}.${step}` : step);

/** The keywords of one schema that must hold a certain kind of value: [keyword, test, what it must be]. */
const SHAPES = [
  ['minimum', Number.isFinite, 'a number'], ['maximum', Number.isFinite, 'a number'],
  ['minItems', isCount, 'a non-negative integer'], ['maxItems', isCount, 'a non-negative integer'],
  ['minLength', isCount, 'a non-negative integer'], ['maxLength', isCount, 'a non-negative integer'],
  ['enum', Array.isArray, 'an array'], ['required', value => Array.isArray(value) && value.every(key => typeof key === 'string'), 'an array of names'],
  ['properties', isSchema, 'an object of schemas'], ['oneOf', value => Array.isArray(value) && value.length > 0, 'a non-empty array of schemas'],
];

/** What is wrong with a schema for `validate`: a keyword it does not enforce, or a keyword with a value it cannot enforce. -> [message], empty when the schema is
    fine. `label` names the operation and the side ("probe.run input"); each message names the schema's path inside it. */
export function schemaProblems(schema, label, path = '', found = []) {
  if (schema === undefined) return found;
  const where = path || 'the schema', problem = text => found.push(`${label}: ${where} ${text}`);
  if (!isSchema(schema)) { problem('is not a schema object'); return found; }
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYWORDS.includes(key) && !ANNOTATIONS.includes(key)) problem(`has the unsupported schema keyword "${key}" (supported: ${SCHEMA_KEYWORDS.join(', ')})`);
  if (schema.type !== undefined && !Object.hasOwn(TYPES, schema.type)) problem(`has an unknown type ${JSON.stringify(schema.type)}`);
  for (const [keyword, holds, what] of SHAPES) if (schema[keyword] !== undefined && !holds(schema[keyword])) problem(`has "${keyword}" that must be ${what}`);
  if (schema.items !== undefined && !isSchema(schema.items)) problem('has items that must be one schema');
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean' && !isSchema(schema.additionalProperties)) problem('has additionalProperties that must be true, false or a schema');
  if (isSchema(schema.properties)) for (const [name, next] of Object.entries(schema.properties)) schemaProblems(next, label, joinPath(path, `properties.${name}`), found);
  if (isSchema(schema.items)) schemaProblems(schema.items, label, joinPath(path, 'items'), found);
  if (isSchema(schema.additionalProperties)) schemaProblems(schema.additionalProperties, label, joinPath(path, 'additionalProperties'), found);
  if (Array.isArray(schema.oneOf)) schema.oneOf.forEach((option, at) => schemaProblems(option, label, `${path ? `${path}.` : ''}oneOf[${at}]`, found));
  return found;
}

/** Strict: throws on the first problem of a schema. For the contexts the app installs and its tests, so a bad schema never reaches a learner. */
export function checkSchema(schema, label) {
  const [first] = schemaProblems(schema, label);
  if (first) throw new Error(first);
}

const warned = new Set();
/** Lenient: for a context an outside plugin registers through the public API, which was accepted before the check existed (and may carry the JSON Schema its tool
    library emits: pattern, format, anyOf, $schema ...). An unsupported keyword stays ignored as it was; each problem is said once on the console. */
export function warnSchema(schema, label) {
  for (const message of schemaProblems(schema, label)) {
    if (warned.has(message)) continue;
    warned.add(message);
    console.warn(`[studyhub] ${message}; it is ignored, not enforced`);
  }
}
