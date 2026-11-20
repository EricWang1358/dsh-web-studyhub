import { evaluateSandboxPreview } from './math-eval.js';

/* Structural and pedagogical validator for `studyhub-lesson/1` interactive companion lessons.
   Validates both existing empirical benchmark lessons (e.g. Java Hood Lab) and cross-discipline
   lessons across mathematics, philosophy, mechanical engineering, economics, law, and sciences. */

export const LESSON_FORMAT = 'studyhub-lesson/1';
export const LESSON_MODES = Object.freeze(['full', 'rescue']);

export const DEFAULT_BEATS_ZH = Object.freeze([
  { id: 'open', label: '热身与场景' },
  { id: 'hook', label: '核心悬念' },
  { id: 'code', label: '直觉推演' },
  { id: 'predict', label: '先猜一猜' },
  { id: 'run', label: '动手验证' },
  { id: 'why', label: '掀盖看本质' },
  { id: 'fix', label: '修正与对照' },
  { id: 'choose', label: '怎么拍板' },
  { id: 'name', label: '挂牌命名' },
  { id: 'check', label: '边界小测' },
  { id: 'say', label: '开口讲透' },
  { id: 'take', label: '带走卡片' },
]);

export const DEFAULT_BEATS_EN = Object.freeze([
  { id: 'open', label: 'Warm-up' },
  { id: 'hook', label: 'Core Puzzle' },
  { id: 'code', label: 'First Pass' },
  { id: 'predict', label: 'Predict' },
  { id: 'run', label: 'Test It' },
  { id: 'why', label: 'Under the Hood' },
  { id: 'fix', label: 'Resolution' },
  { id: 'choose', label: 'How to Choose' },
  { id: 'name', label: 'Name It' },
  { id: 'check', label: 'Quick Check' },
  { id: 'say', label: 'Say It Aloud' },
  { id: 'take', label: 'Takeaways' },
]);

export const SUPPORTED_BLOCKS = new Set([
  'text', 'points', 'callout', 'recall', 'scene', 'code', 'spot', 'inside',
  'predict', 'reveal', 'experiment', 'try', 'workshop', 'chart', 'lanes', 'schedule',
  'choose', 'decide', 'cases', 'name', 'quiz', 'say', 'cards',
  'sandbox', 'matrix', 'schematic',
]);

const TONE_MAP = Object.freeze({ success: 'ok', warning: 'warn', error: 'bad' });
const mapTone = (t, forLanes = false) => {
  if (!t) return t;
  if (forLanes && t === 'error') return 'fail';
  return TONE_MAP[t] || t;
};
const PLACEHOLDER_RE = /^(?:todo|tbd|placeholder|\.{3,}|待补充|略|此处略)$/i;

const nonEmpty = value => typeof value === 'string' && value.trim().length > 0 && !PLACEHOLDER_RE.test(value.trim());

export function inferLessonLanguage(lesson) {
  if (lesson?.language === 'en' || lesson?.language === 'zh') return lesson.language;
  const sample = `${lesson?.title || ''} ${lesson?.lead || ''} ${lesson?.slides?.[0]?.title || ''}`;
  return /[\u4e00-\u9fff]/.test(sample) ? 'zh' : 'en';
}

