/* Lightweight zero-dependency SVG diagram renderer for inline Markdown diagrams (#1288).
   Supports Mermaid-subset syntax (`flowchart` / `graph`, `sequenceDiagram`, `stateDiagram` / `stateDiagram-v2`)
   behind a lazy dynamic import so pages without diagrams load zero diagram code.
   Pure deterministic string/geometry builder: no DOM APIs, no React, no Node built-ins, no eval/HTML injection.
   Returns `null` on malformed or unsupported syntax so callers fall back seamlessly to a fenced code block. */

const DIAGRAM_LANGS = new Set(['mermaid', 'diagram']);
const MAX_NODES = 40;
const MAX_EDGES = 80;
const MAX_PARTICIPANTS = 12;
const MAX_STEPS = 36;
const FONT_FAMILY = 'var(--font-ui, system-ui, -apple-system, sans-serif)';

export function isDiagramFenceLang(lang) {
  return DIAGRAM_LANGS.has(String(lang || '').trim().toLowerCase());
}

function escXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hashTag(source) {
  let h = 2166136261;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const charUnits = (ch) => (/[\u1100-\uffff]/.test(ch) ? 2 : 1);
function textUnits(text) {
  let total = 0;
  for (const ch of String(text ?? '')) total += charUnits(ch);
  return total;
}

function wrapLines(raw, maxUnits = 24, maxLines = 3) {
  const cleaned = String(raw ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\n/g, '\n')
    .trim();
  if (!cleaned) return [''];
  const out = [];
  for (const para of cleaned.split('\n')) {
    const line = para.trim();
    if (!line) continue;
    let cur = '';
    let used = 0;
    for (const ch of line) {
      const u = charUnits(ch);
      if (used + u > maxUnits && cur) {
        out.push(cur.trimEnd());
        cur = ch.trimStart();
        used = cur ? u : 0;
      } else {
        cur += ch;
        used += u;
      }
    }
    if (cur.trim()) out.push(cur.trim());
  }
  if (!out.length) return [''];
  if (out.length <= maxLines) return out;
  const kept = out.slice(0, maxLines);
  const last = kept[maxLines - 1];
  kept[maxLines - 1] = last.length > 1 ? last.slice(0, -1) + '…' : '…';
  return kept;
}

function unquote(text) {
  const s = String(text ?? '').trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

/* ---------- Flowchart / Graph parser ---------- */

const FLOW_HEADER = /^(?:flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?\s*;?$/i;
const FLOW_IGNORE = /^(?:classDef|class|style|linkStyle|click|direction)\b/i;
const SUBGRAPH_START = /^subgraph\b(.*)$/i;
const NODE_ID = /^([\p{L}\p{N}_][\p{L}\p{N}_.-]*)/u;

const SHAPE_DELIMS = [
  ['([', '])', 'stadium'],
  ['((', '))', 'circle'],
  ['[[', ']]', 'rect'],
  ['[(', ')]', 'rect'],
  ['[', ']', 'rect'],
  ['(', ')', 'round'],
  ['{', '}', 'diamond'],
];

function parseNodeToken(segment) {
  const s = segment.trim();
  if (!s) return null;
  const idMatch = NODE_ID.exec(s);
  if (!idMatch) return null;
  const id = idMatch[1];
  const rest = s.slice(id.length).trim();
  if (!rest) return { id, label: null, shape: null };
  for (const [open, close, shape] of SHAPE_DELIMS) {
    if (rest.startsWith(open) && rest.endsWith(close) && rest.length >= open.length + close.length) {
      const inner = rest.slice(open.length, rest.length - close.length);
      const label = unquote(inner);
      if (!label) return null;
      return { id, label, shape };
    }
  }
  return null;
}

function splitAmpersand(segment) {
  const parts = [];
  let cur = '';
  let quote = '';
  let depth = 0;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      cur += ch;
      if (ch === quote && segment[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '[' || ch === '(' || ch === '{') {
      depth++;
      cur += ch;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (ch === '&' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const EDGE_TOKENS = [
  { re: /^-\.\s+([^.\n][^-\n]*?)\s+\.->/, style: 'dashed', arrow: true, labelGroup: 1 },
  { re: /^--\s+([^-\n>][^-\n]*?)\s+-->/, style: 'solid', arrow: true, labelGroup: 1 },
  { re: /^==\s+([^=\n>][^=\n]*?)\s+==>/, style: 'thick', arrow: true, labelGroup: 1 },
  { re: /^-\.->(?:\|([^|\n]+)\|)?/, style: 'dashed', arrow: true, labelGroup: 1 },
  { re: /^==+>(?:\|([^|\n]+)\|)?/, style: 'thick', arrow: true, labelGroup: 1 },
  { re: /^--+>(?:\|([^|\n]+)\|)?/, style: 'solid', arrow: true, labelGroup: 1 },
  { re: /^-\.-(?:\|([^|\n]+)\|)?/, style: 'dashed', arrow: false, labelGroup: 1 },
  { re: /^===+(?:\|([^|\n]+)\|)?/, style: 'thick', arrow: false, labelGroup: 1 },
  { re: /^---+(?:\|([^|\n]+)\|)?/, style: 'solid', arrow: false, labelGroup: 1 },
];

function splitFlowChain(line) {
  const items = [];
  let cur = '';
  let quote = '';
  let depth = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (quote) {
      cur += ch;
      if (ch === quote && line[i - 1] !== '\\') quote = '';
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (ch === '[' || ch === '(' || ch === '{') {
      depth++;
      cur += ch;
      i++;
      continue;
    }
    if (ch === ']' || ch === ')' || ch === '}') {
      depth = Math.max(0, depth - 1);
      cur += ch;
      i++;
      continue;
    }
    if (depth === 0 && (ch === '-' || ch === '=')) {
      const slice = line.slice(i);
      let matched = null;
      for (const spec of EDGE_TOKENS) {
        const m = spec.re.exec(slice);
        if (m) {
          matched = { raw: m[0], style: spec.style, arrow: spec.arrow, label: unquote(m[spec.labelGroup] || '') };
          break;
        }
      }
      if (matched) {
        items.push({ kind: 'nodes', raw: cur.trim() });
        items.push({ kind: 'edge', style: matched.style, arrow: matched.arrow, label: matched.label });
        cur = '';
        i += matched.raw.length;
        continue;
      }
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) items.push({ kind: 'nodes', raw: cur.trim() });
  return items;
}

function parseFlowchart(lines) {
  const header = FLOW_HEADER.exec(lines[0]);
  if (!header) return null;
  let direction = (header[1] || 'TD').toUpperCase();
  if (direction === 'TB') direction = 'TD';

  const nodes = new Map();
  const edges = [];
  const subgraphs = [];
  const stack = [];

  const ensureNode = (spec) => {
    const existing = nodes.get(spec.id);
    if (!existing) {
      nodes.set(spec.id, {
        id: spec.id,
        label: spec.label || spec.id,
        shape: spec.shape || 'rect',
      });
    } else {
      if (spec.label) existing.label = spec.label;
      if (spec.shape) existing.shape = spec.shape;
    }
    for (const sg of stack) sg.nodeIds.add(spec.id);
  };

  for (let idx = 1; idx < lines.length; idx++) {
    const rawLine = lines[idx].replace(/%%.*$/, '').trim().replace(/;$/, '').trim();
    if (!rawLine || FLOW_IGNORE.test(rawLine)) continue;
    if (/^end$/i.test(rawLine)) {
      if (!stack.length) return null;
      stack.pop();
      continue;
    }
    const sgMatch = SUBGRAPH_START.exec(rawLine);
    if (sgMatch) {
      let title = sgMatch[1].trim();
      const bracketed = /^[\p{L}\p{N}_.-]+\s*\[([^\]]+)\]$/u.exec(title);
      if (bracketed) title = unquote(bracketed[1]);
      else title = unquote(title) || `Group ${subgraphs.length + 1}`;
      const sg = { title, nodeIds: new Set() };
      subgraphs.push(sg);
      stack.push(sg);
      continue;
    }
    const tokens = splitFlowChain(rawLine);
    if (!tokens.length) return null;
    if (tokens.length === 1) {
      if (tokens[0].kind !== 'nodes') return null;
      const parts = splitAmpersand(tokens[0].raw);
      if (!parts.length) return null;
      for (const part of parts) {
        const parsed = parseNodeToken(part);
        if (!parsed) return null;
        ensureNode(parsed);
      }
      continue;
    }
    if (tokens.length % 2 === 0) return null;
    for (let t = 0; t < tokens.length; t += 2) {
      if (tokens[t].kind !== 'nodes') return null;
      const parts = splitAmpersand(tokens[t].raw);
      if (!parts.length) return null;
      const parsedList = parts.map(parseNodeToken);
      if (parsedList.some((p) => !p)) return null;
      for (const parsed of parsedList) ensureNode(parsed);
      tokens[t].parsed = parsedList;
    }
    for (let t = 1; t < tokens.length; t += 2) {
      if (tokens[t].kind !== 'edge') return null;
      const fromList = tokens[t - 1].parsed;
      const toList = tokens[t + 1].parsed;
      for (const from of fromList) {
        for (const to of toList) {
          edges.push({
            from: from.id,
            to: to.id,
            label: tokens[t].label || '',
            style: tokens[t].style,
            arrow: tokens[t].arrow,
          });
        }
      }
    }
  }

  if (stack.length > 0) return null;
  if (!nodes.size || nodes.size > MAX_NODES || edges.length > MAX_EDGES) return null;
  // Require at least one edge or explicit shaped node so plain English prose does not accidentally parse as a 1-word flowchart
  if (!edges.length && [...nodes.values()].every((n) => n.label === n.id && n.shape === 'rect')) return null;

  return {
    kind: 'flowchart',
    direction,
    nodes: [...nodes.values()],
    edges,
    subgraphs: subgraphs.filter((sg) => sg.nodeIds.size > 0),
  };
}

/* ---------- State Diagram parser ---------- */

const STATE_HEADER = /^stateDiagram(?:-v2)?\s*;?$/i;
const STATE_ALIAS = /^state\s+"([^"]+)"\s+as\s+([\p{L}\p{N}_][\p{L}\p{N}_.-]*)$/iu;
const STATE_EDGE = /^(\[\*\]|[\p{L}\p{N}_][\p{L}\p{N}_.-]*)\s*-->\s*(\[\*\]|[\p{L}\p{N}_][\p{L}\p{N}_.-]*)(?:\s*:\s*(.+))?$/u;
const STATE_DESC = /^([\p{L}\p{N}_][\p{L}\p{N}_.-]*)\s*:\s*(.+)$/u;
const STATE_DIR = /^direction\s+(TD|TB|BT|LR|RL)$/i;

function parseStateDiagram(lines) {
  if (!STATE_HEADER.test(lines[0])) return null;
  let direction = 'TD';
  const nodes = new Map();
  const edges = [];

  const ensureState = (rawId, isEnd) => {
    if (rawId === '[*]') {
      const id = isEnd ? '__end__' : '__start__';
      if (!nodes.has(id)) nodes.set(id, { id, label: '', shape: isEnd ? 'end' : 'start' });
      return id;
    }
    if (!nodes.has(rawId)) nodes.set(rawId, { id: rawId, label: rawId, shape: 'round' });
    return rawId;
  };

  for (let idx = 1; idx < lines.length; idx++) {
    const rawLine = lines[idx].replace(/%%.*$/, '').trim().replace(/;$/, '').trim();
    if (!rawLine || /^note\b/i.test(rawLine)) continue;
    const dir = STATE_DIR.exec(rawLine);
    if (dir) {
      direction = dir[1].toUpperCase() === 'TB' ? 'TD' : dir[1].toUpperCase();
      continue;
    }
    const alias = STATE_ALIAS.exec(rawLine);
    if (alias) {
      nodes.set(alias[2], { id: alias[2], label: alias[1].trim(), shape: 'round' });
      continue;
    }
    const edge = STATE_EDGE.exec(rawLine);
    if (edge) {
      const from = ensureState(edge[1], false);
      const to = ensureState(edge[2], true);
      edges.push({ from, to, label: (edge[3] || '').trim(), style: 'solid', arrow: true });
      continue;
    }
    const desc = STATE_DESC.exec(rawLine);
    if (desc) {
      const id = ensureState(desc[1], false);
      const node = nodes.get(id);
      if (node.label === id) node.label = `${id}\n${desc[2].trim()}`;
      continue;
    }
    return null;
  }

  if (!nodes.size || !edges.length || nodes.size > MAX_NODES || edges.length > MAX_EDGES) return null;
  return {
    kind: 'state',
    direction,
    nodes: [...nodes.values()],
    edges,
    subgraphs: [],
  };
}

/* ---------- Sequence Diagram parser ---------- */

const SEQ_HEADER = /^sequenceDiagram\s*;?$/i;
const SEQ_PARTICIPANT = /^(?:participant|actor)\s+([\p{L}\p{N}_][\p{L}\p{N}_.-]*)(?:\s+as\s+(.+))?$/iu;
const SEQ_MSG = /^([\p{L}\p{N}_][\p{L}\p{N}_.-]*)\s*(-->>|->>|-->|->|--x|-x|--\)|-\))([+-])?\s*([\p{L}\p{N}_][\p{L}\p{N}_.-]*)\s*:\s*(.*)$/u;
const SEQ_NOTE = /^note\s+(left of|right of|over)\s+([\p{L}\p{N}_.-]+(?:\s*,\s*[\p{L}\p{N}_.-]+)?)\s*:\s*(.+)$/iu;
const SEQ_IGNORE = /^(?:autonumber|activate\b|deactivate\b|loop\b|alt\b|else\b|opt\b|par\b|and\b|end$|rect\b)/i;

function parseSequenceDiagram(lines) {
  if (!SEQ_HEADER.test(lines[0])) return null;
  const participants = new Map();
  const steps = [];

  const ensureParticipant = (id, label) => {
    if (!participants.has(id)) {
      participants.set(id, { id, label: unquote(label || id) });
    } else if (label) {
      participants.get(id).label = unquote(label);
    }
  };

  for (let idx = 1; idx < lines.length; idx++) {
    const rawLine = lines[idx].replace(/%%.*$/, '').trim();
    if (!rawLine || SEQ_IGNORE.test(rawLine)) continue;
    const part = SEQ_PARTICIPANT.exec(rawLine);
    if (part) {
      ensureParticipant(part[1], part[2]);
      continue;
    }
    const note = SEQ_NOTE.exec(rawLine);
    if (note) {
      const targets = note[2].split(',').map((t) => t.trim()).filter(Boolean);
      for (const t of targets) ensureParticipant(t);
      steps.push({ kind: 'note', placement: note[1].toLowerCase(), targets, text: note[3].trim() });
      continue;
    }
    const msg = SEQ_MSG.exec(rawLine);
    if (msg) {
      ensureParticipant(msg[1]);
      ensureParticipant(msg[4]);
      const arrow = msg[2];
      steps.push({
        kind: 'msg',
        from: msg[1],
        to: msg[4],
        dashed: arrow.startsWith('--'),
        label: msg[5].trim(),
      });
      continue;
    }
    return null;
  }

  if (!participants.size || participants.size > MAX_PARTICIPANTS || !steps.length || steps.length > MAX_STEPS) {
    return null;
  }
  return {
    kind: 'sequence',
    participants: [...participants.values()],
    steps,
  };
}

export function parseStudyDiagram(source) {
  if (typeof source !== 'string') return null;
  const lines = source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('%%'));
  if (!lines.length) return null;
  if (FLOW_HEADER.test(lines[0])) return parseFlowchart(lines);
  if (SEQ_HEADER.test(lines[0])) return parseSequenceDiagram(lines);
  if (STATE_HEADER.test(lines[0])) return parseStateDiagram(lines);
  return null;
}

/* ---------- Layered Graph SVG Renderer (Flowchart & State) ---------- */

function measureNode(node) {
  if (node.shape === 'start' || node.shape === 'end') {
    return { lines: [], w: 22, h: 22 };
  }
  const maxUnits = node.shape === 'diamond' ? 16 : 22;
  const lines = wrapLines(node.label, maxUnits, 3);
  const longest = Math.max(4, ...lines.map(textUnits));
  const textW = longest * 7.2;
  const textH = lines.length * 18;
  if (node.shape === 'diamond') {
    const w = Math.max(88, Math.ceil(textW * 1.38 + 30));
    const h = Math.max(54, Math.ceil(textH * 1.48 + 26));
    return { lines, w, h };
  }
  if (node.shape === 'circle') {
    const d = Math.max(54, Math.ceil(Math.max(textW, textH) + 26));
    return { lines, w: d, h: d };
  }
  const w = Math.max(76, Math.ceil(textW + 28));
  const h = Math.max(38, Math.ceil(textH + 18));
  return { lines, w, h };
}

function assignLayers(nodes, edges) {
  const ids = nodes.map((n) => n.id);
  const adj = new Map(ids.map((id) => [id, []]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const e of edges) {
    if (e.from === e.to) continue;
    adj.get(e.from)?.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  }
  // Cycle-breaking DFS order to find a DAG subset for layering
  const state = new Map();
  const backEdges = new Set();
  const dfs = (u) => {
    state.set(u, 1);
    for (const v of adj.get(u) || []) {
      if (state.get(v) === 1) backEdges.add(`${u}\0${v}`);
      else if (!state.get(v)) dfs(v);
    }
    state.set(u, 2);
  };
  const roots = ids.filter((id) => (indeg.get(id) || 0) === 0);
  for (const id of [...roots, ...ids]) {
    if (!state.get(id)) dfs(id);
  }

  const dagOut = new Map(ids.map((id) => [id, []]));
  const dagIn = new Map(ids.map((id) => [id, 0]));
  for (const e of edges) {
    if (e.from === e.to || backEdges.has(`${e.from}\0${e.to}`)) continue;
    dagOut.get(e.from).push(e.to);
    dagIn.set(e.to, dagIn.get(e.to) + 1);
  }

  const layer = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => dagIn.get(id) === 0);
  const indegCopy = new Map(dagIn);
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i];
    const nextLayer = layer.get(u) + 1;
    for (const v of dagOut.get(u)) {
      if (nextLayer > layer.get(v)) layer.set(v, nextLayer);
      indegCopy.set(v, indegCopy.get(v) - 1);
      if (indegCopy.get(v) === 0) queue.push(v);
    }
  }
  return { layer, backEdges };
}

