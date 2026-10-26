/* The deck's stylesheet: light and dark (follows the system, with an explicit toggle on <html data-theme>), full-viewport slides with
   scroll-snap, phone widths without sideways page scroll, calm motion, and one slide per page when printed. */
import { COMPARE_CSS } from "./compare.mjs";
import { SEQUENCE_LIGHT_VARS, sequenceCss } from "./sequence.mjs";

const LIGHT = "--dk-bg:#fbfbf8;--dk-fg:#1f2328;--dk-muted:#59636e;--dk-line:#d0d7de;--dk-card:#f3f4f0;--dk-accent:#1a7f37;--dk-accent-bg:#dafbe1;--dk-link:#0b5cad;--dk-bad:#cf222e;--dk-bar:rgba(251,251,248,.88)";
const DARK = "--dk-bg:#0f1318;--dk-fg:#e6edf3;--dk-muted:#9aa4af;--dk-line:#30363d;--dk-card:#171c22;--dk-accent:#3fb950;--dk-accent-bg:#12261e;--dk-link:#79b8ff;--dk-bad:#ff7b72;--dk-bar:rgba(15,19,24,.88)";

export function deckCss() {
  return `
:root{${LIGHT};color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK};color-scheme:dark}}
:root[data-theme="dark"]{${DARK};color-scheme:dark}
:root[data-theme="light"]{${LIGHT};color-scheme:light}
*{box-sizing:border-box}
html{scroll-snap-type:y proximity;-webkit-text-size-adjust:100%}
@media (min-width:900px) and (min-height:560px){html{scroll-snap-type:y mandatory}}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}.dk-progress i{transition:transform .25s ease}}
body{margin:0;background:var(--dk-bg);color:var(--dk-fg);font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;font-size:clamp(1rem,.9rem + .5vw,1.3rem);line-height:1.6;overflow-wrap:anywhere}
a{color:var(--dk-link)}
code{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;background:var(--dk-card);border-radius:4px;padding:.05em .3em;font-size:.92em}
.dk-bar{position:fixed;inset:0 0 auto 0;z-index:5;display:flex;align-items:center;gap:.5rem;padding:.4rem clamp(.6rem,2vw,1.2rem);background:var(--dk-bar);backdrop-filter:blur(6px);border-bottom:1px solid var(--dk-line);font-size:.85rem}
.dk-bar__title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dk-muted)}
.dk-bar button{font:inherit;color:inherit;background:var(--dk-card);border:1px solid var(--dk-line);border-radius:8px;min-width:2.2rem;height:2.2rem;cursor:pointer}
.dk-bar button:hover{border-color:var(--dk-accent)}
.dk-bar button:focus-visible{outline:2px solid var(--dk-link);outline-offset:2px}
.dk-count{font-variant-numeric:tabular-nums;min-width:4rem;text-align:center}
.dk-progress{position:fixed;inset:auto 0 0 0;height:4px;z-index:5;background:var(--dk-line)}
.dk-progress i{display:block;height:100%;background:var(--dk-accent);transform-origin:left;transform:scaleX(0)}
.dk-slide{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;justify-content:center;padding:4.2rem clamp(1rem,5vw,4.5rem) 2.6rem;scroll-snap-align:start;border-bottom:1px solid var(--dk-line)}
.dk-inner{width:100%;max-width:1180px;margin:0 auto}
.dk-slide h1{font-size:clamp(2rem,5.5vw,4rem);line-height:1.2;margin:0 0 .5em}
.dk-slide h2{font-size:clamp(1.5rem,3.4vw,2.4rem);line-height:1.25;margin:0 0 .7em}
.dk-sub{font-size:1.2em;color:var(--dk-muted);margin:0 0 .4em}
.dk-meta{color:var(--dk-muted);font-size:.9em}
.dk-t-title .dk-inner{border-left:6px solid var(--dk-accent);padding-left:clamp(.8rem,3vw,2rem)}
.dk-t-section{background:var(--dk-card)}
.dk-t-section h2{font-size:clamp(2rem,5vw,3.4rem)}
.dk-slide ul{margin:0;padding-left:1.3em}
.dk-slide li{margin:.45em 0}
.dk-slide li ul{font-size:.92em;color:var(--dk-muted)}
.dk-slide p{margin:.6em 0;max-width:46em}
.dk-slide ul.dk-toc{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:.8rem;list-style:none;padding:0}
.dk-n{display:inline-block;min-width:1.6em;color:var(--dk-muted);font-variant-numeric:tabular-nums}
.dk-toc>li{margin:0;border:1px solid var(--dk-line);border-radius:12px;padding:.7rem 1rem;background:var(--dk-card)}
.dk-toc a{font-weight:700;text-decoration:none}
.dk-toc ol{list-style:none;margin:.3rem 0 0;padding-left:0;font-size:.88em;color:var(--dk-muted)}
.dk-toc ol a{font-weight:400;text-decoration:underline}
.dk-tablebox{overflow-x:auto}
.dk-table{width:100%;border-collapse:collapse;font-size:.95em}
.dk-table caption{text-align:left;color:var(--dk-muted);padding:.3rem 0;font-size:.9em}
.dk-table th,.dk-table td{border:1px solid var(--dk-line);padding:.6rem .8rem;text-align:left;vertical-align:top}
.dk-table th{background:var(--dk-card)}
.dk-table td:last-child{background:var(--dk-accent-bg)}
@media (max-width:640px){
  .dk-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .dk-table,.dk-table tbody,.dk-table tr,.dk-table td{display:block;width:100%}
  .dk-table tr{border:1px solid var(--dk-line);border-radius:10px;margin:.6rem 0;overflow:hidden}
  .dk-table td{border:0;border-bottom:1px solid var(--dk-line)}
  .dk-table td::before{content:attr(data-label);display:block;font-size:.8em;color:var(--dk-muted)}
}
.dk-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:1rem}
.dk-stat{border:1px solid var(--dk-line);border-radius:14px;padding:1rem 1.2rem;background:var(--dk-card)}
.dk-stat__label{color:var(--dk-muted)}
.dk-stat__num{font-size:clamp(2.2rem,6vw,4rem);font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums}
.dk-stat__num s{color:var(--dk-muted);font-weight:500;font-size:.7em}
.dk-stat__num .dk-arrow{color:var(--dk-muted);font-weight:400;padding:0 .15em}
.dk-stat__delta{display:inline-block;margin-top:.3rem;font-weight:700;color:var(--dk-accent)}
.dk-stat__delta.is-worse{color:var(--dk-bad)}
.dk-figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));gap:1rem}
.dk-fig{margin:0}
.dk-fig img{display:block;width:100%;height:auto;border:1px solid var(--dk-line);border-radius:10px;background:#fff}
.dk-fig figcaption{margin-top:.4rem;font-size:.9em;color:var(--dk-muted)}
.dk-tag{display:inline-block;font-size:.8em;font-weight:700;border:1px solid var(--dk-line);border-radius:999px;padding:0 .6em;margin-right:.5em;color:var(--dk-fg)}
${COMPARE_CSS}
${sequenceCss()}
@media print{
  @page{size:A4 landscape;margin:10mm}
  :root:root:root{${LIGHT};color-scheme:light}
  :root:root:root .rk-seq{${SEQUENCE_LIGHT_VARS}}
  html{scroll-snap-type:none}
  .dk-bar,.dk-progress{display:none}
  .dk-slide{min-height:0;padding:0 0 4mm;break-after:page;page-break-after:always;border:0;justify-content:flex-start}
  .dk-slide:last-of-type{break-after:auto;page-break-after:auto}
  .rk-scroll,.dk-tablebox{overflow:visible}
  .rk-seq{min-width:0 !important}
  .dk-t-compare{zoom:.78}
  .rk-pane,.dk-stat,.dk-fig,.rk-plain__item{break-inside:avoid}
}
`.trim();
}
