// Legacy PowerPoint (.ppt) fixtures built in memory, like tests/helpers/office.mjs builds .pptx ones (no binary
// fixtures are committed): a Compound File Binary writer and a minimal [MS-PPT] record stream.

const SECTOR = 512, MINI = 64, CUTOFF = 4096;
const ENDOFCHAIN = 0xfffffffe, FREESECT = 0xffffffff, FATSECT = 0xfffffffd, NOSTREAM = 0xffffffff;
const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const pad = (buffer, size) => Buffer.concat([buffer, Buffer.alloc((size - (buffer.length % size)) % size)]);
const u32 = (...values) => { const out = Buffer.alloc(values.length * 4); values.forEach((value, index) => out.writeUInt32LE(value >>> 0, index * 4)); return out; };
// Directory order: shorter names first, then by upper-case name.
const compareNames = (a, b) => a.length - b.length || (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0);

/**
 * A version 3 compound file (512-byte sectors) holding `streams` ([{ name, data }]) in its root storage. Streams under
 * 4096 bytes go to the mini stream, as the format requires.
 */
export function compoundFile(streams) {
  const small = streams.filter(stream => stream.data.length < CUTOFF), big = streams.filter(stream => stream.data.length >= CUTOFF);
  const miniFat = [], miniParts = [];
  const miniStart = new Map();
  for (const stream of small) {
    const count = Math.ceil(stream.data.length / MINI);
    miniStart.set(stream, count ? miniFat.length : ENDOFCHAIN);
    for (let index = 0; index < count; index++) miniFat.push(index === count - 1 ? ENDOFCHAIN : miniFat.length + 1);
    if (count) miniParts.push(pad(stream.data, MINI));
  }
  const miniStream = Buffer.concat(miniParts);
  const ordered = [...streams].sort((a, b) => compareNames(a.name, b.name));
  const directoryBytes = (ordered.length + 1) * 128;

  // Sector plan: big streams, the mini stream, the mini FAT, the directory, then the FAT itself.
  const blocks = [];
  const place = (key, bytes) => { const count = Math.ceil(bytes / SECTOR); blocks.push({ key, count }); };
  for (const stream of big) place(stream, stream.data.length);
  if (miniStream.length) place('mini', miniStream.length);
  if (miniFat.length) place('minifat', miniFat.length * 4);
  place('directory', directoryBytes);
  const used = blocks.reduce((total, block) => total + block.count, 0);
  let fatCount = 1;
  while ((used + fatCount) > fatCount * (SECTOR / 4)) fatCount++;
  const fat = [], start = new Map();
  for (const block of blocks) {
    start.set(block.key, fat.length);
    for (let index = 0; index < block.count; index++) fat.push(index === block.count - 1 ? ENDOFCHAIN : fat.length + 1);
  }
  const fatStart = fat.length;
  for (let index = 0; index < fatCount; index++) fat.push(FATSECT);
  while (fat.length % (SECTOR / 4)) fat.push(FREESECT);

  const entry = ({ name, type, child = NOSTREAM, right = NOSTREAM, first = ENDOFCHAIN, size = 0 }) => {
    const out = Buffer.alloc(128);
    const encoded = Buffer.from(`${name}\0`, 'utf16le');
    encoded.copy(out, 0);
    out.writeUInt16LE(encoded.length, 0x40); out[0x42] = type; out[0x43] = 1;
    out.writeUInt32LE(NOSTREAM, 0x44); out.writeUInt32LE(right, 0x48); out.writeUInt32LE(child, 0x4c);
    out.writeUInt32LE(first, 0x74); out.writeUInt32LE(size, 0x78);
    return out;
  };
  const directory = [entry({ name: 'Root Entry', type: 5, child: ordered.length ? 1 : NOSTREAM,
    first: miniStream.length ? start.get('mini') : ENDOFCHAIN, size: miniStream.length })];
  ordered.forEach((stream, index) => directory.push(entry({ name: stream.name, type: 2, right: index + 1 < ordered.length ? index + 2 : NOSTREAM,
    first: stream.data.length >= CUTOFF ? start.get(stream) : miniStart.get(stream), size: stream.data.length })));

  const header = Buffer.alloc(SECTOR);
  SIGNATURE.copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18); header.writeUInt16LE(3, 0x1a); header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e); header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(fatCount, 0x2c); header.writeUInt32LE(start.get('directory'), 0x30); header.writeUInt32LE(CUTOFF, 0x38);
  header.writeUInt32LE(miniFat.length ? start.get('minifat') : ENDOFCHAIN, 0x3c); header.writeUInt32LE(miniFat.length ? Math.ceil(miniFat.length * 4 / SECTOR) : 0, 0x40);
  header.writeUInt32LE(ENDOFCHAIN, 0x44); header.writeUInt32LE(0, 0x48);
  for (let index = 0; index < 109; index++) header.writeUInt32LE(index < fatCount ? fatStart + index : FREESECT, 0x4c + index * 4);

  const body = [];
  for (const block of blocks) {
    const data = block.key === 'mini' ? miniStream : block.key === 'minifat' ? u32(...miniFat) : block.key === 'directory' ? Buffer.concat(directory) : block.key.data;
    body.push(pad(data, SECTOR));
  }
  body.push(u32(...fat));
  return Buffer.concat([header, ...body]);
}