function clipBorder(box, tx, ty) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  if (box.shape === 'circle' || box.shape === 'start' || box.shape === 'end') {
    const r = box.w / 2;
    const len = Math.hypot(dx, dy);
    return { x: cx + (dx / len) * r, y: cy + (dy / len) * r };
  }
  if (box.shape === 'diamond') {
    const rx = box.w / 2;
    const ry = box.h / 2;
    const s = 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry);
    return { x: cx + dx * s, y: cy + dy * s };
  }
  const sx = dx ? (box.w / 2) / Math.abs(dx) : Infinity;
  const sy = dy ? (box.h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

function renderGraphSvg(diagram, markerId) {
  const horizontal = diagram.direction === 'LR' || diagram.direction === 'RL';
  const reversed = diagram.direction === 'BT' || diagram.direction === 'RL';
  const { layer, backEdges } = assignLayers(diagram.nodes, diagram.edges);
  const measured = new Map(diagram.nodes.map((n) => [n.id, { ...n, ...measureNode(n) }]));

  const maxLayer = Math.max(0, ...layer.values());
  const groups = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of diagram.nodes) {
    const idx = reversed ? maxLayer - layer.get(n.id) : layer.get(n.id);
    groups[idx].push(measured.get(n.id));
  }

  const gapPrimary = horizontal ? 62 : 52;
  const gapCross = horizontal ? 30 : 34;
  const margin = 24;
  const hasBackEdge = diagram.edges.some((e) => e.from === e.to || backEdges.has(`${e.from}\0${e.to}`));
  const extraSide = hasBackEdge ? 42 : 0;

  // Measure group spans on primary & cross axes
  const primarySpans = groups.map((g) => Math.max(...g.map((n) => (horizontal ? n.w : n.h))));
  const crossSpans = groups.map((g) =>
    g.reduce((sum, n) => sum + (horizontal ? n.h : n.w), 0) + Math.max(0, g.length - 1) * gapCross,
  );
  const maxCross = Math.max(...crossSpans, 120);

  const boxes = new Map();
  let primaryCursor = margin;
  groups.forEach((g, gi) => {
    const span = primarySpans[gi];
    let crossCursor = margin + (maxCross - crossSpans[gi]) / 2;
    for (const node of g) {
      if (horizontal) {
        const x = primaryCursor + (span - node.w) / 2;
        const y = crossCursor;
        boxes.set(node.id, { ...node, x, y });
        crossCursor += node.h + gapCross;
      } else {
        const x = crossCursor;
        const y = primaryCursor + (span - node.h) / 2;
        boxes.set(node.id, { ...node, x, y });
        crossCursor += node.w + gapCross;
      }
    }
    primaryCursor += span + gapPrimary;
  });

  const totalPrimary = primaryCursor - gapPrimary + margin;
  const totalCross = maxCross + margin * 2;
  const width = Math.ceil((horizontal ? totalPrimary : totalCross + extraSide));
  const height = Math.ceil((horizontal ? totalCross + extraSide : totalPrimary));

  // Subgraph frames
  const sgParts = [];
  for (const sg of diagram.subgraphs) {
    const members = [...sg.nodeIds].map((id) => boxes.get(id)).filter(Boolean);
    if (!members.length) continue;
    const minX = Math.min(...members.map((m) => m.x)) - 12;
    const minY = Math.min(...members.map((m) => m.y)) - 26;
    const maxX = Math.max(...members.map((m) => m.x + m.w)) + 12;
    const maxY = Math.max(...members.map((m) => m.y + m.h)) + 12;
    sgParts.push(
      `<g class="md-diagram-subgraph">` +
        `<rect x="${Math.max(4, minX).toFixed(1)}" y="${Math.max(4, minY).toFixed(1)}" width="${(maxX - Math.max(4, minX)).toFixed(1)}" height="${(maxY - Math.max(4, minY)).toFixed(1)}" rx="8" fill="var(--bg-sunken, #f4f5f7)" fill-opacity="0.55" stroke="var(--line-strong, #8892a0)" stroke-width="1" stroke-dasharray="5 4"/>` +
        `<text x="${(Math.max(4, minX) + 10).toFixed(1)}" y="${(Math.max(4, minY) + 16).toFixed(1)}" font-size="12" font-family="${FONT_FAMILY}" fill="var(--text-muted, #5c6470)">${escXml(sg.title)}</text>` +
      `</g>`,
    );
  }

  // Edges
  const edgeParts = [];
  const labelParts = [];
  let backIndex = 0;
  for (const e of diagram.edges) {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) continue;
    const strokeWidth = e.style === 'thick' ? '2.4' : '1.5';
    const strokeColor = e.style === 'thick' ? 'var(--accent-soft, #3b82f6)' : 'var(--line-strong, #6b7280)';
    const dash = e.style === 'dashed' ? ' stroke-dasharray="5 4"' : '';
    const markerAttr = e.arrow ? ` marker-end="url(#${markerId})"` : '';

    let d = '';
    let lx = 0;
    let ly = 0;
    if (e.from === e.to) {
      const sx = a.x + a.w;
      const sy = a.y + a.h * 0.35;
      const ex = a.x + a.w;
      const ey = a.y + a.h * 0.68;
      const bulge = sx + 32;
      d = `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${bulge.toFixed(1)} ${(sy - 14).toFixed(1)}, ${bulge.toFixed(1)} ${(ey + 14).toFixed(1)}, ${ex.toFixed(1)} ${ey.toFixed(1)}`;
      lx = bulge + 6;
      ly = (sy + ey) / 2;
    } else if (backEdges.has(`${e.from}\0${e.to}`)) {
      backIndex += 1;
      const offset = 22 + backIndex * 14;
      if (horizontal) {
        const yLane = totalCross - margin + offset * 0.7;
        const sx = a.x + a.w / 2;
        const sy = a.y + a.h;
        const ex = b.x + b.w / 2;
        const ey = b.y + b.h;
        d = `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${((sx + ex) / 2).toFixed(1)} ${yLane.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
        lx = (sx + ex) / 2;
        ly = (sy + ey) / 4 + yLane / 2;
      } else {
        const xLane = totalCross - margin + offset * 0.7;
        const sx = a.x + a.w;
        const sy = a.y + a.h / 2;
        const ex = b.x + b.w;
        const ey = b.y + b.h / 2;
        d = `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${xLane.toFixed(1)} ${((sy + ey) / 2).toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
        lx = (sx + ex) / 4 + xLane / 2;
        ly = (sy + ey) / 2;
      }
    } else {
      const acx = a.x + a.w / 2;
      const acy = a.y + a.h / 2;
      const bcx = b.x + b.w / 2;
      const bcy = b.y + b.h / 2;
      const start = clipBorder(a, bcx, bcy);
      const end = clipBorder(b, acx, acy);
      d = `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} L ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
      lx = (start.x + end.x) / 2;
      ly = (start.y + end.y) / 2;
    }

    edgeParts.push(`<path d="${d}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}"${dash}${markerAttr}/>`);

    if (e.label) {
      const text = e.label.length > 26 ? e.label.slice(0, 25) + '…' : e.label;
      const pw = Math.ceil(textUnits(text) * 6.5 + 12);
      const ph = 20;
      labelParts.push(
        `<g class="md-diagram-edge-label">` +
          `<rect x="${(lx - pw / 2).toFixed(1)}" y="${(ly - ph / 2).toFixed(1)}" width="${pw}" height="${ph}" rx="4" fill="var(--bg-surface, #ffffff)" stroke="var(--line, #d1d5db)" stroke-width="0.8"/>` +
          `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" font-size="11.5" font-family="${FONT_FAMILY}" fill="var(--text-muted, #4b5563)">${escXml(text)}</text>` +
        `</g>`,
      );
    }
  }

  // Nodes
  const nodeParts = [];
  for (const box of boxes.values()) {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    let shapeEl = '';
    if (box.shape === 'start') {
      shapeEl = `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="9" fill="var(--text, #1c1f24)"/>`;
    } else if (box.shape === 'end') {
      shapeEl =
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="10" fill="none" stroke="var(--text, #1c1f24)" stroke-width="1.8"/>` +
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6" fill="var(--text, #1c1f24)"/>`;
    } else if (box.shape === 'diamond') {
      const pts = `${cx.toFixed(1)},${box.y.toFixed(1)} ${(box.x + box.w).toFixed(1)},${cy.toFixed(1)} ${cx.toFixed(1)},${(box.y + box.h).toFixed(1)} ${box.x.toFixed(1)},${cy.toFixed(1)}`;
      shapeEl = `<polygon points="${pts}" fill="var(--bg-surface, #ffffff)" stroke="var(--accent-soft, #3b82f6)" stroke-width="1.5"/>`;
    } else if (box.shape === 'circle') {
      shapeEl = `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(box.w / 2).toFixed(1)}" fill="var(--bg-surface, #ffffff)" stroke="var(--line-strong, #6b7280)" stroke-width="1.5"/>`;
    } else {
      const rx = box.shape === 'stadium' ? Math.round(box.h / 2) : box.shape === 'round' ? 10 : 5;
      shapeEl = `<rect x="${box.x.toFixed(1)}" y="${box.y.toFixed(1)}" width="${box.w.toFixed(1)}" height="${box.h.toFixed(1)}" rx="${rx}" fill="var(--bg-surface, #ffffff)" stroke="var(--line-strong, #6b7280)" stroke-width="1.5"/>`;
    }

    let textEl = '';
    if (box.lines.length) {
      const startY = cy - ((box.lines.length - 1) * 18) / 2 + 4.5;
      textEl = box.lines
        .map((line, i) => `<text x="${cx.toFixed(1)}" y="${(startY + i * 18).toFixed(1)}" text-anchor="middle" font-size="13" font-family="${FONT_FAMILY}" fill="var(--text, #1c1f24)">${escXml(line)}</text>`)
        .join('');
    }
    nodeParts.push(`<g class="md-diagram-node">${shapeEl}${textEl}</g>`);
  }

  const label = diagram.kind === 'state' ? 'State diagram' : 'Flowchart diagram';
  const svg =
    `<svg class="md-diagram-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}">` +
      `<defs>` +
        `<marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
          `<path d="M 1 1.5 L 9 5 L 1 8.5 z" fill="var(--line-strong, #6b7280)"/>` +
        `</marker>` +
      `</defs>` +
      sgParts.join('') +
      edgeParts.join('') +
      nodeParts.join('') +
      labelParts.join('') +
    `</svg>`;

  return { svg, kind: diagram.kind, width, height };
}

/* ---------- Sequence Diagram SVG Renderer ---------- */

function renderSequenceSvg(diagram, markerId) {
  const { participants, steps } = diagram;
  const colW = 168;
  const boxW = 128;
  const boxH = 36;
  const marginX = 24;
  const topY = 18;
  const stepGap = 48;
  const firstStepY = topY + boxH + 34;

  const colX = new Map();
  participants.forEach((p, idx) => {
    colX.set(p.id, marginX + idx * colW + colW / 2);
  });

  const bodyEndY = firstStepY + steps.length * stepGap;
  const footY = bodyEndY + 10;
  const width = Math.ceil(marginX * 2 + participants.length * colW);
  const height = Math.ceil(footY + boxH + 18);

  const parts = [];
  // Lifelines and participant boxes
  for (const p of participants) {
    const cx = colX.get(p.id);
    parts.push(`<line x1="${cx}" y1="${topY + boxH}" x2="${cx}" y2="${footY}" stroke="var(--line-strong, #8892a0)" stroke-width="1.2" stroke-dasharray="4 4"/>`);
    const lines = wrapLines(p.label, 14, 2);
    const drawHead = (y) => {
      const startY = y + boxH / 2 - ((lines.length - 1) * 15) / 2 + 4.5;
      return (
        `<rect x="${(cx - boxW / 2).toFixed(1)}" y="${y}" width="${boxW}" height="${boxH}" rx="6" fill="var(--bg-surface, #ffffff)" stroke="var(--line-strong, #6b7280)" stroke-width="1.5"/>` +
        lines.map((l, i) => `<text x="${cx}" y="${(startY + i * 15).toFixed(1)}" text-anchor="middle" font-size="12.5" font-family="${FONT_FAMILY}" fill="var(--text, #1c1f24)">${escXml(l)}</text>`).join('')
      );
    };
    parts.push(`<g class="md-diagram-participant">${drawHead(topY)}${drawHead(footY)}</g>`);
  }

  // Messages and notes
  steps.forEach((step, idx) => {
    const y = firstStepY + idx * stepGap;
    if (step.kind === 'note') {
      const xs = step.targets.map((id) => colX.get(id)).filter((v) => v !== undefined);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const lines = wrapLines(step.text, 24, 2);
      const nw = Math.max(110, Math.ceil(Math.max(...lines.map(textUnits)) * 6.8 + 20), maxX - minX + 44);
      const nh = lines.length * 16 + 12;
      let nx = (minX + maxX) / 2 - nw / 2;
      if (step.placement === 'right of') nx = minX + 12;
      else if (step.placement === 'left of') nx = minX - nw - 12;
      nx = Math.max(8, Math.min(width - nw - 8, nx));
      const ny = y - nh / 2;
      parts.push(
        `<g class="md-diagram-note">` +
          `<rect x="${nx.toFixed(1)}" y="${ny.toFixed(1)}" width="${nw}" height="${nh}" rx="5" fill="var(--bg-sunken, #f4f5f7)" stroke="var(--line-strong, #8892a0)" stroke-width="1"/>` +
          lines.map((l, i) => `<text x="${(nx + nw / 2).toFixed(1)}" y="${(ny + 16 + i * 16).toFixed(1)}" text-anchor="middle" font-size="11.5" font-family="${FONT_FAMILY}" fill="var(--text-muted, #4b5563)">${escXml(l)}</text>`).join('') +
        `</g>`,
      );
      return;
    }

    const x1 = colX.get(step.from);
    const x2 = colX.get(step.to);
    const dash = step.dashed ? ' stroke-dasharray="5 4"' : '';
    const labelText = step.label.length > 34 ? step.label.slice(0, 33) + '…' : step.label;

    if (step.from === step.to) {
      const loopW = 36;
      const loopH = 22;
      parts.push(
        `<path d="M ${x1} ${y - 6} H ${x1 + loopW} V ${y + loopH - 6} H ${x1 + 3}" fill="none" stroke="var(--line-strong, #6b7280)" stroke-width="1.5"${dash} marker-end="url(#${markerId})"/>` +
        (labelText ? `<text x="${x1 + loopW + 6}" y="${y + 8}" text-anchor="start" font-size="12" font-family="${FONT_FAMILY}" fill="var(--text, #1c1f24)">${escXml(labelText)}</text>` : ''),
      );
    } else {
      const dir = x2 > x1 ? 1 : -1;
      const tx = x2 - dir * 3;
      parts.push(
        `<line x1="${x1}" y1="${y}" x2="${tx}" y2="${y}" stroke="var(--line-strong, #6b7280)" stroke-width="1.5"${dash} marker-end="url(#${markerId})"/>` +
        (labelText ? `<text x="${((x1 + x2) / 2).toFixed(1)}" y="${(y - 7).toFixed(1)}" text-anchor="middle" font-size="12" font-family="${FONT_FAMILY}" fill="var(--text, #1c1f24)">${escXml(labelText)}</text>` : ''),
      );
    }
  });

  const svg =
    `<svg class="md-diagram-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Sequence diagram">` +
      `<defs>` +
        `<marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
          `<path d="M 1 1.5 L 9 5 L 1 8.5 z" fill="var(--line-strong, #6b7280)"/>` +
        `</marker>` +
      `</defs>` +
      parts.join('') +
    `</svg>`;

  return { svg, kind: 'sequence', width, height };
}

/**
 * Parse and render a Mermaid-subset diagram to an accessible, theme-tokened SVG string.
 * Returns `{ svg, kind, width, height }` on success, or `null` if the source is malformed or unsupported.
 */
export function renderStudyDiagram(source) {
  try {
    const parsed = parseStudyDiagram(source);
    if (!parsed) return null;
    const markerId = `md-dg-${hashTag(source)}`;
    if (parsed.kind === 'sequence') return renderSequenceSvg(parsed, markerId);
    return renderGraphSvg(parsed, markerId);
  } catch {
    return null;
  }
}

/** Static HTML wrapper for note preview and exported HTML book pages. Returns `null` on fallback. */
export function renderStudyDiagramHtml(source) {
  const rendered = renderStudyDiagram(source);
  if (!rendered) return null;
  return `<figure class="md-diagram-static" data-diagram-kind="${escXml(rendered.kind)}">${rendered.svg}</figure>\n`;
}
