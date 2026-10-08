import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { addNode, answerNode, emptyThread, failNode, MAX_DEPTH, MAX_NODES, pathLabel, planAsk, retryNode, revealNode, threadFor, depthOf, toggleNode, childrenOf } from '../ui/document-preview/ask-thread.js';
import { stripTermMarkers, TERM_PATTERN } from '../ui/term-marker.js';

/* Questions inside an answer: the thread reducer, the [[term]] markers, and the Markdown that draws them. */

const answered = (thread, node, answer = 'a') => answerNode(addNode(thread, node), node.id, answer);

test('a thread grows from the first answer; the path of terms is the heading', () => {
  let thread = answered(emptyThread(), { id: 'n1', parentId: null, question: '没听懂' }, 'About [[ELK]]');
  thread = answered(thread, { id: 'n2', parentId: 'n1', question: 'what is ELK', term: 'ELK' });
  thread = answered(thread, { id: 'n3', parentId: 'n2', question: 'what is Kibana', term: 'Kibana' });
  assert.equal(pathLabel(thread, 'n3'), '没听懂 › ELK › Kibana');
  assert.equal(depthOf(thread, 'n3'), 3);
  assert.deepEqual(threadFor(thread, 'n3').map(entry => entry.question), ['没听懂', 'what is ELK', 'what is Kibana']);
  assert.deepEqual(Object.keys(threadFor(thread, 'n3')[0]), ['question', 'answer']);
});

test('a step is named by its term, its quick question, or the question shortened', () => {
  let thread = answered(emptyThread(), { id: 'n1', parentId: null, question: '这段我没听懂，请按原文顺序讲一下。', label: '没听懂' });
  thread = answered(thread, { id: 'n2', parentId: 'n1', question: 'x', term: 'ELK' });
  thread = answered(thread, { id: 'n3', parentId: 'n2', question: 'Could you say much more about how the second stage works in practice?' });
  assert.equal(pathLabel(thread, 'n2'), '没听懂 › ELK');
  assert.equal(pathLabel(thread, 'n3'), '没听懂 › ELK › Could you say much more…');
});

test('only answered ancestors are sent as context, at most three', () => {
  let thread = answered(emptyThread(), { id: 'n1', parentId: null, question: 'q1' });
  thread = addNode(thread, { id: 'n2', parentId: 'n1', question: 'q2' });
  assert.deepEqual(threadFor(thread, 'n2').map(entry => entry.question), ['q1']);
});

test('depth and node limits refuse with a reason; a busy parent is refused too', () => {
  let thread = answered(emptyThread(), { id: 'n1', parentId: null, question: 'q' });
  thread = answered(thread, { id: 'n2', parentId: 'n1', question: 'q', term: 'a' });
  thread = answered(thread, { id: 'n3', parentId: 'n2', question: 'q', term: 'b' });
  assert.equal(MAX_DEPTH, 3);
  assert.deepEqual(planAsk(thread, { parentId: 'n3', term: 'c' }), { action: 'refuse', reason: 'depth' });
  assert.equal(planAsk(thread, { parentId: 'n2', term: 'c' }).action, 'ask');
  let wide = answered(emptyThread(), { id: 'r', parentId: null, question: 'q' });
  for (let i = 1; i < MAX_NODES; i++) wide = answered(wide, { id: `c${i}`, parentId: 'r', question: 'q', term: `t${i}` });
  assert.equal(wide.nodes.length, MAX_NODES);
  assert.deepEqual(planAsk(wide, { parentId: 'r', term: 'new' }), { action: 'refuse', reason: 'nodes' });
  assert.equal(planAsk(addNode(emptyThread(), { id: 'p', parentId: null, question: 'q' }), { parentId: 'p', term: 'x' }).reason, 'busy');
});

test('the same term under the same parent opens the node it has, with no second ask', () => {
  let thread = answered(emptyThread(), { id: 'n1', parentId: null, question: 'q' });
  thread = answered(thread, { id: 'n2', parentId: 'n1', question: 'what is ELK', term: 'ELK' });
  const plan = planAsk(thread, { parentId: 'n1', term: 'ELK' });
  assert.equal(plan.action, 'open'); assert.equal(plan.node.id, 'n2');
  assert.equal(planAsk(thread, { parentId: 'n1', term: 'Kibana' }).action, 'ask');
  assert.equal(planAsk(answered(thread, { id: 'n3', parentId: 'n2', question: 'q', term: 'x' }), { parentId: 'n2', term: 'ELK' }).action, 'ask', 'another parent is another question');
  // An open still works when the thread is full.
  let full = thread;
  for (let i = 0; full.nodes.length < MAX_NODES; i++) full = answered(full, { id: `f${i}`, parentId: 'n1', question: 'q', term: `f${i}` });
  assert.equal(planAsk(full, { parentId: 'n1', term: 'ELK' }).action, 'open');
});