// [MS-PPT] records: version and instance, type, length.
export const record = (type, data = Buffer.alloc(0), { instance = 0, version = 0 } = {}) => {
  const head = Buffer.alloc(8);
  head.writeUInt16LE((instance << 4) | version, 0); head.writeUInt16LE(type, 2); head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data]);
};
export const container = (type, children, { instance = 0 } = {}) => record(type, Buffer.concat(children), { instance, version: 0x0f });

const TEXT = { title: 0, body: 1, notes: 2, other: 4, centerBody: 5 };
const textHeader = type => record(0x0f9f, u32(type));
const textAtom = (text, bytes) => bytes ? record(0x0fa8, Buffer.from(text, 'latin1')) : record(0x0fa0, Buffer.from(text, 'utf16le'));
const textbox = children => container(0xf00d, children);
const spContainer = (children) => container(0xf004, children);
const drawing = shapes => container(0x040c, [container(0xf002, [container(0xf003, [spContainer([]), ...shapes])])]);
const placeholderData = id => container(0xf011, [record(0x0bc3, Buffer.concat([u32(0), Buffer.from([id, 0, 0, 0])]))]);
const slideAtom = notesId => { const data = Buffer.alloc(24); data.writeUInt32LE(notesId, 16); return record(0x03ef, data, { version: 2 }); };

/**
 * Build a .ppt. slides: [{ title?, body?: string[], subtitle?, boxes?: string[], grouped?: string, footer?, slideNumber?, notes?, inline? }]:
 * title and body are placeholders whose text lives in the slide list (referenced from the drawing) unless `inline`;
 * boxes are text boxes; grouped is a text box inside a group; footer is a footer placeholder; slideNumber adds the "*"
 * field. Options: order (indexes in presentation order), bytes (TextBytesAtom instead of TextCharsAtom), encrypted
 * (the encrypted Current User token), staleTitle (an older edit with this title for slide 1, superseded by the newest),
 * currentUser: false leaves the "Current User" stream out.
 */
