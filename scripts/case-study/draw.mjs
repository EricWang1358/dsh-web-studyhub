/* Figures of the StudyHub case study, drawn as inline SVG (no dependency, works offline). The primitives (box, group, arrow, sequence) are small on purpose:
   a figure is a list of boxes and arrows with coordinates, so it can be edited as text and reviewed in a diff. */
export const FILL = '#8fd6f6', FILL2 = '#d9f1fc', STROKE = '#2c82b4';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const DEFS = `<defs>
<marker id="open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9" fill="none" stroke="#333" stroke-width="1"/></marker>
<marker id="tri" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1,1 L11,6 L1,11 Z" fill="#fff" stroke="#333" stroke-width="1"/></marker>
<marker id="dia" viewBox="0 0 14 10" refX="1" refY="5" markerWidth="9" markerHeight="7" orient="auto-start-reverse"><path d="M1,5 L7,1 L13,5 L7,9 Z" fill="#fff" stroke="#333" stroke-width="1"/></marker>
</defs>`;
const wrap = (w, h, inner, size = 7.5) => `<svg viewBox="0 0 ${w} ${h}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Arial, Helvetica, sans-serif" font-size="${size}">${DEFS}${inner}</svg>`;


/* Sequence diagrams */
export function sequence(parts, steps, { width = 640, topPad = 14, gap = 17 } = {}) {
  const n = parts.length, left = 14, span = (width - 2 * left) / n;
  const X = {}; parts.forEach((p, i) => (X[p.id] = left + span * (i + 0.5)));
  const h = topPad + 24 + steps.length * gap + 14;
  let s = parts.map((p) => `<rect x="${X[p.id] - span / 2 + 6}" y="${topPad}" width="${span - 12}" height="18" fill="${FILL}" stroke="${STROKE}"/><text x="${X[p.id]}" y="${topPad + 11.5}" text-anchor="middle" font-size="7" font-weight="700">${esc(p.label)}</text><line x1="${X[p.id]}" y1="${topPad + 18}" x2="${X[p.id]}" y2="${h - 6}" stroke="#7a8b99" stroke-dasharray="3,3" stroke-width="0.7"/>`).join('');
  let y = topPad + 34;
  for (const st of steps) {
    if (st.alt) { s += `<rect x="${X[st.alt[0]] - 10}" y="${y - 10}" width="${X[st.alt[1]] - X[st.alt[0]] + 20}" height="${(st.rows || 1) * gap}" fill="#fff6e0" stroke="#d9a441" stroke-dasharray="3,2" opacity="0.7"/><text x="${X[st.alt[0]] - 7}" y="${y - 3}" font-size="5.8" font-weight="700" fill="#8a5a00">${esc(st.label)}</text>`; y += gap * 0.6; continue; }
    const x1 = X[st.from], x2 = X[st.to];
    if (st.from === st.to) {
      s += `<path d="M${x1},${y} h22 v8 h-22" fill="none" stroke="#222" stroke-width="0.9" marker-end="url(#open)"/><text x="${x1 + 25}" y="${y + 5}" font-size="6.5">${esc(st.text)}</text>`; y += gap + 4; continue;
    }
    const dir = x2 > x1 ? 1 : -1, wide = st.text.length * 3.5 > Math.abs(x2 - x1) - 6, tx = wide ? x1 + dir * 3 : (x1 + x2) / 2, anchor = wide ? (dir > 0 ? 'start' : 'end') : 'middle';
    s += `<line x1="${x1}" y1="${y}" x2="${x2 - dir * 1}" y2="${y}" stroke="${st.color || '#222'}" stroke-width="0.9"${st.dash ? ' stroke-dasharray="4,3"' : ''} marker-end="url(#open)"/><text x="${tx}" y="${y - 2.4}" text-anchor="${anchor}" font-size="6.5" fill="${st.color || '#111'}" paint-order="stroke" stroke="#fff" stroke-width="2">${esc(st.text)}</text>`;
    y += gap;
  }
  return wrap(width, h, s);
}



