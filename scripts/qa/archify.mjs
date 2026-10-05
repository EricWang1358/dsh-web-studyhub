/* npm run qa:archify [-- --lang zh|en --theme dark|light --width 1280|420 --accent jade --out <dir>]
   The Archify companion (docs/companions.md) in the browser preview, on a seeded temporary library with the fake model. The walk is the learner's:
     知识骨架 page: the recommendation card at the end of the page (copy the install command, 以后再说 is remembered) → open the saved skeleton → 用 Archify 画这门课的知识骨架 (the hand-off text
     the conversation would receive) → the agent's reply is simulated by calling skeleton.diagram.attach with a self-contained interactive HTML file written into a temporary workspace (nodes drawn by an
     inline script, an outside link, a probe of the parent page) → the list → 打开: the isolated viewer (the script runs inside, parent.document throws, the page cannot read the frame, the outside link does
     not navigate anything, Esc closes) → the skeleton changes: 骨架已更新，图可能过期 → 删除 (the shared confirmation) → the file is gone.
   Every claim is checked against the page and the library, not just photographed. Fake model, Chromium, every key/token/base-url variable removed. One screenshot per step and <out>/summary.json. */
/* global document, localStorage */
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { StudyService } from "../../lib/service.js";
import { previewCall } from "../preview-server.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

const quote = "Retries amplify load and replicas absorb failures when properly isolated.";
const card = (id, topic) => ({
  id, kind: "quiz", topic, objective: `why ${id}`, prompt: `Why does ${id} need isolation?`, answer: "A", hint: "h", misconception: "m",
  explanation: "Isolation keeps a failure local so that it cannot cascade into an outage, which is why it exists.",
  citations: [{ sourceId: "s1", quote }],
  options: [{ id: "a", text: "A", correct: true, explanation: "yes" }, { id: "b", text: "B", correct: false, explanation: "no" }, { id: "c", text: "C", correct: false, explanation: "no" }],
});
const NODES = [
  ["availability", "Availability", "The share of time a service answers requests.", null, ["a1"]],
  ["redundancy", "Redundancy", "Extra copies so one failure does not stop the service.", "availability", ["a2"]],
  ["failover", "Failover", "Switching to a standby when the primary fails.", "redundancy", ["a3"]],
  ["isolation", "Isolation", "Limiting how far one failure can spread.", "availability", ["a4"]],
  ["retries", "Retries", "Trying again after a failure; amplifies load if unbounded.", null, ["a5"]],
  ["backoff", "Backoff", "Waiting longer between retries to protect the service.", "retries", ["a6"]],
];