/** Fill optional defaults (like `beats` inferred from the slides' `beat` sequence) without hiding broken blocks. */
export function normalizeLessonSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Lesson specification must be a JSON object');
  }
  const lesson = structuredClone(raw);
  lesson.format ||= LESSON_FORMAT;
  lesson.template ||= 'interactive';
  if (typeof lesson.mode === 'string') lesson.mode = lesson.mode.trim();
  if (typeof lesson.hid === 'string') {
    const trimmedHid = lesson.hid.trim();
    if (trimmedHid) lesson.hid = trimmedHid;
    else delete lesson.hid;
  }
  if (Array.isArray(lesson.targetCardIds)) {
    const cleaned = [];
    for (const cardId of lesson.targetCardIds) {
      if (typeof cardId === 'string' && cardId.trim()) {
        const trimmed = cardId.trim();
        if (!cleaned.includes(trimmed)) cleaned.push(trimmed);
      } else {
        cleaned.push(cardId);
      }
    }
    lesson.targetCardIds = cleaned;
  }
  const isRescue = lesson.mode === 'rescue';
  const lang = inferLessonLanguage(lesson);
  lesson.language = lang;
  lesson.minutes = Number.isFinite(Number(lesson.minutes)) && Number(lesson.minutes) > 0
    ? Math.min(180, Math.max(isRescue ? 2 : 5, Math.round(Number(lesson.minutes))))
    : (isRescue ? 4 : 25);
  lesson.needs = Array.isArray(lesson.needs) ? lesson.needs.filter(nonEmpty) : [];
  lesson.after = Array.isArray(lesson.after) ? lesson.after.filter(nonEmpty) : [];
  if (Array.isArray(lesson.terms)) {
    const dict = {};
    for (const entry of lesson.terms) {
      if (entry && nonEmpty(entry.term) && nonEmpty(entry.plain || entry.definition)) {
        dict[entry.term.trim()] = (entry.plain || entry.definition).trim();
      }
    }
    lesson.terms = dict;
  } else if (!lesson.terms || typeof lesson.terms !== 'object' || Array.isArray(lesson.terms)) {
    lesson.terms = {};
  }

  const defaults = lang === 'en' ? DEFAULT_BEATS_EN : DEFAULT_BEATS_ZH;
  const defaultMap = new Map(defaults.map(b => [b.id, b.label]));
  if (!Array.isArray(lesson.beats) || !lesson.beats.length) {
    const seen = [];
    for (const slide of Array.isArray(lesson.slides) ? lesson.slides : []) {
      const beatId = typeof slide?.beat === 'string' && slide.beat.trim() ? slide.beat.trim() : 'open';
      slide.beat = beatId;
      if (!seen.includes(beatId)) seen.push(beatId);
    }
    lesson.beats = seen.map(id => ({ id, label: defaultMap.get(id) || id }));
  }

  for (const slide of Array.isArray(lesson.slides) ? lesson.slides : []) {
    for (const block of Array.isArray(slide?.blocks) ? slide.blocks : []) {
      if (block && !block.t && typeof block.type === 'string') {
        block.t = block.type;
      }
      if (block?.t === 'sandbox') {
        if (block.target !== undefined && block.threshold === undefined) {
          block.threshold = block.target;
        }
        if (typeof block.threshold === 'number' && Number.isFinite(block.threshold)) {
          block.threshold = { value: block.threshold, label: '' };
        } else if (block.threshold && typeof block.threshold === 'object' && !Array.isArray(block.threshold)) {
          const tv = block.threshold.value;
          if (tv !== undefined && tv !== null && tv !== '' && Number.isFinite(Number(tv))) {
            block.threshold.value = Number(tv);
          }
          if (block.threshold.band !== undefined && Number.isFinite(Number(block.threshold.band))) {
            block.threshold.band = Number(block.threshold.band);
          }
        }
        if (Array.isArray(block.presets)) {
          for (const pr of block.presets) {
            if (pr && pr.values && typeof pr.values === 'object' && !Array.isArray(pr.values)) {
              for (const [pk, pv] of Object.entries(pr.values)) {
                if (pv !== '' && pv !== null && pv !== undefined && Number.isFinite(Number(pv))) {
                  pr.values[pk] = Number(pv);
                }
              }
            }
          }
        }
        try {
          const preview = evaluateSandboxPreview(block);
          block._compiled = {
            domain: preview.domain,
            series: preview.series.map(s => (s.parametric
              ? { id: s.id, label: s.label, parametric: true, xAst: s.xAst, yAst: s.yAst }
              : { id: s.id, label: s.label, parametric: false, ast: s.ast })),
            ...(preview.field ? { field: preview.field } : {}),
            markers: preview.markers.map(({ id, label, xAst, yAst }) => ({ id, label, xAst, yAst })),
            readouts: preview.readouts.map(({ id, label, unit, ast }) => ({ id, label, unit, ast })),
          };
        } catch {
          /* Reported with slide/block context by validateLessonSpec */
        }
      }
      if (block?.t === 'spot' && !block.source && Array.isArray(block.lines)) {
        block.source = block.lines.join('\n');
      }
      if (block?.t === 'quiz') {
        block.q ||= block.question || block.prompt || '';
        if (!Array.isArray(block.options) && Array.isArray(block.choices)) {
          block.options = block.choices;
        }
        if (Array.isArray(block.options)) {
          const ansIdx = Number.isInteger(block.answer) ? block.answer : (Number.isInteger(block.answerIndex) ? block.answerIndex : -1);
          const fallbackWhy = typeof block.why === 'string' ? block.why : (typeof block.explanation === 'string' ? block.explanation : '');
          block.options = block.options.map((opt, idx) => {
            if (typeof opt === 'string') {
              return { text: opt, ok: idx === ansIdx, why: fallbackWhy };
            }
            if (opt && typeof opt === 'object') {
              const text = opt.text ?? opt.label ?? opt.choice ?? '';
              const ok = opt.ok !== undefined
                ? Boolean(opt.ok)
                : opt.correct !== undefined
                  ? Boolean(opt.correct)
                  : opt.isCorrect !== undefined
                    ? Boolean(opt.isCorrect)
                    : idx === ansIdx;
              const why = opt.why ?? opt.feedback ?? opt.explanation ?? fallbackWhy;
              return { ...opt, text, ok, why };
            }
            return opt;
          });
        }
      }
      if (block?.tone) block.tone = mapTone(block.tone);
      if (block?.t === 'matrix') {
        for (const sc of block.scenarios || []) for (const c of sc?.cells || []) if (c?.tone) c.tone = mapTone(c.tone);
      }
      if (block?.t === 'schematic') {
        for (const nd of block.nodes || []) {
          if (nd && typeof nd.detail === 'string') {
            const trimmed = nd.detail.trim();
            if (!trimmed) delete nd.detail;
            else nd.detail = trimmed;
          }
        }
        for (const w of block.walk || []) if (w?.tone) w.tone = mapTone(w.tone);
      }
      if (block?.t === 'lanes') {
        for (const st of block.steps || []) if (st?.tone) st.tone = mapTone(st.tone, true);
      }
      if (block?.t === 'say' && !nonEmpty(block.model) && nonEmpty(block.sample)) {
        block.model = block.sample;
      }
    }
  }
  return lesson;
}

