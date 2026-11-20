import { OfficeFileError } from './zip.js';

export { OfficeFileError };

const MAX_DEPTH = 200;
const MAX_NODES = 5_000_000;
const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const bad = detail => new OfficeFileError('xml', `Office file is damaged or not a valid XML package (${detail})`);

/** Transitional + Strict ISO/IEC 29500 OOXML Namespace URI -> canonical prefix mapping. */
export const OOXML_NAMESPACES = Object.freeze({
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
  'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://schemas.openxmlformats.org/presentationml/2006/main': 'p',
  'http://purl.oclc.org/ooxml/presentationml/main': 'p',
  'http://schemas.openxmlformats.org/officeDocument/2006/math': 'm',
  'http://purl.oclc.org/ooxml/officeDocument/math': 'm',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
  'http://schemas.openxmlformats.org/package/2006/relationships': 'rels',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'http://schemas.microsoft.com/office/drawing/2010/main': 'a14',
  'http://purl.org/dc/elements/1.1/': 'dc',
  'http://www.w3.org/XML/1998/namespace': 'xml',
});

/** Transitional + Strict OOXML relationship type URI prefixes. */
export const RELATIONSHIP_PREFIXES = Object.freeze([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/',
]);

/** True when `typeUri` is a Transitional or Strict OOXML relationship of kind `suffix` (e.g. `'slide'`, `'notesSlide'`). */
export function isRelationshipType(typeUri, suffix) {
  if (typeof typeUri !== 'string' || !typeUri) return false;
  return RELATIONSHIP_PREFIXES.some(prefix => typeUri.startsWith(prefix)) && typeUri.endsWith(`/${suffix}`);
}

const ROOT_NS_SCOPE = Object.freeze({ xml: 'http://www.w3.org/XML/1998/namespace' });

function splitQName(name) {
  const colon = name.indexOf(':');
  return colon < 0 ? ['', name] : [name.slice(0, colon), name.slice(colon + 1)];
}

function canonicalPrefixOf(uri) {
  return uri && Object.hasOwn(OOXML_NAMESPACES, uri) ? OOXML_NAMESPACES[uri] : '';
}

function resolveScope(parentScope, attrs) {
  let next = null;
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'xmlns') {
      if (!next) next = { ...parentScope };
      next[''] = value;
    } else if (key.startsWith('xmlns:')) {
      const prefix = key.slice(6);
      if (prefix) {
        if (!next) next = { ...parentScope };
        next[prefix] = value;
      }
    }
  }
  return next || parentScope;
}

function buildElementNode(name, attrs, parentScope) {
  const scope = resolveScope(parentScope, attrs);
  const [prefix, local] = splitQName(name);
  const ns = Object.hasOwn(scope, prefix) ? scope[prefix] : '';
  const canonicalNs = canonicalPrefixOf(ns);
  const canonical = canonicalNs
    ? (canonicalNs === 'rels' ? local : `${canonicalNs}:${local}`)
    : name;
  return { name, local, ns, canonical, scope, attrs, children: [] };
}

/** Predefined and numeric character references only; anything else stays as written. */
function decode(value) {
  if (!value.includes('&')) return value;
  return value.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z]+));/g, (match, hex, dec, name) => {
    if (name) return Object.hasOwn(NAMED, name) ? NAMED[name] : match;
    const code = hex ? parseInt(hex, 16) : parseInt(dec, 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });
}

/**
 * A small non-validating, namespace-aware XML parser for OOXML parts. It refuses
 * DOCTYPE declarations (so there are no external or recursive entities to expand),
 * skips comments and processing instructions, keeps CDATA as text and caps
 * nesting depth and node count. Returns the root as { name, local, ns, canonical,
 * scope, attrs, children } where children are elements or strings; `canonical`
 * normalizes both Transitional and Strict OOXML Namespace URIs to canonical
 * prefixes ("w:p", "a:t", "p:sld", "m:oMath", "mc:AlternateContent").
 */
