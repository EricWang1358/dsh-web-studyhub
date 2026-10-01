import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readZip, OfficeFileError } from '../lib/office/zip.js';
import { zipFiles } from './helpers/office.mjs';

const code = expected => error => error instanceof OfficeFileError && error.code === expected;

test('reads stored and deflated entries, UTF-8 names and listing order', () => {
  const zip = readZip(zipFiles([
    { name: 'a.txt', data: 'plain', method: 'stored' },
    { name: 'dir/中文.xml', data: '你好'.repeat(500), method: 'deflate' },
    { name: 'empty.xml', data: '' },
  ]));
  assert.deepEqual(zip.names(), ['a.txt', 'dir/中文.xml', 'empty.xml']);
  assert.equal(zip.has('a.txt'), true);
  assert.equal(zip.has('missing'), false);
  assert.equal(zip.text('a.txt'), 'plain');
  assert.equal(zip.text('dir/中文.xml'), '你好'.repeat(500));
  assert.equal(zip.text('empty.xml'), '');
  assert.equal(zip.read('missing'), null);
});

test('finds the end record behind an archive comment', () => {
  const zip = readZip(zipFiles([{ name: 'x', data: 'ok' }], { comment: 'x'.repeat(5000) }));
  assert.equal(zip.text('x'), 'ok');
});

test('rejects files that are not ZIP archives with a specific reason', () => {
  assert.throws(() => readZip(Buffer.from('definitely not a zip')), code('not-zip'));
  assert.throws(() => readZip(Buffer.alloc(0)), code('not-zip'));
  // Password-protected or pre-2007 Office files are OLE containers, not ZIP.
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
  assert.throws(() => readZip(ole), code('ole'));
});

test('rejects ZIP64 archives', () => {
  assert.throws(() => readZip(zipFiles([{ name: 'x', data: 'ok' }], { zip64: true })), code('zip64'));
});

test('rejects encrypted entries', () => {
  assert.throws(() => readZip(zipFiles([{ name: 'secret.xml', data: 'abc', flags: 1 }])), code('encrypted'));
});

test('rejects unsupported compression methods when the entry is read', () => {
  const bytes = zipFiles([{ name: 'x', data: 'ok', method: 'stored' }]);
  // Method field of the central directory record.
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt16LE(12, central + 10);
  assert.throws(() => readZip(bytes).read('x'), code('unsupported-method'));
});

test('detects truncated and corrupted archives', () => {
  const bytes = zipFiles([{ name: 'x', data: 'hello world '.repeat(50) }]);
  assert.throws(() => readZip(bytes.subarray(0, bytes.length - 30)), code('corrupt'));
  const flipped = Buffer.from(bytes);
  flipped[40] ^= 0xff; // inside the deflate stream
  assert.throws(() => readZip(flipped).read('x'), code('corrupt'));
  const badCrc = readZip(zipFiles([{ name: 'x', data: 'abc', method: 'stored', crc: 12345 }]));
  assert.throws(() => badCrc.read('x'), code('corrupt'));
});

test('caps the number of entries', () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({ name: `f${index}.xml`, data: 'x' }));
  assert.throws(() => readZip(zipFiles(entries), { maxEntries: 20 }), code('too-many-entries'));
  assert.equal(readZip(zipFiles(entries), { maxEntries: 30 }).names().length, 30);
});

test('caps declared and inflated sizes (zip bombs)', () => {
  // Honest bomb: 1 MB of zeros deflates to ~1 KB.
  const bomb = zipFiles([{ name: 'bomb.xml', data: Buffer.alloc(1024 * 1024) }]);
  assert.ok(bomb.length < 4096);
  assert.throws(() => readZip(bomb, { maxEntryBytes: 64 * 1024 }).read('bomb.xml'), code('bomb'));
  assert.throws(() => readZip(bomb, { maxRatio: 100 }).read('bomb.xml'), code('bomb'));
  // Declared total over the cap is refused before anything is inflated.
  assert.throws(() => readZip(bomb, { maxTotalBytes: 512 * 1024 }), code('bomb'));
  // A header that understates the size cannot make the reader inflate more than the cap.
  const liar = zipFiles([{ name: 'lie.xml', data: Buffer.alloc(1024 * 1024), declaredSize: 10 }]);
  assert.throws(() => readZip(liar, { maxEntryBytes: 64 * 1024 }).read('lie.xml'), code('corrupt'));
  // Cumulative reads are capped too.
  const many = zipFiles([{ name: 'a.xml', data: 'a'.repeat(40_000) }, { name: 'b.xml', data: 'b'.repeat(40_000) }]);
  const zip = readZip(many, { maxReadBytes: 60_000 });
  zip.read('a.xml');
  assert.throws(() => zip.read('b.xml'), code('bomb'));
});

test('ordinary compressible XML stays within the default ratio cap', () => {
  const xml = '<w:p><w:r><w:t>text</w:t></w:r></w:p>'.repeat(20_000);
  const zip = readZip(zipFiles([{ name: 'word/document.xml', data: xml }]));
  assert.equal(zip.text('word/document.xml').length, xml.length);
});

test('rejects an entry whose compressed bytes run past the archive', () => {
  const bytes = zipFiles([{ name: 'x', data: Buffer.from(deflateRawSync(Buffer.from('abc'))), method: 'stored', declaredCompressed: 99999 }]);
  assert.throws(() => readZip(bytes).read('x'), code('corrupt'));
});
