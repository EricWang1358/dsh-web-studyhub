import { createElement, memo, useMemo } from 'react';

/* The one place an HTML diagram or interactive companion that StudyHub did not write is put on screen (docs/companions.md, "Threat note").

   The file may be anything an AI wrote, so it is shown in an iframe that is a separate, powerless origin:
   · sandbox="allow-scripts" and nothing else. Without allow-same-origin the document gets an opaque origin: it cannot read this
     page, its storage, its cookies or its DOM, and `parent.document` throws. Without the other flags it cannot navigate the page
     (allow-top-navigation), submit forms, open popups, download, show dialogs or lock the pointer.
   · srcdoc, not a URL of this origin, so nothing is fetched from the app's server and no address leaks.
   · referrerpolicy="no-referrer", csp="…" AND an injected `<meta http-equiv="Content-Security-Policy">` inside the srcdoc `<head>`
     so Chromium, Firefox and Safari all enforce the egress policy on inline srcdoc documents (no fetch, XHR, WebSocket or beacons).
   · One small click guard goes at the top of the head: a link that leaves the page is stopped, an in-page #link still works.
     That is for the person looking at the diagram, not a security boundary: the sandbox is the boundary. */

export const FRAME_SANDBOX = 'allow-scripts';
export const FRAME_CSP = "connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'";
export const COMPANION_META_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'";
export const COMPANION_PROTOCOL = 'studyhub-companion/1';

const COALESCABLE_KINDS = new Set(['theme', 'labels', 'goto']);

/**
 * Sandpack-style host ↔ iframe message channel with `ready` handshake and pre-ready buffering.
 * Outbound messages sent before the iframe signals `ready` are buffered in FIFO order (coalescing
 * idempotent state-sync kinds `theme`, `labels`, `goto` so the latest value wins) and flushed
 * atomically once `ready` (or any valid protocol message from an older companion) arrives.
 */
export function createCompanionChannel({ token, getTargetWindow, maxQueue = 32 }) {
  let ready = false;
  const queue = [];

  function rawPost(payload) {
    const win = typeof getTargetWindow === 'function' ? getTargetWindow() : null;
    if (!win || typeof win.postMessage !== 'function') return false;
    try {
      win.postMessage({ protocol: COMPANION_PROTOCOL, token, ...payload }, '*');
      return true;
    } catch {
      return false;
    }
  }

  function enqueue(payload) {
    if (COALESCABLE_KINDS.has(payload.kind)) {
      const idx = queue.findIndex(item => item.kind === payload.kind);
      if (idx >= 0) queue.splice(idx, 1);
    }
    if (queue.length >= maxQueue) queue.shift();
    queue.push(payload);
  }

  function flush() {
    if (!ready || !queue.length) return 0;
    let sent = 0;
    while (queue.length) {
      const next = queue[0];
      if (!rawPost(next)) break;
      queue.shift();
      sent++;
    }
    return sent;
  }

  function send(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (ready && rawPost(payload)) return true;
    enqueue(payload);
    return false;
  }

  function ping() {
    if (ready) return false;
    return rawPost({ kind: 'ping' });
  }

  function handleMessage(event) {
    const win = typeof getTargetWindow === 'function' ? getTargetWindow() : null;
    if (!win || event?.source !== win) return null;
    const msg = event?.data;
    if (!msg || msg.protocol !== COMPANION_PROTOCOL || msg.token !== token) return null;
    if (!ready && (msg.kind === 'ready' || msg.kind === 'progress' || msg.kind === 'self-check' || msg.kind === 'inquiry')) {
      ready = true;
      flush();
    }
    return msg;
  }

  function reset({ clearQueue = false } = {}) {
    ready = false;
    if (clearQueue) queue.length = 0;
  }

  return {
    send,
    ping,
    flush,
    handleMessage,
    reset,
    isReady: () => ready,
    pendingCount: () => queue.length,
  };
}

const metaCspTag = (policy) => `<meta http-equiv="Content-Security-Policy" content="${policy}">`;

const GUARD = "<script>document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');"
  + "if(a&&!/^#/.test(a.getAttribute('href')||''))e.preventDefault()},true)</script>";

