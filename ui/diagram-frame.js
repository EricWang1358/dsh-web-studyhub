import { createElement } from 'react';

/* The one place an HTML diagram or interactive companion that StudyHub did not write is put on screen (docs/companions.md, "Threat note").

   The file may be anything an AI wrote, so it is shown in an iframe that is a separate, powerless origin:
   · sandbox="allow-scripts" and nothing else. Without allow-same-origin the document gets an opaque origin: it cannot read this
     page, its storage, its cookies or its DOM, and `parent.document` throws. Without the other flags it cannot navigate the page
     (allow-top-navigation), submit forms, open popups, download, show dialogs or lock the pointer.
   · srcdoc, not a URL of this origin, so nothing is fetched from the app's server and no address leaks.
   · referrerpolicy="no-referrer" and csp="connect-src 'none' …": it cannot call out with fetch, XHR, WebSocket or beacons (an
     image or font request is still possible, which is how an offline page with an external font works; it carries nothing of ours).
   · One small click guard goes at the top of the head: a link that leaves the page is stopped, an in-page #link still works.
     That is for the person looking at the diagram, not a security boundary: the sandbox is the boundary. */

export const FRAME_SANDBOX = 'allow-scripts';
export const FRAME_CSP = "connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'";

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
  + `if(d.kind==='theme'&&(d.theme==='dark'||d.theme==='light')){var curDark=document.documentElement.getAttribute('data-theme')==='dark'||(!document.documentElement.getAttribute('data-theme')&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);var tBtn=document.getElementById('theme');if(tBtn&&curDark!==(d.theme==='dark')){try{tBtn.click();}catch(e){}}document.documentElement.setAttribute('data-theme',d.theme);}`
  + `else if(d.kind==='labels'){if(askBtn&&typeof d.askLabel==='string'&&d.askLabel)askBtn.textContent=d.askLabel;if(pill&&typeof d.selectionLabel==='string'&&d.selectionLabel)pill.textContent=d.selectionLabel;}`
  + `else if(d.kind==='goto'){var cur=curSlide(),tot=Math.max(1,cur.total||1),tgt=Math.max(1,Math.min(tot,Math.floor(Number(d.slide)||1)));if(cur.slide===tgt)return;try{location.hash='#'+tgt;}catch(e){}if(curSlide().slide===tgt)return;`
  + `if(lesson&&Array.isArray(lesson.slides)&&Array.isArray(lesson.beats)){var bBtns=document.querySelectorAll('#beats .beat, #beats button'),best=-1,bestSlide=-1;for(var bi=0;bi<lesson.beats.length&&bi<bBtns.length;bi++){var bid=lesson.beats[bi]&&lesson.beats[bi].id,fs=-1;for(var si=0;si<lesson.slides.length;si++){if(lesson.slides[si]&&lesson.slides[si].beat===bid){fs=si+1;break;}}if(fs>=1&&fs<=tgt&&fs>bestSlide){bestSlide=fs;best=bi;}}if(best>=0&&(curSlide().slide>tgt||bestSlide>curSlide().slide)){try{bBtns[best].click();}catch(e){}}}`
  + `var nx=document.getElementById('next'),pv=document.getElementById('prev'),g=0,backed=false;while(nx&&curSlide().slide<tgt&&!nx.disabled&&g++<240){nx.click();}while(pv&&curSlide().slide>tgt&&!pv.disabled&&g++<240){pv.click();backed=true;}`
  + `if(backed&&pv){if(tgt>1){while(curSlide().slide===tgt&&!pv.disabled&&g++<40){pv.click();}while(nx&&curSlide().slide<tgt&&!nx.disabled&&g++<10){nx.click();}}else{while(!pv.disabled&&g++<40){pv.click();}}}}`
  + `});`
  + `function syncBeat(){var nb=document.querySelector('#beats .beat.is-now');if(nb&&nb.scrollIntoView){try{nb.scrollIntoView({block:'nearest',inline:'nearest'});}catch(e){}}}`
  + `syncBeat();`
  + `var cEl=document.getElementById('count');if(cEl){var timer=0;new MutationObserver(function(){syncBeat();clearTimeout(timer);timer=setTimeout(function(){var p=curSlide();post({kind:'progress',slide:p.slide,slideTotal:p.total,completed:p.slide>=p.total});},400);}).observe(cEl,{childList:true,characterData:true,subtree:true});}`
  + `});}catch(e){}})();</script>`;