export function parseXml(source) {
  const text = String(source).replace(/^﻿/, '');
  const root = { name: '#document', local: '#document', ns: '', canonical: '#document', scope: ROOT_NS_SCOPE, attrs: {}, children: [] };
  const stack = [root];
  let index = 0, nodes = 0;
  const top = () => stack[stack.length - 1];
  while (index < text.length) {
    const lt = text.indexOf('<', index);
    if (lt < 0) { addText(text.slice(index)); break; }
    if (lt > index) addText(text.slice(index, lt));
    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4);
      if (close < 0) throw bad('unterminated comment');
      index = close + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const close = text.indexOf(']]>', lt + 9);
      if (close < 0) throw bad('unterminated CDATA');
      top().children.push(text.slice(lt + 9, close));
      index = close + 3;
    } else if (text.startsWith('<?', lt)) {
      const close = text.indexOf('?>', lt + 2);
      if (close < 0) throw bad('unterminated processing instruction');
      index = close + 2;
    } else if (text.startsWith('<!', lt)) {
      throw bad('DTDs and entity declarations are not allowed');
    } else if (text.startsWith('</', lt)) {
      const close = text.indexOf('>', lt + 2);
      if (close < 0) throw bad('unterminated end tag');
      const name = text.slice(lt + 2, close).trim();
      if (stack.length < 2 || top().name !== name) throw bad(`unexpected </${name}>`);
      stack.pop();
      index = close + 1;
    } else {
      const { node, end, selfClosing } = startTag(text, lt, top().scope);
      if (++nodes > MAX_NODES) throw bad('too many elements');
      top().children.push(node);
      if (!selfClosing) {
        if (stack.length > MAX_DEPTH) throw bad('elements are nested too deeply');
        stack.push(node);
      }
      index = end;
    }
  }
  if (stack.length !== 1) throw bad('unclosed element');
  const elements = root.children.filter(child => typeof child !== 'string');
  if (elements.length !== 1) throw bad('no root element');
  return elements[0];

  function addText(value) {
    if (stack.length === 1) { if (value.trim()) throw bad('text outside the root element'); return; }
    top().children.push(decode(value));
  }
}

const NAME = /[^\s/>]+/y;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

function startTag(text, start, parentScope) {
  let index = start + 1;
  NAME.lastIndex = index;
  const named = NAME.exec(text);
  if (!named) throw bad('bad tag name');
  const name = named[0];
  index += name.length;
  const attrs = {};
  for (;;) {
    while (index < text.length && /\s/.test(text[index])) index++;
    if (index >= text.length) throw bad('unterminated tag');
    if (text[index] === '>') return { node: buildElementNode(name, attrs, parentScope), end: index + 1, selfClosing: false };
    if (text[index] === '/') {
      if (text[index + 1] !== '>') throw bad('bad self-closing tag');
      return { node: buildElementNode(name, attrs, parentScope), end: index + 2, selfClosing: true };
    }
    ATTRIBUTE.lastIndex = index;
    const match = ATTRIBUTE.exec(text);
    if (!match) throw bad('bad attribute');
    attrs[match[1]] = decode(match[2] ?? match[3]);
    index = ATTRIBUTE.lastIndex;
  }
}

/** Normalized canonical tag name for an element node (e.g. `"w:p"`, `"m:oMath"`, `"Relationship"`). */
export const canonicalTag = node => (typeof node === 'string' || !node ? '' : node.canonical || node.name || '');

/** Namespace-aware element name matcher supporting both Transitional and Strict OOXML URIs. */
export function matchesName(node, name) {
  if (!node || typeof node === 'string') return false;
  if (name === undefined) return true;
  if (node.canonical === name) return true;
  return !node.ns && node.name === name;
}

/** Child elements matching canonical `name` (all child elements when omitted). */
export const elements = (node, name) => (node?.children || []).filter(child => typeof child !== 'string' && matchesName(child, name));
/** First child element matching canonical `name`. */
export const element = (node, name) => elements(node, name)[0];

/** Namespace-aware attribute lookup (resolves arbitrary prefixes bound to canonical OOXML URIs). */
export function attr(node, name) {
  const attrs = node?.attrs;
  if (!attrs) return undefined;
  const [wantPrefix, wantLocal] = splitQName(name);
  if (!wantPrefix) return Object.hasOwn(attrs, name) ? attrs[name] : undefined;
  const scope = node.scope || ROOT_NS_SCOPE;
  if (Object.hasOwn(attrs, name)) {
    const boundUri = Object.hasOwn(scope, wantPrefix) ? scope[wantPrefix] : '';
    const boundCanonical = canonicalPrefixOf(boundUri);
    if (!boundCanonical || boundCanonical === wantPrefix) return attrs[name];
  }
  for (const [key, value] of Object.entries(attrs)) {
    const [prefix, local] = splitQName(key);
    if (!prefix || local !== wantLocal) continue;
    const uri = Object.hasOwn(scope, prefix) ? scope[prefix] : '';
    if (canonicalPrefixOf(uri) === wantPrefix) return value;
  }
  // Strict/default-namespace producers occasionally omit the prefix on attributes belonging to the element's own namespace.
  if (wantPrefix !== 'r' && wantPrefix !== 'xml' && canonicalTag(node).startsWith(`${wantPrefix}:`) && Object.hasOwn(attrs, wantLocal)) {
    return attrs[wantLocal];
  }
  return undefined;
}

/** All text beneath a node. */
export const textContent = node => typeof node === 'string' ? node : (node?.children || []).map(textContent).join('');
