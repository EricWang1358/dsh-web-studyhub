import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import katex from 'katex/dist/katex.js';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { exportAttachments, importAttachments, formatFor, mimeFor } from '../lib/contexts/materials/files.js';
import { extractLatex } from '../lib/contexts/materials/latex.js';
import { groupSourcesByDocument, sourceFormat } from '../lib/source-groups.js';
import { materialRelations } from '../lib/source-relations.js';
import { displayTitle } from '../lib/document-title.js';
import { MAX_DOCUMENT_BYTES, maxBytesFor } from '../lib/office/limits.js';
import { sectionsOf } from '../lib/sections.js';
import { formulaAt } from '../lib/math-scan.js';
import { domainTool } from '../lib/runtime/tools.js';
import { materialsSchemas } from '../lib/contexts/materials/contracts.js';
import { libraryContracts } from '../lib/study-contracts.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'latex-materials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }) });
  return { root, store, call: (action, args = {}, request = {}) => ops.handlers[action](args, request) };
}

function scannedFormulas(text) {
  const out = [];
  for (let i = 0; i < text.length;) {
    const hit = formulaAt(text, i);
    if (hit) { out.push(hit.formula); i = hit.end; }
    else i += 1;
  }
  return out;
}

const LECTURE_TEX = String.raw`% CS3230 Lecture 4 handout
\documentclass[11pt]{article}
\usepackage{amsmath,amssymb,amsthm,booktabs}
\newcommand{\R}{\mathbb{R}}
\newcommand{\norm}[2][2]{\left\|#2\right\|_{#1}}
\DeclareMathOperator*{\argmin}{arg\,min}
\def\eps{\varepsilon}
\newtheorem{theorem}{Theorem}
\newtheorem{dingli}{定理}
\title[Short Title]{Lecture 4: Convex Optimization \\ \& Spectral Bounds\thanks{Draft notes for NUS}}
\author{Prof.\ Lin}
\date{\today}

\begin{document}
\maketitle
\tableofcontents

\section{Convex Sets and Norms}
% Ignore this comment completely
We achieve $95\%$ accuracy in $\R^d$ (that is, 95\% in prose). A multiline inline bound is
$f(x) \le f(y) +
\nabla f(y)^\top (x - y)$ for all $x, y \in \R^d$.

\begin{theorem}[First-Order Condition]
Let $f: \R^d \to \R$ be differentiable. For tolerance $\eps > 0$,
\begin{equation}\label{eq:opt}
x^\star \in \argmin_{x \in \R^d} f(x) + \lambda \norm{x} + \norm[1]{x}.
\end{equation}
\end{theorem}

\begin{dingli}
若矩阵对称，则特征值皆为实数。
\end{dingli}

\begin{proof}
Combine \eqref{eq:opt} with \cite[Ch.~3]{boyd2004} and \textbf{Jensen's inequality}.
\end{proof}

\subsection{Key Properties}
\begin{itemize}
  \item First bullet with \emph{emphasis} and \texttt{grad\_step}.
  \item Second bullet referencing \href{https://example.edu/opt}{course notes}.
\end{itemize}

\begin{description}
  \item[Complexity] Runs in $O(n \log n)$ steps.
\end{description}

\begin{tabular}{lcc}
\toprule
Method & Rate & Space \\
\midrule
GD & $O(1/k)$ & $O(d)$ \\
AGD & $O(1/k^2)$ & $O(d)$ \\
\bottomrule
\end{tabular}

\begin{verbatim}
% literal comment inside verbatim
x = $PATH # not math
\end{verbatim}
\end{document}
`;

