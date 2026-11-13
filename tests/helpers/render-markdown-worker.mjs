/* A worker that renders Markdown with the reader (ui/Markdown.jsx), so a test can give up on a render that never ends (tests/markdown-fences-regate.test.mjs). */
import { parentPort } from 'node:worker_threads';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './ui-module.mjs';

const ui = await loadUi(`export { default as Markdown } from './ui/Markdown.jsx';`);
parentPort.on('message', text => parentPort.postMessage(renderToStaticMarkup(React.createElement(ui.Markdown, { text }))));
parentPort.postMessage('ready');
