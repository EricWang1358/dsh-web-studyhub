import { OfficeFileError } from './zip.js';

export { OfficeFileError };

const MAX_DEPTH = 200;
const MAX_NODES = 5_000_000;
const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const bad = detail => new OfficeFileError('xml', `Office file is damaged or not a valid XML package (${detail})`);

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
 * A small non-validating XML parser for OOXML parts. It refuses DOCTYPE
 * declarations (so there are no external or recursive entities to expand),
 * skips comments and processing instructions, keeps CDATA as text and caps
 * nesting depth and node count. Returns the root as { name, attrs, children }
 * where children are elements or strings; names keep their prefix ("w:p").
 */
export function parseXml(source) {
  const text = String(source).replace(/^﻿/, '');
  const root = { name: '#document', attrs: {}, children: [] };
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
      const { node, end, selfClosing } = startTag(text, lt);
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

function startTag(text, start) {
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
    if (text[index] === '>') return { node: { name, attrs, children: [] }, end: index + 1, selfClosing: false };
    if (text[index] === '/') {
      if (text[index + 1] !== '>') throw bad('bad self-closing tag');
      return { node: { name, attrs, children: [] }, end: index + 2, selfClosing: true };
    }
    ATTRIBUTE.lastIndex = index;
    const match = ATTRIBUTE.exec(text);
    if (!match) throw bad('bad attribute');
    attrs[match[1]] = decode(match[2] ?? match[3]);
    index = ATTRIBUTE.lastIndex;
  }
}

/** Child elements named `name` (all child elements when omitted). */
export const elements = (node, name) => (node?.children || []).filter(child => typeof child !== 'string' && (name === undefined || child.name === name));
/** First child element named `name`. */
export const element = (node, name) => elements(node, name)[0];
export const attr = (node, name) => node?.attrs?.[name];
/** All text beneath a node. */
export const textContent = node => typeof node === 'string' ? node : (node?.children || []).map(textContent).join('');