/** Validate a lesson specification; returns `{ ok, errors, warnings, stats }`. */
export function validateLessonSpec(raw, { strictPedagogy = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['Lesson must be an object'], warnings, stats: null };
  }
  if (raw.format && raw.format !== LESSON_FORMAT) {
    errors.push(`Unsupported lesson format "${raw.format}" (expected "${LESSON_FORMAT}")`);
  }
  if (raw.mode !== undefined && !LESSON_MODES.includes(raw.mode)) {
    errors.push(`Unsupported lesson mode "${raw.mode}" (expected "full" or "rescue")`);
  }
  if (raw.hid !== undefined && !nonEmpty(raw.hid)) {
    errors.push('Lesson "hid" must be a non-empty string');
  }
  if (raw.targetCardIds !== undefined && (!Array.isArray(raw.targetCardIds) || raw.targetCardIds.some(cardId => !nonEmpty(cardId)))) {
    errors.push('Lesson "targetCardIds" must be an array of non-empty strings');
  }
  const isRescue = raw.mode === 'rescue';
  if (!nonEmpty(raw.id)) errors.push('Lesson "id" is required');
  if (!nonEmpty(raw.title)) errors.push('Lesson "title" is required');
  if (!nonEmpty(raw.course)) warnings.push('Lesson "course" is empty');
  if (isRescue) {
    if (!Array.isArray(raw.slides) || raw.slides.length < 3 || raw.slides.length > 6) {
      errors.push(`Rescue lesson must contain 3 to 6 slides (got ${Array.isArray(raw.slides) ? raw.slides.length : 0})`);
      return { ok: false, errors, warnings, stats: null };
    }
  } else {
    if (!Array.isArray(raw.slides) || raw.slides.length < 4) {
      errors.push('Lesson must contain at least 4 slides');
      return { ok: false, errors, warnings, stats: null };
    }
    if (strictPedagogy && raw.slides.length < 12) {
      errors.push(`Generated interactive lesson has only ${raw.slides.length} slides; at least 12 progressive slides are required for full pedagogical depth`);
    }
  }

  const predicts = new Map();
  const blockCounts = {};
  const experiments = raw.experiments && typeof raw.experiments === 'object' ? raw.experiments : {};

  for (const [sIdx, slide] of raw.slides.entries()) {
    const sLabel = `Slide ${sIdx + 1}`;
    if (!slide || typeof slide !== 'object') { errors.push(`${sLabel}: must be an object`); continue; }
    if (!nonEmpty(slide.title)) errors.push(`${sLabel}: missing slide title`);
    if (!Array.isArray(slide.blocks) || !slide.blocks.length) {
      errors.push(`${sLabel}: must have at least one block`);
      continue;
    }
    for (const [bIdx, block] of slide.blocks.entries()) {
      const bType = block?.t || block?.type;
      const bLabel = `${sLabel} block ${bIdx + 1} (${bType || 'unknown'})`;
      if (!block || typeof block !== 'object' || !SUPPORTED_BLOCKS.has(bType)) {
        errors.push(`${bLabel}: unsupported block type "${bType}"`);
        continue;
      }
      blockCounts[bType] = (blockCounts[bType] || 0) + 1;
      switch (bType) {
        case 'text':
          if (!nonEmpty(block.md)) errors.push(`${bLabel}: text.md is required`);
          break;
        case 'points':
          if (!Array.isArray(block.items) || !block.items.length || block.items.some(it => !nonEmpty(it))) {
            errors.push(`${bLabel}: points.items requires non-empty strings`);
          }
          break;
        case 'callout':
          if (!nonEmpty(block.title) || !nonEmpty(block.md)) errors.push(`${bLabel}: callout needs title and md`);
          break;
        case 'recall':
          if (!Array.isArray(block.items) || !block.items.length) errors.push(`${bLabel}: recall needs items`);
          else for (const it of block.items) {
            if (!nonEmpty(it?.q) || !Array.isArray(it?.options) || it.options.length < 2 || !Number.isInteger(it.answer) || it.answer < 0 || it.answer >= it.options.length || !nonEmpty(it?.why)) {
              errors.push(`${bLabel}: recall item needs q, >=2 options, valid 0-based answer, and why`);
            }
          }
          break;
        case 'scene':
          if (!nonEmpty(block.story) || !Array.isArray(block.map) || !block.map.length) {
            errors.push(`${bLabel}: scene needs story and non-empty map`);
          }
          break;
        case 'code': {
          if (!nonEmpty(block.source)) { errors.push(`${bLabel}: code.source is required`); break; }
          const totalLines = String(block.source).split('\n').length;
          for (const ln of block.focusLines || []) {
            if (!Number.isInteger(ln) || ln < 1 || ln > totalLines) errors.push(`${bLabel}: focusLines ${ln} out of range 1..${totalLines}`);
          }
          for (const step of block.walk || []) {
            if (!nonEmpty(step?.say)) errors.push(`${bLabel}: code.walk step needs say`);
            for (const ln of step?.focusLines || []) {
              if (!Number.isInteger(ln) || ln < 1 || ln > totalLines) errors.push(`${bLabel}: walk focusLines ${ln} out of range 1..${totalLines}`);
            }
          }
          break;
        }
        case 'spot': {
          if (!nonEmpty(block.q) || !nonEmpty(block.source) || !Array.isArray(block.answerLines) || !block.answerLines.length || !nonEmpty(block.found) || !nonEmpty(block.hint)) {
            errors.push(`${bLabel}: spot needs q, source, answerLines, found, and hint`);
            break;
          }
          const totalLines = String(block.source).split('\n').length;
          for (const ln of block.answerLines) {
            if (!Number.isInteger(ln) || ln < 1 || ln > totalLines) errors.push(`${bLabel}: spot answerLine ${ln} out of range 1..${totalLines}`);
          }
          break;
        }
        case 'inside': {
          if (!nonEmpty(block.source) || !Array.isArray(block.walk) || !block.walk.length) {
            errors.push(`${bLabel}: inside needs source and non-empty walk`);
            break;
          }
          const totalLines = String(block.source).split('\n').length;
          for (const step of block.walk) {
            if (!nonEmpty(step?.label) || !nonEmpty(step?.say) || !Array.isArray(step?.focusLines) || !step.focusLines.length) {
              errors.push(`${bLabel}: inside.walk step needs label, say, and focusLines`);
            } else for (const ln of step.focusLines) {
              if (!Number.isInteger(ln) || ln < 1 || ln > totalLines) errors.push(`${bLabel}: inside focusLines ${ln} out of range 1..${totalLines}`);
            }
          }
          break;
        }
        case 'predict':
          if (!nonEmpty(block.id) || !nonEmpty(block.q) || !Array.isArray(block.options) || block.options.length < 2 || !Number.isInteger(block.answer) || block.answer < 0 || block.answer >= block.options.length) {
            errors.push(`${bLabel}: predict needs id, q, >=2 options, and valid answer index`);
          } else {
            predicts.set(block.id, block);
          }
          break;
        case 'reveal':
          if (!nonEmpty(block.of) || !predicts.has(block.of)) {
            errors.push(`${bLabel}: reveal.of "${block.of}" must reference an earlier predict.id`);
          }
          break;
        case 'experiment':
          if (!nonEmpty(block.lab) || !experiments[block.lab] || !Array.isArray(block.show) || !block.show.length) {
            errors.push(`${bLabel}: experiment needs valid lab key in experiments and non-empty show[]`);
          }
          break;
        case 'chart':
          if (!nonEmpty(block.of) || !experiments[block.of]) {
            errors.push(`${bLabel}: chart.of "${block.of}" must reference an experiment in experiments`);
          }
          break;
        case 'lanes':
          if (!Array.isArray(block.lanes) || block.lanes.length !== 2 || !block.shared || !nonEmpty(block.shared.name) || !Array.isArray(block.steps) || !block.steps.length || !nonEmpty(block.verdict)) {
            errors.push(`${bLabel}: lanes needs 2 actor names, shared {name, start}, steps[], and verdict`);
          }
          break;
        case 'sandbox': {
          let shapeOk = true;
          if (!Array.isArray(block.knobs) || !block.knobs.length || (!Array.isArray(block.series) || (!block.series.length && !block.field))) {
            errors.push(`${bLabel}: sandbox needs knobs[] and series[]`);
            shapeOk = false;
          } else {
            for (const s of block.series || []) {
              const hasParam = s?.xExpr !== undefined || s?.yExpr !== undefined;
              if (hasParam) {
                if (!nonEmpty(s?.xExpr) || !nonEmpty(s?.yExpr)) {
                  errors.push(`${bLabel}: parametric sandbox series "${s?.label || s?.id || '?'}" requires non-empty xExpr and yExpr`);
                  shapeOk = false;
                }
              } else if (!nonEmpty(s?.expr)) {
                errors.push(`${bLabel}: sandbox series "${s?.label || s?.id || '?'}" requires non-empty expr (or xExpr + yExpr)`);
                shapeOk = false;
              }
            }
          }
          if (block.field !== undefined && block.field !== null) {
            if (typeof block.field !== 'object' || Array.isArray(block.field)) {
              errors.push(`${bLabel}: sandbox.field must be an object { xMin, xMax, yMin, yMax, grid?, dxExpr, dyExpr }`);
              shapeOk = false;
            } else if (!nonEmpty(block.field.dxExpr) || !nonEmpty(block.field.dyExpr)) {
              errors.push(`${bLabel}: sandbox.field requires non-empty dxExpr and dyExpr`);
              shapeOk = false;
            }
          }
          if (block.markers !== undefined && block.markers !== null) {
            if (!Array.isArray(block.markers)) {
              errors.push(`${bLabel}: sandbox.markers must be an array`);
              shapeOk = false;
            } else {
              for (const [mIdx, mk] of block.markers.entries()) {
                if (!nonEmpty(mk?.label) || !nonEmpty(mk?.xExpr) || !nonEmpty(mk?.yExpr)) {
                  errors.push(`${bLabel}: sandbox.markers[${mIdx}] requires non-empty label, xExpr, and yExpr`);
                  shapeOk = false;
                }
              }
            }
          }
          if (shapeOk) {
            try {
              evaluateSandboxPreview(block);
            } catch (err) {
              errors.push(`${bLabel}: ${err.message}`);
            }
          }
          const rawThresh = block.threshold ?? block.target;
          if (rawThresh !== undefined && rawThresh !== null) {
            if (typeof rawThresh !== 'object' || Array.isArray(rawThresh)) {
              errors.push(`${bLabel}: sandbox.threshold must be an object { value, label? }`);
            } else {
              if (rawThresh.value === undefined || rawThresh.value === null || rawThresh.value === '' || !Number.isFinite(Number(rawThresh.value))) {
                errors.push(`${bLabel}: sandbox.threshold.value must be a finite number`);
              }
              if (rawThresh.label !== undefined && (typeof rawThresh.label !== 'string' || PLACEHOLDER_RE.test(rawThresh.label.trim()))) {
                errors.push(`${bLabel}: sandbox.threshold.label must be a valid string`);
              }
              if (rawThresh.band !== undefined && (!Number.isFinite(Number(rawThresh.band)) || Number(rawThresh.band) < 0)) {
                errors.push(`${bLabel}: sandbox.threshold.band must be a non-negative finite number`);
              }
            }
          }
          if (block.presets !== undefined && block.presets !== null) {
            if (!Array.isArray(block.presets)) {
              errors.push(`${bLabel}: sandbox.presets must be an array of { label, values }`);
            } else {
              const knobBounds = new Map();
              for (const k of Array.isArray(block.knobs) ? block.knobs : []) {
                if (nonEmpty(k?.id)) {
                  const lo = Number(k.min ?? 0);
                  const hi = Number(k.max ?? 10);
                  knobBounds.set(k.id, { min: Number.isFinite(lo) ? lo : 0, max: Number.isFinite(hi) ? hi : 10 });
                }
              }
              for (const [pIdx, pr] of block.presets.entries()) {
                if (!nonEmpty(pr?.label) || !pr?.values || typeof pr.values !== 'object' || Array.isArray(pr.values) || !Object.keys(pr.values).length) {
                  errors.push(`${bLabel}: sandbox.presets[${pIdx}] requires non-empty label and non-empty values map`);
                } else {
                  for (const [kId, kVal] of Object.entries(pr.values)) {
                    const bounds = knobBounds.get(kId);
                    const num = Number(kVal);
                    if (!bounds) {
                      errors.push(`${bLabel}: sandbox.presets[${pIdx}] references unknown knob "${kId}"`);
                    } else if (kVal === '' || kVal === null || kVal === undefined || !Number.isFinite(num) || num < bounds.min - 1e-9 || num > bounds.max + 1e-9) {
                      errors.push(`${bLabel}: sandbox.presets[${pIdx}] value "${kVal}" for knob "${kId}" must be within [${bounds.min}, ${bounds.max}]`);
                    }
                  }
                }
              }
            }
          }
          break;
        }
        case 'matrix':
          if (!Array.isArray(block.frameworks) || block.frameworks.length < 2 || !Array.isArray(block.scenarios) || !block.scenarios.length) {
            errors.push(`${bLabel}: matrix needs >=2 frameworks and >=1 scenarios`);
          } else {
            for (const sc of block.scenarios) {
              if (!nonEmpty(sc?.id) || !nonEmpty(sc?.title) || !nonEmpty(sc?.prompt) || !Array.isArray(sc?.cells) || sc.cells.length !== block.frameworks.length) {
                errors.push(`${bLabel}: matrix scenario "${sc?.id || '?'}" needs id, title, prompt, and cells matching frameworks.length`);
              }
            }
          }
          if (block.predictBeforeReveal !== undefined && typeof block.predictBeforeReveal !== 'boolean') {
            errors.push(`${bLabel}: matrix.predictBeforeReveal must be a boolean`);
          }
          break;
        case 'schematic':
          if (!Array.isArray(block.nodes) || block.nodes.length < 2 || !Array.isArray(block.edges) || !Array.isArray(block.walk) || !block.walk.length) {
            errors.push(`${bLabel}: schematic needs >=2 nodes, edges[], and walk[]`);
          } else {
            const nodeIds = new Set();
            for (const nd of block.nodes) {
              if (!nonEmpty(nd?.id) || !nonEmpty(nd?.label)) {
                errors.push(`${bLabel}: schematic node requires non-empty id and label`);
              } else {
                nodeIds.add(nd.id);
              }
              if (nd?.detail !== undefined && nd?.detail !== null && !nonEmpty(nd.detail)) {
                errors.push(`${bLabel}: schematic node "${nd?.id || '?'}" detail must be a non-empty string`);
              }
            }
            for (const ed of block.edges) {
              if (!nonEmpty(ed?.from) || !nonEmpty(ed?.to) || !nodeIds.has(ed.from) || !nodeIds.has(ed.to)) {
                errors.push(`${bLabel}: schematic edge "${ed?.id || `${ed?.from}->${ed?.to}`}" must reference existing node ids`);
              }
            }
          }
          break;
        case 'choose':
          if (!Array.isArray(block.options) || block.options.length < 2 || !nonEmpty(block.rule)) {
            errors.push(`${bLabel}: choose needs >=2 options and rule`);
          }
          break;
        case 'decide':
          if (!nonEmpty(block.q) || !Array.isArray(block.branches) || block.branches.length < 2) {
            errors.push(`${bLabel}: decide needs q and >=2 branches`);
          }
          break;
        case 'cases':
          if (!Array.isArray(block.tools) || block.tools.length < 2 || !Array.isArray(block.items) || !block.items.length) {
            errors.push(`${bLabel}: cases needs >=2 tools and items[]`);
          } else for (const it of block.items) {
            if (!nonEmpty(it?.text) || !Number.isInteger(it?.answer) || it.answer < 0 || it.answer >= block.tools.length || !nonEmpty(it?.why)) {
              errors.push(`${bLabel}: cases item needs text, valid answer index into tools, and why`);
            }
          }
          break;
        case 'name':
          if (!nonEmpty(block.term) || !nonEmpty(block.oneLine) || !Array.isArray(block.asked) || !block.asked.length) {
            errors.push(`${bLabel}: name needs term, oneLine, and asked[]`);
          }
          break;
        case 'quiz': {
          const qText = block.q || block.question || block.prompt;
          const opts = Array.isArray(block.options) ? block.options : Array.isArray(block.choices) ? block.choices : null;
          const minOpts = strictPedagogy ? 3 : 2;
          const rawAns = Number.isInteger(block.answer) ? block.answer : (Number.isInteger(block.answerIndex) ? block.answerIndex : -1);
          const hasAnsIdx = rawAns >= 0 && Boolean(opts && rawAns < opts.length);
          const hasOkFlag = Boolean(opts && opts.some(o => o && typeof o === 'object' && (o.ok === true || o.correct === true || o.isCorrect === true)));
          const invalidOpt = Boolean(opts && opts.some(o => {
            if (typeof o === 'string') return !nonEmpty(o);
            if (!o || typeof o !== 'object') return true;
            if (!nonEmpty(o.text || o.label || o.choice)) return true;
            const whyVal = o.why ?? o.feedback ?? o.explanation;
            if (whyVal !== undefined && whyVal !== null && whyVal !== '' && !nonEmpty(whyVal)) return true;
            if (strictPedagogy && !nonEmpty(whyVal || block.why || block.explanation)) return true;
            return false;
          }));
          if (!nonEmpty(qText) || !opts || opts.length < minOpts || (!hasOkFlag && !hasAnsIdx) || invalidOpt) {
            errors.push(`${bLabel}: quiz needs q and >=${minOpts} valid options/choices with at least one correct answer`);
          }
          break;
        }
        case 'say':
          if (!nonEmpty(block.prompt) || !Array.isArray(block.points) || block.points.length < 2 || (!nonEmpty(block.model) && !nonEmpty(block.sample))) {
            errors.push(`${bLabel}: say needs prompt, >=2 points, and model/sample answer`);
          }
          break;
        case 'try':
        case 'workshop': {
          for (const fld of ['title', 'text', 'md', 'prompt', 'goal', 'mission', 'hint', 'solution', 'sampleAnswer']) {
            if (block[fld] !== undefined && block[fld] !== null && (typeof block[fld] !== 'string' || PLACEHOLDER_RE.test(block[fld].trim()))) {
              errors.push(`${bLabel}: ${bType}.${fld} must be a valid string`);
            }
          }
          for (const listFld of ['steps', 'criteria', 'points']) {
            if (block[listFld] !== undefined && block[listFld] !== null) {
              if (!Array.isArray(block[listFld]) || block[listFld].some(it => !(typeof it === 'string' ? nonEmpty(it) : nonEmpty(it?.label || it?.text)))) {
                errors.push(`${bLabel}: ${bType}.${listFld} must be an array of non-empty step strings`);
              }
            }
          }
          break;
        }
        case 'cards':
          if (!Array.isArray(block.items) || block.items.length < 2 || block.items.some(c => !nonEmpty(c?.q) || !nonEmpty(c?.a))) {
            errors.push(`${bLabel}: cards needs >=2 {q, a} items`);
          }
          break;
        default:
          break;
      }
    }
  }

  if (isRescue) {
    const firstBlocks = Array.isArray(raw.slides[0]?.blocks) ? raw.slides[0].blocks : [];
    const lastBlocks = Array.isArray(raw.slides[raw.slides.length - 1]?.blocks) ? raw.slides[raw.slides.length - 1].blocks : [];
    if (!firstBlocks.some(b => (b?.t || b?.type) === 'predict')) {
      errors.push('Rescue lesson Slide 1 must include a "predict" block');
    }
    if (!lastBlocks.some(b => (b?.t || b?.type) === 'quiz')) {
      errors.push('Rescue lesson final slide must include a "quiz" check block');
    }
    if (strictPedagogy && !blockCounts.sandbox && !blockCounts.experiment && !blockCounts.matrix && !blockCounts.lanes && !blockCounts.schematic) {
      errors.push('Pedagogical gate: rescue lesson must include at least one interactive exploration block (sandbox, experiment, matrix, lanes, or schematic)');
    }
  } else if (strictPedagogy) {
    if (!blockCounts.predict || !blockCounts.reveal) {
      errors.push('Pedagogical gate: lesson must include at least one predict + reveal pair so the learner hypothesizes before seeing the outcome');
    }
    if (!blockCounts.sandbox && !blockCounts.experiment && !blockCounts.matrix && !blockCounts.lanes && !blockCounts.schematic) {
      errors.push('Pedagogical gate: lesson must include at least one interactive exploration block (sandbox, experiment, matrix, lanes, or schematic)');
    }
    if (!blockCounts.quiz) errors.push('Pedagogical gate: lesson must include at least one check quiz block');
    if (!blockCounts.say) errors.push('Pedagogical gate: lesson must include a "say" oral recall synthesis block');
    if (!blockCounts.cards) errors.push('Pedagogical gate: lesson must end with a "cards" takeaway block');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      mode: isRescue ? 'rescue' : 'full',
      slides: raw.slides.length,
      terms: raw.terms ? Object.keys(raw.terms).length : 0,
      blocks: blockCounts,
    },
  };
}