test('a failed node keeps its place and is retried in place', () => {
  let thread = addNode(emptyThread(), { id: 'n1', parentId: null, question: 'q' });
  thread = failNode(thread, 'n1', 'offline');
  assert.equal(thread.nodes[0].status, 'failed'); assert.equal(thread.nodes[0].error, 'offline');
  thread = retryNode(thread, 'n1');
  assert.equal(thread.nodes[0].status, 'asking'); assert.equal(thread.nodes[0].error, '');
  assert.equal(toggleNode(thread, 'n1').nodes[0].collapsed, true);
  assert.equal(childrenOf(thread, null).length, 1);
});

test('revealing a node opens it and the nodes above it', () => {
  let thread = answered(emptyThread(), { id: 'n1', parentId: null, question: 'q' });
  thread = answered(thread, { id: 'n2', parentId: 'n1', question: 'q', term: 'a' });
  thread = toggleNode(toggleNode(thread, 'n1'), 'n2');
  assert.equal(thread.nodes.every(node => node.collapsed), true);
  assert.equal(revealNode(thread, 'n2').nodes.some(node => node.collapsed), false);
});

test('markers are removed from saved text, but not inside code', () => {
  assert.equal(stripTermMarkers('About [[ELK]] and [[Elastic Search]].'), 'About ELK and Elastic Search.');
  assert.equal(stripTermMarkers('Use `[[x]]` here and [[y]]'), 'Use `[[x]]` here and y');
  assert.equal(stripTermMarkers('```\n[[z]]\n```\n[[w]]'), '```\n[[z]]\n```\nw');
  assert.equal(stripTermMarkers('broken [[open and closed [[]] x]]'), 'broken [[open and closed [[]] x]]');
  assert.equal(stripTermMarkers('no markers'), 'no markers');
  assert.equal(stripTermMarkers(undefined), '');
  assert.ok(TERM_PATTERN.test('[[a]]'));
});

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as Markdown } from './ui/Markdown.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { Markdown } = module.exports;
const html = (text, props = {}) => renderToStaticMarkup(React.createElement(Markdown, { text, onTerm() {}, ...props }));

test('a marked term is a keyboard-focusable button with its label, never a link', () => {
  const out = html('Logs go to [[ELK]] today.');
  assert.match(out, /<button type="button" class="[^"]*md-term"[^>]*>ELK<\/button>/);
  assert.doesNotMatch(out, /href=/);
  assert.doesNotMatch(out, /\[\[/);
  assert.match(out, /aria-label="[^"]*ELK/, 'the label names the action');
});

test('terms work inside bold and lists, and duplicates each get a button', () => {
  const out = html('**See [[ELK]]**\n\n- [[ELK]] stores\n- `[[code]]` stays');
  assert.equal((out.match(/class="[^"]*md-term/g) || []).length, 2);
  assert.match(out, /<code>\[\[code\]\]<\/code>/);
  assert.match(out, /<strong>See <span class="sh-popover-anchor"><button/);
});

test('terms inside code blocks are untouched; malformed markers stay plain text', () => {
  assert.doesNotMatch(html('```\n[[ELK]]\n```'), /<button/);
  for (const text of ['[[ELK', 'ELK]]', '[[ ]]', '[[]]', '[[a\nb]]', `[[${'x'.repeat(100)}]]`]) assert.doesNotMatch(html(text), /<button/, text);
  assert.match(html('[[ELK'), /\[\[ELK/);
});

test('English originals and asked terms render; without a handler the text stays as written', () => {
  const asked = html('A [[Elasticsearch]] node', { askedTerms: ['Elasticsearch'] });
  assert.match(asked, /md-term md-term--asked/);
  assert.match(html('A [[ELK]] node', { onTerm: undefined }), /\[\[ELK\]\]/);
});
