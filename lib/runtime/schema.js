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

const isSchema = value => !!value && typeof value === 'object' && !Array.isArray(value);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const lengthOf = text => [...text].length;

/** Throws when `value` breaks `schema`; `path` names the value in the message. A missing schema accepts anything. */
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
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path} must be at most ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && lengthOf(value) < schema.minLength) throw new Error(`${path} must have at least ${plural(schema.minLength, 'character')}`);
    if (schema.maxLength !== undefined && lengthOf(value) > schema.maxLength) throw new Error(`${path} must have at most ${plural(schema.maxLength, 'character')}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path} must have at least ${plural(schema.minItems, 'item')}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${path} must have at most ${plural(schema.maxItems, 'item')}`);
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
const isCount = value => Number.isInteger(value) && value >= 0;

/** The keywords of one schema that must hold a certain kind of value: [keyword, test, what it must be]. */
const SHAPES = [
  ['minimum', Number.isFinite, 'a number'], ['maximum', Number.isFinite, 'a number'],
  ['minItems', isCount, 'a non-negative integer'], ['maxItems', isCount, 'a non-negative integer'],
  ['minLength', isCount, 'a non-negative integer'], ['maxLength', isCount, 'a non-negative integer'],
  ['enum', Array.isArray, 'an array'], ['required', value => Array.isArray(value) && value.every(key => typeof key === 'string'), 'an array of names'],
  ['properties', isSchema, 'an object of schemas'], ['oneOf', value => Array.isArray(value) && value.length > 0, 'a non-empty array of schemas'],
];

/** Throws when a schema uses a keyword `validate` does not enforce, or a keyword with a value it cannot enforce. `label` names the operation and the side
    ("probe.run input"); the message names the schema's path inside it. Called when a context registers, so a bad schema never reaches a learner. */
export function checkSchema(schema, label, path = '') {
  if (schema === undefined) return;
  const where = path || 'the schema', fail = text => { throw new Error(`${label}: ${where} ${text}`); };
  if (!isSchema(schema)) fail('is not a schema object');
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYWORDS.includes(key) && !ANNOTATIONS.includes(key)) fail(`has the unsupported schema keyword "${key}" (supported: ${SCHEMA_KEYWORDS.join(', ')})`);
  if (schema.type !== undefined && !Object.hasOwn(TYPES, schema.type)) fail(`has an unknown type ${JSON.stringify(schema.type)}`);
  for (const [keyword, holds, what] of SHAPES) if (schema[keyword] !== undefined && !holds(schema[keyword])) fail(`has "${keyword}" that must be ${what}`);
  if (schema.items !== undefined && !isSchema(schema.items)) fail('has items that must be one schema');
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean' && !isSchema(schema.additionalProperties)) fail('has additionalProperties that must be true, false or a schema');
  for (const [name, next] of Object.entries(schema.properties || {})) checkSchema(next, label, joinPath(path, `properties.${name}`));
  if (schema.items !== undefined) checkSchema(schema.items, label, joinPath(path, 'items'));
  if (isSchema(schema.additionalProperties)) checkSchema(schema.additionalProperties, label, joinPath(path, 'additionalProperties'));
  (schema.oneOf || []).forEach((option, at) => checkSchema(option, label, `${path ? `${path}.` : ''}oneOf[${at}]`));
}
