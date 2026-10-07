/* The alpha acceptance record (docs/plans/unified-job-runtime/s6-7-acceptance.md) cannot drift from what it summarises: its numbers are the inventory's, every work package of
   sprints-2-6.md has a line with a merged PR and a SHA, every switch is counted, the pending gates stay pending, and it names no released version. A document check, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MIGRATION_SWITCHES } from '../lib/runtime-config.js';

const DIR = new URL('../docs/plans/unified-job-runtime/', import.meta.url);
const doc = await readFile(new URL('s6-7-acceptance.md', DIR), 'utf8');
const plan = await readFile(new URL('sprints-2-6.md', DIR), 'utf8');
const inventory = JSON.parse(await readFile(new URL('s1-7-legacy-exceptions.json', DIR), 'utf8'));

test('the numbers of the exceptions section are the inventory\'s', () => {
  const dispositions = {};
  for (const group of ['entries', 'starts']) for (const row of inventory[group]) for (const site of row.sites) dispositions[site.disposition] = (dispositions[site.disposition] || 0) + 1;
  assert.equal(dispositions.migrate ?? 0, 0, 'no site is waiting to be migrated');
  const asked = /模型形状的调用点 (\d+) 行、后台启动点 (\d+) 行（合计 (\d+) 个已审查的位置）、边界例外 (\d+) 行、模型获取例外 (\d+) 行/.exec(doc);
  assert.ok(asked, 'the counts line is there');
  assert.deepEqual(asked.slice(1).map(Number), [inventory.entries.length, inventory.starts.length, (dispositions['delete-s6-2'] || 0) + (dispositions.exception || 0), inventory.boundaries.length, inventory.hostModelAccess.length]);
  assert.match(doc, new RegExp(`\\| \`migrate\`[^\\n]*\\| \\*\\*0\\*\\* \\|`));
  assert.match(doc, new RegExp(`\\| \`delete-s6-2\`[^\\n]*\\| ${dispositions['delete-s6-2']} \\|`));
  assert.match(doc, new RegExp(`\\| \`exception\`[^\\n]*\\| ${dispositions.exception} \\|`));
  assert.match(doc, new RegExp(`清单里 \\*\\*${inventory.managedDefinitions.length} 个\\*\\*定义是 \`managed\``));
  for (const row of [...inventory.entries, ...inventory.starts]) assert.ok(doc.includes(`\`${row.file}\``), `${row.file} is listed`);
});

test('no exception is scheduled for a step that is over: nothing is left to "S6-5", and the instant rows say what was decided', () => {
  const text = JSON.stringify(inventory);
  assert.ok(!/"removeAt": ?"S6-5|owner decision at S6-5|until they read the kernel|scheduler replaces it/.test(text), 'a stale schedule came back');
  const instant = [...inventory.entries, ...inventory.starts].filter(row => /decided in S6-5a/.test(String(row.removeAt)));
  assert.equal(instant.length, 8, 'the eight instant request rows record the S6-5a decision');
  for (const row of inventory.boundaries.filter(item => /^retained:/.test(item.removeAt))) assert.ok(row.reason.length > 20, row.file);
});

test('every work package of the plan has a line with a merged PR and its SHA, and the earlier phases do too', () => {
  const steps = [...plan.matchAll(/^### U\d+\. (S\d-\d+)$/gm)].map(match => match[1]).filter(step => step !== 'S6-7');
  const table = doc.slice(doc.indexOf('## 2. 工作包'), doc.indexOf('## 3. 没有合并'));
  for (const step of [...steps, 'S1-0', 'S1-1', 'S1-2', 'S1-3', 'S1-4', 'S1-5', 'S1-6', 'S1-7']) {
    const line = table.split('\n').find(row => row.startsWith(`| ${step} |`));
    assert.ok(line, `${step} has a line`);
    assert.match(line, /\[#\d+\]\(https:\/\/github\.com\/EricWang1358\/dsh-web-studyhub\/pull\/\d+\) `[0-9a-f]{8}`/, `${step}: a merged PR and its SHA`);
  }
});

test('the switches are counted, the pending gates stay pending and no version is recorded as released', () => {
  assert.match(doc, new RegExp(`${Object.keys(MIGRATION_SWITCHES).length} 个迁移开关\\*\\*全部默认关闭`));
  const gates = doc.slice(doc.indexOf('## 8. 待定门禁'), doc.indexOf('## 9.'));
  for (const gate of ['真实模型质量抽检', 'alpha 版本号 / tag / GitHub 发布', '真实安装包']) assert.match(gates, new RegExp(`${gate.replace(/[/.]/g, '\\$&')}[^\\n]*\\*\\*PENDING`), `${gate} is pending`);
  assert.deepEqual([...new Set(doc.match(/\bv\d+\.\d+\.\d+\b/g))], ['v2.7.1'], 'the only release the record names is the fixed rollback target');
  assert.ok(!/已发布为|released as|发布了 alpha/i.test(doc));
  assert.match(doc, /## 9\. 宿主与浏览器证据\s+全文见 \[s6-7-host-evidence\.md\]/, 'the host evidence is linked, not summarised from memory');
});