export function pptFile(slides, { order, bytes = false, encrypted = false, staleTitle, currentUser = true } = {}) {
  const sequence = order || slides.map((_, index) => index);
  const persistOf = index => 2 + index, slideIdOf = index => 256 + index, notesPersistOf = index => 100 + index, notesIdOf = index => 512 + index;
  const placeholders = slide => [
    ...(slide.title !== undefined ? [{ type: TEXT.title, text: slide.title }] : []),
    ...(slide.subtitle !== undefined ? [{ type: TEXT.centerBody, text: slide.subtitle }] : []),
    ...(slide.body ? [{ type: TEXT.body, text: slide.body.join('\r') }] : []),
  ];
  const slideList = [], notesList = [];
  for (const index of sequence) {
    const slide = slides[index], listed = slide.inline ? [] : placeholders(slide);
    slideList.push(record(0x03f3, u32(persistOf(index), 0, listed.length, slideIdOf(index), 0)));
    for (const item of listed) slideList.push(textHeader(item.type), textAtom(item.text, bytes));
    if (slide.notes !== undefined) notesList.push(record(0x03f3, u32(notesPersistOf(index), 0, 0, notesIdOf(index), 0)));
  }
  const documentContainer = container(0x03e8, [record(0x03e9, Buffer.alloc(40), { version: 1 }),
    container(0x0ff0, slideList, { instance: 0 }), ...(notesList.length ? [container(0x0ff0, notesList, { instance: 2 })] : [])]);
  const slideContainer = (slide, index, titleOverride) => {
    const listed = placeholders({ ...slide, ...(titleOverride !== undefined ? { title: titleOverride } : {}) });
    const shapes = listed.map((item, position) => spContainer([textbox(slide.inline || titleOverride !== undefined
      ? [textHeader(item.type), textAtom(item.text, bytes)] : [record(0x0f9e, u32(position))])]));
    for (const text of slide.boxes || []) shapes.push(spContainer([textbox([textHeader(TEXT.other), textAtom(text, bytes)])]));
    if (slide.grouped) shapes.push(container(0xf003, [spContainer([]), spContainer([textbox([textHeader(TEXT.other), textAtom(slide.grouped, bytes)])])]));
    if (slide.footer) shapes.push(spContainer([placeholderData(0x09), textbox([textHeader(TEXT.other), textAtom(slide.footer, bytes)])]));
    if (slide.slideNumber) shapes.push(spContainer([textbox([textHeader(TEXT.other), textAtom('*', bytes)])]));
    return container(0x03ee, [slideAtom(slide.notes !== undefined ? notesIdOf(index) : 0), drawing(shapes)]);
  };
  const notesContainer = (slide, index) => container(0x03f0, [record(0x03f1, Buffer.concat([u32(slideIdOf(index)), Buffer.alloc(4)]), { version: 1 }),
    drawing([spContainer([placeholderData(0x08), textbox([textHeader(TEXT.other), textAtom('*', bytes)])]),
      spContainer([textbox([textHeader(TEXT.notes), textAtom(String(slide.notes).replace(/\n/g, '\r'), bytes)])])])]);

  const parts = [];
  let offset = 0;
  const put = buffer => { const at = offset; parts.push(buffer); offset += buffer.length; return at; };
  const persistDirectory = map => record(0x1772, Buffer.concat([...map].sort((a, b) => a[0] - b[0]).map(([id, at]) => u32(id | (1 << 20), at))));
  const userEdit = ({ previous, directoryAt }) => {
    const data = Buffer.alloc(encrypted ? 32 : 28);
    data.writeUInt32LE(slideIdOf(0), 0); data.writeUInt16LE(0, 4); data[6] = 0; data[7] = 3;
    data.writeUInt32LE(previous, 8); data.writeUInt32LE(directoryAt, 12); data.writeUInt32LE(1, 16); data.writeUInt32LE(1000, 20);
    if (encrypted) data.writeUInt32LE(999, 28);
    return record(0x0ff5, data);
  };

  const map = new Map();
  map.set(1, put(documentContainer));
  let previous = 0;
  if (staleTitle !== undefined) {
    const old = new Map([[1, map.get(1)], [persistOf(0), put(slideContainer(slides[0], 0, staleTitle))]]);
    previous = put(userEdit({ previous: 0, directoryAt: put(persistDirectory(old)) }));
  }
  slides.forEach((slide, index) => { map.set(persistOf(index), put(slideContainer(slide, index))); });
  slides.forEach((slide, index) => { if (slide.notes !== undefined) map.set(notesPersistOf(index), put(notesContainer(slide, index))); });
  const lastEdit = put(userEdit({ previous, directoryAt: put(persistDirectory(map)) }));
  const document = Buffer.concat(parts);

  const user = Buffer.concat([u32(0x14, encrypted ? 0xf3d1c4df : 0xe391c05f, lastEdit), Buffer.from([4, 0, 0xf4, 0x03, 3, 0, 0, 0]), Buffer.from('Test', 'latin1')]);
  return compoundFile([{ name: 'PowerPoint Document', data: document },
    ...(currentUser ? [{ name: 'Current User', data: record(0x0ff6, user) }] : [])]);
}