const COMPANION_FRAME_FIX = `<style id="sh-companion-frame-fix">`
  + `html[data-theme="dark"]{color-scheme:dark}`
  + `html[data-theme="light"]{color-scheme:light}`
  + `html body .top{grid-template-columns:minmax(0,auto) minmax(0,1fr) auto;gap:.75rem 1rem}`
  + `html body .top:has(>.top__title:empty){grid-template-columns:minmax(0,1fr) auto}`
  + `html body .top__title{max-width:14rem}`
  + `html body .top__title:empty{display:none}`
  + `html body .beats{min-width:0;max-width:100%;overflow-x:auto;scrollbar-width:none}`
  + `html body .beats::-webkit-scrollbar{display:none}`
  + `html body .top__tools{flex-shrink:0;white-space:nowrap;gap:.5rem}`
  + `html body .stage{scrollbar-width:thin;scrollbar-color:var(--rule-strong,rgba(160,150,138,.36)) transparent}`
  + `html body .slide--hook .slide__title{margin-top:clamp(.25rem,2.2vh,1.5rem)}`
  + `html body .pic__board{left:150px;transform:translateX(-50%);width:auto;min-width:120px;max-width:184px;min-height:62px;height:auto;padding:6px 12px}`
  + `html body .pic__value{font-size:clamp(16px,1.2rem,22px);line-height:1.22;overflow-wrap:break-word}`
  + `@media (max-width:900px){html body .top{grid-template-columns:minmax(0,1fr) auto}}`
  + `</style>`;

function safeBootJson(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
}

/**
 * The document as it is shown:
 * - Without `companion`, the file is unchanged except for the one click guard right after `<head>` (preserving byte-for-byte Archify framing).
 * - With `companion` (`{ channelToken, theme, initialAnchor, memory, language }`), injects the read-only boot payload and bridge shim,
 *   and strips unresolvable external relative `study-notes.js` script tags.
 */
export function framedDocument(html, companion) {
  let text = String(html ?? '');
  let headInsert = GUARD;
  if (companion && typeof companion === 'object' && companion.channelToken) {
    text = text.replace(/<script\b[^>]*\bsrc=["'][^"']*study-notes\.js["'][^>]*>\s*<\/script>/gi, '');
    const slideNum = Math.floor(Number(companion.initialSlide) || 0);
    const resolvedAnchor = typeof companion.initialAnchor === 'string' && companion.initialAnchor
      ? companion.initialAnchor
      : (slideNum >= 1 ? `#${slideNum}` : '');
    const bootTag = `<script id="sh-companion-boot" type="application/json">${safeBootJson({
      protocol: 'studyhub-companion/1',
      channelToken: String(companion.channelToken),
      theme: companion.theme === 'dark' ? 'dark' : 'light',
      initialAnchor: resolvedAnchor,
      ...(slideNum >= 1 ? { initialSlide: slideNum } : {}),
      memory: companion.memory && typeof companion.memory === 'object' ? companion.memory : {},
      askLabel: typeof companion.askLabel === 'string' && companion.askLabel ? companion.askLabel : '+ Ask / Note',
      selectionLabel: typeof companion.selectionLabel === 'string' && companion.selectionLabel ? companion.selectionLabel : 'Ask about selection',
    })}</script>`;
    headInsert = GUARD + COMPANION_FRAME_FIX + bootTag + UNIVERSAL_COMPANION_SHIM;
  }
  for (const opening of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /^\s*(?:﻿)?<!doctype[^>]*>/i]) {
    const found = opening.exec(text);
    if (found) return text.slice(0, found.index + found[0].length) + headInsert + text.slice(found.index + found[0].length);
  }
  return headInsert + text;
}

/** The isolated frame. `title` names it for assistive technology; `className` is for the layout only. */
export function DiagramFrame({ html, title, className = 'sk-diagram-frame', companion, frameRef }) {
  return createElement('iframe', {
    ...(frameRef ? { ref: frameRef } : {}),
    className,
    title,
    sandbox: FRAME_SANDBOX,
    srcDoc: framedDocument(html, companion),
    referrerPolicy: 'no-referrer',
    csp: FRAME_CSP,
  });
}