const box = (x, y, w, h, title, lines = [], o = {}) => ({
  node: { cx: x + w / 2, cy: y + h / 2, hw: w / 2, hh: h / 2 },
  svg: `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${o.fill || FILL2}" stroke="${o.stroke || '#2c82b4'}"${o.dash ? ' stroke-dasharray="3,2"' : ''}/>`
    + `<text x="${x + w / 2}" y="${y + 10}" text-anchor="middle" font-size="${o.size || 7.4}" font-weight="700" fill="#14304a">${esc(title)}</text>`
    + lines.map((l, i) => `<text x="${x + w / 2}" y="${y + 20 + i * 8.2}" text-anchor="middle" font-size="6.5" fill="#222">${esc(l)}</text>`).join('') + '</g>',
});
const group = (x, y, w, h, title, o = {}) => `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${o.fill || 'none'}" stroke="${o.stroke || '#6aa6d6'}" stroke-dasharray="${o.solid ? '0' : '4,3'}"/>${title ? `<text x="${x + 5}" y="${y + 9}" font-size="7.2" font-weight="700" fill="#2a5b80">${esc(title)}</text>` : ''}</g>`;
const edgeR = (n, px, py) => {
  const dx = px - n.cx, dy = py - n.cy;
  const t = Math.min(dx ? n.hw / Math.abs(dx) : 1e9, dy ? n.hh / Math.abs(dy) : 1e9);
  return [n.cx + dx * t, n.cy + dy * t];
};
const arrow = (a, b, o = {}) => {
  const [x1, y1] = edgeR(a, b.cx, b.cy), [x2, y2] = edgeR(b, a.cx, a.cy);
  const label = o.label ? `<text x="${(x1 + x2) / 2 + (o.dx || 0)}" y="${(y1 + y2) / 2 + (o.dy || -2)}" text-anchor="middle" font-size="6.3" font-style="italic" fill="#333" paint-order="stroke" stroke="#fff" stroke-width="2">${esc(o.label)}</text>` : '';
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${o.color || '#333'}" stroke-width="0.9"${o.dash ? ' stroke-dasharray="4,3"' : ''}${o.both ? ' marker-start="url(#open)"' : ''} marker-end="url(#open)"/>${label}`;
};
const draw = (B, links, extra = '') => extra + links.join('') + Object.values(B).map((b) => b.svg).join('');

/* System context: the learner, the host, and what StudyHub talks to. */
export function figureStudyContext() {
  const B = {};
  const add = (id, ...a) => (B[id] = box(...a));
  add('learner', 8, 120, 92, 50, 'Learner', ['reads, practises,', 'reviews drafts']);
  add('agent', 8, 30, 92, 50, 'DSH main chat', ['assistant calling', 'StudyHub tools']);
  add('dsh', 150, 70, 118, 140, 'DeepSeek Harness (DSH)', ['desktop (Electron) app', 'or local web server', 'plugin manager,', 'sessions, tools,', 'model keys and routes,', 'sidebar and previews'], { fill: FILL });
  add('study', 318, 70, 150, 140, 'StudyHub (plugin family)', ['workbench + 6 capability', 'plugins, one shared', 'studyRuntime service,', 'React panel, library', 'on the local disk'], { fill: '#bfe9fb' });
  add('model', 520, 10, 112, 38, 'Model providers', ['reached through DSH']);
  add('trans', 520, 56, 112, 38, 'Transcription providers', ['SiliconFlow, Groq, Gemini']);
  add('live', 520, 102, 112, 38, 'Gemini Live', ['real-time speech to text']);
  add('mineru', 520, 148, 112, 38, 'MinerU (local)', ['large PDF conversion']);
  add('mcp', 520, 194, 112, 38, 'Search extension', ['MCP retrieval server']);
  add('git', 318, 236, 150, 34, 'GitHub Releases', ['update check, plugin tarball']);
  add('disk', 150, 236, 118, 34, 'Local disk', ['library shards, originals']);
  const N = (k) => B[k].node;
  return wrap(640, 282, draw(B, [
    arrow(N('learner'), N('dsh'), { both: true }), arrow(N('agent'), N('dsh'), { both: true }), arrow(N('dsh'), N('study'), { both: true, label: 'plugin API' }),
    arrow(N('study'), N('model'), { dash: true }), arrow(N('study'), N('trans'), { dash: true }), arrow(N('study'), N('live'), { dash: true }), arrow(N('study'), N('mineru'), { dash: true }), arrow(N('study'), N('mcp'), { dash: true }),
    arrow(N('study'), N('git'), { dash: true }), arrow(N('study'), N('disk')),
  ]));
}

export function figureLayersReal(S) {
  const B = {};
  const add = (id, ...a) => (B[id] = box(...a));
  add('ui', 8, 8, 424, 34, 'Presentation: React panel (ui/)', ['workspace seat in DSH, lazy views, reader and preview contributions, zh / en strings'], { fill: FILL });
  add('control', 8, 56, 424, 34, 'Control: actions and tools (lib/runtime/, lib/host.js)', ['study_capabilities and five per-context tools, action routing, request services, validation'], { fill: FILL });
  add('domain', 8, 104, 424, 56, `Domain: ${S.contextCount} contexts with versioned APIs (lib/contexts/)`, ['materials, bank, study, authoring, generation, audio, jobs, library, courses, notes, ...', 'each owns its records, declares dependencies, reaches others only through granted operations'], { fill: FILL });
  add('data', 8, 174, 206, 44, 'Data access: shard store (lib/store.js)', ['content-addressed shards, atomic manifest']);
  add('integ', 226, 174, 206, 44, 'External integration', ['host adapter, model gateway, audio providers,', 'retrieval, MinerU, update check']);
  add('shared', 448, 8, 124, 210, 'Shared library', ['pure modules in lib/*.js:', 'quote matching,', 'assessment quality,', 'SM-2, batching,', 'application messages,', 'job contract, ...'], { fill: FILL });
  return wrap(580, 226, draw(B, []));
}

export function figureContainersReal(S) {
  const B = {};
  const add = (id, ...a) => (B[id] = box(...a));
  const frame = group(4, 4, 632, 306, 'DSH process (desktop app or local web server), one machine', { solid: true });
  add('panel', 14, 28, 150, 60, 'Panel (browser side)', ['React 18 host instance,', 'client.*.js chunks,', 'polls a snapshot']);
  add('host', 184, 28, 150, 60, 'Host adapter (lib/host.js)', ['library binding, request', 'services, host-only actions']);
  add('tools', 354, 28, 130, 60, 'Agent tools', ['study_capabilities,', 'study_materials, bank,', 'practice, generate, audio']);
  add('runtime', 184, 112, 300, 90, 'StudyRuntime (one per library)', ['registration, routing, validation, transactions', 'task service: queues, budgets, cancellation', `${S.contextCount} contexts with versioned APIs and operation grants`, 'cross-context transactions under one storage lock'], { fill: FILL });
  add('jobs', 504, 112, 120, 90, 'Job runtime', ['one job contract', 'attempts, steps, calls', 'gateway admission', 'pilots default off']);
  add('store', 14, 112, 150, 90, 'Store (shards)', ['study-workspace.json', 'manifest + shards/', 'attachments/materials/', 'backups/, job-archive.json'], { fill: '#d9f1fc' });
  add('gw', 184, 226, 150, 62, 'Model gateway', ['request services:', 'complete, completeLight,', 'language, signal, notify']);
  add('audio', 354, 226, 130, 62, 'Audio / PDF workers', ['transcription, live,', 'MinerU, retrieval index']);
  add('ext', 504, 226, 120, 62, 'External', ['providers, Gemini Live,', 'MinerU process, MCP,', 'GitHub'], { fill: '#eee' });
  const N = (k) => B[k].node;
  return wrap(640, 318, draw(B, [
    arrow(N('panel'), N('host'), { both: true, label: 'actions' }), arrow(N('tools'), N('host'), { both: true }), arrow(N('host'), N('runtime')), arrow(N('runtime'), N('store'), { both: true, label: 'scoped writes' }),
    arrow(N('runtime'), N('jobs'), { both: true }), arrow(N('runtime'), N('gw')), arrow(N('runtime'), N('audio')), arrow(N('gw'), N('ext'), { dash: true }), arrow(N('audio'), N('ext'), { dash: true }),
  ], frame));
}

/* Domain model of the library: the main entities and which context owns them. */
export function figureDomainReal() {
  const B = {};
  const add = (id, ...a) => (B[id] = box(...a));
  const pkgs = [
    group(6, 6, 190, 112, 'courses.v1', { solid: true, fill: '#eef8fd' }), group(206, 6, 200, 112, 'materials.v1', { solid: true, fill: '#eef8fd' }), group(416, 6, 218, 112, 'bank.v1', { solid: true, fill: '#eef8fd' }),
    group(6, 128, 190, 104, 'study.v1', { solid: true, fill: '#eef8fd' }), group(206, 128, 200, 104, 'generation.v1 + authoring.v1', { solid: true, fill: '#eef8fd' }), group(416, 128, 218, 104, 'jobs.v1 (the contract of every background job)', { solid: true, fill: '#eef8fd' }),
    group(6, 242, 190, 66, 'learner / coach / notes', { solid: true, fill: '#eef8fd' }), group(206, 242, 200, 66, 'workflows / skeleton', { solid: true, fill: '#eef8fd' }), group(416, 242, 218, 66, 'library.v1 (presentation joins)', { solid: true, fill: '#eef8fd' }),
  ].join('');
  add('course', 18, 28, 80, 22, 'Course', ['exam profile']);
  add('aliases', 108, 28, 76, 22, 'Alias', []);
  add('source', 218, 28, 74, 22, 'Source', ['page / slide']);
  add('document', 302, 28, 92, 22, 'Document', ['revision, original']);
  add('selection', 260, 70, 90, 22, 'Selection', ['quote + locator']);
  add('deck', 428, 28, 64, 22, 'Deck', []);
  add('card', 502, 28, 64, 22, 'Card', ['kind, citations']);
  add('draft', 576, 28, 52, 22, 'Draft', []);
  add('run', 18, 150, 66, 22, 'Run', []);
  add('attempt', 94, 150, 90, 22, 'Attempt', ['grade, SM-2']);
  add('exam', 18, 190, 100, 22, 'Exam / oral run', []);
  add('plan', 218, 150, 90, 22, 'Plan + targets', ['answerability']);
  add('review', 318, 150, 80, 22, 'Review receipt', []);
  add('pub', 218, 190, 120, 22, 'Publication (tx)', ['version-checked']);
  add('job', 428, 150, 90, 22, 'Job', ['kind, status']);
  add('att', 528, 150, 90, 22, 'Attempt / Step', ['executor, checkpoint']);
  add('call', 428, 190, 90, 22, 'Call', ['usage, tokens']);
  add('event', 528, 190, 90, 22, 'Event', []);
  add('note', 18, 264, 80, 22, 'Note', []);
  add('coach', 108, 264, 76, 22, 'Coach plan', []);
  add('flow', 218, 264, 96, 22, 'Learning flow', []);
  add('skel', 324, 264, 74, 22, 'Outline', []);
  add('stats', 428, 264, 90, 22, 'Snapshot', ['stats, map']);
  add('inbox', 528, 264, 90, 22, 'Inbox letter', []);
  const N = (k) => B[k].node;
  return wrap(640, 316, draw(B, [
    arrow(N('course'), N('source'), { dash: true, label: 'labels', dy: -4 }), arrow(N('source'), N('document')), arrow(N('source'), N('selection'), { dash: true }), arrow(N('deck'), N('card')), arrow(N('card'), N('source'), { dash: true, label: 'cites', dy: 12 }),
    arrow(N('run'), N('attempt')), arrow(N('run'), N('card'), { dash: true }), arrow(N('plan'), N('review')), arrow(N('review'), N('draft'), { dash: true }), arrow(N('pub'), N('deck'), { dash: true, label: 'appends' }),
    arrow(N('job'), N('att')), arrow(N('job'), N('call')), arrow(N('job'), N('event')), arrow(N('job'), N('plan'), { dash: true, label: 'runs', dy: -4 }),
  ], pkgs));
}

export function figureGenerateSequence(S) {
  return sequence([
    { id: 'ui', label: 'Panel' }, { id: 'rt', label: 'Runtime' }, { id: 'gen', label: 'Generation' }, { id: 'gw', label: 'Model gateway' },
    { id: 'bank', label: 'Bank (draft)' }, { id: 'auth', label: 'Authoring' }, { id: 'store', label: 'Store' },
  ], [
    { from: 'ui', to: 'rt', text: 'usage.estimate (tokens, no model)' },
    { from: 'ui', to: 'rt', text: 'generate { sources, kind, count, operationId }' },
    { from: 'rt', to: 'gen', text: `start job (queue, ${S.generation.jobMinutes} min budget)` },
    { from: 'rt', to: 'ui', text: 'job handle at once; panel keeps polling', dash: true },
    { from: 'gen', to: 'gen', text: `split by page ranges: parts of at most ${S.generation.partSize} questions` },
    { from: 'gen', to: 'gw', text: 'plan: targets with quotes and answerability' },
    { from: 'gen', to: 'gen', text: 'ground quotes in code (tolerant comparison)' },
    { from: 'gen', to: 'gw', text: 'author: write cards from the evidence' },
    { from: 'gen', to: 'gw', text: 'independent review: one call, re-ask at most twice' },
    { from: 'gen', to: 'bank', text: 'checkpoint: save accepted cards in the draft (version check)' },
    { from: 'ui', to: 'bank', text: 'learner reads the draft and its citations' },
    { from: 'ui', to: 'auth', text: 'draft.publish { draftVersion }' },
    { from: 'auth', to: 'store', text: 'one transaction: re-check, write deck, receipt' },
    { from: 'store', to: 'ui', text: 'deck published; stale version refused', dash: true },
  ], { gap: 15.8 });
}

export function figureJobRecovery() {
  return sequence([
    { id: 'ui', label: 'Panel / agent' }, { id: 'rt', label: 'Runtime' }, { id: 'job', label: 'Job (in memory)' }, { id: 'draft', label: 'Draft (on disk)' }, { id: 'prov', label: 'Provider' },
  ], [
    { from: 'ui', to: 'rt', text: 'generate (operationId A)' },
    { from: 'rt', to: 'job', text: 'queue slot opens, budget clock starts' },
    { from: 'job', to: 'prov', text: 'model calls (abortable)' },
    { from: 'job', to: 'draft', text: 'checkpoint after each reviewed part' },
    { from: 'ui', to: 'rt', text: 'job.cancel (idempotent)' },
    { from: 'rt', to: 'job', text: 'abort signal; status cancelling' },
    { from: 'job', to: 'prov', text: 'stream aborted, children cleaned up' },
    { from: 'job', to: 'rt', text: 'settled: cancelled (only now), no new stage starts', dash: true },
    { from: 'rt', to: 'ui', text: 'the draft keeps its approved questions', dash: true },
    { alt: ['ui', 'prov'], label: 'host restarts: the in-memory job is gone', rows: 3 },
    { from: 'ui', to: 'draft', text: 'draft shown as interrupted' },
    { from: 'ui', to: 'rt', text: 'generate { operationId A } or fill the uncovered parts' },
    { from: 'rt', to: 'draft', text: 'continue: saved candidates re-reviewed, not rewritten' },
  ], { gap: 16.5 });
}

export function figureLiveCapture(S) {
  return sequence([
    { id: 'learn', label: 'Learner' }, { id: 'page', label: 'Panel (browser)' }, { id: 'host', label: 'StudyHub host' }, { id: 'gem', label: 'Gemini Live' }, { id: 'tr', label: 'Translator' }, { id: 'lib', label: 'Library' },
  ], [
    { from: 'learn', to: 'page', text: 'choose a source; click Start recording' },
    { from: 'page', to: 'page', text: 'getUserMedia or getDisplayMedia (needs a user click)' },
    { from: 'page', to: 'host', text: 'start session; then PCM frames, 16 kHz, about 100 ms' },
    { from: 'host', to: 'gem', text: 'WebSocket; audio only after setup is confirmed' },
    { from: 'gem', to: 'host', text: 'final text per sentence', dash: true },
    { from: 'host', to: 'tr', text: `translate in order (${S.live.translateSentences} sentences / ${S.live.translateChars} chars, ${S.live.translateTries} attempts)` },
    { from: 'host', to: 'lib', text: 'segments saved as they arrive (recoverable)' },
    { from: 'host', to: 'page', text: 'poll: original above, Chinese below', dash: true },
    { from: 'host', to: 'gem', text: `next connection opened at ${Math.floor(S.live.rotateAtSeconds / 60)} min ${S.live.rotateAtSeconds % 60} s (${S.live.sessionMinutes} min cap)` },
  ], { gap: 17 });
}

/* Logical packaging cum deployment for "Generate and publish a deck", as built. */
export function figurePackagingGenerate(S) {
  const B = {};
  const add = (id, ...a) => (B[id] = box(...a));
  const frame = [
    group(4, 4, 150, 196, '<<location>> Browser side (the panel)', { solid: true, fill: '#d9f1fc' }),
    group(164, 4, 472, 196, '<<location>> DSH process, server side (one StudyRuntime per library)', { solid: true, fill: '#eef8fd' }),
    group(4, 210, 632, 52, '<<location>> Local disk and external services', { solid: true, fill: '#f4f4f4' }),
  ].join('');
  add('form', 14, 28, 130, 34, '<<boundary>> GenerateForm', ['sources, kind, count,', 'estimate shown first']);
  add('draftview', 14, 72, 130, 34, '<<boundary>> DraftView', ['citations, checks,', 'publish button']);
  add('jobcard', 14, 116, 130, 34, '<<boundary>> Job card / console', ['progress, stop, retry']);
  add('poll', 14, 160, 130, 32, '<<control>> Snapshot poll', ['fingerprint, back-off']);
  add('host', 174, 28, 110, 34, '<<control>> Host actions', ['validate, route,', 'request services']);
  add('gen', 294, 28, 150, 34, '<<control>> Generation context', ['plan, author, review,', 'checkpoint, failure kinds']);
  add('auth', 454, 28, 172, 34, '<<control>> Authoring context', ['publication transaction,', 'version-checked']);
  add('task', 174, 76, 110, 38, '<<control>> Task service', [`queue, ${S.generation.jobMinutes} min budget,`, 'cancel, progress']);
  add('mat', 294, 76, 150, 38, '<<entity>> Source / Document', ['evidence, quotes,', 'locators (materials)']);
  add('bank', 454, 76, 172, 38, '<<entity>> Draft / Deck / Card', ['bank context owns them;', 'idempotent append, receipts']);
  add('gw', 174, 124, 110, 38, '<<port>> Model gateway', ['complete, signal,', 'language, usage']);
  add('jobs', 294, 124, 150, 38, '<<entity>> Job contract', ['status, attempts, calls,', 'events (jobs context)']);
  add('storeapi', 454, 124, 172, 38, '<<subsystem>> Store port', ['scoped read / write sets,', 'participants under one lock']);
  add('disk', 14, 232, 150, 22, 'Shards + originals', [], { fill: '#fff' });
  add('prov', 244, 232, 170, 22, 'Model providers (via DSH)', [], { fill: '#fff' });
  add('docs', 494, 232, 132, 22, 'Backups, job archive', [], { fill: '#fff' });
  const N = (k) => B[k].node;
  return wrap(640, 268, draw(B, [
    arrow(N('form'), N('host'), { label: 'generate', dy: -3 }), arrow(N('draftview'), N('auth'), { dash: true }), arrow(N('poll'), N('host'), { dash: true }), arrow(N('host'), N('gen')), arrow(N('host'), N('task')), arrow(N('gen'), N('mat')), arrow(N('gen'), N('bank')),
    arrow(N('gen'), N('gw')), arrow(N('gen'), N('jobs')), arrow(N('auth'), N('bank')), arrow(N('bank'), N('storeapi')), arrow(N('storeapi'), N('disk'), { dash: true }), arrow(N('gw'), N('prov'), { dash: true }), arrow(N('storeapi'), N('docs'), { dash: true }),
  ], frame));
}
