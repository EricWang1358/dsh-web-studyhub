// Build the existing landing page as two standalone static pages, without CDN requests.
import { build } from 'esbuild';
import { parse, serialize } from 'parse5';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderContent } from '../site/content.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export const SITE_OUTPUT = resolve(repositoryRoot, 'output/site-dist');
export async function buildSite({ outdir = SITE_OUTPUT } = {}) {
  const { version } = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid package version for the site');
  const source = (await readFile(join(repositoryRoot, 'site/index.html'), 'utf8')).replaceAll('2.5.10', version);
  await mkdir(join(outdir, 'assets'), { recursive: true });
  await build({ absWorkingDir: repositoryRoot, entryPoints: ['site/demo.mjs'], bundle: true, platform: 'browser',
    format: 'iife', target: 'es2020', minify: true, outfile: join(outdir, 'assets/site-demo.js') });
  const images = new Set(), pages = [];
  for (const lang of ['zh', 'en']) {
    let html = source.replace(/<main(?:\s[^>]*)?>[\s\S]*?<\/main>/, renderContent(lang).replaceAll('2.5.10', version));
    html = html.replace(/<html lang="[^"]*">/, `<html lang="${lang === 'en' ? 'en' : 'zh-CN'}">`)
      .replace(/<title>[\s\S]*?<\/title>/, `<title>StudyHub ${version} — ${lang === 'en' ? 'Learn from your own sources' : '自己的资料，扎实地学'}</title>`);
    if (lang === 'en') {
      html = html.replace(/<meta name="description"[^>]*>/, `<meta name="description" content="Turn your materials, recordings and existing questions into practice you can check against the source. DSH study plugin · local ${version} preview.">`)
        .replace('href="en.html" hreflang="en">English', 'href="index.html" hreflang="zh-CN" lang="zh-CN">简体中文')
        .replace('跳到正文', 'Skip to content').replace('章节导航', 'Section navigation').replace('安装 <span>↓</span>', 'Install <span>↓</span>')
        .replace('示例截图来自现有应用；交互图在浏览器中演示机制，不读取真实学习库。', 'Screenshots show the existing app with samples. Interactive figures demonstrate the mechanism without reading a real library.');
      for (const [zh, en] of Object.entries(SCRIPT_ENGLISH)) html = html.replaceAll(JSON.stringify(zh), JSON.stringify(en));
    }
    const tree = parse(html);
    visit(tree, node => {
      if (node.tagName === 'img') {
        for (const attribute of node.attrs) {
          if (attribute.name === 'src') images.add(attribute.value);
          if (attribute.name === 'srcset') attribute.value.split(',').forEach(candidate => images.add(candidate.trim().split(/\s+/)[0]));
        }
      }
    });
    const name = lang === 'en' ? 'en.html' : 'index.html';
    await writeFile(join(outdir, name), serialize(tree));
    pages.push(name);
  }
  for (const image of images) {
    if (!/^assets\/[A-Za-z0-9._-]+\.(?:webp|png|svg)$/.test(image)) throw new Error(`Unexpected site image: ${image}`);
    await copyFile(join(repositoryRoot, 'site', image), join(outdir, image));
  }
  const report = { version, releaseStatus: 'local-preview', pages, assets: [...images, 'assets/site-demo.js'], externalRuntimeRequests: 0 };
  await writeFile(join(outdir, 'build-manifest.json'), JSON.stringify(report, null, 2) + '\n');
  return { outdir, ...report };
}
function visit(node, inspect) { inspect(node); for (const child of node.childNodes || []) visit(child, inspect); }

const SCRIPT_ENGLISH = {
  '跳到 ': 'Go to ', '第 1 段 · 引用片段': 'Paragraph 1 · evidence passage', '原文': 'Source',
  '这就是这道题的依据 —— 在原文里的位置': 'The evidence for this question, in its source passage',
  '点一下，看看这道题的依据在原文哪里': 'Click to locate the evidence for this question', '收起引用': 'Hide citation', '查看引用来源': 'View source citation',
  '设计模式 · 第 4 章': 'Design patterns', '不透明对象与封装': 'Opaque snapshots', '快照由谁保管': 'Snapshot keeper',
  '为什么需要撤销': 'Why undo exists', 'Caretaker 的访问边界': 'Snapshot access', '已掌握': 'Mastered', '薄弱': 'Weak', '未学': 'New',
  '学习中 · 你卡住的这道': 'Learning · target', '前置题 2 · 已掌握 1': '2 prerequisites · 1 mastered',
  '实线是所属关系，虚线箭头是前置，节点颜色即掌握度。': 'Solid lines show membership; dashed arrows show prerequisites; colours indicate mastery.',
  '答对右边这道题 →': 'Pass the target question →', '已通过': 'Passed', '✓ 记一次通过': '✓ Pass recorded',
  '✓ 一并记一次通过': '✓ Also credited', '未到期 · 不动': 'Not due · unchanged', '前置题 2 · 记通过 1': '2 prerequisites · 1 credited',
  '答对这道题，<b>两层内到期、薄弱或没学过的前置题一并记一次通过</b> —— ': 'Passing also <b>credits eligible prerequisites within two levels</b>. ',
  '「快照由谁保管」不再是薄弱；「不透明对象与封装」尚未到期，不动。': 'The snapshot keeper question is no longer weak; the mastered snapshot question is not due and stays unchanged.',
  '答错': 'Miss', ' 天': ' days', '学习中': 'Learning', '熟悉': 'Familiar', '还没学过': 'Not studied yet',
  '下次复习 · <b>': 'Next review · <b>in ', ' 天后</b>': ' days</b>', '答错了 · 明天再复习': 'Missed · review tomorrow',
};
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildSite({ ...(process.argv[2] ? { outdir: resolve(process.argv[2]) } : {}) });
  console.log(`Built StudyHub ${result.version} local site: ${result.outdir} (${result.pages.length} pages, ${result.assets.length} assets)`);
}
