/* Bytes of scanned-page images for generated PDFs (the page-peek decode test and the peek QA journey). No files, no network. */

/** CCITT Group 4 (the FAX encoding scanned books use), 64 x 64: 24 white rows then 40 black rows. */
export function ccittG4Bytes() {
  const bits = ['1'.repeat(24)];
  bits.push('001' + '00110101' + '0000001111' + '0000110111'); // first black row: horizontal mode, white run 0, black run 64 (make-up 64 + 0)
  bits.push('11'.repeat(39)); // every further black row repeats the one above (vertical mode, no shift)
  bits.push('000000000001000000000001'); // end of block
  const text = bits.join(''), bytes = Buffer.alloc(Math.ceil(text.length / 8));
  for (let i = 0; i < text.length; i += 1) if (text[i] === '1') bytes[i >> 3] |= 0x80 >> (i & 7);
  return bytes;
}

/** Bytes that claim to be an image (say /Filter /JPXDecode) and are not: no decoder can read them, so pdf.js drops the image and the popover must say so. */
export const brokenImageBytes = () => Buffer.from('this is not a JBIG2 stream '.repeat(8));