const UNIVERSAL_COMPANION_SHIM = `<script>(function(){try{`
  + `var bEl=document.getElementById('sh-companion-boot');if(!bEl)return;var boot=JSON.parse(bEl.textContent);`
  + `if(boot.theme==='light'||boot.theme==='dark')document.documentElement.setAttribute('data-theme',boot.theme);`
  + `if(boot.initialAnchor&&/^#/.test(boot.initialAnchor)){try{location.hash=boot.initialAnchor;}catch(e){}}`
  + `function post(p){if(window.parent&&window.parent!==window){try{window.parent.postMessage(Object.assign({protocol:'studyhub-companion/1',token:boot.channelToken},p),'*');}catch(e){}}}`
  + `window.addEventListener('DOMContentLoaded',function(){`
  + `try{if(bEl&&bEl.parentNode)bEl.parentNode.removeChild(bEl);}catch(e){}`
  + `if(window.__shCompanionMounted)return;window.__shCompanionMounted=true;`
  + `var lEl=document.getElementById('lesson-data'),lesson=null;if(lEl){try{lesson=JSON.parse(lEl.textContent);}catch(e){}}`
  + `function curSlide(){var c=document.getElementById('count');var m=c&&/(\\d+)\\s*\\/\\s*(\\d+)/.exec(c.textContent||'');return m?{slide:Number(m[1]),total:Number(m[2])}:{slide:1,total:lesson&&lesson.slides?lesson.slides.length:1};}`
  + `function ctxOf(q){var p=curSlide(),sl=lesson&&lesson.slides?lesson.slides[p.slide-1]:null;var ln=document.getElementById('line');var cb=sl&&sl.blocks?sl.blocks.find(function(x){return x&&x.source;}):null;`
  + `return{lessonId:lesson?lesson.id:'',lessonTitle:lesson?lesson.title:(document.title||''),course:lesson?lesson.course||'':'',slide:p.slide,slideTotal:p.total,slideTitle:sl?sl.title||'':'',beat:sl?sl.beat||'':'',moment:0,teacherLine:ln?ln.textContent||'':'',quote:String(q||'').trim().slice(0,600),codeSlice:cb?String(cb.source).split('\\n').slice(0,35).join('\\n'):''};}`
  + `var askBtn=null,tools=document.querySelector('.top__tools');if(tools){askBtn=document.createElement('button');askBtn.type='button';askBtn.className='tool';askBtn.style.fontWeight='600';askBtn.textContent=boot.askLabel||'+ Ask / Note';`
  + `askBtn.addEventListener('click',function(){var s=window.getSelection?window.getSelection().toString():'';post({kind:'inquiry',context:ctxOf(s)});});tools.insertBefore(askBtn,tools.firstChild);}`
  + `var pill=document.createElement('button');pill.type='button';pill.hidden=true;pill.textContent=boot.selectionLabel||'Ask about selection';`
  + `pill.style.cssText='position:fixed;z-index:60;padding:.32rem .72rem;border-radius:999px;border:1px solid var(--rule-strong,rgba(255,241,220,.42));background:var(--ink,#1e1a15);color:var(--canvas,#f1ede6);box-shadow:0 3px 12px rgba(0,0,0,.32);font-size:.78rem;font-weight:600;cursor:pointer;';`
  + `pill.addEventListener('mousedown',function(e){e.preventDefault();});pill.addEventListener('click',function(){var s=window.getSelection?window.getSelection().toString():'';pill.hidden=true;post({kind:'inquiry',context:ctxOf(s)});});document.body.appendChild(pill);`
  + `document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!pill.hidden)pill.hidden=true;});`
  + `document.addEventListener('selectionchange',function(){var sel=window.getSelection&&window.getSelection();var t=sel?sel.toString().trim():'';if(!t||t.length<2||!sel.rangeCount){pill.hidden=true;return;}var r=sel.getRangeAt(0).getBoundingClientRect();if(!r.width&&!r.height){pill.hidden=true;return;}pill.hidden=false;pill.style.left=Math.max(8,Math.min(window.innerWidth-160,r.left+r.width/2-60))+'px';pill.style.top=Math.max(8,r.top-38)+'px';});`
  + `window.addEventListener('message',function(ev){var d=ev&&ev.data;if(!d||d.protocol!=='studyhub-companion/1'||d.token!==boot.channelToken)return;`
  + `if(d.kind==='ping'){post({kind:'ready',version:1,shim:true,replyToPing:true});return;}`
  + `if(d.kind==='theme'&&(d.theme==='dark'||d.theme==='light')){var curDark=document.documentElement.getAttribute('data-theme')==='dark'||(!document.documentElement.getAttribute('data-theme')&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);var tBtn=document.getElementById('theme');if(tBtn&&curDark!==(d.theme==='dark')){try{tBtn.click();}catch(e){}}document.documentElement.setAttribute('data-theme',d.theme);}`
  + `else if(d.kind==='labels'){if(askBtn&&typeof d.askLabel==='string'&&d.askLabel)askBtn.textContent=d.askLabel;if(pill&&typeof d.selectionLabel==='string'&&d.selectionLabel)pill.textContent=d.selectionLabel;}`
  + `else if(d.kind==='goto'){var cur=curSlide(),tot=Math.max(1,cur.total||1),tgt=Math.max(1,Math.min(tot,Math.floor(Number(d.slide)||1)));if(cur.slide===tgt)return;try{location.hash='#'+tgt;}catch(e){}if(curSlide().slide===tgt)return;`
  + `if(lesson&&Array.isArray(lesson.slides)&&Array.isArray(lesson.beats)){var bBtns=document.querySelectorAll('#beats .beat, #beats button'),best=-1,bestSlide=-1;for(var bi=0;bi<lesson.beats.length&&bi<bBtns.length;bi++){var bid=lesson.beats[bi]&&lesson.beats[bi].id,fs=-1;for(var si=0;si<lesson.slides.length;si++){if(lesson.slides[si]&&lesson.slides[si].beat===bid){fs=si+1;break;}}if(fs>=1&&fs<=tgt&&fs>bestSlide){bestSlide=fs;best=bi;}}if(best>=0&&(curSlide().slide>tgt||bestSlide>curSlide().slide)){try{bBtns[best].click();}catch(e){}}}`
  + `var nx=document.getElementById('next'),pv=document.getElementById('prev'),g=0,backed=false;while(nx&&curSlide().slide<tgt&&!nx.disabled&&g++<240){nx.click();}while(pv&&curSlide().slide>tgt&&!pv.disabled&&g++<240){pv.click();backed=true;}`
  + `if(backed&&pv){if(tgt>1){while(curSlide().slide===tgt&&!pv.disabled&&g++<40){pv.click();}while(nx&&curSlide().slide<tgt&&!nx.disabled&&g++<10){nx.click();}}else{while(!pv.disabled&&g++<40){pv.click();}}}}`
  + `});`
  + `var cEl=document.getElementById('count');if(cEl){var timer=0;new MutationObserver(function(){clearTimeout(timer);timer=setTimeout(function(){var p=curSlide();post({kind:'progress',slide:p.slide,slideTotal:p.total,completed:p.slide>=p.total});},400);}).observe(cEl,{childList:true,characterData:true,subtree:true});}`
  + `post({kind:'ready',version:1,shim:true});`
  + `});}catch(e){}})();</script>`;

