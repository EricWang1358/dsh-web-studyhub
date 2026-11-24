/* Paper-token CSS for self-contained `studyhub-lesson/1` HTML files.
   Matches StudyHub's ui/tokens.css and Java Hood Lab's stage typography,
   extended with MathML, parametric sandbox, dialectical matrix, schematic SVG,
   and optional StudyHub bridge selection controls. */

export const LESSON_TEMPLATE_CSS = `
:root {
  --canvas: #f1ede6; --surface: #faf8f4; --raised: #ffffff; --sunken: #e8e3da;
  --ink: #1e1a15; --ink-2: #453e35; --muted: #635b51; --faint: #7b7368;
  --rule: #2a1c0e24; --rule-strong: #2a1c0e52;
  --accent: #c03a1f; --accent-text: #ad4025; --accent-ink: #fffaf5; --accent-wash: #c03a1f14;
  --ok: #1c6c48; --ok-wash: #1c6c4817; --bad: #a23461; --bad-wash: #a2346114; --info: #346287; --ochre: #8a5a10;
  --code-k: #8a3b1f;
  --s1: #1c5cab; --s2: #e0703a; --s3: #16a37a; --s4: #8a5a10;
  --font: "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", sans-serif;
  --display: "Segoe UI Variable Display", "SF Pro Display", "Segoe UI", "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", sans-serif;
  --mono: ui-monospace, "Cascadia Mono", "SF Mono", Consolas, "Microsoft YaHei UI", monospace;
  --ease: cubic-bezier(.2, .7, .2, 1);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --canvas: #161412; --surface: #1e1b18; --raised: #26231f; --sunken: #110f0d;
  --ink: #efe9df; --ink-2: #c5bdb1; --muted: #a59d91; --faint: #958e84;
  --rule: #fff1dc21; --rule-strong: #fff1dc4d;
  --accent: #d8492c; --accent-text: #ec6a4a; --accent-ink: #fff8f2; --accent-wash: #ec6a4a1f;
  --ok: #62c092; --ok-wash: #62c0921f; --bad: #dd8cb9; --bad-wash: #dd8cb91f; --info: #86b4dc; --ochre: #e0a04e;
  --code-k: #eb9a78;
  --s1: #3987e5; --s2: #e0703a; --s3: #199e70; --s4: #d8b24c;
  color-scheme: dark;
} }
:root[data-theme="dark"] {
  --canvas: #161412; --surface: #1e1b18; --raised: #26231f; --sunken: #110f0d;
  --ink: #efe9df; --ink-2: #c5bdb1; --muted: #a59d91; --faint: #958e84;
  --rule: #fff1dc21; --rule-strong: #fff1dc4d;
  --accent: #d8492c; --accent-text: #ec6a4a; --accent-ink: #fff8f2; --accent-wash: #ec6a4a1f;
  --ok: #62c092; --ok-wash: #62c0921f; --bad: #dd8cb9; --bad-wash: #dd8cb91f; --info: #86b4dc; --ochre: #e0a04e;
  --code-k: #eb9a78;
  --s1: #3987e5; --s2: #e0703a; --s3: #199e70; --s4: #d8b24c;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { font-size: clamp(16px, .5vw + 10.5px, 19px); -webkit-text-size-adjust: 100%; }
body { margin: 0; height: 100vh; height: 100dvh; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden;
  background: var(--canvas); color: var(--ink); font-family: var(--font); line-height: 1.6; }
button, input, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
code, .mono { font-family: var(--mono); }
p code, li code, .opt code, .voice code { font-size: .9em; background: var(--sunken); padding: .08em .36em; border-radius: 5px; }
mark { background: none; color: inherit; box-shadow: inset 0 -.5em 0 var(--accent-wash); font-weight: 600; }
.num { font-variant-numeric: tabular-nums; }
math { font-size: 1.04em; font-feature-settings: "dtls" off; }
math * { border-color: currentColor; }
math.tml-display { display: block; width: 100%; }
.tml-left { text-align: left; }
.tml-right { text-align: right; }
.tml-overline { padding: .1em 0 0 0; border-top: .065em solid; }
.tml-underline { padding: 0 0 .1em 0; border-bottom: .065em solid; }
.tml-fbox { padding: 3pt; border: 1px solid; }
.tml-cancel { display: inline-block; position: absolute; left: .5px; bottom: 0; width: 100%; height: 100%; background-color: currentColor; }
.tml-cancel.upstrike { clip-path: polygon(.05em 100%, 0 calc(100% - .05em), calc(100% - .05em) 0, 100% .05em); }
.tml-cancel.downstrike { clip-path: polygon(0 .05em, .05em 0, 100% calc(100% - .05em), calc(100% - .05em) 100%); }
.tml-cancel.sout { clip-path: polygon(0 calc(55% + .0333em), 0 calc(55% - .0333em), 100% calc(55% - .0333em), 100% calc(55% + .0333em)); }
.tml-xcancel { clip-path: polygon(.05em 0, 0 .05em, calc(50% - .05em) 50%, 0 calc(100% - .05em), .05em 100%, 50% calc(50% + .05em), calc(100% - .05em) 100%, 100% calc(100% - .05em), calc(50% + .05em) 50%, 100% .05em, calc(100% - .05em) 0, 50% calc(50% - .05em)); }
.tml-sml-pad { padding-left: .05em; }
.tml-med-pad { padding-left: .10em; }
.tml-lrg-pad { padding-left: .15em; }
mtable.tml-jot > mtr > mtd { padding-top: .7ex; padding-bottom: .7ex; }
mtable.tml-small mtd { padding-top: .35ex; padding-bottom: .35ex; }
.sh-math-block { display: block; margin: .65rem 0; overflow-x: auto; padding: .2rem 0; }
menclose[notation], menclose.sh-cancel, menclose.sh-bcancel, menclose.sh-xcancel, menclose.sh-sout { position: relative; display: inline-block; padding: 0 .08em; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
menclose[notation="updiagonalstrike"], menclose.sh-cancel { background: linear-gradient(to top left, transparent calc(50% - .8px), currentColor calc(50% - .8px), currentColor calc(50% + .8px), transparent calc(50% + .8px)); }
menclose[notation="downdiagonalstrike"], menclose.sh-bcancel { background: linear-gradient(to top right, transparent calc(50% - .8px), currentColor calc(50% - .8px), currentColor calc(50% + .8px), transparent calc(50% + .8px)); }
menclose[notation="updiagonalstrike downdiagonalstrike"], menclose.sh-xcancel { background: linear-gradient(to top left, transparent calc(50% - .8px), currentColor calc(50% - .8px), currentColor calc(50% + .8px), transparent calc(50% + .8px)), linear-gradient(to top right, transparent calc(50% - .8px), currentColor calc(50% - .8px), currentColor calc(50% + .8px), transparent calc(50% + .8px)); }
menclose[notation="horizontalstrike"], menclose.sh-sout { text-decoration: line-through; }

.top { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto; align-items: center; gap: 1rem; padding: .55rem 1.4rem; border-bottom: 1px solid var(--rule); }
.top__title { min-width: 0; font-size: .8rem; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.top__tools { display: flex; justify-content: flex-end; align-items: center; gap: .6rem; font-size: .8rem; color: var(--muted); flex-shrink: 0; }
.beats { display: flex; align-items: center; justify-self: center; max-width: 100%; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.beat { display: flex; align-items: center; gap: .4rem; padding: .3rem .55rem; border: 0; background: none; border-radius: 8px; font-size: .78rem; color: var(--faint); cursor: pointer; white-space: nowrap; }
.beat::before { content: ""; width: 6px; height: 6px; border-radius: 50%; border: 1.5px solid currentColor; }
.beat:hover { color: var(--ink); }
.beat.is-done { color: var(--muted); }
.beat.is-done::before { background: currentColor; }
.beat.is-now { color: var(--ink); font-weight: 650; }
.beat.is-now::before { background: var(--accent); border-color: var(--accent); }
.tool { border: 1px solid var(--rule); background: none; border-radius: 8px; padding: .25rem .6rem; cursor: pointer; white-space: nowrap; }
.tool:hover { border-color: var(--rule-strong); color: var(--ink); }
.tool--ask { border-color: var(--rule-strong); color: var(--ink); font-weight: 600; }
.tool--ask:hover { border-color: var(--accent); color: var(--accent-text); }

.stage { overflow-x: hidden; overflow-y: auto; padding: 0 clamp(1rem, 4vw, 3.4rem) 2rem; }
.slide { width: 100%; max-width: 68rem; margin: 0 auto; padding-top: clamp(1.4rem, 4vh, 2.8rem); }
.slide__title { font-family: var(--display); font-size: clamp(1.5rem, 2.6vw, 2.3rem); line-height: 1.22; font-weight: 680; letter-spacing: -.01em; margin: 0 0 1.3rem; text-wrap: balance; }
.slide__blocks { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1.25rem; }
.slide--split .slide__blocks { grid-template-columns: minmax(0, 11fr) minmax(0, 9fr); column-gap: 2.4rem; align-items: start; }
.slide--split .block:first-child { grid-row: 1 / span 4; }
.block { transition: opacity .28s var(--ease), transform .28s var(--ease); }
.block.is-waiting { opacity: 0; transform: translateY(8px); pointer-events: none; }

.slide--hook .slide__title { font-size: clamp(2.1rem, 4.6vw, 3.6rem); line-height: 1.14; font-weight: 720; letter-spacing: -.02em; max-width: 15em; margin-top: clamp(.5rem, 6vh, 3.8rem); margin-bottom: 1.4rem; }
.hook__meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2.4rem; margin-top: 2.2rem; padding-top: 1.2rem; border-top: 1px solid var(--rule); max-width: 52rem; }
.hook__meta h3 { font-size: .78rem; font-weight: 600; color: var(--muted); margin: 0 0 .5rem; }
.hook__meta ul { margin: 0; padding: 0; list-style: none; font-size: .92rem; color: var(--ink-2); }
.hook__meta li { padding: .14rem 0; }

.text { font-size: 1.16rem; line-height: 1.65; color: var(--ink-2); margin: 0; max-width: 36em; }
.slide--hook .text { font-size: 1.34rem; color: var(--ink); }
.points { margin: 0; padding: 0; list-style: none; display: grid; gap: .7rem; font-size: 1.06rem; line-height: 1.55; max-width: 44rem; }
.points li { display: grid; grid-template-columns: 1.1rem 1fr; }
.points li::before { content: ""; width: 6px; height: 6px; margin-top: .62em; background: var(--ink-2); border-radius: 50%; }
.callout { border-left: 3px solid var(--info); padding: .15rem 0 .15rem 1rem; max-width: 40em; background: var(--surface); border-radius: 0 8px 8px 0; padding-right: 1rem; }
.callout--pitfall, .callout--warn { border-left-color: var(--bad); }
.callout--ok { border-left-color: var(--ok); }
.callout h4 { margin: 0 0 .2rem; font-size: 1rem; }
.callout p { margin: 0; color: var(--ink-2); }

.code { background: var(--raised); border: 1px solid var(--rule); border-radius: 12px; overflow: hidden; max-width: 50rem; }
.code__path { padding: .55rem 1rem .5rem; border-bottom: 1px solid var(--rule); font-family: var(--mono); font-size: .7rem; color: var(--faint); -webkit-user-select: none; user-select: none; }
.code__scroll { overflow: auto; max-height: min(58vh, 31rem); padding: .5rem 0 .8rem; scrollbar-width: thin; }
.code__line { display: grid; grid-template-columns: 3em minmax(0, 1fr); font-family: var(--mono); font-size: .8rem; line-height: 1.7; white-space: pre-wrap; word-break: break-word; padding-right: 1rem; border-left: 3px solid transparent; transition: opacity .3s, background-color .3s; }
.code__no { text-align: right; padding-right: 1em; color: var(--faint); opacity: .7; -webkit-user-select: none; user-select: none; pointer-events: none; }
.code__no::before { content: attr(data-no); }
.code__tag { -webkit-user-select: none; user-select: none; }
.code.is-pickable .code__line:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; background: var(--sunken); }
.code.has-focus .code__line { opacity: .42; }
.code.has-focus .code__line.is-focus { opacity: 1; background: var(--accent-wash); border-left-color: var(--accent); }
.code .code__line.is-changed { opacity: 1; background: var(--ok-wash); border-left-color: var(--ok); }
.tk-k { color: var(--code-k); font-weight: 600; }
.tk-s { color: var(--ok); }
.tk-n { color: var(--info); }
.tk-c { color: var(--faint); font-style: italic; }

.btn { border: 1px solid var(--rule-strong); background: var(--raised); border-radius: 10px; padding: .5rem 1rem; cursor: pointer; }
.btn:hover:not(:disabled) { border-color: var(--ink-2); }
.btn--primary { background: var(--ink); border-color: var(--ink); color: var(--canvas); font-weight: 600; }
.btn--primary:hover:not(:disabled) { border-color: var(--ink); opacity: .86; }
.btn--quiet { border-color: transparent; background: none; color: var(--muted); padding: .2rem .5rem; font-size: .78rem; }
.btn--quiet:hover:not(:disabled) { color: var(--ink); border-color: var(--rule); }
.btn:disabled { opacity: .4; cursor: default; }
.seg { display: inline-flex; align-items: center; gap: .6rem; font-size: .82rem; color: var(--muted); flex-wrap: wrap; }
.seg__set { display: inline-flex; padding: 3px; background: var(--sunken); border-radius: 10px; flex-wrap: wrap; }
.seg__set button { border: 0; background: none; padding: .32rem .8rem; border-radius: 8px; color: var(--muted); cursor: pointer; white-space: nowrap; }
.seg__set button:hover { color: var(--ink); }
.seg__set button[aria-pressed="true"] { background: var(--raised); color: var(--ink); font-weight: 600; box-shadow: 0 0 0 1px var(--rule); }

.exp__bar { display: flex; justify-content: space-between; align-items: center; gap: .8rem 1.5rem; flex-wrap: wrap; margin-bottom: .4rem; padding: .5rem 0; position: sticky; top: 0; z-index: 2; background: var(--canvas); }
.exp__body { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: 1.6rem; align-items: start; }
.exp .code__scroll { max-height: min(34vh, 22rem); }
.block:has(> .try) { display: none; }
.exp.is-invited .seg__set, .sbox.is-invited .sbox__controls { animation: invite 2.4s var(--ease); }
@keyframes invite { 0%, 70% { box-shadow: 0 0 0 2px var(--accent); border-radius: 10px; } }
.exp__q { margin: .1rem 0 .7rem; font-size: .92rem; color: var(--ink-2); }
.plot__row { display: grid; grid-template-columns: 7.6em minmax(0, 1fr) 6.2em; align-items: center; gap: .8rem; width: 100%; padding: 0; border: 0; border-top: 1px solid var(--rule); background: none; text-align: left; }
.plot__label { font-size: .86rem; color: var(--muted); border: 0; background: none; padding: .3rem 0; text-align: left; cursor: pointer; line-height: 1.3; }
.plot__row.is-on .plot__label { color: var(--ink); font-weight: 650; }
.plot__track { position: relative; height: 3.3rem; }
.plot__track::before { content: ""; position: absolute; inset: 50% 0 auto 0; border-top: 1px solid var(--rule); }
.plot__track::after { content: ""; position: absolute; top: 0; bottom: 0; left: var(--expect); border-left: 1.5px dashed var(--ok); opacity: .7; }
.dot { position: absolute; top: 50%; width: 9px; height: 9px; margin: -4.5px 0 0 -4.5px; border-radius: 50%; background: var(--bad); z-index: 1; cursor: pointer;
  transition: left .55s var(--ease), transform .55s var(--ease), opacity .3s, background-color .3s; }
.dot.is-ok { background: var(--ok); }
.dot.is-waiting { opacity: 0; pointer-events: none; }
.plot__row:not(.is-on) .dot { opacity: .5; }
.plot__row:not(.is-on) .dot.is-waiting { opacity: 0; }
.plot__sum { text-align: right; font-size: .8rem; color: var(--muted); line-height: 1.35; }
.plot__sum.is-held > * { visibility: hidden; }
.plot__sum b { display: block; font-size: .9rem; color: var(--bad); }
.plot__sum b.is-ok { color: var(--ok); }
.plot__axis { display: grid; grid-template-columns: 7.6em minmax(0, 1fr) 6.2em; gap: .8rem; border-top: 1px solid var(--rule); font-size: .72rem; color: var(--faint); }
.plot__ticks { position: relative; height: 1.6rem; }
.plot__ticks span { position: absolute; top: .3rem; white-space: nowrap; }
.plot__ticks .is-expect { left: var(--expect); transform: translateX(-100%); padding-right: .4rem; color: var(--ok); font-weight: 600; }
.exp__finding { margin: .9rem 0 0; font-size: 1.04rem; line-height: 1.55; min-height: 2.8em; }
.exp__foot { margin-top: .5rem; display: flex; align-items: center; gap: .3rem .9rem; flex-wrap: wrap; font-size: .72rem; color: var(--faint); }
.exp__note { margin: .5rem 0 0; font-size: .84rem; color: var(--muted); }
.exp__hand { display: flex; gap: .6rem; flex-wrap: wrap; margin-top: .9rem; }
.exp__hand[hidden] { display: none; }
.cmd { font-family: var(--mono); background: var(--sunken); color: var(--ink-2); padding: .15rem .5rem; border-radius: 6px; }

/* Parametric Sandbox (Math / Physics / Mechanical / Economics) */
.sbox { display: grid; gap: .95rem; max-width: 60rem; }
.sbox__toolbar { display: flex; justify-content: space-between; align-items: center; gap: .5rem 1rem; flex-wrap: wrap; }
.sbox__toolbar--solo { justify-content: flex-end; }
.sbox__presets { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
.sbox__preset { border: 1px solid var(--rule-strong); background: var(--raised); border-radius: 999px; padding: .22rem .72rem; font-size: .8rem; color: var(--ink-2); cursor: pointer; transition: border-color .2s, background-color .2s, color .2s; }
.sbox__preset:hover { border-color: var(--ink-2); color: var(--ink); }
.sbox__preset[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-wash); color: var(--accent-text); font-weight: 650; }
.sbox__controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 14.5rem), 1fr)); gap: .8rem 1.4rem; padding: .85rem 1.1rem; background: var(--surface); border: 1px solid var(--rule); border-radius: 12px; }
.sbox__knob { display: grid; gap: .32rem; }
.sbox__khead { display: flex; justify-content: space-between; align-items: baseline; gap: .5rem; font-size: .84rem; }
.sbox__khead b { font-family: var(--mono); color: var(--accent-text); font-variant-numeric: tabular-nums; }
.sbox__krow { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .4rem; }
.sbox__step { width: 1.55rem; height: 1.55rem; padding: 0; border: 1px solid var(--rule-strong); border-radius: 6px; background: var(--raised); color: var(--muted); font-family: var(--mono); font-size: .88rem; line-height: 1; cursor: pointer; display: grid; place-items: center; }
.sbox__step:hover { border-color: var(--ink-2); color: var(--ink); }
.sbox__knob input[type="range"] { width: 100%; accent-color: var(--accent); cursor: pointer; margin: 0; }
.sbox__body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(13rem, 18rem); gap: 1.4rem; align-items: start; }
.sbox__plot { background: var(--raised); border: 1px solid var(--rule); border-radius: 12px; padding: .8rem .9rem; display: grid; gap: .45rem; }
.sbox__svg { display: block; width: 100%; height: auto; overflow: visible; touch-action: pan-y; }
.sbox__zero { stroke: var(--ink-2); stroke-width: 1.25; stroke-dasharray: 4 3; opacity: .65; }
.sbox__zero-x { stroke: var(--rule-strong); stroke-width: 1.1; stroke-dasharray: 3 3; }
.sbox__zero-tag { font-size: 10px; fill: var(--muted); font-family: var(--mono); }
.sbox__band { fill: var(--ok-wash); stroke: none; }
.sbox__thresh-line { stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 6 4; }
.sbox__thresh-label { font-size: 10.5px; font-weight: 600; fill: var(--ok); }
.sbox__quiver-path { fill: none; stroke: var(--muted); stroke-width: 1.1; stroke-linecap: round; stroke-linejoin: round; opacity: .44; pointer-events: none; }
.sbox__dir-arrow { fill: var(--s, var(--s1)); pointer-events: none; }
.sbox__marker { pointer-events: none; }
.sbox__marker-halo { fill: var(--accent-wash); stroke: var(--accent); stroke-width: 1.25; }
.sbox__marker-dot { fill: var(--accent); stroke: var(--raised); stroke-width: 1.6; }
.sbox__marker-label { font-size: 10.5px; font-weight: 650; fill: var(--accent-text); }
.sbox__axis-label { font-size: 10.5px; font-weight: 600; fill: var(--muted); }
.sbox__cross[hidden] { display: none; }
.sbox__cross-line { stroke: var(--ink-2); stroke-width: 1.15; stroke-dasharray: 3 3; pointer-events: none; }
.sbox__dot { fill: var(--s, var(--s1)); stroke: var(--raised); stroke-width: 2; pointer-events: none; }
.sbox__hit { fill: transparent; cursor: crosshair; }
.sbox__hit:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sbox__cursor { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .3rem .8rem; min-height: 1.45rem; padding: .22rem .55rem; border-radius: 7px; background: var(--surface); border: 1px solid var(--rule); font-size: .78rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.sbox__cursor.is-pinned { border-color: var(--accent); color: var(--ink); }
.sbox__cursor-vals { display: inline-flex; flex-wrap: wrap; gap: .25rem .75rem; font-family: var(--mono); color: var(--ink); }
.sbox__side { display: grid; gap: .75rem; }
.sbox__metrics { display: grid; gap: .5rem; }
.sbox__metric { display: flex; justify-content: space-between; align-items: baseline; gap: .6rem; padding: .55rem .8rem; border-radius: 9px; background: var(--raised); border: 1px solid var(--rule); font-size: .88rem; }
.sbox__metric b { font-family: var(--mono); font-size: 1rem; font-variant-numeric: tabular-nums; color: var(--ink); }
.sbox__legend { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem .9rem; font-size: .8rem; color: var(--ink-2); margin-top: .15rem; }
.sbox__leg { display: inline-flex; align-items: center; gap: .38rem; padding: .14rem .48rem; border-radius: 6px; background: var(--surface); border: 1px solid var(--rule); }
.sbox__leg b { font-family: var(--mono); font-size: .78rem; color: var(--ink); font-variant-numeric: tabular-nums; }
.sbox__swatch { width: 16px; height: 3px; border-radius: 2px; background: var(--s, var(--s1)); flex: none; }
.sbox__swatch--dash { height: 0; border-top: 2px dashed var(--ok); background: none; }
.sbox__swatch--zero { height: 0; border-top: 2px dashed var(--ink-2); background: none; opacity: .75; }
.sbox__swatch--marker { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }

/* Dialectical / Scenario Matrix (Philosophy / Law / Ethics / Diagnosis) */
.mtx { display: grid; gap: .95rem; max-width: 58rem; }
.mtx__bar { display: flex; justify-content: space-between; align-items: center; gap: .6rem 1rem; flex-wrap: wrap; }
.mtx__actions { display: inline-flex; align-items: center; gap: .45rem; flex-wrap: wrap; }
.mtx__prompt { padding: .9rem 1.1rem; border-radius: 12px; background: var(--surface); border: 1px solid var(--rule-strong); font-size: 1.04rem; line-height: 1.6; }
.mtx__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr)); gap: .85rem; }
.mtx__card { padding: .9rem 1.05rem; border-radius: 12px; background: var(--raised); border: 1px solid var(--rule); display: grid; gap: .45rem; align-content: start; cursor: pointer; text-align: left; transition: border-color .25s var(--ease), box-shadow .25s var(--ease), opacity .25s var(--ease), transform .25s var(--ease), background-color .25s var(--ease); }
.mtx__card:hover { border-color: var(--rule-strong); }
.mtx__grid.has-focus .mtx__card:not(.is-focus) { opacity: .66; }
.mtx__card.is-focus { border-color: var(--accent); box-shadow: 0 0 0 1.5px var(--accent); background: var(--surface); transform: translateY(-2px); opacity: 1; }
.mtx__head { display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
.mtx__fw { font-weight: 700; font-size: .96rem; }
.mtx__badge { font-size: .74rem; font-weight: 600; padding: .12rem .55rem; border-radius: 999px; border: 1px solid var(--rule-strong); color: var(--muted); transition: opacity .22s var(--ease); }
.mtx__badge--ok { border-color: var(--ok); color: var(--ok); background: var(--ok-wash); }
.mtx__badge--bad { border-color: var(--bad); color: var(--bad); background: var(--bad-wash); }
.mtx__badge--warn { border-color: var(--ochre); color: var(--ochre); }
.mtx__verdict { font-weight: 650; font-size: .98rem; margin: 0; transition: opacity .22s var(--ease); }
.mtx__why { margin: 0; font-size: .88rem; color: var(--ink-2); line-height: 1.55; transition: opacity .22s var(--ease); }
.mtx__veil { margin: .25rem 0 0; padding: .42rem .7rem; border-radius: 8px; border: 1px dashed var(--rule-strong); font-size: .84rem; color: var(--muted); text-align: center; }
.mtx__card.is-masked:hover .mtx__veil { border-color: var(--accent); color: var(--accent-text); }

/* Step-by-step Schematic / Force & Causal Diagram */
.schem { display: grid; gap: .75rem; max-width: 54rem; }
.schem__bar { display: flex; justify-content: space-between; align-items: center; gap: .5rem 1rem; flex-wrap: wrap; }
.schem__actions { display: inline-flex; align-items: center; gap: .45rem; }
.schem__trace-pos { font-family: var(--mono); font-size: .78rem; color: var(--muted); }
.schem__canvas { background: var(--raised); border: 1px solid var(--rule); border-radius: 12px; padding: .8rem; overflow-x: auto; }
.schem__svg { display: block; width: 100%; height: auto; overflow: visible; }
.schem__node { cursor: pointer; }
.schem__node rect { fill: var(--surface); stroke: var(--ink-2); stroke-width: 1.5; rx: 8; transition: stroke .25s, fill .25s, stroke-width .25s; }
.schem__node:hover rect { stroke: var(--ink); }
.schem__node.is-selected rect { stroke: var(--info); stroke-width: 2.3; }
.schem__node.is-active rect { stroke: var(--accent); stroke-width: 2.4; fill: var(--accent-wash); }
.schem__node.is-ok rect { stroke: var(--ok); fill: var(--ok-wash); }
.schem__node.is-bad rect { stroke: var(--bad); fill: var(--bad-wash); }
.schem__nlabel { font-size: 13px; font-weight: 650; fill: var(--ink); text-anchor: middle; pointer-events: none; }
.schem__nsub { font-size: 11px; fill: var(--muted); text-anchor: middle; font-family: var(--mono); pointer-events: none; }
.schem__edge line, .schem__edge path { fill: none; stroke: var(--rule-strong); stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; transition: stroke .25s, stroke-width .25s; }
.schem__edge polygon { fill: var(--rule-strong); transition: fill .25s; }
.schem__edge text { font-size: 11px; fill: var(--muted); text-anchor: middle; }
.schem__edge.is-active line, .schem__edge.is-active path { stroke: var(--accent); stroke-width: 2.5; }
.schem__edge.is-active polygon { fill: var(--accent); }
.schem__edge.is-active text { fill: var(--accent-text); font-weight: 650; }
.schem__inspect { padding: .6rem .9rem; border-radius: 10px; background: var(--surface); border: 1px solid var(--rule); font-size: .88rem; color: var(--ink-2); line-height: 1.55; display: flex; flex-wrap: wrap; align-items: baseline; gap: .35rem .65rem; }
.schem__inspect.is-selected { border-color: var(--rule-strong); color: var(--ink); }
.schem__inspect-hint { color: var(--muted); font-size: .82rem; }
.schem__inspect-sub { font-family: var(--mono); font-size: .78rem; padding: .08rem .45rem; border-radius: 6px; background: var(--sunken); color: var(--ink-2); }

/* Interactive Tactile Workshop / Try Block */
.try-work { display: grid; gap: .85rem; max-width: 48rem; padding: 1rem 1.2rem; border-radius: 12px; background: var(--surface); border: 1px solid var(--rule-strong); }
.try-work__head { display: flex; justify-content: space-between; align-items: center; gap: .6rem 1rem; flex-wrap: wrap; }
.try-work__title { margin: 0; font-size: 1.05rem; font-weight: 680; }
.try-work__badge { font-family: var(--mono); font-size: .78rem; font-weight: 650; padding: .14rem .56rem; border-radius: 999px; border: 1px solid var(--rule-strong); background: var(--raised); color: var(--muted); }
.try-work__badge.is-done { border-color: var(--ok); color: var(--ok); background: var(--ok-wash); }
.try-work__prompt { margin: 0; font-size: .98rem; color: var(--ink-2); line-height: 1.6; }
.try-work__checks { margin: 0; padding: 0; list-style: none; display: grid; gap: .45rem; }
.try-work__item label { display: grid; grid-template-columns: 1.35rem minmax(0, 1fr); gap: .5rem; align-items: start; cursor: pointer; font-size: .95rem; line-height: 1.5; padding: .3rem .45rem; border-radius: 8px; transition: background-color .2s; }
.try-work__item label:hover { background: var(--raised); }
.try-work__item input { width: 1rem; height: 1rem; margin-top: .28rem; accent-color: var(--ok); cursor: pointer; }
.try-work__item.is-checked span { color: var(--muted); text-decoration: line-through; text-decoration-color: var(--rule-strong); }
.try__pad { border: 1px solid var(--rule); border-radius: 10px; background: var(--raised); padding: .45rem .7rem .65rem; }
.try__pad-sum { cursor: pointer; font-size: .82rem; font-weight: 600; color: var(--muted); user-select: none; }
.try__draft { display: block; width: 100%; min-height: 4.5rem; margin-top: .45rem; padding: .55rem .7rem; border: 1px solid var(--rule-strong); border-radius: 8px; background: var(--surface); font-size: .92rem; line-height: 1.55; resize: vertical; }
.try-work__actions { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.try__hint { margin: 0; padding: .6rem .85rem; border-left: 3px solid var(--ochre); border-radius: 0 8px 8px 0; background: var(--raised); font-size: .9rem; color: var(--ink-2); }
.try__solution { margin: 0; padding: .75rem .95rem; border-left: 3px solid var(--ok); border-radius: 0 8px 8px 0; background: var(--raised); font-size: .92rem; line-height: 1.65; color: var(--ink); }
.try__hint[hidden], .try__solution[hidden] { display: none; }

/* Lanes & Schedule */
.lanes { display: grid; grid-template-columns: minmax(0, 46rem) 300px; gap: 0 2rem; align-items: start; }
.lanes__side { position: sticky; top: .6rem; }
.lanes__now { margin: 0 0 .1rem; font-size: .76rem; color: var(--muted); text-align: center; }
.lanes__expr { display: flex; align-items: center; gap: .6rem 1.4rem; flex-wrap: wrap; margin-bottom: 1.1rem; }
.lanes__code { font-family: var(--mono); font-size: 1.35rem; font-weight: 650; }
.lanes__parts { display: flex; align-items: center; gap: .45rem; font-size: .84rem; color: var(--faint); }
.part { padding: .2rem .7rem; border: 1px solid var(--rule); border-radius: 999px; color: var(--muted); }
.part.is-now { color: var(--accent-text); border-color: var(--accent); background: var(--accent-wash); font-weight: 600; }
.lanes__grid { display: grid; grid-template-columns: minmax(0, 1fr) 5.8rem minmax(0, 1fr); max-width: 46rem; }
.lanes__head { font-size: .82rem; color: var(--muted); padding-bottom: .5rem; border-bottom: 1px solid var(--rule); }
.lanes__head--a { text-align: right; padding-right: 3.2rem; }
.lanes__head--b { padding-left: 3.2rem; }
.lanes__head--mid { text-align: center; font-family: var(--mono); color: var(--ink); font-weight: 600; }
.lcell { min-height: 2.8rem; display: flex; align-items: center; }
.lcell--a { justify-content: flex-end; }
.lcell--mid { justify-content: center; position: relative; }
.lcell--mid::before { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; border-left: 1px solid var(--rule-strong); }
.lrow { display: contents; }
.lrow.is-waiting .lcell > * { opacity: 0; }
.lcell > * { transition: opacity .3s var(--ease); }
.chip { font-size: .9rem; padding: .32rem .78rem; border-radius: 8px; background: var(--raised); border: 1px solid var(--rule); }
.lrow.is-now .chip { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.chip--wait { border-style: dashed; color: var(--muted); }
.chip--fail { border-color: var(--bad); color: var(--bad); background: var(--bad-wash); }
.chip--ok { border-color: var(--ok); color: var(--ok); }
.arrow { flex: 0 0 2.6rem; height: 0; border-top: 1.5px solid var(--ink-2); position: relative; margin: 0 .3rem; }
.arrow::after { content: ""; position: absolute; top: -5px; border: 4.25px solid transparent; }
.arrow--right::after { right: -2px; border-left: 7px solid var(--ink-2); border-right: 0; }
.arrow--left::after { left: -2px; border-right: 7px solid var(--ink-2); border-left: 0; }
.arrow--none { border-top-color: transparent; }
.arrow--none::after { display: none; }
.val { position: relative; z-index: 1; min-width: 2.7rem; text-align: center; font-family: var(--mono); font-size: .92rem; font-weight: 650; padding: .2rem .55rem; border-radius: 8px; background: var(--canvas); border: 1.5px solid var(--ink-2); }
.val--write { border-color: var(--accent); color: var(--accent-text); }
.lanes__verdict { max-width: 46rem; margin: .9rem 0 0; padding-top: .9rem; border-top: 1px solid var(--rule); font-size: 1.12rem; font-weight: 650; }
.lanes__verdict.is-waiting { opacity: 0; }
.lanes__ask { max-width: 46rem; margin-top: .8rem; padding: .8rem 1rem; border: 1px solid var(--rule-strong); border-radius: 10px; background: var(--surface); display: grid; gap: .5rem; }
.lanes__ask[hidden] { display: none; }
.lrow-list { display: contents; }
.lrow--controls .lcell { padding-top: .7rem; }
.sched__bar { display: flex; align-items: center; gap: .6rem 1.2rem; flex-wrap: wrap; margin-bottom: 1rem; }
.goals { display: flex; gap: .5rem; flex-wrap: wrap; margin: 0; padding: 0; list-style: none; font-size: .86rem; }
.goal { display: flex; align-items: center; gap: .4rem; padding: .22rem .7rem; border: 1px solid var(--rule-strong); border-radius: 999px; color: var(--ink-2); }
.goal::before { content: ""; width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid currentColor; }
.goal.is-done { color: var(--ok); border-color: var(--ok); font-weight: 600; }
.goal.is-done::before { background: var(--ok); border-color: var(--ok); }
.sched__result { max-width: 46rem; margin: .9rem 0 0; min-height: 2.8em; font-size: 1.04rem; }

/* Predict, Quiz, Name, Say, Cards */
.predict__q, .quiz__q { font-size: 1.26rem; font-weight: 650; line-height: 1.42; margin: 0 0 1rem; max-width: 42rem; }
.opts { display: grid; gap: .55rem; max-width: 42rem; }
.opt { display: grid; grid-template-columns: 1.6rem minmax(0, 1fr) auto; align-items: center; gap: .6rem; width: 100%; text-align: left; padding: .75rem 1rem; border: 1px solid var(--rule-strong); border-radius: 10px; background: var(--raised); cursor: pointer; font-size: 1rem; }
.opt:hover { border-color: var(--ink-2); }
.opt__key { font-family: var(--mono); font-size: .82rem; color: var(--faint); }
.opt__tag { font-size: .74rem; font-weight: 600; }
.opt.is-picked { border-color: var(--ink); box-shadow: 0 0 0 1px var(--ink); }
.opt.is-right { border-color: var(--ok); box-shadow: 0 0 0 1px var(--ok); }
.opt.is-right .opt__tag { color: var(--ok); }
.opt.is-wrong { border-color: var(--bad); box-shadow: 0 0 0 1px var(--bad); }
.opt.is-wrong .opt__tag { color: var(--bad); }
.opt__why { grid-column: 2 / -1; font-size: .88rem; color: var(--ink-2); }
.reveal { display: flex; gap: .5rem 2.6rem; flex-wrap: wrap; padding-top: .8rem; border-top: 1px solid var(--rule); max-width: 46rem; }
.reveal dl { margin: 0; }
.reveal dt { font-size: .76rem; color: var(--muted); }
.reveal dd { margin: .1rem 0 0; font-size: 1.02rem; font-weight: 600; }
.reveal .is-ok { color: var(--ok); }
.reveal .is-miss { color: var(--bad); }

.name__term { font-family: var(--display); font-size: clamp(2.2rem, 5vw, 3.8rem); line-height: 1.12; font-weight: 720; letter-spacing: -.02em; margin: 0; }
.name__alias { font-family: var(--mono); font-size: .92rem; color: var(--muted); margin: .5rem 0 0; }
.name__line { font-size: 1.24rem; line-height: 1.58; margin: 1.1rem 0 0; max-width: 34em; }
.name__asked { margin: 1.8rem 0 0; padding-top: 1rem; border-top: 1px solid var(--rule); max-width: 42rem; }
.name__asked h4 { font-size: .78rem; font-weight: 600; color: var(--muted); margin: 0 0 .4rem; }
.name__asked ul { margin: 0; padding: 0; list-style: none; font-size: 1rem; color: var(--ink-2); }
.name__asked li { padding: .2rem 0; }

.say__prompt { font-size: 1.42rem; font-weight: 650; line-height: 1.42; margin: 0 0 1.2rem; max-width: 30em; text-wrap: balance; }
.say__row { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.say__clock { font-family: var(--mono); font-size: 1.7rem; font-weight: 600; font-variant-numeric: tabular-nums; min-width: 3.4em; }
.say__points { margin: 1.4rem 0 0; padding: 1rem 0 0; border-top: 1px solid var(--rule); list-style: none; display: grid; gap: .5rem; max-width: 42rem; }
.say__points label { display: grid; grid-template-columns: 1.4rem 1fr; gap: .5rem; align-items: start; cursor: pointer; font-size: 1rem; }
.say__points input { width: 1.05rem; height: 1.05rem; margin-top: .32rem; accent-color: var(--ok); }
.say__score { margin: .8rem 0 0; font-size: .92rem; color: var(--muted); }
.say__model { margin: 1rem 0 0; padding: .9rem 1.1rem; border-left: 3px solid var(--rule-strong); background: var(--surface); font-size: .98rem; line-height: 1.75; max-width: 44rem; }
.cards { display: grid; gap: 0; max-width: 46rem; border-bottom: 1px solid var(--rule); }
.card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .2rem 1rem; align-items: baseline; padding: .9rem 0; border-top: 1px solid var(--rule); }
.card__q { font-size: 1.08rem; font-weight: 600; margin: 0; }
.card__a { grid-column: 1 / -1; margin: 0; color: var(--ink-2); }

.picks { display: flex; gap: .45rem; flex-wrap: wrap; }
.pick { border: 1px solid var(--rule-strong); background: var(--raised); border-radius: 9px; padding: .36rem .85rem; font-size: .94rem; cursor: pointer; }
.pick:hover:not(:disabled) { border-color: var(--ink-2); }
.pick:disabled { cursor: default; color: var(--muted); }
.pick.is-right { border-color: var(--ok); box-shadow: 0 0 0 1px var(--ok); color: var(--ok); font-weight: 600; }
.pick.is-wrong { border-color: var(--bad); box-shadow: 0 0 0 1px var(--bad); color: var(--bad); }
.pick--tool { font-family: var(--mono); font-size: .86rem; }

.recall, .cases { max-width: 50rem; }
.recall__item { display: grid; grid-template-columns: 7.8rem minmax(0, 1fr); gap: .4rem 1.2rem; padding: .9rem 0; border-top: 1px solid var(--rule); }
.recall__have { grid-row: 1 / span 3; font-size: .82rem; color: var(--muted); padding-top: .2rem; }
.recall__q, .cases__text { margin: 0; font-size: 1.06rem; font-weight: 600; line-height: 1.5; }
.recall__why, .cases__why { margin: 0; font-size: .92rem; color: var(--ink-2); }
.recall__score, .cases__score { margin: 0; padding-top: .8rem; border-top: 1px solid var(--rule); font-size: .92rem; color: var(--muted); min-height: 2.2em; }
.cases__item { display: grid; gap: .5rem; padding: .9rem 0; border-top: 1px solid var(--rule); }
.cases__text { font-weight: 400; }
.scene__story { margin: 0 0 1.4rem; font-size: 1.22rem; line-height: 1.7; max-width: 35em; }
.scene__map { max-width: 44rem; transition: opacity .3s var(--ease); }
.scene__map.is-waiting, .scene__row.is-waiting { opacity: 0; }
.scene__head, .scene__row { display: grid; grid-template-columns: minmax(0, 1fr) 2.6rem minmax(0, 1.1fr); align-items: center; }
.scene__head { font-size: .76rem; color: var(--muted); padding-bottom: .4rem; border-bottom: 1px solid var(--rule); }
.scene__row { padding: .58rem 0; border-bottom: 1px solid var(--rule); font-size: 1.02rem; transition: opacity .3s var(--ease); }
.scene__arrow { color: var(--faint); }
.scene__row.is-now .scene__arrow { color: var(--accent); }
.scene__to { font-weight: 600; }
.scene__body.has-picture { display: grid; grid-template-columns: minmax(0, 44rem) 300px; gap: 0 2.4rem; align-items: start; }

.inside { max-width: 50rem; }
.inside__what { margin: 0 0 .6rem; font-size: .86rem; color: var(--muted); }
.inside .code__line { position: relative; font-size: .86rem; line-height: 2.15; }
.code__tag { position: absolute; right: 1rem; top: 50%; transform: translateY(-50%); font-family: var(--font); font-size: .76rem; font-weight: 600; line-height: 1.65; padding: 0 .68rem; border-radius: 999px; background: var(--raised); border: 1px solid var(--rule-strong); }
.code__line.is-focus .code__tag { border-color: var(--accent); color: var(--accent-text); }
.spot { display: grid; grid-template-columns: minmax(0, 46rem) minmax(13rem, 19rem); gap: 0 2rem; align-items: start; }
.spot__q { grid-column: 1 / -1; margin: 0 0 .8rem; font-size: 1.16rem; font-weight: 650; line-height: 1.45; }
.spot__how { margin: .2rem 0 .8rem; font-size: .9rem; color: var(--muted); }
.code.is-pickable .code__line { cursor: pointer; }
.code.is-pickable .code__line:hover { background: var(--sunken); }
.code__line.is-wrong { background: var(--bad-wash); border-left-color: var(--bad); }
.spot__out { margin: 0; font-size: .98rem; line-height: 1.68; color: var(--ink-2); }
.spot__out.is-ok { color: var(--ok); font-weight: 600; }

.choose { max-width: 62rem; }
.choose__head, .choose__row { display: grid; grid-template-columns: 10rem repeat(3, minmax(0, 1fr)); gap: 0 1.5rem; }
.choose__head { font-size: .76rem; color: var(--muted); padding-bottom: .4rem; }
.choose__row { padding: .8rem 0; border-top: 1px solid var(--rule); font-size: .96rem; line-height: 1.5; color: var(--ink-2); transition: opacity .3s var(--ease); }
.choose.is-walking .choose__row:not(.is-now) { opacity: .42; }
.choose__name { font-family: var(--mono); font-weight: 650; color: var(--ink); }
.choose__rule { margin: 0; padding-top: .9rem; border-top: 1px solid var(--rule-strong); font-size: 1.1rem; font-weight: 600; }
.choose__rule.is-waiting { visibility: hidden; }

.decide { max-width: 20rem; padding: 1rem 1.1rem; border: 1px solid var(--rule-strong); border-radius: 12px; background: var(--surface); }
.decide__q { margin: 0; font-weight: 650; font-size: 1.02rem; }
.decide__list { list-style: none; margin: 0; padding: .5rem 0 0 .5rem; }
.decide__branch { position: relative; display: grid; gap: .2rem; padding: .5rem 0 .6rem 1.4rem; border-left: 1.5px solid var(--ink-2); }
.decide__branch:last-child { border-left-color: transparent; }
.decide__branch::before { content: ""; position: absolute; left: -1.5px; top: 0; width: 1rem; height: 1.2rem; border-left: 1.5px solid var(--ink-2); border-bottom: 1.5px solid var(--ink-2); border-bottom-left-radius: 9px; }
.decide__when { font-size: .92rem; color: var(--ink-2); }
.decide__pick { justify-self: start; font-family: var(--mono); font-weight: 650; font-size: .9rem; padding: .18rem .6rem; border: 1.5px solid var(--ink-2); border-radius: 8px; background: var(--raised); }
.decide__eg { font-size: .78rem; color: var(--muted); }
.decide__branch.is-used .decide__pick { border-color: var(--ok); color: var(--ok); }
.decide__branch.is-hit .decide__pick { animation: hit 1.6s var(--ease); }
@keyframes hit { 0%, 55% { box-shadow: 0 0 0 5px var(--ok-wash), 0 0 0 1.5px var(--ok); } 100% { box-shadow: 0 0 0 0 transparent; } }
.slide--split .slide__blocks:has(.decide) { grid-template-columns: minmax(0, 1fr) 20rem; }
.slide--split .block:has(> .decide) { grid-column: 2; position: sticky; top: .6rem; }
.slide--split .block:has(> .decide) ~ .block { grid-column: 1; grid-row: 1; }

.pic { position: relative; width: 300px; height: 300px; flex: none; font-size: 16px; line-height: 1.3; }
.pic__lines { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.pic__arrow { opacity: 0; transition: opacity .25s var(--ease); }
.pic__arrow.is-on { opacity: 1; }
.pic__arrow line { stroke: var(--accent); stroke-width: 1.75; }
.pic__arrow polygon { fill: var(--accent); }
.pic--plain .pic__arrow line { stroke: var(--ink-2); }
.pic--plain .pic__arrow polygon { fill: var(--ink-2); }
.pic__over { position: absolute; left: 0; right: 0; bottom: calc(100% - 38px); display: grid; justify-items: center; gap: 3px; }
.pic__name { font-size: 13px; color: var(--muted); }
.pic__tags { display: grid; justify-items: center; gap: 3px; }
.pic__tags span { font-family: var(--mono); font-size: 12.5px; font-weight: 650; color: var(--ink); padding: 1px 8px; border-radius: 999px; border: 1px solid var(--rule-strong); background: var(--surface); white-space: nowrap; }
.pic__board { position: absolute; left: 90px; top: 44px; width: 120px; height: 62px; display: grid; place-items: center; border: 1.5px solid var(--ink-2); border-radius: 8px; background: var(--raised); }
.pic__board.is-now { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.pic__value { font-family: var(--mono); font-size: 24px; font-weight: 650; line-height: 1.1; text-align: center; padding: 0 4px; }
.pic__board.is-now .pic__value { color: var(--accent-text); }
.pic__hand { position: absolute; top: 146px; width: 64px; height: 38px; display: grid; place-items: center; border: 1px solid var(--rule-strong); border-radius: 8px; background: var(--raised); font-family: var(--mono); font-size: 15px; }
.pic__hand--a { left: 50px; }
.pic__hand--b { left: 186px; }
.pic__hand small { position: absolute; left: 0; right: 0; top: -18px; text-align: center; font-family: var(--font); font-size: 11px; color: var(--faint); }
.pic__hand.is-empty { border-style: dashed; background: none; }
.pic__hand.is-now { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.pic__actor { position: absolute; top: 196px; width: 110px; display: grid; justify-items: center; gap: 3px; }
.pic__actor--a { left: 0; }
.pic__actor--b { left: 190px; }
.pic__figure { width: 44px; height: 40px; fill: var(--raised); stroke: var(--ink-2); stroke-width: 1.5; }
.pic__actor.is-now .pic__figure { stroke: var(--accent); }
.pic__note { font-size: 12px; padding: 2px 8px; border-radius: 7px; border: 1px solid var(--rule-strong); background: var(--raised); white-space: nowrap; }
.pic__note:empty { display: none; }
.pic__note--wait { border-style: dashed; color: var(--muted); }
.pic__note--fail { border-color: var(--bad); color: var(--bad); background: var(--bad-wash); }
.pic__note--ok { border-color: var(--ok); color: var(--ok); }
.pic__action { position: absolute; left: 0; right: 0; top: 138px; text-align: center; font-family: var(--mono); font-weight: 650; font-size: 13px; color: var(--ink); }

.chart { margin: 0; display: grid; grid-template-columns: minmax(0, 44rem) minmax(13rem, 1fr); gap: 0 2rem; align-items: start; }
.chart__cap { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: baseline; gap: .3rem 1rem; font-size: .84rem; color: var(--muted); margin-bottom: .5rem; }
.chart__cap b { font-size: 1rem; color: var(--ink); }
.chart__svg { display: block; width: 100%; height: auto; overflow: visible; }
.chart__grid { stroke: var(--rule); stroke-width: 1; }
.chart__base { stroke: var(--rule-strong); stroke-width: 1; }
.chart__tick { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
.chart__line { fill: none; stroke: var(--s, var(--ink-2)); stroke-width: 2.2; stroke-linejoin: round; stroke-linecap: round; }
.chart__dot { fill: var(--s, var(--ink-2)); stroke: var(--canvas); stroke-width: 2; }
.chart__dot.is-wrong { fill: var(--canvas); stroke: var(--s, var(--ink-2)); }
.chart__series--1, .sbox__s--1 { --s: var(--s1); }
.chart__series--2, .sbox__s--2 { --s: var(--s2); }
.chart__series--3, .sbox__s--3 { --s: var(--s3); }
.chart__series--4, .sbox__s--4 { --s: var(--s4); }
.chart__picks { display: grid; justify-items: start; gap: .4rem; margin-bottom: .8rem; }
.chart__pick { display: inline-flex; align-items: center; gap: .5rem; padding: .24rem .72rem; border: 1px solid var(--rule-strong); border-radius: 999px; background: none; font-size: .84rem; cursor: pointer; }
.chart__pick[aria-pressed="true"] { border-color: var(--ink); font-weight: 600; background: var(--raised); }
.chart__read { margin: 0 0 .8rem; font-size: .95rem; line-height: 1.6; color: var(--ink-2); }

.voice { border-top: 1px solid var(--rule); padding: 1rem clamp(1rem, 4vw, 3.4rem) 1.1rem; }
.voice__inner { max-width: 68rem; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1.6rem; align-items: end; }
.voice__line { margin: 0; font-size: 1.16rem; line-height: 1.62; min-height: 3.4em; max-width: 45em; }
.voice__line > span { display: block; }
.voice__line.is-fresh > span { animation: line-in .3s var(--ease); }
.voice__nav { display: flex; gap: .5rem; }
.voice__key { margin: .4rem 0 0; font-size: .8rem; color: var(--muted); }
@keyframes line-in { from { opacity: 0; transform: translateY(5px); } }

.term { border-bottom: 1.5px dotted var(--ochre); cursor: help; border-radius: 2px; }
.term:hover, .term:focus-visible { background: var(--accent-wash); }
.tip { position: fixed; z-index: 20; max-width: 22rem; padding: .6rem .8rem; border-radius: 10px; background: var(--ink); color: var(--canvas); font-size: .86rem; line-height: 1.5; }
.tip[hidden] { display: none !important; }
.tip b { display: block; font-size: .8rem; opacity: .75; margin-bottom: .1rem; }
.notes, .kbd, .toc { position: relative; }
.notes__list { position: absolute; right: 0; top: calc(100% + .5rem); z-index: 15; width: min(22rem, 86vw); margin: 0; padding: .7rem 1rem .7rem 2rem; background: var(--raised); border: 1px solid var(--rule-strong); border-radius: 12px; font-size: .86rem; color: var(--ink); line-height: 1.5; }
.notes__list[hidden], .kbd__pop[hidden], .toc__pop[hidden] { display: none !important; }
.notes__list .is-empty { list-style: none; margin-left: -1rem; color: var(--muted); }
.toc__btn { display: inline-flex; align-items: center; gap: .25rem; font-size: .78rem; color: var(--muted); user-select: none; }
.toc__pop { position: absolute; right: 0; top: calc(100% + .5rem); z-index: 17; width: min(23rem, 90vw); max-height: min(68vh, 26rem); overflow-y: auto; padding: .65rem .7rem; background: var(--raised); border: 1px solid var(--rule-strong); border-radius: 12px; color: var(--ink); scrollbar-width: thin; }
.toc__title { margin: 0 0 .45rem; padding: 0 .35rem; font-size: .76rem; font-weight: 700; color: var(--muted); }
.toc__list { margin: 0; padding: 0; list-style: none; display: grid; gap: .2rem; }
.toc__item { display: grid; grid-template-columns: 1.8rem minmax(0, 1fr) auto; align-items: baseline; gap: .45rem; width: 100%; text-align: left; padding: .38rem .5rem; border: 1px solid transparent; border-radius: 8px; background: none; color: var(--ink-2); font-size: .84rem; line-height: 1.38; cursor: pointer; }
.toc__item:hover { background: var(--surface); color: var(--ink); }
.toc__item.is-visited .toc__num { color: var(--ok); }
.toc__item.is-now { background: var(--accent-wash); border-color: var(--accent); color: var(--ink); font-weight: 650; }
.toc__item.is-now .toc__num { color: var(--accent-text); font-weight: 700; }
.toc__num { font-family: var(--mono); font-size: .76rem; color: var(--faint); }
.toc__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toc__beat { font-size: .7rem; padding: .06rem .42rem; border-radius: 999px; background: var(--sunken); color: var(--muted); white-space: nowrap; }
.kbd__btn { font-family: var(--mono); font-weight: 650; padding-inline: .52rem; }
.kbd__pop { position: absolute; right: 0; top: calc(100% + .5rem); z-index: 16; width: min(21rem, 88vw); padding: .75rem .95rem; background: var(--raised); border: 1px solid var(--rule-strong); border-radius: 12px; color: var(--ink); font-size: .83rem; line-height: 1.45; }
.kbd__title { margin: 0 0 .5rem; font-size: .78rem; font-weight: 700; color: var(--muted); }
.kbd__list { margin: 0; display: grid; gap: .4rem; }
.kbd__row { display: flex; justify-content: space-between; align-items: baseline; gap: .8rem; margin: 0; }
.kbd__keys { font-family: var(--mono); font-size: .75rem; font-weight: 600; padding: .1rem .42rem; border-radius: 5px; background: var(--sunken); border: 1px solid var(--rule-strong); color: var(--ink); white-space: nowrap; }
.kbd__desc { margin: 0; text-align: right; color: var(--ink-2); }
.sh-sel-pill { position: fixed; z-index: 50; padding: .34rem .76rem; border-radius: 999px; border: 1px solid var(--rule-strong); background: var(--ink); color: var(--canvas); box-shadow: 0 3px 12px rgba(0, 0, 0, .28); font-size: .78rem; font-weight: 600; cursor: pointer; }
.sh-sel-pill[hidden] { display: none !important; }
.print-sheet { display: none; }

@media (max-width: 900px) {
  .top { grid-template-columns: minmax(0, 1fr) auto; padding: .5rem .9rem; }
  .top__title { display: none; }
  .beat:not(.is-now) { font-size: 0; gap: 0; padding: .3rem .22rem; }
  .slide--split .slide__blocks, .exp__body, .sbox__body, .hook__meta, .spot, .chart, .lanes, .scene__body.has-picture { grid-template-columns: minmax(0, 1fr); }
  .lanes__side { display: none; }
  .choose__head { display: none; }
  .choose__row { grid-template-columns: minmax(0, 1fr); gap: .2rem; }
  .recall__item { grid-template-columns: minmax(0, 1fr); }
  .recall__have { grid-row: auto; }
}
@media (max-width: 640px) {
  .notes__list, .toc__pop, .kbd__pop { position: fixed; left: .65rem; right: .65rem; top: 3.1rem; width: auto; max-width: none; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto !important; }
  *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; }
}
@media print {
  :root, :root[data-theme="dark"] {
    --canvas: #ffffff; --surface: #f7f6f2; --raised: #ffffff; --sunken: #efede8;
    --ink: #141210; --ink-2: #2e2a24; --muted: #575047; --faint: #6e675e;
    --rule: #00000024; --rule-strong: #0000004d;
    color-scheme: light;
  }
  html, body { height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; display: block !important; background: #ffffff !important; color: #141210 !important; font-size: 11.5pt; }
  .top { display: block; padding: 0 0 .55rem; margin-bottom: .9rem; border-bottom: 1.5px solid var(--rule-strong); }
  .top__title { display: block !important; font-size: 1.05rem; font-weight: 700; color: var(--ink); white-space: normal; overflow: visible; }
  .beats, .top__tools, .voice__nav, .sh-sel-pill, .tip, .kbd__pop, .toc__pop, .sbox__toolbar, .sbox__step, .mtx__actions, .schem__bar, .try-work__actions, .exp__hand { display: none !important; }
  .stage { overflow: visible !important; height: auto !important; max-height: none !important; padding: 0 !important; }
  body.has-print-sheet > .stage, body.has-print-sheet > .voice { display: none !important; }
  body.has-print-sheet > .print-sheet { display: block !important; }
  .print-sheet__slide { padding: .85rem 0 1.25rem; border-bottom: 1px solid var(--rule); break-inside: avoid-page; }
  .print-sheet__num { font-family: var(--mono); font-size: .74rem; color: var(--muted); margin-bottom: .2rem; }
  .print-sheet__say { margin: .65rem 0 0; padding: .42rem .75rem; border-left: 2.5px solid var(--rule-strong); background: var(--surface); font-size: .92rem; color: var(--ink-2); }
  .slide { max-width: none; padding-top: .4rem; }
  .slide--hook .slide__title { margin-top: .2rem; font-size: 1.75rem; }
  .code__scroll, .schem__canvas, .sh-math-block { max-height: none !important; overflow: visible !important; }
  .block.is-waiting, .lrow.is-waiting .lcell > *, .lanes__verdict.is-waiting, .scene__map.is-waiting, .scene__row.is-waiting, .choose__rule.is-waiting { opacity: 1 !important; visibility: visible !important; transform: none !important; pointer-events: auto !important; }
  .card__a[hidden], .say__model[hidden], .say__points[hidden], .recall__why[hidden], .cases__why[hidden], .try__hint[hidden], .try__solution[hidden] { display: block !important; }
  .mtx__veil { display: none !important; }
  .callout, .code, .sbox__plot, .schem__canvas, .mtx__card, .try-work, .card, .decide { break-inside: avoid; page-break-inside: avoid; }
  .voice { border-top: 1px solid var(--rule); padding: .6rem 0 0; }
}
`.trim();
