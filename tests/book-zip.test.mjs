/* #489 item 7: 分文件导出 hands over one .zip, stored, with no library. Read back by hand here; a real unzip was run once by hand (see the PR). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, zipTextFiles } from '../ui/book/zip.js';

const decoder = new TextDecoder();

/** Lists a zip the way an unzip does: from the end record, through the central directory, to each local header. */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, 'the end record is last');
  const count = view.getUint16(end + 10, true), files = [];
  let at = view.getUint32(end + 16, true);
  for (let index = 0; index < count; index += 1) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    assert.equal(view.getUint16(at + 8, true) & 0x0800, 0x0800, 'names are UTF-8');
    assert.equal(view.getUint16(at + 10, true), 0, 'stored');
    const crc = view.getUint32(at + 16, true), size = view.getUint32(at + 24, true), length = view.getUint16(at + 28, true), local = view.getUint32(at + 42, true);
    assert.equal(view.getUint32(local, true), 0x04034b50);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + length)), start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true), data = bytes.subarray(start, start + size);
    assert.equal(crc32(data), crc, name);
    files.push({ name, text: decoder.decode(data) });
    at += 46 + length;
  }
  return files;
}

test('the CRC is the standard one', () => {
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
  assert.equal(crc32(new Uint8Array()), 0);
});

test('every file comes back as it went in, in order, Chinese names and text too', () => {
  const files = [{ name: 'book.yaml', text: 'files:\n  - 000-front.md\n' }, { name: '000-front.md', text: '# 复习全书\n\n查找页 p99。' }, { name: '第一章.md', text: '' }];
  assert.deepEqual(readZip(zipTextFiles(files)), files);
});

test('nothing in it is a surprise: no files is an empty zip, the same files make the same bytes, a big book stays quick', () => {
  assert.equal(zipTextFiles([]).length, 22);
  const files = Array.from({ length: 1200 }, (_, at) => ({ name: `${String(at).padStart(4, '0')}-h${at}.gen.md`, text: '第一段讲解。'.repeat(150) }));
  const started = performance.now(), bytes = zipTextFiles(files);
  assert.ok(performance.now() - started < 1500, `${Math.round(performance.now() - started)} ms`);
  assert.equal(readZip(bytes).length, 1200);
  assert.deepEqual(zipTextFiles(files.slice(0, 2)), zipTextFiles(files.slice(0, 2)));
});