/**
 * Serialize JSON safely for embedding inside `<script id="sh-companion-boot" type="application/json">`.
 * Mirrors `safeJsonForScript` in `lib/companion-template/render-html.js`: standard RFC 8259 `\uXXXX`
 * escapes so `</script>` and `<!--` never break out of `<script>` or produce invalid JSON escapes.
 */
function safeBootJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The document as it is shown:
 * - Without `companion`, injects the `<meta http-equiv="Content-Security-Policy">` tag and click guard right after `<head>`.
 * - With `companion` (`{ channelToken, theme, initialAnchor, memory, language }`), injects the strict offline CSP meta tag,
 *   click guard, read-only boot payload and bridge shim, and strips unresolvable external relative `study-notes.js` script tags.
 */
export function framedDocument(html, companion) {
  let text = String(html ?? '');
  let headInsert = metaCspTag(FRAME_CSP) + GUARD;
  if (companion && typeof companion === 'object' && companion.channelToken) {
    text = text.replace(/<script\b[^>]*\bsrc=["'][^"']*study-notes\.js["'][^>]*>\s*<\/script>/gi, '');
    const slideNum = Math.floor(Number(companion.initialSlide) || 0);
    const resolvedAnchor = typeof companion.initialAnchor === 'string' && companion.initialAnchor
      ? companion.initialAnchor
      : (slideNum >= 1 ? `#${slideNum}` : '');
    const bootTag = `<script id="sh-companion-boot" type="application/json">${safeBootJson({
      protocol: COMPANION_PROTOCOL,
      channelToken: String(companion.channelToken),
      theme: companion.theme === 'dark' ? 'dark' : 'light',
      initialAnchor: resolvedAnchor,
      ...(slideNum >= 1 ? { initialSlide: slideNum } : {}),
      memory: companion.memory && typeof companion.memory === 'object' ? companion.memory : {},
      askLabel: typeof companion.askLabel === 'string' && companion.askLabel ? companion.askLabel : '+ Ask / Note',
      selectionLabel: typeof companion.selectionLabel === 'string' && companion.selectionLabel ? companion.selectionLabel : 'Ask about selection',
    })}</script>`;
    headInsert = metaCspTag(COMPANION_META_CSP) + GUARD + bootTag + UNIVERSAL_COMPANION_SHIM;
  }
  for (const opening of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /^\s*(?:﻿)?<!doctype[^>]*>/i]) {
    const found = opening.exec(text);
    if (found) return text.slice(0, found.index + found[0].length) + headInsert + text.slice(found.index + found[0].length);
  }
  return headInsert + text;
}

/** The isolated frame. `title` names it for assistive technology; `className` is for the layout only. */
export const DiagramFrame = memo(function DiagramFrame({ html, title, className = 'sk-diagram-frame', companion, frameRef, onLoad }) {
  const srcDoc = useMemo(() => framedDocument(html, companion), [html, companion]);
  return createElement('iframe', {
    ...(frameRef ? { ref: frameRef } : {}),
    ...(onLoad ? { onLoad } : {}),
    className,
    title,
    sandbox: FRAME_SANDBOX,
    srcDoc,
    referrerPolicy: 'no-referrer',
    csp: FRAME_CSP,
  });
});
