/* Build the StudyHub case study.
     npm run case-study                 rebuilds docs/case-study/studyhub-case-study.pdf and the facts snapshot (needs Chromium for the PDF)
     node scripts/case-study/build.mjs --out some.pdf [--html some.html] [--write-facts] [--facts-only]
   The numbers come from the code (facts.mjs); the prose is in content.mjs. docs/case-study/README.md says when to rebuild. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { REPO, computeFacts } from './facts.mjs';
import { buildHtml } from './content.mjs';
import { SNAPSHOT, snapshotText } from './snapshot.mjs';

const option = (name) => { const at = process.argv.indexOf(name); return at < 0 ? null : process.argv[at + 1]; };
const flag = (name) => process.argv.includes(name);

async function main() {
  const facts = await computeFacts();
  if (flag('--write-facts') || flag('--facts-only')) {
    await mkdir(dirname(SNAPSHOT), { recursive: true });
    await writeFile(SNAPSHOT, snapshotText(facts));
    console.log('wrote', SNAPSHOT);
  }
  if (flag('--facts-only')) return;
  const html = buildHtml(facts);
  const htmlPath = option('--html');
  if (htmlPath) { await mkdir(dirname(resolve(htmlPath)), { recursive: true }); await writeFile(resolve(htmlPath), html, 'utf8'); console.log('wrote', htmlPath); }
  const out = resolve(option('--out') || resolve(REPO, 'output/case-study/studyhub-case-study.pdf'));
  await mkdir(dirname(out), { recursive: true });
  const { launchChromium } = await import('../qa/browser.mjs');
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const band = (inner) => `<div style="width:100%;padding:0 20mm;font-family:'Times New Roman',serif;font-size:8.5pt;font-weight:bold;font-style:italic;color:#000;">${inner}</div>`;
    await page.pdf({
      path: out, format: 'A4', printBackground: true, displayHeaderFooter: true,
      headerTemplate: band('<div style="display:flex;justify-content:space-between;border-bottom:1px solid #000;padding-bottom:1px;"><span>StudyHub case study (self-study, unofficial)</span><span>page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>'),
      footerTemplate: band(`<div style="border-top:1px solid #000;padding-top:2px;line-height:1.25;">Self-study material:<br>Architecting Scalable Systems, StudyHub ${facts.volatile.version}</div>`),
      margin: { top: '22mm', bottom: '24mm', left: '20mm', right: '20mm' },
    });
  } finally { await browser.close(); }
  console.log('wrote', out);
}

await main();
