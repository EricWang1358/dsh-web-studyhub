import { createElement } from 'react';

/* The one place an HTML diagram that StudyHub did not write is put on screen (docs/companions.md, "Threat note").

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

/** The document as it is shown: the file unchanged, plus the click guard right after the opening head tag (or html tag, or doctype). */
export function framedDocument(html) {
  const text = String(html ?? '');
  for (const opening of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /^\s*(?:﻿)?<!doctype[^>]*>/i]) {
    const found = opening.exec(text);
    if (found) return text.slice(0, found.index + found[0].length) + GUARD + text.slice(found.index + found[0].length);
  }
  return GUARD + text;
}

/** The isolated frame. `title` names it for assistive technology; `className` is for the layout only. */
export function DiagramFrame({ html, title, className = 'sk-diagram-frame' }) {
  return createElement('iframe', { className, title, sandbox: FRAME_SANDBOX, srcDoc: framedDocument(html), referrerPolicy: 'no-referrer', csp: FRAME_CSP });
}