/** One self-contained interactive page, like a skill would write it: nodes drawn by an inline script, an outside link, a probe of the parent. */
const sampleDiagram = (title) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { margin: 0; font: 15px system-ui, sans-serif; background: #f6f3ec; color: #1f1d1a; }
  header { padding: 14px 20px; border-bottom: 1px solid #d9d3c4; display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0; } a { color: #8a3b1f; }
  svg { display: block; width: 100%; height: 360px; }
  .node { cursor: pointer; } .node rect { fill: #fffdf8; stroke: #8a3b1f; stroke-width: 1.5; rx: 8; } .node.on rect { fill: #f4d9cb; }
  .node text { font-size: 13px; text-anchor: middle; dominant-baseline: middle; pointer-events: none; }
  .edge { stroke: #8a8374; stroke-width: 1.4; fill: none; marker-end: url(#arrow); }
  #detail, #probe { padding: 8px 20px; margin: 0; }
</style></head>
<body>
<header><h1>${title}</h1><a id="outside" href="https://tt-a1i.github.io/archify/gallery.html" target="_blank">Examples</a></header>
<svg id="canvas" viewBox="0 0 900 360" role="img" aria-label="${title}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#8a8374"/></marker></defs></svg>
<p id="detail">Click a concept.</p>
<p id="probe"></p>
<script>
  var nodes = [["availability",450,50],["redundancy",230,150],["failover",110,270],["isolation",670,150],["retries",450,230],["backoff",450,320]];
  var edges = [["availability","redundancy"],["redundancy","failover"],["availability","isolation"],["retries","backoff"],["isolation","retries"]];
  var svg = document.getElementById("canvas"), NS = "http://www.w3.org/2000/svg", pos = {};
  nodes.forEach(function (n) { pos[n[0]] = n; });
  edges.forEach(function (e) { var a = pos[e[0]], b = pos[e[1]], l = document.createElementNS(NS, "line"); l.setAttribute("class", "edge"); l.setAttribute("x1", a[1]); l.setAttribute("y1", a[2] + 18); l.setAttribute("x2", b[1]); l.setAttribute("y2", b[2] - 18); svg.appendChild(l); });
  nodes.forEach(function (n) {
    var g = document.createElementNS(NS, "g"); g.setAttribute("class", "node"); g.setAttribute("data-id", n[0]);
    var r = document.createElementNS(NS, "rect"); r.setAttribute("x", n[1] - 70); r.setAttribute("y", n[2] - 18); r.setAttribute("width", 140); r.setAttribute("height", 36);
    var t = document.createElementNS(NS, "text"); t.setAttribute("x", n[1]); t.setAttribute("y", n[2]); t.textContent = n[0];
    g.appendChild(r); g.appendChild(t); g.addEventListener("click", function () { document.querySelectorAll(".node").forEach(function (x) { x.classList.remove("on"); }); g.classList.add("on"); document.getElementById("detail").textContent = "Selected: " + n[0]; });
    svg.appendChild(g);
  });
  var probe = document.getElementById("probe");
  try { var read = parent.document.title; probe.textContent = "parent: READABLE " + read; } catch (error) { probe.textContent = "parent: blocked (" + error.name + ")"; }
  document.body.setAttribute("data-ran", "1");
</script></body></html>`;

async function seed(root, options) {
  const service = new StudyService(root);
  await service.call("source.add", { id: "s1", title: "Reliability", text: quote });
  await service.call("draft.save", { deck: { id: "arch", title: "Reliability", course: "QA", cards: ["a1", "a2", "a3", "a4", "a5", "a6"].map((id, i) => card(id, NODES[i][1])) } });
  await service.call("draft.publish", { id: "arch" });
  const saved = await service.call("skeleton.save", { skeleton: { title: options.lang === "zh" ? "可靠性骨架" : "Reliability outline", scope: [{ deckId: "arch" }],
    overview: "Availability depends on redundancy and isolation; retries need backoff.",
    nodes: NODES.map(([id, term, meaning, parent, cards]) => ({ id, term, meaning, ...(parent ? { parent } : {}), cards: cards.map((cardId) => ({ deckId: "arch", cardId })) })),
    relations: [{ from: "redundancy", to: "failover", type: "prerequisite" }, { from: "isolation", to: "retries", type: "contrasts", note: "limits vs amplifies" }, { from: "retries", to: "backoff", type: "causes" }] } });
  service.dispose();
  // The preview stands in for one DSH session whose workspace is the library folder, and the host (lib/host.js) always sets the workspace
  // of skeleton.diagram.attach from that session: the file is written there, and a decoy outside it must be refused whatever the caller says.
  const workspace = root, elsewhere = join(options.out, "work", "elsewhere");
  await mkdir(join(workspace, "diagrams"), { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  await writeFile(join(workspace, "diagrams", "reliability.html"), sampleDiagram("Reliability map"));
  await writeFile(join(elsewhere, "secret.html"), sampleDiagram("Not yours"));
  options.skeletonId = saved.id;
  options.workspace = workspace;
  options.elsewhere = elsewhere;
}

export function parseArgs(argv) {
  const base = parseQaArgs(argv, "archify", { accent: "jade" });
  return { ...base, width: Number(base.width) === 1440 && !argv.includes("--width") ? 1280 : base.width };
}

export async function runArchifyQa(options) {
  return runQa({ name: "archify", options, localStorageSeed: { "study-interface": JSON.stringify({ accent: options.accent }) },
    seed: (root) => seed(root, options),
    async run({ page, server, library, t, step, check, summary }) {
      const call = (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: options.lang });
      const { skeletonId, workspace } = options, facts = {};
      summary.facts = facts;
      const noOverflow = async (label) => { const probe = await page.evaluate(overflowProbe); assert.ok(probe.scrollWidth <= probe.clientWidth + 1, `horizontal overflow on ${label}: ${JSON.stringify(probe)}`); };
      const goto = async (nav) => { const entry = page.locator(`[data-tour="nav-${nav}"]`).first(); await entry.waitFor({ state: "attached" }); await entry.dispatchEvent("click"); await sleep(900); };
      const card = page.locator("[data-archify-card]");

      await step("skeleton-page-card", async () => {
        await goto("skeleton");
        await page.locator(".sk-saved-item").first().waitFor({ timeout: 20000 });
        await card.waitFor();
        await card.scrollIntoViewIfNeeded();
        const text = await card.innerText();
        facts.card = text.split("\n").filter(Boolean);
        for (const part of ["Archify", "MIT", "dsh plugin --profile web add @tt-a1i/archify-dsh@1.0.0"]) assert.ok(text.includes(part), part);
        const links = await card.locator("a").evaluateAll((anchors) => anchors.map((a) => [a.href, a.target, a.rel]));
        assert.deepEqual(links.map(([href]) => href), ["https://github.com/tt-a1i/archify", "https://tt-a1i.github.io/archify/gallery.html"]);
        assert.ok(links.every(([, target, rel]) => target === "_blank" && /noopener/.test(rel)));
        await noOverflow("the skeleton page with the card");
      });
      await step("card-copy", async () => {
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
        await card.getByRole("button", { name: t("复制", "Copy"), exact: true }).click();
        await sleep(300);
        facts.copied = await card.getByRole("button").evaluateAll((buttons) => buttons.map((b) => b.textContent.trim()));
        await noOverflow("the card after copying");
      });
      await step("open-skeleton-handoff-button", async () => {
        await page.locator(".sk-saved-item").first().click();
        await page.locator(".sk-view").waitFor();
        const button = page.getByRole("button", { name: t("用 Archify 画这门课的知识骨架", "Draw this outline with Archify"), exact: true });
        await button.scrollIntoViewIfNeeded();
        await button.click();
        await sleep(600);
        const noticeText = await page.locator(".sh-toast, [role=status]").allInnerTexts();
        facts.notice = noticeText.join(" | ").slice(0, 700);
        await noOverflow("the open skeleton");
      });
      // The preview has no conversation composer, so the prompt goes to the clipboard and a toast says so; let it go before the next pictures.
      await check("the hand-off toast goes by itself", () => page.locator(".sh-toast").first().waitFor({ state: "detached", timeout: 15000 }));

      // The agent's reply is simulated: the file it wrote is registered with the new operation (the host would add the session workspace).
      await step("agent-attaches-the-diagram", async () => {
        const attached = await call("skeleton.diagram.attach", { id: skeletonId, path: "diagrams/reliability.html", workspace });
        facts.attached = { id: attached.diagram.id, bytes: attached.diagram.bytes, title: attached.diagram.title, unchanged: attached.unchanged };
        const again = await call("skeleton.diagram.attach", { id: skeletonId, path: join(workspace, "diagrams", "reliability.html"), workspace });
        assert.equal(again.unchanged, true, "the same file twice is one diagram");
        // the caller names a wider workspace, the host ignores it: the session's own folder is the only one that counts
        await assert.rejects(call("skeleton.diagram.attach", { id: skeletonId, path: join(options.elsewhere, "secret.html"), workspace: options.elsewhere }), /workspace or the library|工作目录或学习库/);
        facts.diagramId = attached.diagram.id;
        await page.locator(".sk-diagrams__row").first().waitFor({ timeout: 30000 });
        assert.equal(await page.locator(".sk-diagrams__row").count(), 1);
        await page.locator(".sk-diagrams").evaluate((element) => element.scrollIntoView({ block: "start" }));
        await noOverflow("the list of diagrams");
      });
      await step("viewer-isolated-frame", async () => {
        await page.locator(".sk-diagrams__row").first().getByRole("button", { name: t("打开", "Open"), exact: true }).click();
        const dialog = page.locator("dialog[open]").filter({ has: page.locator("iframe.sk-diagram-frame") });
        await dialog.waitFor();
        const handle = await dialog.locator("iframe.sk-diagram-frame").waitFor().then(() => dialog.locator("iframe.sk-diagram-frame").elementHandle());
        const attributes = await handle.evaluate((frame) => ({ sandbox: frame.getAttribute("sandbox"), hasSrc: frame.hasAttribute("src"), referrer: frame.getAttribute("referrerpolicy"), csp: frame.getAttribute("csp"),
          // the page cannot read into the frame: an opaque origin gives no document
          contentDocument: frame.contentDocument === null ? "null" : "READABLE", contentWindowDocument: (() => { try { return frame.contentWindow.document ? "READABLE" : "null"; } catch (error) { return `blocked (${error.name})`; } })() }));
        facts.frame = attributes;
        assert.equal(attributes.sandbox, "allow-scripts");
        assert.equal(attributes.hasSrc, false);
        assert.equal(attributes.contentDocument, "null");
        assert.match(attributes.contentWindowDocument, /blocked/);
        const frame = await handle.contentFrame();
        await frame.waitForSelector("body[data-ran='1']", { timeout: 10000 });
        facts.drawn = await frame.locator(".node").count();
        assert.equal(facts.drawn, 6, "the inline script ran inside the frame and drew its nodes");
        facts.probe = (await frame.locator("#probe").innerText()).trim();
        assert.match(facts.probe, /blocked/, "parent.document throws inside the frame");
        await frame.locator(".node[data-id=redundancy]").click();
        assert.equal((await frame.locator("#detail").innerText()).trim(), "Selected: redundancy", "the diagram is interactive");
        const before = page.url();
        await frame.locator("#outside").click({ noWaitAfter: true }).catch(() => {});
        await sleep(600);
        assert.equal(page.url(), before, "an outside link does not navigate the page");
        assert.ok(await frame.locator(".node").count() === 6, "nor the frame: the diagram is still there");
        assert.equal(await dialog.locator(".sh-inline--error").count(), 0, "no failure message in the viewer");
        const note = await dialog.innerText();
        assert.ok(note.includes(t("这是外部生成的图，在隔离窗口里显示", "This diagram was made outside StudyHub and is shown in an isolated window")));
        const box = await handle.boundingBox();
        facts.frameBox = box;
        assert.ok(box.width > Math.min(options.width * 0.85, 900) && box.height > 250, JSON.stringify(box));
        await noOverflow("the viewer");
      });
      await step("viewer-esc-closes", async () => {
        await page.locator("dialog[open] .sh-dialog__close").first().focus();
        await page.keyboard.press("Escape");
        await sleep(500);
        assert.equal(await page.locator("dialog[open]").count(), 0, "Escape closes the viewer");
        facts.focusAfterClose = await page.evaluate(() => document.activeElement?.textContent?.trim() || document.activeElement?.tagName);
      });
      await step("skeleton-changed-stale", async () => {
        await call("skeleton.patch", { id: skeletonId, ops: [{ op: "node.add", node: { id: "timeouts", term: "Timeouts", meaning: "Stop waiting on a slow dependency.", parent: "isolation", cards: [] } }] });
        await page.locator(".sk-diagrams__row .sh-badge").first().waitFor({ timeout: 30000 });
        facts.stale = (await page.locator(".sk-diagrams__row").first().innerText()).replace(/\s+/g, " ");
        assert.ok(facts.stale.includes(t("骨架已更新，图可能过期", "The outline changed; this diagram may be out of date")));
        await noOverflow("the stale note");
      });
      await step("delete-confirm", async () => {
        await page.locator(".sk-diagrams__row").first().getByRole("button", { name: t("删除", "Delete"), exact: true }).click();
        await page.locator("dialog[open] .sh-dialog__footer").waitFor();
        facts.confirm = (await page.locator("dialog[open]").innerText()).replace(/\s+/g, " ");
        await noOverflow("the delete confirmation");
      });
      await step("deleted", async () => {
        await page.locator("dialog[open] .sh-dialog__footer .sh-btn--danger").click();
        await page.locator(".sk-diagrams__row").waitFor({ state: "detached", timeout: 20000 });
        const listed = await call("skeleton.diagram.list", { id: skeletonId });
        assert.deepEqual(listed.diagrams, []);
        await assert.rejects(access(join(library, "skeleton-diagrams", skeletonId, `${facts.diagramId}.html`)), /ENOENT/);
        await access(join(workspace, "diagrams", "reliability.html"));
        await noOverflow("the skeleton after the delete");
      });
      // The empty state of the page: no outline at all. Deleting the skeleton removes its diagram folder too, and the page says Archify can draw it once there is one.
      await step("empty-state", async () => {
        await call("skeleton.diagram.attach", { id: skeletonId, path: "diagrams/reliability.html" });
        await page.locator(".sk-saved-item--selected").click(); // close it first, as the learner would: deleting the open skeleton from elsewhere is the page's quiet "stale" path
        await call("skeleton.delete", { id: skeletonId });
        await assert.rejects(access(join(library, "skeleton-diagrams", skeletonId)), /ENOENT/);
        await page.locator(".sk-saved-item").first().waitFor({ state: "detached", timeout: 30000 });
        const empty = page.locator('[data-tour="skeleton-main"]');
        await empty.waitFor({ timeout: 30000 });
        facts.empty = (await empty.innerText()).replace(/\s+/g, " ");
        assert.ok(facts.empty.includes("Archify"), facts.empty);
        await empty.evaluate((element) => element.scrollIntoView({ block: "start" }));
        await noOverflow("the empty state");
      });
      await step("card-later", async () => {
        await card.scrollIntoViewIfNeeded();
        await card.getByRole("button", { name: t("以后再说", "Maybe later"), exact: true }).click();
        await sleep(400);
        assert.equal(await card.count(), 0, "the card goes");
        facts.stored = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("study-archify")));
        await page.reload();
        await page.locator("aside, nav").first().waitFor();
        await goto("skeleton");
        await page.locator('[data-tour="skeleton-main"]').waitFor({ timeout: 20000 });
        assert.equal(await card.count(), 0, "and stays away after a reload");
        await noOverflow("the page without the card");
      });
    } });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseArgs(process.argv.slice(2)), summary = await runArchifyQa(options);
    finishCli("Archify", options, summary);
  } catch (error) {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 2;
  }
}
