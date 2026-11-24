import { initialReview, norm, quoteFound, schedule, validateDeck } from '../domain.js';
import { inferLessonLanguage } from '../companion-template/validate.js';
import { courseIdOf, courseIndex, courseKey } from '../courses.js';
import { linkPrerequisite } from '../prereq.js';
import { id as makeId } from '../util.js';

/* Zero-token `studyhub-lesson/1` projection, deterministic card compilation (including ADR-8 `kind: "task"` hands-on drills),
   high-confidence existing-card matcher (ADR-3), 3-tier FSRS-preserving sync (ADR-2),
   interactive first-pass credit, and 1-click anti-misconception catch-up cards (ADR-5). */

const GENERIC_TERMS = new Set([
  'java', 'code', 'method', 'class', 'object', 'value', 'thread', 'data', 'list', 'map', 'set', 'key', 'lock', 'time', 'step', 'case', 'rule', 'test', 'model',
  '代码', '方法', '对象', '变量', '线程', '数据', '列表', '集合', '加锁', '时间', '步骤', '情况', '规则', '测试', '模型', '结果', '问题', '方案', '系统', '函数',
]);

function restoreMathString(text, mathTable) {
  const raw = String(text ?? '');
  if (!raw.includes('@@SHM_')) return raw;
  return raw.replace(/@@SHM_(\d+)@@/g, (_whole, idxStr) => {
    const entry = Array.isArray(mathTable) ? mathTable[Number(idxStr)] : null;
    if (entry && typeof entry.tex === 'string' && entry.tex.trim()) {
      return entry.display ? `$$${entry.tex}$$` : `$${entry.tex}$`;
    }
    return '[formula]';
  });
}

export function detokenizeLesson(rawLesson) {
  if (!rawLesson || typeof rawLesson !== 'object') return rawLesson;
  const mathTable = Array.isArray(rawLesson._math) ? rawLesson._math : null;
  if (!mathTable || !mathTable.length) return rawLesson;

  function visit(node, key = '') {
    if (key === '_math' || key === '_compiled') return node;
    if (typeof node === 'string') return restoreMathString(node, mathTable);
    if (Array.isArray(node)) return node.map(item => visit(item, key));
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = k === 'terms' && v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).map(([tk, tv]) => [restoreMathString(tk, mathTable), typeof tv === 'string' ? restoreMathString(tv, mathTable) : visit(tv, tk)]))
          : visit(v, k);
      }
      return out;
    }
    return node;
  }

  return visit(rawLesson);
}

const stripMathTokens = (text, mathTable = null) => restoreMathString(text, mathTable).trim();

const clip = (value, max = 220, mathTable = null) => {
  const clean = stripMathTokens(value, mathTable).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

/** Extract embedded `<script type="application/json" id="lesson-data">` from an HTML document, if present. */
export function extractEmbeddedLesson(html) {
  if (typeof html !== 'string') return null;
  const match = /<script\b[^>]*\bid=["']lesson-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.slides) ? parsed : null;
  } catch {
    return null;
  }
}

/* ---------- Zero-Eval Safe Data Parser for `workshop-lab.html` & Structured `<section>` Drills (ADR-8) ---------- */

function parseSafeJsDataLiteral(source, startAt = 0) {
  let i = startAt;
  const n = source.length;

  function skipWsAndComments() {
    while (i < n) {
      if (/\s/.test(source[i])) { i++; continue; }
      if (source[i] === '/' && source[i + 1] === '/') {
        while (i < n && source[i] !== '\n') i++;
        continue;
      }
      if (source[i] === '/' && source[i + 1] === '*') {
        i += 2;
        while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      break;
    }
  }

  function readString(quote) {
    i++; // skip opening quote
    let out = '';
    while (i < n) {
      const ch = source[i++];
      if (ch === '\\') {
        if (i >= n) break;
        const esc = source[i++];
        if (esc === 'n') out += '\n';
        else if (esc === 'r') out += '\r';
        else if (esc === 't') out += '\t';
        else if (esc === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(i, i + 4))) {
          out += String.fromCharCode(parseInt(source.slice(i, i + 4), 16));
          i += 4;
        } else out += esc;
        continue;
      }
      if (ch === quote) return out;
      out += ch;
    }
    throw new Error('Unterminated string');
  }

  function readValue() {
    skipWsAndComments();
    if (i >= n) throw new Error('Unexpected end');
    const ch = source[i];
    if (ch === '"' || ch === '\'' || ch === '`') return readString(ch);
    if (ch === '[') {
      i++;
      const arr = [];
      for (;;) {
        skipWsAndComments();
        if (i >= n) throw new Error('Unterminated array');
        if (source[i] === ']') { i++; return arr; }
        arr.push(readValue());
        skipWsAndComments();
        if (source[i] === ',') i++;
      }
    }
    if (ch === '{') {
      i++;
      const obj = {};
      for (;;) {
        skipWsAndComments();
        if (i >= n) throw new Error('Unterminated object');
        if (source[i] === '}') { i++; return obj; }
        let key;
        if (source[i] === '"' || source[i] === '\'') key = readString(source[i]);
        else {
          const idMatch = /^[A-Za-z_$][\w$]*/.exec(source.slice(i));
          if (!idMatch) throw new Error('Invalid object key');
          key = idMatch[0];
          i += key.length;
        }
        skipWsAndComments();
        if (source[i] !== ':') throw new Error('Expected colon');
        i++;
        obj[key] = readValue();
        skipWsAndComments();
        if (source[i] === ',') i++;
      }
    }
    const numMatch = /^-?\d+(?:\.\d+)?/.exec(source.slice(i));
    if (numMatch) { i += numMatch[0].length; return Number(numMatch[0]); }
    for (const [kw, val] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(kw, i) && !/[\w$]/.test(source[i + kw.length] || '')) {
        i += kw.length;
        return val;
      }
    }
    throw new Error('Unsupported literal');
  }

  return readValue();
}

