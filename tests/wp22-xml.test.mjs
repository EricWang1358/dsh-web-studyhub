import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, elements, element, attr, OfficeFileError } from '../lib/office/xml.js';

test('parses nested elements, attributes and namespaced names', () => {
  const root = parseXml('<?xml version="1.0"?><w:doc xmlns:w="urn:w"><w:p w:id="1"><w:t>Hello</w:t><w:t xml:space="preserve"> world </w:t></w:p></w:doc>');
  assert.equal(root.name, 'w:doc');
  const p = element(root, 'w:p');
  assert.equal(attr(p, 'w:id'), '1');
  const texts = elements(p, 'w:t');
  assert.equal(texts.length, 2);
  assert.equal(texts[0].children[0], 'Hello');
  assert.equal(attr(texts[1], 'xml:space'), 'preserve');
  assert.equal(texts[1].children[0], ' world ');
});

test('decodes the predefined and numeric entities, nothing else', () => {
  const root = parseXml('<a x="&lt;&quot;&#x4e2d;">&amp;&lt;&gt;&apos;&quot;&#20013;&#x6587;&unknown;</a>');
  assert.equal(attr(root, 'x'), '<"中');
  assert.equal(root.children[0], '&<>\'"中文&unknown;');
});

test('keeps CDATA, skips comments and processing instructions', () => {
  const root = parseXml('<a><!-- gone --><?pi data?><![CDATA[<raw> & text]]><b/></a>');
  assert.deepEqual(root.children.filter(child => typeof child === 'string'), ['<raw> & text']);
  assert.equal(element(root, 'b').name, 'b');
});

test('refuses DTDs and entity declarations (no external or recursive entities)', () => {
  const lol = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><a>&lol2;</a>';
  assert.throws(() => parseXml(lol), error => error instanceof OfficeFileError && error.code === 'xml');
  assert.throws(() => parseXml('<!DOCTYPE a SYSTEM "file:///etc/passwd"><a/>'), error => error instanceof OfficeFileError);
});

test('rejects malformed XML and runaway nesting', () => {
  assert.throws(() => parseXml('<a><b></a>'), error => error instanceof OfficeFileError && error.code === 'xml');
  assert.throws(() => parseXml('<a>'), error => error instanceof OfficeFileError);
  assert.throws(() => parseXml('plain text'), error => error instanceof OfficeFileError);
  assert.throws(() => parseXml('<a>'.repeat(500) + '</a>'.repeat(500)), error => error instanceof OfficeFileError && error.code === 'xml');
});

test('strips a byte order mark and tolerates self-closing and quoted-angle attributes', () => {
  const root = parseXml('﻿<a title="1 &gt; 0 > -1"><b c=\'d\'/></a>');
  assert.equal(attr(root, 'title'), '1 > 0 > -1');
  assert.equal(attr(element(root, 'b'), 'c'), 'd');
});
