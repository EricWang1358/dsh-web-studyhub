import React from "react";
import { createRoot } from "react-dom/client";
// The same global sheets and order as ui/dev.jsx (the DSH host injects them in this order too).
import "./styles.js";
import "./appearance-themes.css";
import "./accent.css";
import './audio-dashboard.css';
import App from "./App.jsx";
import { registerHostParts } from "./host-parts.js";
import { ZCODE_PARTS } from "./zcode/parts.jsx";

/* The StudyHub panel inside ZCode (an MCP Apps surface). The shell page (packages/studyhub-zcode/ui-port/shell-loader.js)
   has made the page's one ext-apps connection and put it on window.__studyShell; every study action goes through the
   page-only study_call tool of StudyHub's MCP server, with DSH's envelope ({ok,value} or {ok:false,error,code}), and with
   the panel nonce the server wrote into the shell page (without it the server refuses the call).
   Plan contract C3: no composer to hand a prompt to, no agent tasks, no landing shell, no native folder picker. */
const host = { capabilities: { edition: "zcode", chat: false, agentTasks: false, landing: false } };
document.title = "StudyHub";
registerHostParts(ZCODE_PARTS);

const shell = window.__studyShell;

/** The envelope of one study_call answer. */
function envelopeOf(result) {
  const text = result?.content?.find?.((item) => item?.type === "text")?.text;
  try { return JSON.parse(text); } catch { return { ok: false, error: result?.isError ? String(text || "StudyHub request failed") : "StudyHub answered something unreadable" }; }
}

const call = async (action, args = {}) => {
  const envelope = envelopeOf(await shell.app.callServerTool({ name: "study_call", arguments: { action, args, nonce: shell.nonce } }));
  if (!envelope.ok) throw Object.assign(new Error(envelope.error), { code: envelope.code });
  return envelope.value;
};

/* ZCode's sandboxed webview swallows target=_blank and window.open; outside http(s) links go to the system browser
   through app.open instead. In-page anchors (#…) and blob:/data: links stay with the page. */
const external = (href) => { try { return ["http:", "https:"].includes(new URL(href, location.href).protocol) ? new URL(href, location.href).href : null; } catch { return null; } };
const openOutside = (href) => call("app.open", { url: href }).catch((error) => console.warn("[studyhub] could not open a link:", error?.message || error));
document.addEventListener("click", (event) => {
  const anchor = event.target?.closest?.("a[href]");
  if (!anchor || event.defaultPrevented || anchor.hasAttribute("download")) return;
  const href = external(anchor.getAttribute("href"));
  if (!href || (anchor.target !== "_blank" && new URL(href).origin === location.origin)) return;
  event.preventDefault();
  void openOutside(href);
}, true);
window.open = (url) => { const href = external(String(url ?? "")); if (href) void openOutside(href); return null; };

createRoot(document.getElementById("root")).render(<App call={call} host={host} />);