const stripHtmlTags = raw => String(raw ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Extract a structured `studyhub-lesson/1` spec with hands-on `workshop` (`try`) drills from
 * `projects/workshop-lab.html` (`#workshop-data`, `const LESSONS = [...]`, or `<section data-drill|data-workshop>`),
 * using pure static parsing with zero script execution. Returns `null` on ordinary non-workshop HTML files.
 */
export function extractWorkshopLesson(html, fallbackId = 'workshop-lab') {
  if (typeof html !== 'string' || !html.trim()) return null;

  // 1. Explicit `<script type="application/json" id="workshop-data">`
  const jsonTag = /<script\b[^>]*\bid=["']workshop-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (jsonTag) {
    try {
      const parsed = JSON.parse(jsonTag[1]);
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.slides)) return parsed;
        if (Array.isArray(parsed.drills) && parsed.drills.length) {
          return {
            format: 'studyhub-lesson/1',
            template: 'workshop',
            id: String(parsed.id || fallbackId),
            title: String(parsed.title || fallbackId),
            ...(parsed.course ? { course: String(parsed.course) } : {}),
            ...(parsed.language ? { language: parsed.language } : {}),
            slides: parsed.drills.map((d, idx) => ({
              beat: 'run',
              title: String(d.title || `Drill ${idx + 1}`),
              blocks: [{
                t: 'try',
                title: String(d.title || `Drill ${idx + 1}`),
                prompt: String(d.prompt || d.goal || d.mission || ''),
                criteria: Array.isArray(d.criteria || d.steps || d.points) ? (d.criteria || d.steps || d.points) : [],
                solution: String(d.solution || d.model || d.goodCode || ''),
                say: String(d.say || d.hood || ''),
              }],
            })),
          };
        }
      }
    } catch { /* fall through */ }
  }

  // 2. `workshop-lab.html` static `const LESSONS = [ { mission, sayPoints, goodCode, ... } ]`
  const lessonsDecl = /\bconst\s+LESSONS\s*=\s*\[/.exec(html);
  if (lessonsDecl) {
    const bracketPos = html.indexOf('[', lessonsDecl.index);
    if (bracketPos >= 0) {
      try {
        const items = parseSafeJsDataLiteral(html, bracketPos);
        if (Array.isArray(items) && items.length > 0 && items.some(it => it && (it.mission || it.prompt || it.goal))) {
          const docTitle = stripHtmlTags(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '') || fallbackId;
          const slides = items.slice(0, 24).map((it, idx) => {
            const slideTitle = `${it.num ? `#${it.num} ` : ''}${String(it.title || `Module ${idx + 1}`)}`.trim();
            const blocks = [];
            if (it.goodCode) {
              blocks.push({
                t: 'code',
                path: it.proj ? `Project ${it.proj}` : 'Reference',
                lang: 'text',
                source: String(it.goodCode),
                say: String(it.hood || ''),
              });
            }
            const criteria = Array.isArray(it.criteria || it.sayPoints || it.steps)
              ? (it.criteria || it.sayPoints || it.steps).map(s => String(s || '').trim()).filter(Boolean)
              : [];
            if ((it.mission || it.prompt || it.goal) && criteria.length) {
              blocks.push({
                t: 'try',
                title: slideTitle,
                prompt: String(it.mission || it.prompt || it.goal).trim(),
                criteria,
                solution: String(it.goodCode || it.hood || '').trim(),
                say: String(it.sayPrompt || it.hood || ''),
              });
            }
            return { beat: 'run', title: slideTitle, blocks };
          }).filter(s => s.blocks.length > 0);

          if (slides.length > 0) {
            const lang = inferLessonLanguage({ title: docTitle, slides });
            return {
              format: 'studyhub-lesson/1',
              template: 'workshop',
              language: lang,
              id: fallbackId,
              title: docTitle,
              slides,
            };
          }
        }
      } catch { /* fall through */ }
    }
  }

  // 3. Structured `<section data-drill|data-workshop>` or `<section class="...workshop-drill...">`
  const sectionRe = /<(?:section|article)\b([^>]*)>([\s\S]*?)<\/(?:section|article)>/gi;
  const sectionDrills = [];
  for (let m = sectionRe.exec(html); m; m = sectionRe.exec(html)) {
    const attrs = m[1] || '';
    if (!/\bdata-(?:drill|workshop|task)\b/i.test(attrs) && !/\bclass=["'][^"']*\b(?:workshop-drill|hands-on-drill|drill-card)\b/i.test(attrs)) {
      continue;
    }
    const body = m[2] || '';
    const heading = stripHtmlTags(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(body)?.[1] || '');
    const paragraphs = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(p => stripHtmlTags(p[1])).filter(Boolean);
    const listItems = [...body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(li => stripHtmlTags(li[1])).filter(Boolean);
    const codeBlock = stripHtmlTags(/<pre\b[^>]*>([\s\S]*?)<\/pre>/i.exec(body)?.[1] || '');
    const prompt = paragraphs[0] || heading;
    if (prompt && listItems.length >= 1) {
      sectionDrills.push({
        beat: 'run',
        title: heading || `Hands-On Drill ${sectionDrills.length + 1}`,
        blocks: [{
          t: 'try',
          title: heading || `Drill ${sectionDrills.length + 1}`,
          prompt,
          criteria: listItems.slice(0, 6),
          solution: codeBlock || listItems.join('; '),
          say: paragraphs[1] || prompt,
        }],
      });
    }
  }
  if (sectionDrills.length > 0) {
    const docTitle = stripHtmlTags(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '') || fallbackId;
    const lang = inferLessonLanguage({ title: docTitle, slides: sectionDrills });
    return {
      format: 'studyhub-lesson/1',
      template: 'workshop',
      language: lang,
      id: fallbackId,
      title: docTitle,
      slides: sectionDrills,
    };
  }

  return null;
}

export function isHandsOnDrillBlock(block) {
  if (!block || (block.t !== 'workshop' && block.t !== 'try')) return false;
  const prompt = String(block.prompt || block.goal || block.mission || '').trim();
  const list = block.criteria || block.steps || block.points;
  return Boolean(prompt && Array.isArray(list) && list.some(it => (typeof it === 'string' ? it.trim() : (it?.descriptor || it?.label || it?.text))));
}

function normalizeDrillCriteria(rawList, isEn) {
  const cleaned = [];
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    if (typeof raw === 'string') {
      const txt = raw.trim();
      if (txt) cleaned.push({ descriptor: txt, keyPoints: [txt] });
    } else if (raw && typeof raw === 'object') {
      const desc = String(raw.descriptor || raw.text || raw.label || '').trim();
      if (!desc) continue;
      const kp = Array.isArray(raw.keyPoints) && raw.keyPoints.length
        ? raw.keyPoints.map(x => String(x || '').trim()).filter(Boolean)
        : [desc];
      cleaned.push({
        label: raw.label ? String(raw.label).trim() : '',
        marks: Number.isFinite(raw.marks) && raw.marks > 0 ? raw.marks : 2,
        descriptor: desc,
        keyPoints: kp.length ? kp : [desc],
      });
    }
  }
  const capped = cleaned.slice(0, 4);
  if (capped.length === 1) {
    const fallbackDesc = isEn
      ? 'Verify boundary conditions and invariants hold without regressions'
      : '核验边界条件与核心状态不变量，确保无回归漏洞';
    capped.push({ descriptor: fallbackDesc, keyPoints: [fallbackDesc] });
  }
  return capped.map((item, idx) => ({
    id: `c${idx + 1}`,
    label: item.label || (isEn ? `Criterion ${idx + 1}` : `验收项 ${idx + 1}`),
    marks: item.marks || 2,
    descriptor: item.descriptor,
    keyPoints: item.keyPoints,
  }));
}

/** Find the best interactive slide number (1-based) to deep-link for visual remediation. */
export function primaryInteractiveSlide(rawLesson, language) {
  const lesson = detokenizeLesson(rawLesson);
  const lang = language === 'en' || language === 'zh' ? language : inferLessonLanguage(lesson);
  const slides = Array.isArray(lesson?.slides) ? lesson.slides : [];
  const priority = ['lanes', 'sandbox', 'experiment', 'matrix', 'schematic', 'inside', 'spot', 'decide', 'try', 'workshop'];
  for (const kind of priority) {
    const idx = slides.findIndex(s => Array.isArray(s?.blocks) && s.blocks.some(b => b?.t === kind));
    if (idx >= 0) {
      const slide = slides[idx];
      const n = idx + 1;
      return {
        slide: n,
        anchor: `#${n}`,
        label: lang === 'en' ? `Slide ${n} · ${clip(slide.title, 36)}` : `第 ${n} 页 · ${clip(slide.title, 28)}`,
      };
    }
  }
  return { slide: 1, anchor: '#1', label: lang === 'en' ? 'Slide 1' : '第 1 页' };
}

/** Project a `studyhub-lesson/1` JSON into a complete structured Markdown Source with `# [Slide N]` anchors and verbatim quotes. */
export function projectLessonSource(rawLesson, { companionId, course, provenance = 'independent-source' }) {
  const lesson = detokenizeLesson(rawLesson);
  const isEn = inferLessonLanguage(lesson) === 'en';
  const sep = isEn ? ': ' : '：';
  const lines = [`# ${lesson.title}`];
  if (lesson.lead) lines.push('', lesson.lead);
  if (Array.isArray(lesson.needs) && lesson.needs.length) {
    lines.push('', isEn ? '## Prerequisites' : '## Prerequisites / 前置基础', ...lesson.needs.map(item => `- ${item}`));
  }
  if (Array.isArray(lesson.after) && lesson.after.length) {
    lines.push('', isEn ? '## Learning Outcomes' : '## Learning Outcomes / 学习目标', ...lesson.after.map(item => `- ${item}`));
  }
  if (lesson.terms && typeof lesson.terms === 'object' && Object.keys(lesson.terms).length) {
    lines.push('', isEn ? '## Glossary' : '## Glossary / 核心术语');
    for (const [term, def] of Object.entries(lesson.terms)) {
      lines.push(`- **${term}**${sep}${def}`);
    }
  }

  const predictById = new Map();

  for (const [index, slide] of (lesson.slides || []).entries()) {
    lines.push('', `## [Slide ${index + 1}] ${slide.title}`);
    if (slide.bridge) lines.push(slide.bridge);
    for (const block of slide.blocks || []) {
      if (block.say) lines.push(block.say);
      if (block.key) lines.push(`> ${block.key}`);
      if (block.t === 'text' && block.md) lines.push(block.md);
      if (block.t === 'points' && Array.isArray(block.items)) lines.push(...block.items.map(it => `- ${it}`));
      if (block.t === 'callout') lines.push(`**${block.title}**${sep}${block.md}`);
      if (block.t === 'recall' && Array.isArray(block.items)) {
        for (const it of block.items) {
          const ansText = Array.isArray(it.options) && Number.isInteger(it.answer) ? (it.options[it.answer] || '') : '';
          lines.push(`- **${it.have || (isEn ? 'Warm-up' : '前置热身')}**${sep}${it.q}${ansText ? ` → ${ansText}` : ''}${it.why ? ` (${it.why})` : ''}`);
        }
      }
      if (block.t === 'scene') {
        lines.push(block.story);
        for (const pair of block.map || []) lines.push(`- ${pair.scene} → ${pair.code || pair.model || ''}${sep}${pair.say || ''}`);
      }
      if (block.t === 'predict') {
        if (block.id) predictById.set(block.id, block);
        lines.push(`**${isEn ? 'Prediction' : '先猜一猜'}**${sep}${block.q}`);
        for (const [oIdx, optText] of (block.options || []).entries()) {
          lines.push(`- (${String.fromCharCode(65 + oIdx)}) ${optText}`);
        }
      }
      if (block.t === 'reveal') {
        const pred = predictById.get(block.of);
        const actual = pred && Array.isArray(pred.options) && Number.isInteger(pred.answer) ? pred.options[pred.answer] : '';
        if (actual) lines.push(`**${isEn ? 'Actual Outcome' : '揭晓结果'}**${sep}${actual}`);
      }
      if ((block.t === 'code' || block.t === 'spot' || block.t === 'inside') && block.source) {
        if (block.t === 'spot' && block.q) {
          lines.push(`**${isEn ? 'Flaw Check' : '找茬焦点'}**${sep}${block.q}`);
        }
        lines.push('```' + (block.lang || 'text'), String(block.source).trimEnd(), '```');
        for (const step of block.walk || []) if (step.say) lines.push(`- ${step.label ? `[${step.label}] ` : ''}${step.say}`);
        if (block.t === 'spot') {
          const srcLines = String(block.source).split('\n');
          const targets = (block.answerLines || [])
            .filter(ln => Number.isInteger(ln) && ln >= 1 && ln <= srcLines.length)
            .map(ln => `L${ln}: ${srcLines[ln - 1].trim()}`);
          if (targets.length) {
            lines.push(`- **${isEn ? 'Flawed Step' : '问题行定位'}** (${targets.join(' | ')})${block.found ? `${sep}${block.found}` : ''}`);
          } else if (block.found) {
            lines.push(block.found);
          }
          if (block.hint) lines.push(`- **${isEn ? 'Hint' : '排查提示'}**${sep}${block.hint}`);
        } else if (block.found) {
          lines.push(block.found);
        }
      }
      if (block.t === 'lanes') {
        for (const step of block.steps || []) lines.push(`- [${block.lanes?.[step.lane] || step.lane}] ${step.text}${sep}${step.say || ''}`);
        if (block.verdict) lines.push(`**${isEn ? 'Verdict' : '结论'}**${sep}${block.verdict}`);
      }
      if (block.t === 'sandbox') {
        if (block.caption) lines.push(block.caption);
        for (const k of block.knobs || []) {
          lines.push(`- **${k.label || k.id}**${sep}[${k.min}, ${k.max}] (default ${k.default ?? k.min}${k.unit ? ` ${k.unit}` : ''})`);
        }
        for (const pr of block.presets || []) {
          if (pr?.label && pr?.values && typeof pr.values === 'object') {
            const summary = Object.entries(pr.values).map(([k, v]) => `${k}=${v}`).join(', ');
            if (summary) lines.push(`- **${pr.label}**${sep}${summary}`);
          }
        }
        for (const s of block.series || []) {
          const formula = s.expr || (s.xExpr && s.yExpr ? `(${s.xExpr}, ${s.yExpr})` : '');
          if (formula) lines.push(`- **${s.label || s.id}**${sep}\`${formula}\``);
        }
        if (block.threshold && block.threshold.value !== undefined) {
          lines.push(`- **${block.threshold.label || (isEn ? 'Threshold' : '参考阈值')}**${sep}${block.threshold.value}`);
        }
        for (const step of block.walk || []) if (step.say) lines.push(`- ${step.say}`);
      }
      if (block.t === 'matrix') {
        for (const sc of block.scenarios || []) {
          lines.push(`### ${sc.title}`, sc.prompt);
          for (const [i, fw] of (block.frameworks || []).entries()) {
            const cell = sc.cells?.[i];
            if (cell) {
              lines.push(isEn
                ? `- **${fw.name}** (${cell.verdict || cell.badge || ''}): ${cell.why || ''}`
                : `- **${fw.name}**（${cell.verdict || cell.badge || ''}）：${cell.why || ''}`);
            }
          }
        }
      }
      if (block.t === 'schematic') {
        const nodeLabels = new Map();
        for (const node of block.nodes || []) {
          nodeLabels.set(node.id, node.label || node.id);
          const sub = node.sub ? ` (${node.sub})` : '';
          const detail = node.detail ? `${sep}${node.detail}` : '';
          lines.push(`- **${node.label || node.id}**${sub}${detail}`);
        }
        for (const edge of block.edges || []) {
          const fromLabel = nodeLabels.get(edge.from) || edge.from;
          const toLabel = nodeLabels.get(edge.to) || edge.to;
          lines.push(`- ${fromLabel} → ${toLabel}${edge.label ? ` [${edge.label}]` : ''}`);
        }
        for (const step of block.walk || []) {
          const stateNotes = step.states && typeof step.states === 'object'
            ? Object.entries(step.states).map(([nid, val]) => `${nodeLabels.get(nid) || nid}=${val}`).join(', ')
            : '';
          if (step.say || stateNotes) {
            lines.push(`- ${step.say || ''}${stateNotes ? ` (${stateNotes})` : ''}`.trim());
          }
        }
      }
      if (block.t === 'choose') {
        for (const opt of block.options || []) lines.push(`- **${opt.name}**${sep}${opt.solves} | ${opt.cost} | ${opt.when}`);
        if (block.rule) lines.push(`**${isEn ? 'Decision Rule' : '选择判准'}**${sep}${block.rule}`);
      }
      if (block.t === 'decide') {
        lines.push(`**${isEn ? 'Decision Question' : '决策问题'}**${sep}${block.q}`);
        for (const br of block.branches || []) {
          lines.push(`- ${br.when} → **${br.pick}**${br.eg ? ` (${br.eg})` : ''}`);
        }
      }
      if (block.t === 'cases') {
        for (const it of block.items || []) {
          const pickedTool = Array.isArray(block.tools) && Number.isInteger(it.answer) ? (block.tools[it.answer] || '') : '';
          lines.push(`- **${isEn ? 'Case' : '实战场景'}**${sep}${it.text} → **${pickedTool}** — ${it.why || ''}`);
        }
      }
      if (isHandsOnDrillBlock(block)) {
        const drillPrompt = String(block.prompt || block.goal || block.mission || '').trim();
        lines.push(`**${isEn ? 'Hands-On Task' : '动手任务'}**${block.title ? ` (${block.title})` : ''}${sep}${drillPrompt}`);
        for (const rawCrit of (block.criteria || block.steps || block.points || [])) {
          const critText = typeof rawCrit === 'string' ? rawCrit.trim() : String(rawCrit?.descriptor || rawCrit?.text || rawCrit?.label || '').trim();
          if (critText) lines.push(`- ${isEn ? 'Criterion' : '验收标准'}${sep}${critText}`);
        }
        const sol = String(block.solution || block.model || block.goodCode || '').trim();
        if (sol) lines.push(`**${isEn ? 'Reference Verification' : '参考核验要点'}**${sep}${sol}`);
      }
      if (block.t === 'name') {
        lines.push(`**${block.term}**${block.alias ? ` (${block.alias})` : ''}${sep}${block.oneLine}`);
        for (const q of block.asked || []) lines.push(`- ${isEn ? 'Follow-up' : '常见追问'}${sep}${q}`);
      }
      if (block.t === 'quiz') {
        const qText = block.q || block.question || block.prompt || '';
        const quizList = Array.isArray(block.options) ? block.options : Array.isArray(block.choices) ? block.choices : [];
        lines.push(`**${isEn ? 'Self-Check' : '自测问题'}**${sep}${qText}`);
        for (const [oIdx, opt] of quizList.entries()) {
          const isRight = typeof opt === 'object' && opt
            ? (opt.ok === true || opt.correct === true || (Number.isInteger(block.answer) && block.answer === oIdx))
            : (Number.isInteger(block.answer) && block.answer === oIdx);
          const optText = typeof opt === 'string' ? opt : (opt?.text || opt?.label || '');
          const optWhy = (typeof opt === 'object' && opt ? (opt.why || opt.feedback || opt.explanation) : '') || block.why || block.explanation || '';
          const tag = isRight ? (isEn ? '[Correct]' : '[正确]') : (isEn ? '[Distractor]' : '[干扰项]');
          lines.push(`- ${tag} ${optText}${optWhy ? ` — ${optWhy}` : ''}`);
        }
      }
      if (block.t === 'say') {
        lines.push(`**${isEn ? 'Oral Synthesis' : '口述演练'}**${sep}${block.prompt}`);
        for (const pt of block.points || []) lines.push(`- ${isEn ? 'Key point' : '要点'}${sep}${pt}`);
        if (block.model || block.sample) lines.push(`**${isEn ? 'Model Answer' : '参考表达'}**${sep}${block.model || block.sample}`);
      }
      if (block.t === 'cards') {
        for (const c of block.items || []) {
          lines.push(isEn ? `- **Q: ${c.q}** A: ${c.a}` : `- **Q：${c.q}** A：${c.a}`);
        }
      }
    }
  }

  const text = lines.join('\n').trim();
  const targetCourse = course || lesson.course || '';
  return {
    id: `src-companion-${companionId}`,
    title: lesson.title,
    text,
    format: 'md',
    provenance,
    companionId,
    ...(targetCourse ? { courses: [targetCourse] } : {}),
  };
}

function safeQuoteFrom(sourceText, candidates) {
  for (const candidate of candidates) {
    const clean = String(candidate || '').trim();
    if (clean.length >= 12 && quoteFound(sourceText, clean)) return clean.slice(0, 260);
  }
  const fallback = sourceText.split('\n').find(line => line.trim().length >= 16 && !line.startsWith('#')) || sourceText.slice(0, 120);
  return fallback.trim().slice(0, 240);
}

/**
 * Deterministically compile `take` (`cards`), `check` (`quiz`), `say` (`open`),
 * ADR-8 `workshop`/`try` hands-on drills (`task`), and opt-in `cases` scenario items into validated StudyHub cards.
 */
export function compileLessonCards(rawLesson, { source, companionId, grounded = true, includeCaseCards } = {}) {
  const lesson = detokenizeLesson(rawLesson);
  const isEn = inferLessonLanguage(lesson) === 'en';
  const emitCaseCards = Boolean(includeCaseCards ?? lesson.includeCaseCards);
  const cards = [];
  const usedObjectives = new Set();
  const usedPrompts = new Set();
  const visualRef = primaryInteractiveSlide(lesson, isEn ? 'en' : 'zh');
  const topic = clip(lesson.slides?.flatMap(s => s.blocks || []).find(b => b?.t === 'name')?.term || lesson.title, 60);
  const commonMisconception = lesson.slides?.flatMap(s => s.blocks || []).find(b => b?.t === 'predict')
    ? (isEn
      ? 'Relying on surface intuition without checking boundary interleavings or hidden assumptions.'
      : '仅凭表面直觉下结论，忽略了边界条件、交错时序或隐含前提。')
    : (isEn ? 'Confusing sufficient conditions with necessary conditions.' : '容易混淆适用边界与底层约束条件。');

  const uniqueObj = base => {
    let candidate = clip(base, 140);
    let n = 2;
    while (usedObjectives.has(norm(candidate))) candidate = `${clip(base, 125)} (${n++})`;
    usedObjectives.add(norm(candidate));
    return candidate;
  };

  let takeIndex = 0;
  let checkIndex = 0;
  let sayIndex = 0;
  let taskIndex = 0;
  let caseIndex = 0;

  for (const [sIdx, slide] of (lesson.slides || []).entries()) {
    const slideNum = sIdx + 1;
    const decideOnSlide = (slide.blocks || []).find(b => b?.t === 'decide' && Array.isArray(b.branches));

    for (const block of slide.blocks || []) {
      if (block.t === 'cards' && Array.isArray(block.items)) {
        for (const item of block.items) {
          const prompt = String(item.q || '').trim();
          const answer = String(item.a || '').trim();
          if (!prompt || !answer || usedPrompts.has(norm(prompt))) continue;
          usedPrompts.add(norm(prompt));
          const quote = safeQuoteFrom(source.text, [`Q: ${prompt}** A: ${answer}`, `Q：${prompt}** A：${answer}`, answer, prompt]);
          cards.push({
            id: `shc-${companionId}-take-${takeIndex}`,
            kind: 'flashcard',
            topic,
            objective: uniqueObj(isEn ? `[${lesson.title} · Key ${takeIndex + 1}] ${prompt}` : `[${lesson.title} · 带走卡 ${takeIndex + 1}] ${prompt}`),
            prompt,
            answer,
            hint: isEn ? `Recall the mechanism demonstrated on ${visualRef.label}.` : `回想「${visualRef.label}」里演示的关键机制与边界。`,
            explanation: isEn ? `Core takeaway from "${lesson.title}" (Slide ${slideNum}).` : `来自交互伴学课《${lesson.title}》第 ${slideNum} 页的核心带走结论。`,
            misconception: commonMisconception,
            citations: [{ sourceId: source.id, quote }],
            companionRef: { companionId, anchor: visualRef.anchor, slide: visualRef.slide, label: visualRef.label, slot: `take:${takeIndex}` },
            grounded,
          });
          takeIndex++;
        }
      } else if (block.t === 'quiz' && (Array.isArray(block.options) || Array.isArray(block.choices))) {
        const rawList = Array.isArray(block.options) ? block.options : block.choices;
        if (rawList.length < 3 || rawList.length > 6) continue;
        const prompt = String(block.q || block.question || block.prompt || '').trim();
        if (!prompt || usedPrompts.has(norm(prompt))) continue;
        const rawOpts = rawList.slice(0, 6);
        const isOptRight = (o, idx) => (typeof o === 'object' && o ? (o.ok === true || o.correct === true) : false)
          || (Number.isInteger(block.answer) && block.answer === idx);
        const correctCount = rawOpts.filter((o, idx) => isOptRight(o, idx)).length;
        if (correctCount !== 1) continue;
        const optTexts = new Set();
        const options = rawOpts.map((opt, idx) => {
          const right = isOptRight(opt, idx);
          let txt = String(typeof opt === 'string' ? opt : (opt?.text || opt?.label || '')).trim();
          while (optTexts.has(norm(txt))) txt = `${txt} (${idx + 1})`;
          optTexts.add(norm(txt));
          const whyText = (typeof opt === 'object' && opt ? (opt.why || opt.feedback || opt.explanation) : '') || block.why || block.explanation || '';
          return {
            id: String.fromCharCode(97 + idx),
            text: txt,
            correct: right,
            explanation: String(whyText || (right ? 'Correct' : 'Incorrect')).trim(),
          };
        });
        const winner = options.find(o => o.correct);
        usedPrompts.add(norm(prompt));
        const quote = safeQuoteFrom(source.text, [`Self-Check**: ${prompt}`, `自测问题**：${prompt}`, winner.explanation, prompt]);
        cards.push({
          id: `shc-${companionId}-check-${checkIndex}`,
          kind: 'quiz',
          topic,
          objective: uniqueObj(isEn ? `[${lesson.title} · Check ${checkIndex + 1}] ${prompt}` : `[${lesson.title} · 边界自测 ${checkIndex + 1}] ${prompt}`),
          prompt,
          answer: winner.text,
          options,
          hint: isEn ? `Think back to the boundary case on ${visualRef.label}.` : `结合「${visualRef.label}」里的反例边界来排除干扰项。`,
          explanation: winner.explanation,
          misconception: options.find(o => !o.correct)?.explanation || commonMisconception,
          citations: [{ sourceId: source.id, quote }],
          companionRef: { companionId, anchor: `#${slideNum}`, slide: slideNum, label: isEn ? `Slide ${slideNum} · Check` : `第 ${slideNum} 页 · 边界小测`, slot: `check:${checkIndex}` },
          grounded,
        });
        checkIndex++;
      } else if (block.t === 'say' && Array.isArray(block.points) && block.points.length >= 2) {
        const prompt = String(block.prompt || '').trim();
        const answer = String(block.model || block.sample || '').trim();
        if (!prompt || !answer || usedPrompts.has(norm(prompt))) continue;
        usedPrompts.add(norm(prompt));
        const pts = block.points.slice(0, 6).map(p => String(p).trim()).filter(Boolean);
        const marks = pts.length * 2;
        const rubricCriteria = pts.map((pt, idx) => ({
          id: `c${idx + 1}`,
          label: isEn ? `Point ${idx + 1}` : `要点 ${idx + 1}`,
          marks: 2,
          descriptor: pt,
          keyPoints: [pt],
        }));
        const rubric = pts.map((pt, idx) => `${idx + 1}. ${pt}`).join('\n');
        const quote = safeQuoteFrom(source.text, [`Oral Synthesis**: ${prompt}`, `口述演练**：${prompt}`, answer, pts[0]]);
        cards.push({
          id: `shc-${companionId}-say-${sayIndex}`,
          kind: 'open',
          topic,
          objective: uniqueObj(isEn ? `[${lesson.title} · Oral Synthesis] ${prompt}` : `[${lesson.title} · 开口讲透] ${prompt}`),
          prompt,
          answer,
          marks,
          rubric,
          rubricCriteria,
          hint: isEn ? `Cover all ${pts.length} structural links from cause to trade-off.` : `按「现象 → 底层原因 → 解决方案与取舍」覆盖 ${pts.length} 个得分点。`,
          explanation: answer,
          misconception: commonMisconception,
          citations: [{ sourceId: source.id, quote }],
          companionRef: { companionId, anchor: visualRef.anchor, slide: visualRef.slide, label: visualRef.label, slot: `say:${sayIndex}` },
          grounded,
        });
        sayIndex++;
      } else if (isHandsOnDrillBlock(block)) {
        const rawPrompt = String(block.prompt || block.goal || block.mission || '').trim();
        const blockTitle = String(block.title || '').trim();
        const prompt = blockTitle && !rawPrompt.includes(blockTitle)
          ? `[${blockTitle}] ${rawPrompt}`
          : rawPrompt;
        if (!prompt || usedPrompts.has(norm(prompt))) continue;

        const rubricCriteria = normalizeDrillCriteria(block.criteria || block.steps || block.points, isEn);
        if (!rubricCriteria.length) continue;

        const marks = rubricCriteria.reduce((sum, c) => sum + c.marks, 0);
        const rubric = rubricCriteria.map((c, idx) => `${idx + 1}. ${c.label}${isEn ? ': ' : '：'}${c.descriptor}`).join('\n');
        const answer = String(block.solution || block.model || block.goodCode || rubricCriteria.map(c => c.keyPoints[0]).join(isEn ? '; ' : '；')).trim();
        if (!answer) continue;

        let hint = isEn
          ? `Inspect Slide ${slideNum} (${clip(slide.title, 32)}) and verify each acceptance criterion statically.`
          : `打开第 ${slideNum} 页「${clip(slide.title, 24)}」，逐条对照验收标准检查实现细节。`;
        if (norm(hint) === norm(answer)) hint = `${hint} (${rubricCriteria.length})`;

        usedPrompts.add(norm(prompt));
        const quote = safeQuoteFrom(source.text, [rawPrompt, rubricCriteria[0].descriptor, answer]);
        cards.push({
          id: `shc-${companionId}-task-${taskIndex}`,
          kind: 'task',
          topic: clip(blockTitle || topic, 60),
          objective: uniqueObj(isEn ? `[${lesson.title} · Hands-On ${taskIndex + 1}] ${prompt}` : `[${lesson.title} · 动手任务 ${taskIndex + 1}] ${prompt}`),
          prompt,
          answer,
          marks,
          rubric,
          rubricCriteria,
          hint,
          explanation: answer,
          misconception: String(block.misconception || block.pitfall || commonMisconception).trim(),
          citations: [{ sourceId: source.id, quote }],
          companionRef: {
            companionId,
            anchor: `#${slideNum}`,
            slide: slideNum,
            label: isEn ? `Slide ${slideNum} · Hands-On Task` : `第 ${slideNum} 页 · 动手实操`,
            slot: `task:${taskIndex}`,
          },
          grounded,
        });
        taskIndex++;
      } else if (
        emitCaseCards
        && block.t === 'cases'
        && Array.isArray(block.tools)
        && block.tools.length >= 2
        && Array.isArray(block.items)
        && block.items.length >= 3
      ) {
        const rawTools = block.tools.slice(0, 6).map(t => String(t || '').trim()).filter(Boolean);
        if (rawTools.length < 2) continue;
        for (const item of block.items.slice(0, 3)) {
          const scenarioText = String(item?.text || '').trim();
          const whyText = String(item?.why || '').trim();
          if (!scenarioText || !whyText || !Number.isInteger(item.answer) || item.answer < 0 || item.answer >= rawTools.length) continue;

          const prompt = decideOnSlide?.q
            ? `${scenarioText} — ${String(decideOnSlide.q).trim()}`
            : (isEn ? `Which approach best fits this scenario: ${scenarioText}` : `针对该场景应优先选择哪种方案：${scenarioText}`);
          if (usedPrompts.has(norm(prompt))) continue;

          const optTexts = new Set();
          const options = rawTools.map((tool, tIdx) => {
            let txt = tool;
            while (optTexts.has(norm(txt))) txt = `${txt} (${tIdx + 1})`;
            optTexts.add(norm(txt));
            const branch = decideOnSlide?.branches?.find(br => String(br?.pick || '').trim().toLowerCase() === tool.toLowerCase());
            const distractorWhy = branch?.when
              ? (isEn ? `Fits when "${branch.when}"; here: ${whyText}` : `适用于「${branch.when}」；而本题场景：${whyText}`)
              : whyText;
            return {
              id: String.fromCharCode(97 + tIdx),
              text: txt,
              correct: tIdx === item.answer,
              explanation: tIdx === item.answer ? whyText : distractorWhy,
            };
          });

          // `quiz` kind requires 3..6 options; synthesize a clean 3rd distractor when `cases.tools` is binary
          if (options.length === 2) {
            let thirdText = isEn ? 'Neither — both violate the governing constraint' : '以上两种皆不适用（违背核心判据）';
            while (optTexts.has(norm(thirdText))) thirdText = `${thirdText} (3)`;
            optTexts.add(norm(thirdText));
            options.push({
              id: 'c',
              text: thirdText,
              correct: false,
              explanation: whyText,
            });
          }

          const winner = options.find(o => o.correct);
          if (!winner) continue;
          usedPrompts.add(norm(prompt));
          const quote = safeQuoteFrom(source.text, [scenarioText, whyText]);
          cards.push({
            id: `shc-${companionId}-case-${caseIndex}`,
            kind: 'quiz',
            topic,
            objective: uniqueObj(isEn ? `[${lesson.title} · Case ${caseIndex + 1}] ${scenarioText}` : `[${lesson.title} · 实战选型 ${caseIndex + 1}] ${scenarioText}`),
            prompt,
            answer: winner.text,
            options,
            hint: decideOnSlide?.q
              ? (isEn ? `Apply the decision rule: ${decideOnSlide.q}` : `套用本课决策判准：${decideOnSlide.q}`)
              : (isEn ? `Check the decision branches on Slide ${slideNum}.` : `对照第 ${slideNum} 页决策树的分支判据。`),
            explanation: whyText,
            misconception: commonMisconception,
            citations: [{ sourceId: source.id, quote }],
            companionRef: {
              companionId,
              anchor: `#${slideNum}`,
              slide: slideNum,
              label: isEn ? `Slide ${slideNum} · Decision Cases` : `第 ${slideNum} 页 · 实战选型`,
              slot: `case:${caseIndex}`,
            },
            grounded,
          });
          caseIndex++;
        }
      }
    }
  }

  const validCards = cards.filter(card => {
    const check = validateDeck({ title: lesson.title, cards: [card] }, [source]);
    return check.errors.length === 0;
  });

  return validCards;
}

/** Build high-confidence anchor terms for ADR-3 zero-token card matching (never loose single words). */
export function highConfidenceTermsOf(rawLesson) {
  const lesson = detokenizeLesson(rawLesson);
  const phrases = new Set();
  const add = raw => {
    const clean = String(raw || '')
      .replace(/\$[^$]*\$/g, '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .trim();
    if (!clean) return;
    const lower = clean.toLowerCase();
    if (GENERIC_TERMS.has(lower)) return;
    const isAscii = /^[\x20-\x7e]+$/.test(clean);
    if (isAscii && clean.length < 4) return;
    if (!isAscii && clean.length < 3) return;
    phrases.add(lower);
  };
  for (const slide of lesson.slides || []) {
    for (const block of slide.blocks || []) {
      if (block.t === 'name') {
        add(block.term);
        if (block.alias) for (const part of String(block.alias).split(/[,/，、;；]/)) add(part);
      }
    }
  }
  for (const term of Object.keys(lesson.terms || {})) add(term);
  return [...phrases];
}

/** ADR-3: Attach `companionRef` only to high-confidence matching cards in existing decks of the course. */
export function matchHighConfidenceCards(state, { course, companionId, lesson }) {
  const phrases = highConfidenceTermsOf(lesson);
  if (!phrases.length) return 0;
  const index = courseIndex(state);
  const targetCourseId = index.resolve(course)?.id;
  if (!targetCourseId) return 0;
  const visual = primaryInteractiveSlide(lesson, inferLessonLanguage(lesson));
  let matched = 0;

  for (const deck of state.decks || []) {
    if (deck.archived || deck.systemKind || courseIdOf(deck, index) !== targetCourseId) continue;
    for (const card of deck.cards || []) {
      if (card.companionRef && card.companionRef.manual) continue;
      const haystack = `${card.topic || ''} ${card.prompt || ''}`.toLowerCase();
      const hits = phrases.filter(p => haystack.includes(p));
      if (hits.length >= 1 && (hits.some(h => h.length >= 5) || hits.length >= 2)) {
        if (!card.companionRef) {
          card.companionRef = { companionId, anchor: visual.anchor, slide: visual.slide, label: visual.label };
          matched++;
        }
      }
    }
  }
  return matched;
}

const quizKeySignature = card => JSON.stringify((card.options || []).map(o => [o.id, Boolean(o.correct)]));

/** Explicitly link targeted cards (e.g. stubborn cards that launched a rescue companion) to the companion. */
export function linkTargetCards(state, { companionId, lesson, targetCardIds = [] }) {
  const ids = new Set((Array.isArray(targetCardIds) ? targetCardIds : []).map(id => (typeof id === 'string' ? id.trim() : '')).filter(Boolean));
  if (!ids.size || !companionId) return 0;
  const lang = inferLessonLanguage(lesson);
  const isRescue = lesson?.mode === 'rescue';
  const target = isRescue
    ? { slide: 1, anchor: '#1', label: lang === 'en' ? 'Slide 1 · Rescue lab' : '第 1 页 · 急救实验' }
    : primaryInteractiveSlide(lesson, lang);
  const hid = typeof lesson?.hid === 'string' && lesson.hid.trim() ? lesson.hid.trim() : '';
  let linked = 0;
  for (const deck of state.decks || []) {
    if (deck.archived || deck.systemKind) continue;
    for (const card of deck.cards || []) {
      if (!ids.has(card.id)) continue;
      card.companionRef = {
        companionId,
        anchor: target.anchor,
        slide: target.slide,
        label: target.label,
        ...(isRescue ? { mode: 'rescue' } : {}),
        ...(hid ? { hid } : {}),
      };
      linked++;
    }
  }
  return linked;
}

/**
 * Sync a `studyhub-lesson/1` companion into `state` (inside one store transaction).
 * Implements ADR-2 (`enrich-existing` vs `full-pack`) and 3-tier FSRS schedule preservation.
 */
export function syncLessonIntoState(state, { course, companionId, lesson, mountMode = 'auto', grounded = true, includeCaseCards, targetCardIds }) {
  const targetCourse = (course || lesson.course || '').trim();
  const isEn = inferLessonLanguage(lesson) === 'en';
  const provenance = grounded ? 'independent-source' : 'ai-drafted-unverified';
  const projected = projectLessonSource(lesson, { companionId, course: targetCourse, provenance });

  const existingSource = state.sources.find(s => s.id === projected.id);
  if (existingSource) {
    delete existingSource.archived;
    delete existingSource.archivedAt;
    existingSource.title = projected.title;
    existingSource.text = projected.text;
    existingSource.provenance = projected.provenance;
    existingSource.companionId = companionId;
    if (targetCourse) existingSource.courses = [...new Set([...(existingSource.courses || []), targetCourse])];
  } else {
    state.sources.push({ createdAt: new Date().toISOString(), ...projected });
  }

  const explicitTargetIds = Array.isArray(targetCardIds) && targetCardIds.length
    ? targetCardIds
    : (Array.isArray(lesson?.targetCardIds) ? lesson.targetCardIds : []);
  const targetLinked = explicitTargetIds.length
    ? linkTargetCards(state, { companionId, lesson, targetCardIds: explicitTargetIds })
    : 0;

  const index = courseIndex(state);
  const courseEntity = targetCourse ? index.resolve(targetCourse) : null;
  const catchupTitles = new Set(['伴学拾遗', 'companion catch-ups']);
  const hasExistingDecks = Boolean(courseEntity && (state.decks || []).some(deck =>
    !deck.archived && !deck.systemKind && courseIdOf(deck, index) === courseEntity.id
    && !deck.companionDeck && !catchupTitles.has(String(deck.title || '').trim().toLowerCase())));

  const resolvedMode = mountMode === 'auto'
    ? (lesson?.mode === 'rescue' ? 'companion-only' : (hasExistingDecks ? 'enrich-existing' : 'full-pack'))
    : mountMode;
  if (resolvedMode === 'companion-only') {
    return { sourceId: projected.id, mode: 'companion-only', cardsAdded: 0, cardsUpdated: 0, cardsLinked: targetLinked, deckId: null };
  }

  const compiledCards = compileLessonCards(lesson, {
    source: existingSource || projected,
    companionId,
    grounded,
    includeCaseCards,
  });

  if (resolvedMode === 'enrich-existing') {
    const linked = targetLinked + (targetCourse ? matchHighConfidenceCards(state, { course: targetCourse, companionId, lesson }) : 0);
    const oralCards = compiledCards.filter(c => c.kind === 'open' || c.kind === 'task');
    let added = 0;
    let deckId = null;
    if (oralCards.length) {
      let supDeck = (state.decks || []).find(d => !d.archived && d.companionSupplementFor === (courseEntity?.id || targetCourse));
      if (!supDeck) {
        supDeck = {
          id: `deck-comp-sup-${makeId()}`,
          title: isEn ? `${targetCourse || lesson.title} · Oral & Lab Drills` : `${targetCourse || lesson.title} · 伴学口述与演练`,
          course: targetCourse,
          folder: targetCourse,
          companionDeck: true,
          companionSupplementFor: courseEntity?.id || targetCourse,
          createdAt: new Date().toISOString(),
          cards: [],
        };
        state.decks.push(supDeck);
      }
      deckId = supDeck.id;
      for (const nextCard of oralCards) {
        const cur = supDeck.cards.find(c => c.id === nextCard.id);
        if (!cur) {
          supDeck.cards.push({ ...nextCard, review: initialReview(state.settings) });
          added++;
        } else {
          Object.assign(cur, { ...nextCard, review: cur.review, revisions: cur.revisions });
        }
      }
    }
    return { sourceId: projected.id, mode: 'enrich-existing', cardsAdded: added, cardsUpdated: 0, cardsLinked: linked, deckId };
  }

  // `full-pack`: create or sync dedicated lesson deck with 3-tier FSRS preservation (#1367-5)
  const deterministicDeckId = `deck-comp-${companionId}`;
  const existingDeck = (state.decks || []).find(d => d.companionId === companionId || d.id === deterministicDeckId);
  let deck = null;
  if (existingDeck) {
    if (!existingDeck.archived) {
      existingDeck.companionDeck = true;
      existingDeck.companionId = companionId;
      if (targetCourse && !existingDeck.course) {
        existingDeck.course = targetCourse;
        existingDeck.folder = targetCourse;
      }
      deck = existingDeck;
    }
    // If existingDeck is explicitly archived, never push a duplicate deck with the same id.
  } else if (compiledCards.length) {
    deck = {
      id: deterministicDeckId,
      title: lesson.title,
      course: targetCourse,
      folder: targetCourse,
      companionDeck: true,
      companionId,
      createdAt: new Date().toISOString(),
      cards: [],
    };
    state.decks.push(deck);
  }

  let added = 0;
  let updated = 0;
  if (deck) {
    const usedCardIds = new Set((state.decks || []).flatMap(d => (d.cards || []).map(c => c.id)));
    for (const nextCard of compiledCards) {
      const existing = deck.cards.find(c => c.id === nextCard.id);
      if (!existing) {
        let cardId = nextCard.id;
        if (usedCardIds.has(cardId)) {
          do { cardId = `${nextCard.id}-${makeId().slice(0, 6)}`; } while (usedCardIds.has(cardId));
        }
        usedCardIds.add(cardId);
        deck.cards.push({ ...nextCard, id: cardId, review: initialReview(state.settings) });
        added++;
      } else {
        const keyFlipped = existing.kind === 'quiz' && nextCard.kind === 'quiz' && quizKeySignature(existing) !== quizKeySignature(nextCard);
        const preservedReview = keyFlipped ? initialReview(state.settings) : existing.review;
        const idx = deck.cards.indexOf(existing);
        deck.cards[idx] = {
          ...existing,
          ...nextCard,
          review: preservedReview,
          ...(existing.followups ? { followups: existing.followups } : {}),
          ...(existing.requires ? { requires: existing.requires } : {}),
        };
        updated++;
      }
    }

    // Wire lesson `needs` into prerequisite graph when matching prerequisite lesson cards exist in the course
    if (Array.isArray(lesson.needs) && lesson.needs.length && deck.cards.length) {
      const entryCard = deck.cards[0];
      for (const needText of lesson.needs.slice(0, 6)) {
        const cleanNeed = String(needText).replace(/（第[^）]*）/g, '').trim().toLowerCase();
        if (cleanNeed.length < 3) continue;
        const prereqDeck = (state.decks || []).find(d => d.id !== deck.id && !d.archived && courseKey(d.course) === courseKey(targetCourse)
          && (String(d.title || '').toLowerCase().includes(cleanNeed) || (d.cards || []).some(c => String(c.topic || '').toLowerCase().includes(cleanNeed))));
        const prereqCard = prereqDeck?.cards?.[0];
        if (prereqDeck && prereqCard) {
          try { linkPrerequisite(state, { deckId: deck.id, cardId: entryCard.id }, { deckId: prereqDeck.id, cardId: prereqCard.id }); } catch { /* ignore cycle/cap */ }
        }
      }
    }
  }

  return { sourceId: projected.id, mode: 'full-pack', cardsAdded: added, cardsUpdated: updated, cardsLinked: compiledCards.length, deckId: deck?.id || null };
}

/** Round 3 Audit: Grant first-pass FSRS credit to untouched cards of a completed interactive lesson so the learner is not immediately re-quizzed on the same day. */
export function applyFirstPassCredit(state, { companionId, checkResults = {}, hadPriorProgress = true }, now = new Date()) {
  const stamp = typeof now === 'string' ? now : now.toISOString();
  const hasCheckCards = (state.decks || []).some(d =>
    !d.archived && !d.systemKind && (d.cards || []).some(c => c.companionRef?.companionId === companionId && String(c.companionRef?.slot || '').startsWith('check:')));
  // Guard against 1-hop jump straight to final slide without touching any intermediate slides or check quizzes
  if (hasCheckCards && Object.keys(checkResults || {}).length === 0 && !hadPriorProgress) {
    return 0;
  }

  let credited = 0;
  for (const deck of state.decks || []) {
    if (deck.archived || deck.systemKind) continue;
    for (const card of deck.cards || []) {
      const ref = card.companionRef;
      if (!ref || ref.companionId !== companionId) continue;
      if ((card.review?.reps || 0) > 0) continue;
      const slot = ref.slot || '';
      if (slot.startsWith('check:') && checkResults[slot] === false) continue;
      if (slot.startsWith('take:') || (slot.startsWith('check:') && checkResults[slot] === true)) {
        card.review = schedule(card.review || initialReview(state.settings), 4, stamp, state.settings);
        credited++;
      }
    }
  }
  return credited;
}

/** ADR-5: Save a confusion resolved in-lesson directly into the course's `伴学拾遗 / Companion Catch-ups` deck scheduled for next-day review. */
export function saveCompanionCatchupCard(state, {
  course, companionId, companionTitle = '', slide = 1, slideTitle = '',
  prompt, answer, misconception = '', quote = '', sourceId = '', language = 'zh',
}, now = new Date()) {
  const isEn = language === 'en';
  const targetCourse = String(course || state.focus?.course || '').trim();
  const deckTitle = isEn ? 'Companion Catch-ups' : '伴学拾遗';
  let deck = (state.decks || []).find(d => !d.archived && !d.systemKind && courseKey(d.course) === courseKey(targetCourse)
    && (d.companionCatchup === true || String(d.title || '').trim() === deckTitle));
  if (!deck) {
    deck = {
      id: `deck-catchup-${makeId()}`,
      title: deckTitle,
      course: targetCourse,
      folder: targetCourse,
      companionCatchup: true,
      createdAt: now.toISOString(),
      cards: [],
    };
    state.decks.push(deck);
  }

  let cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) throw new Error(isEn ? 'Question prompt is required' : '请填写防混卡的问题');
  while (deck.cards.some(c => norm(c.prompt) === norm(cleanPrompt))) {
    cleanPrompt = `${cleanPrompt} · Slide ${slide}`;
  }
  const cleanAnswer = String(answer || '').trim();
  if (!cleanAnswer) throw new Error(isEn ? 'Answer is required' : '请填写防混卡的解答');

  const source = sourceId ? (state.sources || []).find(s => s.id === sourceId) : null;
  const citations = [];
  if (source) {
    const matchedQuote = safeQuoteFrom(source.text, [quote, slideTitle, companionTitle]);
    if (matchedQuote && quoteFound(source.text, matchedQuote)) {
      citations.push({ sourceId: source.id, quote: matchedQuote });
    }
  }

  const cardId = `card-catchup-${makeId()}`;
  const label = isEn
    ? `Slide ${slide}${slideTitle ? ` · ${clip(slideTitle, 28)}` : ''}`
    : `第 ${slide} 页${slideTitle ? ` · ${clip(slideTitle, 24)}` : ''}`;

  const stamp = typeof now === 'string' ? now : now.toISOString();
  const nextDayReview = schedule(initialReview(state.settings), 3, stamp, state.settings);
  const card = {
    id: cardId,
    kind: 'flashcard',
    topic: clip(slideTitle || companionTitle || deckTitle, 60),
    objective: `[${cardId}] ${clip(cleanPrompt, 110)}`,
    prompt: cleanPrompt,
    answer: cleanAnswer,
    hint: isEn ? `Think back to the distinction clarified on ${label}.` : `回想在「${label}」厘清的易混边界。`,
    explanation: cleanAnswer,
    misconception: String(misconception || '').trim() || (isEn ? 'Blurred boundary encountered during interactive study.' : '看交互伴学页时曾混淆的关键边界。'),
    citations,
    companionRef: { companionId, anchor: `#${slide}`, slide, label, manual: true },
    grounded: citations.length > 0,
    review: nextDayReview,
  };

  deck.cards.push(card);
  return { deckId: deck.id, deckTitle: deck.title, cardId: card.id, card };
}

/* ---------- Deterministic Pre-Repair & Scientific Sandbox Math Expression Normalizer ---------- */

const normToolKey = value => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');

function resolveCanonicalTool(rawPick, tools) {
  if (typeof rawPick !== 'string' || !Array.isArray(tools) || !tools.length) return null;
  if (tools.includes(rawPick)) return { tool: rawPick, changed: false };
  const trimmed = rawPick.trim();
  if (!trimmed) return null;
  if (tools.includes(trimmed)) return { tool: trimmed, changed: true };

  const lower = trimmed.toLowerCase();
  const ciHit = tools.find(t => typeof t === 'string' && t.trim().toLowerCase() === lower);
  if (ciHit) return { tool: ciHit, changed: true };

  const key = normToolKey(trimmed);
  if (key) {
    const keyHits = tools.filter(t => typeof t === 'string' && normToolKey(t) === key);
    if (keyHits.length === 1) return { tool: keyHits[0], changed: true };
  }

  if (trimmed.length >= 3) {
    const subHits = tools.filter(t => {
      if (typeof t !== 'string') return false;
      const tl = t.trim().toLowerCase();
      return tl.includes(lower) || lower.includes(tl);
    });
    if (subHits.length === 1) return { tool: subHits[0], changed: true };
  }
  return null;
}

function clampOffByOneLines(lines, lineCount, fixes, label) {
  if (!Array.isArray(lines) || lineCount < 1) return lines;
  const out = [];
  for (const raw of lines) {
    const coerced = typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
    if (!Number.isInteger(coerced)) {
      out.push(coerced);
      continue;
    }
    if (coerced === 0) {
      out.push(1);
      fixes.push(`${label}: clamped 0 -> 1`);
    } else if (coerced === lineCount + 1) {
      out.push(lineCount);
      fixes.push(`${label}: clamped ${coerced} -> ${lineCount}`);
    } else {
      out.push(coerced);
      if (coerced !== raw) fixes.push(`${label}: coerced string line "${raw}" -> ${coerced}`);
    }
  }
  return [...new Set(out)];
}

/**
 * Normalize common scientific LLM syntax quirks in `sandbox` expressions (`expr`, `xExpr`, `yExpr`, `dxExpr`, `dyExpr`):
 * Unicode minus/multiply/divide/pi/superscripts, `$...$` wrappers, `y = ...` prefixes, `Math.*` / `np.*` / `math.*` calls,
 * and LaTeX `\frac` / `\sqrt` / `\cdot` / `\times` / `\sin` tokens into pure `math-eval.js` syntax.
 */
export function normalizeSandboxMathExpr(rawExpr) {
  if (typeof rawExpr !== 'string') return rawExpr;
  let expr = rawExpr.trim();
  if (!expr) return expr;

  // Strip accidental `$...$` or `` `...` `` wrappers
  const dollarWrap = /^\$\$?([^$]+)\$\$?$/.exec(expr);
  if (dollarWrap) expr = dollarWrap[1].trim();
  const tickWrap = /^`([^`]+)`$/.exec(expr);
  if (tickWrap) expr = tickWrap[1].trim();

  // Strip accidental LHS assignment prefix like `y = ...`, `x(t) = ...`, or `dx/dt = ...`
  expr = expr
    .replace(/^\s*d[A-Za-z_]\w*\s*\/\s*d[A-Za-z_]\w*\s*=\s*(?!=)/, '')
    .replace(/^\s*[A-Za-z_]\w*(?:\s*\(\s*[A-Za-z_]\w*\s*\))?\s*=\s*(?!=)/, '');

  // Convert simple LaTeX `\frac{a}{b}`, `\sqrt{a}`, `\left(`, `\right)`, `\cdot`, `\times`, `\pi`
  for (let pass = 0; pass < 2; pass++) {
    expr = expr.replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '(($1)/($2))');
    expr = expr.replace(/\\sqrt\s*\{([^{}]+)\}/g, 'sqrt($1)');
  }
  expr = expr
    .replace(/\\left\s*\(/g, '(')
    .replace(/\\right\s*\)/g, ')')
    .replace(/\\(?:cdot|times)\b/g, '*')
    .replace(/\\div\b/g, '/')
    .replace(/\\pi\b/g, 'pi')
    .replace(/\\tau\b/g, 'tau')
    .replace(/\\(arcsin|arccos|arctan|sin|cos|tan|sec|csc|cot|asin|acos|atan|sinh|cosh|tanh|exp|ln|log|sqrt|min|max)\b/g, '$1')
    .replace(/\^\s*\{([^{}]+)\}/g, '^($1)');

  // Unicode operators, dashes, superscripts, and Greek constants
  expr = expr
    .replace(/[\u2212\u2010\u2011\u2012\u2013\u2014\uff0d]/g, '-')
    .replace(/[\u00d7\u00b7\u22c5\u2217\uff0a]/g, '*')
    .replace(/[\u00f7\u2215\uff0f]/g, '/')
    .replace(/＋/g, '+')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/，/g, ',')
    .replace(/\u207b\u00b9/g, '^(-1)')
    .replace(/\u00b2/g, '^2')
    .replace(/\u00b3/g, '^3')
    .replace(/\u2074/g, '^4')
    .replace(/(\d|\))\s*\u03c0/g, '$1*pi')
    .replace(/\u03c0/g, 'pi')
    .replace(/(\d|\))\s*\u03c4/g, '$1*tau')
    .replace(/\u03c4/g, 'tau');

  // JS `Math.*` and Python `np.*` / `numpy.*` / `math.*` constants and functions
  expr = expr
    .replace(/\bMath\.SQRT2\b/g, 'sqrt(2)')
    .replace(/\bMath\.SQRT1_2\b/g, '(1/sqrt(2))')
    .replace(/\bMath\.LN2\b/g, 'ln(2)')
    .replace(/\bMath\.LN10\b/g, 'ln(10)')
    .replace(/\bMath\.LOG2E\b/g, '(1/ln(2))')
    .replace(/\bMath\.LOG10E\b/g, '(1/ln(10))')
    .replace(/\b(?:Math|np|numpy|math)\.(?:PI|pi)\b/g, 'pi')
    .replace(/\b(?:Math|np|numpy|math)\.(?:E|e)\b/g, 'e')
    .replace(/\b(?:Math|np|numpy|math)\.(sin|cos|tan|sec|csc|cot|asin|acos|atan|atan2|arcsin|arccos|arctan|arctan2|sinh|cosh|tanh|exp|ln|log|log10|log2|sqrt|cbrt|hypot|abs|fabs|floor|ceil|round|sign|min|max|pow|erf)\s*\(/g, '$1(')
    .replace(/\barcsin\s*\(/g, 'asin(')
    .replace(/\barccos\s*\(/g, 'acos(')
    .replace(/\barctan2\s*\(/g, 'atan2(')
    .replace(/\barctan\s*\(/g, 'atan(')
    .replace(/\bsgn\s*\(/g, 'sign(')
    .replace(/\bfabs\s*\(/g, 'abs(');

  return expr.trim();
}

function trimOverlong(value, maxChars, fixes, label) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  fixes.push(`${label}: trimmed overlong text (${trimmed.length} -> ${maxChars})`);
  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Deterministically normalize trivial mechanical & scientific syntax glitches (off-by-one line indices,
 * Unicode/`Math.*` sandbox expressions, missing 1D `domain`/`xRange`/`steps`, `field.grid` clamping,
 * case-mismatched `decide.branches[].pick` vs `cases.tools`, duplicate `predict.id`s / `reveal.of` casing,
 * and overlong `beats`/`eyebrow`/`label` strings) BEFORE spending a Stage 3 model repair call.
 */
export function preRepairLessonWithReport(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { lesson: raw, fixes: [] };
  }
  const lesson = structuredClone(raw);
  const fixes = [];

  if (Array.isArray(lesson.beats)) {
    for (const beat of lesson.beats) {
      if (!beat || typeof beat !== 'object') continue;
      if (typeof beat.id === 'string') beat.id = beat.id.trim();
      if (typeof beat.label === 'string') beat.label = trimOverlong(beat.label, 36, fixes, `beat "${beat.id || '?'}" label`);
    }
  }

  const slides = Array.isArray(lesson.slides) ? lesson.slides : [];
  const seenPredictIds = new Set();
  const latestPredictByKey = new Map();
  const unrevealedPredicts = [];
  let predictSeq = 0;

  for (const [sIdx, slide] of slides.entries()) {
    if (!slide || typeof slide !== 'object' || !Array.isArray(slide.blocks)) continue;
    const sTag = `Slide ${sIdx + 1}`;
    if (typeof slide.title === 'string') slide.title = trimOverlong(slide.title, 160, fixes, `${sTag} title`);
    if (typeof slide.eyebrow === 'string') slide.eyebrow = trimOverlong(slide.eyebrow, 48, fixes, `${sTag} eyebrow`);

    for (const b of slide.blocks) {
      if (b && typeof b === 'object' && !b.t && typeof b.type === 'string') {
        b.t = b.type.trim();
        fixes.push(`${sTag}: mapped block.type "${b.t}" -> block.t`);
      }
    }

    const casesBlock = slide.blocks.find(b => b?.t === 'cases' && Array.isArray(b.tools) && b.tools.length >= 2);
    if (casesBlock) {
      casesBlock.tools = casesBlock.tools.map(t => (typeof t === 'string' ? t.trim() : t));
      if (Array.isArray(casesBlock.items) && casesBlock.items.length) {
        for (const it of casesBlock.items) {
          if (!it || typeof it !== 'object') continue;
          if (typeof it.answer === 'string') {
            if (/^\d+$/.test(it.answer.trim())) {
              it.answer = Number(it.answer.trim());
              fixes.push(`${sTag} cases: coerced string answer index`);
            } else {
              const matched = resolveCanonicalTool(it.answer, casesBlock.tools);
              if (matched) {
                it.answer = casesBlock.tools.indexOf(matched.tool);
                fixes.push(`${sTag} cases: mapped tool name "${matched.tool}" to index ${it.answer}`);
              }
            }
          }
        }
        const allOneBased = casesBlock.items.every(it => Number.isInteger(it?.answer) && it.answer >= 1 && it.answer <= casesBlock.tools.length)
          && casesBlock.items.some(it => it.answer === casesBlock.tools.length);
        if (allOneBased) {
          for (const it of casesBlock.items) it.answer -= 1;
          fixes.push(`${sTag} cases: shifted 1-based answer indices to 0-based`);
        }
      }
    }

    for (const [bIdx, block] of slide.blocks.entries()) {
      if (!block || typeof block !== 'object') continue;
      const bTag = `${sTag} block ${bIdx + 1} (${block.t || '?'})`;

      if ((block.t === 'spot' || block.t === 'code' || block.t === 'inside') && typeof block.source === 'string' && block.source.trim()) {
        const cleanedSource = block.source.replace(/\r\n/g, '\n').replace(/\n+$/, '');
        if (cleanedSource !== block.source) block.source = cleanedSource;
        const lineCount = block.source.split('\n').length;

        if (block.t === 'spot' && Array.isArray(block.answerLines)) {
          block.answerLines = clampOffByOneLines(block.answerLines, lineCount, fixes, `${bTag} answerLines`);
        }
        if (block.t === 'code') {
          if (Array.isArray(block.focusLines)) {
            block.focusLines = clampOffByOneLines(block.focusLines, lineCount, fixes, `${bTag} focusLines`);
          }
          if (Array.isArray(block.walk)) {
            for (const step of block.walk) {
              if (step && Array.isArray(step.focusLines)) {
                step.focusLines = clampOffByOneLines(step.focusLines, lineCount, fixes, `${bTag} walk.focusLines`);
              }
            }
          }
        }
        if (block.t === 'inside' && Array.isArray(block.walk)) {
          for (const step of block.walk) {
            if (!step || typeof step !== 'object') continue;
            if (typeof step.label === 'string') step.label = trimOverlong(step.label, 48, fixes, `${bTag} inside.label`);
            if (Array.isArray(step.focusLines)) {
              step.focusLines = clampOffByOneLines(step.focusLines, lineCount, fixes, `${bTag} inside.focusLines`);
            }
          }
        }
      }

      if (block.t === 'sandbox') {
        const xr = Array.isArray(block.xRange) && block.xRange.length >= 2 ? block.xRange : null;
        if (!block.domain || typeof block.domain !== 'object' || Array.isArray(block.domain)) {
          const dMin = xr && Number.isFinite(Number(xr[0])) ? Number(xr[0]) : 0;
          const dMax = xr && Number.isFinite(Number(xr[1])) && Number(xr[1]) > dMin ? Number(xr[1]) : dMin + 10;
          block.domain = { variable: 'x', min: dMin, max: dMax, steps: 80, label: 'x' };
          fixes.push(`${bTag}: initialized default sandbox.domain [${dMin}, ${dMax}]`);
        } else {
          if (typeof block.domain.variable !== 'string' || !block.domain.variable.trim()) {
            block.domain.variable = 'x';
            fixes.push(`${bTag}: defaulted sandbox.domain.variable -> "x"`);
          } else {
            block.domain.variable = block.domain.variable.trim();
          }
          if (!Number.isFinite(Number(block.domain.min))) {
            block.domain.min = xr && Number.isFinite(Number(xr[0])) ? Number(xr[0]) : 0;
            fixes.push(`${bTag}: repaired sandbox.domain.min`);
          } else {
            block.domain.min = Number(block.domain.min);
          }
          if (!Number.isFinite(Number(block.domain.max)) || Number(block.domain.max) <= block.domain.min) {
            block.domain.max = xr && Number.isFinite(Number(xr[1])) && Number(xr[1]) > block.domain.min ? Number(xr[1]) : block.domain.min + 10;
            fixes.push(`${bTag}: repaired sandbox.domain.max`);
          } else {
            block.domain.max = Number(block.domain.max);
          }
          const rawSteps = Number(block.domain.steps);
          const clampedSteps = Number.isFinite(rawSteps) && rawSteps > 0 ? Math.max(16, Math.min(240, Math.round(rawSteps))) : 80;
          if (block.domain.steps !== clampedSteps) {
            if (block.domain.steps !== undefined) fixes.push(`${bTag}: normalized sandbox.domain.steps -> ${clampedSteps}`);
            block.domain.steps = clampedSteps;
          }
        }

        const knobBounds = new Map();
        const knobBoundsByLower = new Map();
        if (Array.isArray(block.knobs)) {
          for (const [kIdx, knob] of block.knobs.entries()) {
            if (!knob || typeof knob !== 'object') continue;
            knob.id = typeof knob.id === 'string' && knob.id.trim() ? knob.id.trim() : `k${kIdx + 1}`;
            const hasMin = knob.min !== undefined && knob.min !== null && knob.min !== '' && Number.isFinite(Number(knob.min));
            const hasMax = knob.max !== undefined && knob.max !== null && knob.max !== '' && Number.isFinite(Number(knob.max));
            let kMin = hasMin ? Number(knob.min) : 0;
            let kMax = hasMax ? Number(knob.max) : kMin + 1;
            if (hasMin && hasMax && kMin > kMax) {
              [kMin, kMax] = [kMax, kMin];
              fixes.push(`${bTag}: swapped inverted min/max on knob "${knob.id}" -> [${kMin}, ${kMax}]`);
            } else if (kMax <= kMin) {
              kMax = kMin + 1;
              fixes.push(`${bTag}: expanded degenerate max on knob "${knob.id}" -> [${kMin}, ${kMax}]`);
            } else if (knob.min !== kMin || knob.max !== kMax) {
              fixes.push(`${bTag}: normalized knob "${knob.id}" min/max`);
            }
            knob.min = kMin;
            knob.max = kMax;

            if ((knob.default === undefined || knob.default === null || knob.default === '')
              && knob.value !== undefined && knob.value !== null && knob.value !== '' && Number.isFinite(Number(knob.value))) {
              knob.default = Number(knob.value);
              fixes.push(`${bTag}: mapped knob "${knob.id}" value -> default`);
            }
            const hasDef = knob.default !== undefined && knob.default !== null && knob.default !== '' && Number.isFinite(Number(knob.default));
            const rawDef = hasDef ? Number(knob.default) : kMin;
            const kDef = Math.min(kMax, Math.max(kMin, rawDef));
            if (!hasDef) {
              fixes.push(`${bTag}: defaulted knob "${knob.id}" default -> ${kDef}`);
            } else if (kDef !== rawDef) {
              fixes.push(`${bTag}: clamped knob "${knob.id}" default ${rawDef} -> ${kDef}`);
            }
            knob.default = kDef;

            if (knob.step !== undefined && Number.isFinite(Number(knob.step)) && Number(knob.step) > 0) {
              knob.step = Number(knob.step);
            }
            const boundEntry = { id: knob.id, min: kMin, max: kMax };
            knobBounds.set(knob.id, boundEntry);
            knobBoundsByLower.set(knob.id.toLowerCase(), boundEntry);
          }
        }

        if (block.presets !== undefined && block.presets !== null) {
          if (!Array.isArray(block.presets) && typeof block.presets === 'object') {
            block.presets = Object.entries(block.presets).map(([label, values]) => ({ label, values }));
            fixes.push(`${bTag}: converted sandbox.presets map -> array`);
          }
          if (Array.isArray(block.presets)) {
            const cleanedPresets = [];
            for (const [pIdx, pr] of block.presets.entries()) {
              if (!pr || typeof pr !== 'object' || Array.isArray(pr)) {
                fixes.push(`${bTag}: dropped non-object sandbox.presets[${pIdx}]`);
                continue;
              }
              if ((!pr.label || !String(pr.label).trim()) && typeof (pr.name || pr.title) === 'string' && String(pr.name || pr.title).trim()) {
                pr.label = String(pr.name || pr.title).trim();
                fixes.push(`${bTag}: mapped sandbox.presets[${pIdx}] name/title -> label`);
              }
              const label = typeof pr.label === 'string' ? trimOverlong(pr.label, 48, fixes, `${bTag} preset.label`) : '';
              const rawValues = (pr.values && typeof pr.values === 'object' && !Array.isArray(pr.values))
                ? pr.values
                : (pr.set && typeof pr.set === 'object' && !Array.isArray(pr.set))
                  ? pr.set
                  : null;
              if (pr.values === undefined && rawValues) {
                fixes.push(`${bTag}: mapped sandbox.presets[${pIdx}].set -> values`);
              }
              if (!label || /^(?:todo|tbd|placeholder|\.{3,}|待补充|略|此处略)$/i.test(label) || !rawValues) {
                fixes.push(`${bTag}: dropped invalid/empty sandbox.presets[${pIdx}]`);
                continue;
              }
              const nextValues = {};
              for (const [rawKey, rawVal] of Object.entries(rawValues)) {
                const target = knobBounds.get(rawKey) || knobBoundsByLower.get(rawKey.trim().toLowerCase());
                if (!target) {
                  fixes.push(`${bTag} preset "${label}": dropped unknown knob "${rawKey}"`);
                  continue;
                }
                if (rawVal === '' || rawVal === null || rawVal === undefined || !Number.isFinite(Number(rawVal))) {
                  fixes.push(`${bTag} preset "${label}": dropped non-numeric value for "${target.id}"`);
                  continue;
                }
                const num = Number(rawVal);
                const clamped = Math.min(target.max, Math.max(target.min, num));
                if (target.id !== rawKey) {
                  fixes.push(`${bTag} preset "${label}": aligned knob key "${rawKey}" -> "${target.id}"`);
                }
                if (clamped !== num) {
                  fixes.push(`${bTag} preset "${label}": clamped "${target.id}" ${num} -> ${clamped}`);
                }
                nextValues[target.id] = clamped;
              }
              if (!Object.keys(nextValues).length) {
                fixes.push(`${bTag}: dropped empty preset "${label}"`);
                continue;
              }
              cleanedPresets.push({ ...pr, label, values: nextValues });
            }
            block.presets = cleanedPresets;
          }
        }

        if (Array.isArray(block.series)) {
          for (const [srIdx, sr] of block.series.entries()) {
            if (!sr || typeof sr !== 'object') continue;
            sr.id ||= `s${srIdx + 1}`;
            sr.label = typeof sr.label === 'string' && sr.label.trim() ? trimOverlong(sr.label, 64, fixes, `${bTag} series.label`) : sr.id;
            for (const exprKey of ['expr', 'xExpr', 'yExpr']) {
              if (typeof sr[exprKey] === 'string') {
                const normExpr = normalizeSandboxMathExpr(sr[exprKey]);
                if (normExpr !== sr[exprKey]) {
                  fixes.push(`${bTag} series.${exprKey}: normalized math syntax`);
                  sr[exprKey] = normExpr;
                }
              }
            }
          }
        }

        if (block.field && typeof block.field === 'object' && !Array.isArray(block.field)) {
          for (const boundKey of ['xMin', 'xMax', 'yMin', 'yMax']) {
            if (typeof block.field[boundKey] === 'string' && Number.isFinite(Number(block.field[boundKey]))) {
              block.field[boundKey] = Number(block.field[boundKey]);
            }
          }
          const rawGrid = Number(block.field.grid);
          const clampedGrid = Number.isFinite(rawGrid) && rawGrid > 0 ? Math.max(4, Math.min(24, Math.round(rawGrid))) : 12;
          if (block.field.grid !== clampedGrid) {
            if (block.field.grid !== undefined) fixes.push(`${bTag} field.grid: clamped ${block.field.grid} -> ${clampedGrid}`);
            block.field.grid = clampedGrid;
          }
          for (const exprKey of ['dxExpr', 'dyExpr']) {
            if (typeof block.field[exprKey] === 'string') {
              const normExpr = normalizeSandboxMathExpr(block.field[exprKey]);
              if (normExpr !== block.field[exprKey]) {
                fixes.push(`${bTag} field.${exprKey}: normalized math syntax`);
                block.field[exprKey] = normExpr;
              }
            }
          }
        }

        if (Array.isArray(block.markers)) {
          for (const [mIdx, mk] of block.markers.entries()) {
            if (!mk || typeof mk !== 'object') continue;
            mk.id ||= `marker-${mIdx + 1}`;
            mk.label = typeof mk.label === 'string' && mk.label.trim() ? trimOverlong(mk.label, 48, fixes, `${bTag} marker.label`) : mk.id;
            for (const exprKey of ['xExpr', 'yExpr']) {
              if (typeof mk[exprKey] === 'string') {
                const normExpr = normalizeSandboxMathExpr(mk[exprKey]);
                if (normExpr !== mk[exprKey]) {
                  fixes.push(`${bTag} markers.${exprKey}: normalized math syntax`);
                  mk[exprKey] = normExpr;
                }
              }
            }
          }
        }

        if (Array.isArray(block.readouts)) {
          for (const [rIdx, rd] of block.readouts.entries()) {
            if (!rd || typeof rd !== 'object') continue;
            rd.id ||= `r${rIdx + 1}`;
            if (typeof rd.label === 'string') rd.label = trimOverlong(rd.label, 64, fixes, `${bTag} readout.label`);
            if (typeof rd.expr === 'string') {
              const normExpr = normalizeSandboxMathExpr(rd.expr);
              if (normExpr !== rd.expr) {
                fixes.push(`${bTag} readouts.expr: normalized math syntax`);
                rd.expr = normExpr;
              }
            }
          }
        }
      }

      if (block.t === 'decide' && Array.isArray(block.branches) && casesBlock) {
        for (const br of block.branches) {
          if (!br || typeof br.pick !== 'string') continue;
          const resolved = resolveCanonicalTool(br.pick, casesBlock.tools);
          if (resolved && resolved.changed) {
            fixes.push(`${bTag}: aligned branch.pick "${br.pick}" -> "${resolved.tool}"`);
            br.pick = resolved.tool;
          }
        }
      }

      if (block.t === 'predict') {
        predictSeq++;
        const rawId = typeof block.id === 'string' ? block.id.trim() : '';
        let nextId = rawId || `pred-${predictSeq}`;
        if (seenPredictIds.has(nextId)) {
          let suffix = 2;
          while (seenPredictIds.has(`${nextId}-${suffix}`)) suffix++;
          const deduped = `${nextId}-${suffix}`;
          fixes.push(`${bTag}: deduplicated predict.id "${nextId}" -> "${deduped}"`);
          nextId = deduped;
        } else if (nextId !== block.id) {
          fixes.push(`${bTag}: normalized predict.id "${block.id ?? ''}" -> "${nextId}"`);
        }
        block.id = nextId;
        seenPredictIds.add(nextId);
        unrevealedPredicts.push(nextId);
        if (rawId) latestPredictByKey.set(rawId.toLowerCase(), nextId);
        latestPredictByKey.set(nextId.toLowerCase(), nextId);
        if (typeof block.answer === 'string' && /^\d+$/.test(block.answer.trim())) {
          block.answer = Number(block.answer.trim());
          fixes.push(`${bTag}: coerced predict.answer to integer`);
        }
      }

      if (block.t === 'reveal') {
        const rawOf = typeof block.of === 'string' ? block.of.trim() : '';
        if (rawOf) {
          const mapped = latestPredictByKey.get(rawOf.toLowerCase());
          if (mapped && mapped !== block.of) {
            fixes.push(`${bTag}: aligned reveal.of "${block.of}" -> "${mapped}"`);
            block.of = mapped;
          } else if (rawOf !== block.of) {
            block.of = rawOf;
          }
        } else if (unrevealedPredicts.length > 0) {
          const fallbackId = unrevealedPredicts[unrevealedPredicts.length - 1];
          block.of = fallbackId;
          fixes.push(`${bTag}: bound empty reveal.of -> "${fallbackId}"`);
        }
        const idx = unrevealedPredicts.lastIndexOf(block.of);
        if (idx >= 0) unrevealedPredicts.splice(idx, 1);
      }

      if (block.t === 'quiz') {
        if ((!block.q || !String(block.q).trim()) && typeof (block.question || block.prompt) === 'string' && String(block.question || block.prompt).trim()) {
          block.q = String(block.question || block.prompt).trim();
          fixes.push(`${bTag}: mapped quiz question/prompt -> q`);
        }
        const repairQuizList = (list, isChoicesField) => {
          for (const opt of list) {
            if (!opt || typeof opt !== 'object') continue;
            if (!opt.label || !String(opt.label).trim()) {
              const aliasLabel = isChoicesField ? (opt.text ?? opt.choice ?? opt.option) : (opt.choice ?? opt.option);
              if (typeof aliasLabel === 'string' && aliasLabel.trim()) {
                opt.label = aliasLabel.trim();
                if (!opt.text || !String(opt.text).trim()) opt.text = opt.label;
                fixes.push(`${bTag}: mapped quiz choice text/choice -> label`);
              } else if (!isChoicesField && typeof opt.text === 'string' && opt.text.trim()) {
                opt.label = opt.text.trim();
                if (opt.ok === undefined && opt.correct === undefined
                  && (opt.isCorrect !== undefined || opt.answer !== undefined || block.answerIndex !== undefined || block.correctIndex !== undefined)) {
                  fixes.push(`${bTag}: mapped quiz option.text -> label`);
                }
              }
            } else if (!opt.text || !String(opt.text).trim()) {
              opt.text = String(opt.label).trim();
            }

            if (opt.correct === undefined) {
              if (typeof opt.isCorrect === 'boolean') {
                opt.correct = opt.isCorrect;
                if (opt.ok === undefined) opt.ok = opt.isCorrect;
                fixes.push(`${bTag}: mapped quiz choice.isCorrect -> correct`);
              } else if (typeof opt.answer === 'boolean') {
                opt.correct = opt.answer;
                if (opt.ok === undefined) opt.ok = opt.answer;
                fixes.push(`${bTag}: mapped quiz choice.answer -> correct`);
              } else if (typeof opt.ok === 'boolean') {
                opt.correct = opt.ok;
                if (isChoicesField) fixes.push(`${bTag}: mapped quiz choice.ok -> correct`);
              }
            } else if (typeof opt.correct === 'boolean' && opt.ok === undefined) {
              opt.ok = opt.correct;
            }

            if ((!opt.why || !String(opt.why).trim())) {
              const aliasWhy = opt.feedback ?? opt.explanation;
              if (typeof aliasWhy === 'string' && aliasWhy.trim()) {
                opt.why = aliasWhy.trim();
                fixes.push(`${bTag}: mapped quiz choice feedback/explanation -> why`);
              }
            }
          }

          const hasMarkedRight = list.some(o => o && typeof o === 'object' && (o.correct === true || o.ok === true));
          if (!hasMarkedRight && list.length >= 2) {
            const hasExplicitAnswerIdx = block.answerIndex !== undefined || block.correctIndex !== undefined;
            const allObjects = list.every(o => o && typeof o === 'object');
            const rawIdx = hasExplicitAnswerIdx ? (block.answerIndex ?? block.correctIndex) : (allObjects ? block.answer : undefined);
            let ansIdx = -1;
            if (Number.isInteger(rawIdx) && rawIdx >= 0 && rawIdx < list.length) {
              ansIdx = rawIdx;
            } else if (typeof rawIdx === 'string' && /^\d+$/.test(rawIdx.trim())) {
              const parsed = Number(rawIdx.trim());
              if (parsed >= 0 && parsed < list.length) ansIdx = parsed;
            } else if (typeof rawIdx === 'string' && /^[A-Fa-f]$/.test(rawIdx.trim())) {
              const letterIdx = rawIdx.trim().toUpperCase().charCodeAt(0) - 65;
              if (letterIdx >= 0 && letterIdx < list.length) ansIdx = letterIdx;
            }
            if (ansIdx >= 0) {
              for (let i = 0; i < list.length; i++) {
                const item = list[i];
                const isWinner = i === ansIdx;
                if (typeof item === 'string') {
                  const trimmed = item.trim();
                  list[i] = { label: trimmed, text: trimmed, correct: isWinner, ok: isWinner };
                } else if (item && typeof item === 'object') {
                  if (isWinner || item.correct === undefined) item.correct = isWinner;
                  if (isWinner || item.ok === undefined) item.ok = isWinner;
                }
              }
              fixes.push(`${bTag}: marked choice[${ansIdx}] correct from block answerIndex`);
            }
          }
        };
        if (Array.isArray(block.choices)) repairQuizList(block.choices, true);
        if (Array.isArray(block.options)) repairQuizList(block.options, false);
      }

      if (block.t === 'recall' && Array.isArray(block.items)) {
        for (const it of block.items) {
          if (!it || typeof it !== 'object') continue;
          if (typeof it.answer === 'string' && /^\d+$/.test(it.answer.trim())) {
            it.answer = Number(it.answer.trim());
            fixes.push(`${bTag}: coerced recall.answer to integer`);
          }
        }
      }

      if (block.t === 'matrix' && Array.isArray(block.frameworks) && Array.isArray(block.scenarios) && Array.isArray(block.walk)) {
        const scMap = new Map(block.scenarios.filter(s => typeof s?.id === 'string').map(s => [s.id.trim().toLowerCase(), s.id.trim()]));
        const fwMap = new Map(block.frameworks.filter(f => typeof f?.id === 'string').map(f => [f.id.trim().toLowerCase(), f.id.trim()]));
        for (const step of block.walk) {
          if (!step || typeof step !== 'object') continue;
          if (typeof step.scenario === 'string') {
            const hit = scMap.get(step.scenario.trim().toLowerCase());
            if (hit && hit !== step.scenario) { step.scenario = hit; fixes.push(`${bTag}: aligned matrix walk.scenario`); }
          }
          if (typeof step.focus === 'string') {
            const hit = fwMap.get(step.focus.trim().toLowerCase());
            if (hit && hit !== step.focus) { step.focus = hit; fixes.push(`${bTag}: aligned matrix walk.focus`); }
          }
        }
      }

      if (block.t === 'schematic' && Array.isArray(block.nodes)) {
        for (const nd of block.nodes) {
          if (!nd || typeof nd !== 'object') continue;
          if (typeof nd.id === 'string') nd.id = nd.id.trim();
          if (typeof nd.label === 'string') nd.label = trimOverlong(nd.label, 64, fixes, `${bTag} node.label`);
        }
        const validNodeSet = new Set(block.nodes.filter(n => typeof n?.id === 'string' && n.id).map(n => n.id));
        const nodeIds = new Map([...validNodeSet].map(id => [id.toLowerCase(), id]));
        if (Array.isArray(block.edges)) {
          for (const edge of block.edges) {
            if (!edge || typeof edge !== 'object') continue;
            if ((!edge.from || !String(edge.from).trim()) && typeof edge.source === 'string' && edge.source.trim()) {
              edge.from = edge.source.trim();
              fixes.push(`${bTag}: mapped schematic edge.source -> from`);
            }
            if ((!edge.to || !String(edge.to).trim()) && typeof edge.target === 'string' && edge.target.trim()) {
              edge.to = edge.target.trim();
              fixes.push(`${bTag}: mapped schematic edge.target -> to`);
            }
            if (typeof edge.from === 'string') {
              const hit = nodeIds.get(edge.from.trim().toLowerCase());
              if (hit && hit !== edge.from) { edge.from = hit; fixes.push(`${bTag}: aligned schematic edge.from`); }
            }
            if (typeof edge.to === 'string') {
              const hit = nodeIds.get(edge.to.trim().toLowerCase());
              if (hit && hit !== edge.to) { edge.to = hit; fixes.push(`${bTag}: aligned schematic edge.to`); }
            }
          }
          const validEdges = block.edges.filter(edge => edge && typeof edge === 'object' && validNodeSet.has(edge.from) && validNodeSet.has(edge.to));
          if (validEdges.length >= 1 && validEdges.length < block.edges.length) {
            const droppedCount = block.edges.length - validEdges.length;
            const keptEdgeIds = new Set(validEdges.map(e => e.id).filter(Boolean));
            block.edges = validEdges;
            fixes.push(`${bTag}: dropped ${droppedCount} schematic edge(s) referencing non-existent node ids`);
            if (Array.isArray(block.walk)) {
              for (const w of block.walk) {
                if (w && Array.isArray(w.edges)) {
                  w.edges = w.edges.filter(eid => typeof eid === 'number' ? eid >= 0 && eid < validEdges.length : keptEdgeIds.has(eid));
                }
                if (w && Array.isArray(w.nodes)) {
                  w.nodes = w.nodes.filter(nid => validNodeSet.has(nid));
                }
              }
            }
          }
        }
      }
    }
  }

  return { lesson, fixes };
}

export function preRepairLessonSpec(raw) {
  return preRepairLessonWithReport(raw).lesson;
}