test('LaTeX extensions, aliases, MIME type, size limit and tool schemas are registered', () => {
  for (const filename of ['lec04.tex', 'LEC04.TEX', 'notes.ltx', 'paper.latex']) assert.equal(formatFor({ filename }), 'tex', filename);
  assert.equal(formatFor({ filename: 'upload', format: 'tex' }), 'tex');
  assert.equal(formatFor({ filename: 'upload', format: 'latex' }), 'tex');
  assert.equal(mimeFor('tex'), 'text/x-tex');
  assert.equal(maxBytesFor('tex'), MAX_DOCUMENT_BYTES.pdf);
  assert.equal(displayTitle('C:\\notes\\lecture04.tex'), 'lecture04');
  assert.equal(displayTitle('handout.latex'), 'handout');
  const tool = domainTool('materials', {});
  const schemaEnum = tool.inputSchema?.properties?.format?.enum || tool.parameters?.properties?.format?.enum || tool.parameters?.format?.enum;
  for (const name of ['tex', 'latex']) {
    assert.ok(schemaEnum.includes(name), name);
    assert.ok(materialsSchemas['materials.document.import'].input.oneOf[0].properties.format.enum.includes(name), name);
  }
  assert.match(libraryContracts.imports, /\btex\b/);
});

test('extractLatex turns a real lecture .tex into clean sections, expanded KaTeX-valid formulas, theorems, lists, tables and verbatim blocks', () => {
  const result = extractLatex(LECTURE_TEX, { filename: 'lec04.tex' });
  assert.equal(result.title, 'Lecture 4: Convex Optimization & Spectral Bounds');
  assert.doesNotMatch(result.text, /\\documentclass|\\usepackage|\\maketitle|\\tableofcontents|Ignore this comment|Draft notes for NUS/);
  assert.match(result.text, /^# Convex Sets and Norms$/m);
  assert.match(result.text, /^## Key Properties$/m);
  assert.match(result.text, /that is, 95% in prose/);
  assert.match(result.text, /Theorem \(First-Order Condition\)\./);
  assert.match(result.text, /定理\.\s*若矩阵对称/);
  assert.match(result.text, /Proof\.\s*Combine \(eq:opt\) with \[boyd2004\] and Jensen's inequality\./);
  assert.match(result.text, /^- First bullet with emphasis and grad_step\.$/m);
  assert.match(result.text, /^- Complexity: Runs in \$O\(n \\log n\)\$ steps\.$/m);
  assert.match(result.text, /\| Method \| Rate \| Space \|/);
  assert.match(result.text, /% literal comment inside verbatim/);

  const sections = sectionsOf([{ id: 's1', text: result.text }], { windows: false });
  assert.deepEqual(sections.map(s => [s.level, s.title]), [[1, 'Convex Sets and Norms'], [2, 'Key Properties']]);

  const formulas = scannedFormulas(result.text);
  assert.ok(formulas.length >= 9, `expected >= 9 formulas, got ${formulas.length}`);
  for (const formula of formulas) {
    assert.doesNotMatch(formula.source, /\\label\{|\\R\b|\\norm\b|\\argmin\b|\\eps\b/, formula.source);
    assert.doesNotThrow(() => katex.renderToString(formula.source, { displayMode: formula.display, output: 'mathml', throwOnError: true }), formula.source);
  }
});

test('extractLatex supports Beamer frames with overlays, chapterless input files, and self-referential macros without hanging', () => {
  const beamer = String.raw`
\documentclass{beamer}
\renewcommand{\vec}[1]{\mathbf{\vec{#1}}}
\newcommand{\bad}{\bad\bad}
\begin{document}
\section{Dynamic Programming}
\begin{frame}<1->[fragile]{Bellman Optimality}{Finite Horizon}
\pause
\begin{enumerate}
  \item<1-> Base case $V_T(s) = 0$ for $\vec{s}$.
  \item<2-> Step: \only<2>{optimal transition} $\bad$.
\end{enumerate}
\end{frame}
\end{document}`;
  const started = performance.now();
  const slideOut = extractLatex(beamer, { filename: 'dp-slides.tex' });
  assert.ok(performance.now() - started < 500, 'bounded macro expansion finishes quickly');
  assert.match(slideOut.text, /^## Bellman Optimality — Finite Horizon$/m);
  assert.doesNotMatch(slideOut.text, /\\pause|<1->|<2->|\\only/);
  assert.match(slideOut.text, /^1\. Base case \$V_T\(s\) = 0\$/m);
  assert.match(slideOut.text, /^2\. Step: optimal transition/m);

  const chapterInput = String.raw`\section{Included Chapter}
An input file without document wrapper keeps its math \[ \int_0^1 x^2\,dx = \frac{1}{3} \] and text.`;
  const sub = extractLatex(chapterInput, { filename: 'ch2.tex' });
  assert.equal(sub.title, undefined);
  assert.match(sub.text, /^# Included Chapter$/m);
  assert.equal(scannedFormulas(sub.text).length, 1);
});

test('materials.document.import retains original .tex, resolves selections, round-trips backups, probes originals and enforces UTF-8 / empty checks', async t => {
  const { root, call, store } = await fixture(t);
  const bytes = Buffer.from(LECTURE_TEX, 'utf8');
  const imported = await call('materials.document.import', { dataBase64: bytes.toString('base64'), filename: 'lec04.tex', courses: ['CS3230'] });
  const doc = imported.document;
  assert.equal(doc.format, 'tex');
  assert.equal(doc.title, 'Lecture 4: Convex Optimization & Spectral Bounds');
  assert.equal(doc.filename, 'lec04.tex');
  assert.equal(doc.originalAvailable, true);
  assert.equal(doc.preview.kind, 'file');
  assert.equal(doc.preview.mime, 'text/x-tex');
  assert.deepEqual(await readFile(doc.preview.path), bytes);
  assert.equal(imported.sourceIds.length, 1);
  assert.deepEqual(doc.sources[0].courses, ['CS3230']);
  assert.equal(sourceFormat(doc.sources[0]), 'tex');

  const groups = groupSourcesByDocument((await store.read()).sources);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].format, 'tex');
  const rel = materialRelations([groups[0], { key: 'derived', title: `${doc.title} (notes)`, format: 'md', sourceIds: ['m1'] }]);
  assert.equal(rel.get(groups[0].key)?.role, 'original');

  const selected = await call('materials.selection.resolve', { documentId: doc.id, revision: doc.revision, quote: "Jensen's inequality" });
  assert.equal(selected.status, 'resolved');

  const rawGot = await call('materials.document.bytes', { documentId: doc.id });
  assert.equal(rawGot.mime, 'text/x-tex');
  assert.deepEqual(Buffer.from(rawGot.dataBase64, 'base64'), bytes);

  const probe = await call('materials.original.probe', { documentId: doc.id, dataBase64: bytes.toString('base64'), filename: 'lec04.tex' });
  assert.equal(probe.verdict, 'identical');
  assert.equal(probe.accepted, true);

  const recommented = Buffer.from(`% extra header comment\n${LECTURE_TEX}`, 'utf8');
  const probeSameText = await call('materials.original.probe', { documentId: doc.id, dataBase64: recommented.toString('base64'), filename: 'lec04.tex' });
  assert.equal(probeSameText.accepted, true);
  assert.ok(probeSameText.similarity >= 0.99);

  const exported = await exportAttachments(root, (await store.read()).documents);
  assert.equal(exported.length, 1);
  assert.equal(exported[0].format, 'tex');
  const copyRoot = await mkdtemp(join(tmpdir(), 'latex-restore-'));
  t.after(() => rm(copyRoot, { recursive: true, force: true }));
  assert.deepEqual(await importAttachments(copyRoot, exported), { restored: 1 });

  const ltxPath = join(root, 'chapter.ltx');
  await writeFile(ltxPath, '\\section{Rings}\nEvery field is an integral domain.\n', 'utf8');
  const fromPath = await call('materials.document.import', { path: ltxPath });
  assert.equal(fromPath.document.format, 'tex');
  assert.equal(fromPath.sourceIds.length, 1);

  const commentOnly = await call('materials.document.import', { dataBase64: Buffer.from('% nothing here\n\\documentclass{article}\n\\begin{document}\n% still empty\n\\end{document}\n').toString('base64'), filename: 'empty.tex' });
  assert.deepEqual(commentOnly.sourceIds, []);
  assert.ok(commentOnly.warnings.length > 0);

  await assert.rejects(
    call('materials.document.import', { dataBase64: Buffer.from([0xff, 0xfe, 0x00]).toString('base64'), filename: 'bad.tex' }),
    error => error.code === 'text-not-utf8',
  );
});
