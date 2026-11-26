// Authoritative Keymap Conflict, HelpOverlay Parity, Barrel-Bypass, Modal TextInput & Scroll Ergonomics Audit:
// `node --test tests/keymap-audit.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const srcRoot = path.join(pkgRoot, 'src');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-keymap-audit-'));
const outfile = path.join(outDir, 'bundle.mjs');

await build({
  stdin: {
    contents: [
      `export { PAGE_REGISTRY } from './src/types/contracts.ts';`,
      `export { GLOBAL_SINGLE_KEY_ROUTES, GLOBAL_PAGE_SHORTCUTS, resolveGlobalKeyRoute, resolveSystemKeyRoute } from './src/input/global-router.ts';`,
      `export { globalShortcuts, featureShortcuts } from './src/shell/HelpOverlay.tsx';`,
      `export { DIGIT_KEYS } from './src/components/focus.ts';`,
      `export { pageStep, nextScrollOffset, scrollbarThumb } from './src/components/VirtualList.tsx';`,
      `export { pageStep as scrollViewPageStep } from './src/components/ScrollView.tsx';`,
    ].join('\n'),
    resolveDir: pkgRoot,
    loader: 'ts',
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});

fs.symlinkSync(path.join(pkgRoot, 'node_modules'), path.join(outDir, 'node_modules'), 'junction');
const Bundle = await import(pathToFileURL(outfile).href);
process.on('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));

const EXPECTED_GLOBAL_SINGLE_KEYS = new Set([
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'n', 'b', 't', 'a', 'r', 'c', ',', 'I', '?', '/', '\\', '[', ']', 'q',
]);

function parseTsx(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  return ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function walkTsxFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsxFiles(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

function listPrimaryViews() {
  const viewsRoot = path.join(srcRoot, 'views');
  const files = [];
  for (const dir of fs.readdirSync(viewsRoot).sort()) {
    const fullDir = path.join(viewsRoot, dir);
    if (!fs.statSync(fullDir).isDirectory()) continue;
    for (const file of fs.readdirSync(fullDir).sort()) {
      if (file.endsWith('View.tsx')) {
        files.push(path.join(fullDir, file));
      }
    }
  }
  return files;
}

function collectStringArrayBindings(sf) {
  const bindings = new Map([['DIGIT_KEYS', [...Bundle.DIGIT_KEYS]]]);

  function resolveArrayExpr(expr) {
    if (!expr) return [];
    if (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isTypeAssertionExpression(expr)) {
      return resolveArrayExpr(expr.expression);
    }
    if (ts.isCallExpression(expr)) {
      const callee = expr.expression.getText(sf);
      if (callee === 'Object.freeze' && expr.arguments[0]) {
        return resolveArrayExpr(expr.arguments[0]);
      }
      if (callee === 'useMemo' && expr.arguments[0] && ts.isArrowFunction(expr.arguments[0])) {
        const body = expr.arguments[0].body;
        if (ts.isBlock(body)) {
          const collected = [];
          const localBindings = new Map(bindings);
          const resolveLocal = (ex) => {
            if (!ex) return [];
            if (ts.isIdentifier(ex)) return localBindings.get(ex.text) ?? resolveArrayExpr(ex);
            if (ts.isArrayLiteralExpression(ex)) {
              const items = [];
              for (const el of ex.elements) {
                if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) items.push(el.text);
                else if (ts.isSpreadElement(el)) items.push(...resolveLocal(el.expression));
              }
              return items;
            }
            if (ts.isConditionalExpression(ex)) return [...resolveLocal(ex.whenTrue), ...resolveLocal(ex.whenFalse)];
            return resolveArrayExpr(ex);
          };
          const scanBlock = (stmt) => {
            if (ts.isVariableStatement(stmt)) {
              for (const d of stmt.declarationList.declarations) {
                if (ts.isIdentifier(d.name) && d.initializer) {
                  const vals = resolveLocal(d.initializer);
                  if (vals.length > 0) localBindings.set(d.name.text, vals);
                }
              }
            } else if (ts.isReturnStatement(stmt)) {
              collected.push(...resolveLocal(stmt.expression));
            } else if (ts.isIfStatement(stmt)) {
              scanBlock(stmt.thenStatement);
              if (stmt.elseStatement) scanBlock(stmt.elseStatement);
            } else if (ts.isBlock(stmt)) {
              stmt.statements.forEach(scanBlock);
            }
          };
          body.statements.forEach(scanBlock);
          return collected;
        }
        return resolveArrayExpr(body);
      }
    }
    if (ts.isArrayLiteralExpression(expr)) {
      const items = [];
      for (const el of expr.elements) {
        if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) items.push(el.text);
        else if (ts.isSpreadElement(el)) items.push(...resolveArrayExpr(el.expression));
      }
      return items;
    }
    if (ts.isIdentifier(expr)) return bindings.get(expr.text) ?? [];
    if (ts.isConditionalExpression(expr)) {
      return [...resolveArrayExpr(expr.whenTrue), ...resolveArrayExpr(expr.whenFalse)];
    }
    return [];
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const resolved = resolveArrayExpr(node.initializer);
      if (resolved.length > 0) bindings.set(node.name.text, resolved);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  return { bindings, resolveArrayExpr };
}

function findPrimaryComponentNode(sf, componentName) {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === componentName) {
      return stmt;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === componentName && decl.initializer) {
          return decl.initializer;
        }
      }
    }
  }
  return null;
}

function auditViewGlobalClaims(filePath) {
  const sf = parseTsx(filePath);
  const componentName = path.basename(filePath, '.tsx');
  const viewNode = findPrimaryComponentNode(sf, componentName);
  assert.ok(viewNode, `Could not locate primary component ${componentName} in ${path.relative(pkgRoot, filePath)}`);

  const { resolveArrayExpr } = collectStringArrayBindings(sf);
  const claimed = new Set();
  const topLevelGlobalHits = new Map();

  function recordHit(keyChar, line) {
    if (!EXPECTED_GLOBAL_SINGLE_KEYS.has(keyChar)) return;
    const prev = topLevelGlobalHits.get(keyChar) ?? [];
    prev.push(line);
    topLevelGlobalHits.set(keyChar, prev);
  }

  function walkInputCallback(node) {
    // Skip modal-specific branches inside a combined useInput handler
    if (ts.isIfStatement(node)) {
      const condText = node.expression.getText(sf);
      if (/\b(overlay\s*===\s*['"](?!none)|noteModalOpen|editModalOpen)\b/.test(condText)) {
        if (node.elseStatement) walkInputCallback(node.elseStatement);
        return;
      }
    }
    // Skip Ctrl+key or Meta+key combinations (not single-key global shortcuts)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (/\bkey\.(ctrl|meta)\b/.test(node.left.getText(sf)) || /\bkey\.(ctrl|meta)\b/.test(node.right.getText(sf))) {
        return;
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      let literal = null;
      if (node.left.getText(sf) === 'input' && (ts.isStringLiteral(node.right) || ts.isNoSubstitutionTemplateLiteral(node.right))) {
        literal = node.right.text;
      } else if (node.right.getText(sf) === 'input' && (ts.isStringLiteral(node.left) || ts.isNoSubstitutionTemplateLiteral(node.left))) {
        literal = node.left.text;
      }
      if (literal !== null) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        recordHit(literal, line);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'includes' &&
      node.arguments.length === 1 &&
      node.arguments[0].getText(sf) === 'input'
    ) {
      const arr = resolveArrayExpr(node.expression.expression);
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      for (const item of arr) recordHit(item, line);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'test' &&
      node.arguments.length === 1 &&
      node.arguments[0].getText(sf) === 'input' &&
      ts.isRegularExpressionLiteral(node.expression.expression)
    ) {
      const pattern = node.expression.expression.text;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const body = pattern.slice(1, pattern.lastIndexOf('/'));
      const rangeMatch = /^\^\[(\d)-(\d)\]\$$/.exec(body);
      if (rangeMatch) {
        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        for (let d = start; d <= end; d += 1) recordHit(String(d), line);
      }
      const letterRangeMatch = /^\^\[([a-z])-([a-z])\]\$$/.exec(body) || /^\^\[([A-Z])-([A-Z])\]\$$/.exec(body);
      if (letterRangeMatch) {
        const start = letterRangeMatch[1].charCodeAt(0);
        const end = letterRangeMatch[2].charCodeAt(0);
        for (let code = start; code <= end; code += 1) recordHit(String.fromCharCode(code), line);
      }
    }
    ts.forEachChild(node, walkInputCallback);
  }

  function scanComponent(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fnName = node.expression.text;
      if (fnName === 'useClaimKeys' && node.arguments[0]) {
        for (const k of resolveArrayExpr(node.arguments[0])) claimed.add(k);
      }
      if (fnName === 'useKeyScope' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        let onKeyExpr = null;
        let isModalOnlyScope = false;
        for (const prop of node.arguments[0].properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
          if (prop.name.text === 'keys') {
            for (const k of resolveArrayExpr(prop.initializer)) claimed.add(k);
          } else if (prop.name.text === 'onKey') {
            onKeyExpr = prop.initializer;
          } else if (prop.name.text === 'id' || prop.name.text === 'active') {
            const text = prop.initializer.getText(sf);
            if (/\b(overlays|lintOpen|noteModalOpen|editModalOpen)\b/.test(text) && !/!\s*(lintOpen|noteModalOpen|editModalOpen)/.test(text)) {
              isModalOnlyScope = true;
            }
          }
        }
        if (onKeyExpr && !isModalOnlyScope) {
          walkInputCallback(onKeyExpr);
        }
      }
      if (fnName === 'useInput' && node.arguments[0]) {
        const optsText = node.arguments[1]?.getText(sf) ?? '';
        const isModalOnlyHook =
          /\b(lintOpen|noteModalOpen|editModalOpen)\b/.test(optsText) &&
          !/!\s*(lintOpen|noteModalOpen|editModalOpen)/.test(optsText);
        if (!isModalOnlyHook) {
          walkInputCallback(node.arguments[0]);
        }
      }
    }
    ts.forEachChild(node, scanComponent);
  }
  scanComponent(viewNode);

  const collisions = [];
  for (const [keyChar, lines] of topLevelGlobalHits.entries()) {
    if (!claimed.has(keyChar)) {
      collisions.push({ key: keyChar, lines });
    }
  }
  return {
    file: path.relative(pkgRoot, filePath),
    component: componentName,
    claimed: [...claimed].sort(),
    usedGlobals: [...topLevelGlobalHits.keys()].sort(),
    collisions,
  };
}

test('AppShell global shortcuts match PAGE_REGISTRY & HelpOverlay.globalShortcuts with zero undocumented or duplicate keys', () => {
  const switchCases = Object.keys(Bundle.GLOBAL_SINGLE_KEY_ROUTES);
  const baseCtx = {
    overlayOpen: false,
    inputCaptured: false,
    showLaunchpad: false,
    page: 'library',
    passiveAssistantOpen: false,
    isKeyClaimed: () => false,
  };
  const emptyKey = {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageDown: false, pageUp: false, home: false, end: false,
    return: false, escape: false, ctrl: false, shift: false, tab: false,
    backspace: false, delete: false, meta: false,
  };
  assert.equal(Bundle.GLOBAL_PAGE_SHORTCUTS.size, Bundle.PAGE_REGISTRY.length, 'GLOBAL_PAGE_SHORTCUTS must mirror PAGE_REGISTRY');
  assert.deepEqual(
    Bundle.resolveGlobalKeyRoute('', { ...emptyKey, backspace: true }, baseCtx),
    { action: 'go-back' },
    'global-router must handle Backspace goBack',
  );
  const sysCtx = {
    blockedByScope: false, tooSmall: false, quitConfirmOpen: false, commandPaletteOpen: false,
    assistantOpen: false, assistantFocused: false, assistantFullscreen: false,
  };
  assert.equal(Bundle.resolveSystemKeyRoute('k', { ...emptyKey, ctrl: true }, sysCtx)?.action, 'palette-open', 'global-router must handle Ctrl+K');
  assert.equal(Bundle.resolveSystemKeyRoute('r', { ...emptyKey, ctrl: true }, sysCtx)?.action, 'refresh', 'global-router must handle Ctrl+R');

  const pageShortcuts = Bundle.PAGE_REGISTRY.map((p) => p.shortcut);
  assert.equal(new Set(pageShortcuts).size, pageShortcuts.length, 'Duplicate shortcut in PAGE_REGISTRY');
  assert.equal(new Set(switchCases).size, switchCases.length, 'Duplicate case in AppShell switch(input)');

  for (const sw of switchCases) {
    assert.ok(!pageShortcuts.includes(sw), `AppShell switch key "${sw}" collides with PAGE_REGISTRY`);
  }

  const combinedGlobalKeys = new Set([...pageShortcuts, ...switchCases]);
  assert.deepEqual(
    [...combinedGlobalKeys].sort(),
    [...EXPECTED_GLOBAL_SINGLE_KEYS].sort(),
    'AppShell + PAGE_REGISTRY global shortcut set drifted from expected specification',
  );

  for (const lang of ['zh', 'en']) {
    for (const ascii of [false, true]) {
      const globals = Bundle.globalShortcuts(lang, ascii);
      const keys = globals.map((g) => g.key);
      assert.equal(new Set(keys).size, keys.length, `Duplicate key in globalShortcuts(${lang}, ascii=${ascii})`);

      const joinedKeys = keys.join(' ');
      for (const sw of switchCases) {
        assert.ok(joinedKeys.includes(sw), `AppShell global key "${sw}" missing from globalShortcuts(${lang})`);
      }
      assert.ok(joinedKeys.includes('Ctrl+K'), `Ctrl+K missing from globalShortcuts(${lang})`);
      assert.ok(joinedKeys.includes('Ctrl+R'), `Ctrl+R missing from globalShortcuts(${lang})`);
      assert.ok(
        joinedKeys.includes(ascii ? 'Bksp' : '⌫'),
        `Backspace missing from globalShortcuts(${lang}, ascii=${ascii})`,
      );
      assert.ok(joinedKeys.includes('1-9 0'), `1-9 0 missing from globalShortcuts(${lang})`);
    }
  }
});

test('every primary view and sub-view claims all global shortcut keys handled in its non-modal useInput', () => {
  const primaryViews = listPrimaryViews();
  assert.equal(primaryViews.length, 17, `Expected 17 *View.tsx files, found ${primaryViews.length}`);

  const subViews = [
    path.join(srcRoot, 'views/exam/ExamSetup.tsx'),
    path.join(srcRoot, 'views/exam/ExamRunner.tsx'),
    path.join(srcRoot, 'views/generate/DraftEditor.tsx'),
    path.join(srcRoot, 'views/sources/DocumentReader.tsx'),
    path.join(srcRoot, 'views/review/RoundSummary.tsx'),
    path.join(srcRoot, 'views/settings/ModelsTab.tsx'),
    path.join(srcRoot, 'views/settings/WorkspaceTab.tsx'),
    path.join(srcRoot, 'views/settings/AppearanceTab.tsx'),
    path.join(srcRoot, 'views/settings/StudyGenTab.tsx'),
  ];

  const failures = [];
  for (const filePath of [...primaryViews, ...subViews]) {
    const result = auditViewGlobalClaims(filePath);
    if (result.collisions.length > 0) {
      failures.push(
        `${result.file} (${result.component}): unclaimed global key(s) ${result.collisions
          .map((c) => `'${c.key}' @ L${c.lines.join(',')}`)
          .join(', ')}`,
      );
    }
  }

  assert.deepEqual(failures, [], `Unclaimed global key collisions found:\n${failures.join('\n')}`);
});

test('#1314: reserved global keys (r, q, ?) must never be claimed by any primary view or sub-view', () => {
  const RESERVED = ['r', 'q', '?'];
  const primaryViews = listPrimaryViews();
  const subViews = [
    path.join(srcRoot, 'views/exam/ExamSetup.tsx'),
    path.join(srcRoot, 'views/exam/ExamRunner.tsx'),
    path.join(srcRoot, 'views/generate/DraftEditor.tsx'),
    path.join(srcRoot, 'views/sources/DocumentReader.tsx'),
    path.join(srcRoot, 'views/sources/ReaderNotesDrawer.tsx'),
    path.join(srcRoot, 'views/sources/ReaderOutlineDrawer.tsx'),
    path.join(srcRoot, 'views/review/RoundSummary.tsx'),
    path.join(srcRoot, 'views/settings/ModelsTab.tsx'),
    path.join(srcRoot, 'views/settings/WorkspaceTab.tsx'),
    path.join(srcRoot, 'views/settings/AppearanceTab.tsx'),
    path.join(srcRoot, 'views/settings/StudyGenTab.tsx'),
  ];

  const violations = [];
  for (const filePath of [...primaryViews, ...subViews]) {
    const result = auditViewGlobalClaims(filePath);
    const bad = result.claimed.filter((k) => RESERVED.includes(k));
    if (bad.length > 0) {
      violations.push(`${result.file} (${result.component}): claims reserved global key(s) ${bad.map((k) => `'${k}'`).join(', ')}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Views must not claim reserved global keys (${RESERVED.join(', ')}):\n${violations.join('\n')}`,
  );
});

test('#1345: primary views and sub-views must not display stale lowercase [r] hints for Ctrl+R refresh/reload or R restart', () => {
  const primaryViews = listPrimaryViews();
  const subViews = [
    path.join(srcRoot, 'views/exam/ExamSetup.tsx'),
    path.join(srcRoot, 'views/exam/ExamRunner.tsx'),
    path.join(srcRoot, 'views/generate/DraftEditor.tsx'),
    path.join(srcRoot, 'views/sources/DocumentReader.tsx'),
    path.join(srcRoot, 'views/review/RoundSummary.tsx'),
    path.join(srcRoot, 'views/settings/ModelsTab.tsx'),
    path.join(srcRoot, 'views/settings/WorkspaceTab.tsx'),
    path.join(srcRoot, 'views/settings/AppearanceTab.tsx'),
    path.join(srcRoot, 'views/settings/StudyGenTab.tsx'),
  ];

  const STALE_TEXT_RE = /\[r\]\s*(?:刷新|重载|重试|再来一轮|Refresh|Reload|Retry|New\b|to retry|to reload|to refresh)|\(\s*r\s*(?:重载|:\s*reload)\s*\)|\(?\[r\]\)/;
  const violations = [];

  for (const filePath of [...primaryViews, ...subViews]) {
    const sf = parseTsx(filePath);
    const componentName = path.basename(filePath, '.tsx');
    const viewNode = findPrimaryComponentNode(sf, componentName);
    if (!viewNode) continue;
    const rel = path.relative(pkgRoot, filePath);

    function visit(node, inModal) {
      if (ts.isJsxElement(node)) {
        const tag = node.openingElement.tagName.getText(sf);
        const childInModal = inModal || tag === 'Modal';
        ts.forEachChild(node, (child) => visit(child, childInModal));
        return;
      }
      if (!inModal) {
        // Check `{ key: 'r', label: ... }` object literals inside primary component (allow LibraryView global Resume)
        if (ts.isObjectLiteralExpression(node)) {
          let keyProp = null;
          let labelText = '';
          for (const prop of node.properties) {
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
              if (prop.name.text === 'key' && (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))) {
                keyProp = prop.initializer.text;
              }
              if (prop.name.text === 'label') {
                labelText = prop.initializer.getText(sf);
              }
            }
          }
          if (keyProp === 'r' && !(componentName === 'LibraryView' && /继续|Resume/i.test(labelText))) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            violations.push(`${rel}:${line} stale hint { key: 'r', label: ${labelText} }`);
          }
        }
        // Check string literals with stale `[r] 刷新/重载/重试/再来一轮` text
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          if (STALE_TEXT_RE.test(node.text)) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            violations.push(`${rel}:${line} stale text "${node.text.slice(0, 80)}"`);
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, inModal));
    }
    visit(viewNode, false);
  }

  assert.deepEqual(
    violations,
    [],
    `Stale lowercase 'r' hints found in primary/sub views (should be Ctrl+R or R):\n${violations.join('\n')}`,
  );
});

test('src/App.tsx never imports ./views/*/index.js barrels (Round 22 Barrel-Bypass NFR)', () => {
  const appPath = path.join(srcRoot, 'App.tsx');
  const sf = parseTsx(appPath);
  const specifiers = [];

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push({ kind: 'static', spec: node.moduleSpecifier.text, pos: node.getStart(sf) });
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push({ kind: 'dynamic', spec: node.arguments[0].text, pos: node.getStart(sf) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  const viewSpecs = specifiers.filter((s) => s.spec.startsWith('./views/'));
  assert.ok(viewSpecs.length >= 16, `Expected >= 16 view imports in App.tsx, found ${viewSpecs.length}`);

  const violations = [];
  for (const item of viewSpecs) {
    const line = sf.getLineAndCharacterOfPosition(item.pos).line + 1;
    if (/^\.\/views\/[^/]+\/index(\.[cm]?[jt]sx?)?$/.test(item.spec) || /^\.\/views\/[^/]+\/?$/.test(item.spec)) {
      violations.push(`App.tsx:${line} (${item.kind}) imports barrel "${item.spec}"`);
    }
  }
  assert.deepEqual(violations, [], `Barrel-Bypass NFR violations in App.tsx:\n${violations.join('\n')}`);
});

test('every Modal containing <TextInput passes a bounded width prop', () => {
  const tsxFiles = walkTsxFiles(srcRoot);
  const violations = [];
  let checkedCount = 0;

  for (const filePath of tsxFiles) {
    const sf = parseTsx(filePath);
    const rel = path.relative(pkgRoot, filePath);

    function visit(node, inModal) {
      if (ts.isJsxElement(node)) {
        const tag = node.openingElement.tagName.getText(sf);
        const childInModal = inModal || tag === 'Modal';
        ts.forEachChild(node, (child) => visit(child, childInModal));
        return;
      }
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && inModal) {
        if (node.tagName.getText(sf) === 'TextInput') {
          checkedCount += 1;
          const widthAttr = node.attributes.properties.find(
            (prop) => ts.isJsxAttribute(prop) && prop.name.getText(sf) === 'width',
          );
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          if (!widthAttr || !widthAttr.initializer) {
            violations.push(`${rel}:${line} <TextInput> inside <Modal> is missing bounded width prop`);
            return;
          }
          const initText = widthAttr.initializer.getText(sf).trim();
          if (initText === '{undefined}' || initText === '{Infinity}' || initText === '{0}') {
            violations.push(`${rel}:${line} <TextInput> inside <Modal> has unbounded/invalid width=${initText}`);
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, inModal));
    }
    visit(sf, false);
  }

  assert.ok(checkedCount > 20, `Expected > 20 <TextInput> inside <Modal>, checked ${checkedCount}`);
  assert.deepEqual(violations, [], `Unbounded <TextInput> inside <Modal>:\n${violations.join('\n')}`);
});

// -----------------------------------------------------------------------------
// Keyboard Ergonomics & HelpOverlay Parity Unit Tests (merged from ergonomics.test.mjs)
// -----------------------------------------------------------------------------

test('pageStep computes exact half and full page steps with minimum 1', () => {
  assert.equal(Bundle.pageStep(0, 'half'), 1);
  assert.equal(Bundle.pageStep(1, 'half'), 1);
  assert.equal(Bundle.pageStep(2, 'half'), 1);
  assert.equal(Bundle.pageStep(10, 'half'), 5);
  assert.equal(Bundle.pageStep(11, 'half'), 5);
  assert.equal(Bundle.pageStep(25, 'half'), 12);

  assert.equal(Bundle.pageStep(0, 'full'), 1);
  assert.equal(Bundle.pageStep(1, 'full'), 1);
  assert.equal(Bundle.pageStep(2, 'full'), 1);
  assert.equal(Bundle.pageStep(10, 'full'), 9);
  assert.equal(Bundle.pageStep(24, 'full'), 23);

  assert.equal(Bundle.pageStep(Number.NaN, 'half'), 1);
  assert.equal(Bundle.scrollViewPageStep(16, 'half'), 8);
  assert.equal(Bundle.scrollViewPageStep(16, 'full'), 15);
});

test('nextScrollOffset keeps cursor visible with padding and clamps to bounds', () => {
  assert.equal(Bundle.nextScrollOffset(0, 0, 10, 5), 0);
  assert.equal(Bundle.nextScrollOffset(4, 0, 10, 5), 0);

  assert.equal(Bundle.nextScrollOffset(0, 0, 10, 30), 0);
  assert.equal(Bundle.nextScrollOffset(8, 0, 10, 30), 0);
  assert.equal(Bundle.nextScrollOffset(9, 0, 10, 30), 1);
  assert.equal(Bundle.nextScrollOffset(29, 10, 10, 30), 20);
  assert.equal(Bundle.nextScrollOffset(0, 20, 10, 30), 0);

  // Half-page jump down from cursor 0 in a 10-row viewport of 30 items
  const halfDown = 0 + Bundle.pageStep(10, 'half');
  assert.equal(halfDown, 5);
  assert.equal(Bundle.nextScrollOffset(halfDown, 0, 10, 30), 0);

  // Full-page jump down to cursor 9 pushes viewport down by 1
  const fullDown = 0 + Bundle.pageStep(10, 'full');
  assert.equal(fullDown, 9);
  assert.equal(Bundle.nextScrollOffset(fullDown, 0, 10, 30), 1);
});

test('scrollbarThumb computes accurate thumb segments and empty track when unscrollable', () => {
  assert.deepEqual(Bundle.scrollbarThumb(5, 10, 0), new Array(10).fill(false));
  assert.deepEqual(Bundle.scrollbarThumb(10, 10, 0), new Array(10).fill(false));
  assert.deepEqual(Bundle.scrollbarThumb(10, 0, 0), []);

  const topThumb = Bundle.scrollbarThumb(40, 10, 0);
  assert.equal(topThumb.length, 10);
  assert.equal(topThumb[0], true);
  assert.equal(topThumb[9], false);
  assert.ok(topThumb.filter(Boolean).length >= 1);

  const botThumb = Bundle.scrollbarThumb(40, 10, 30);
  assert.equal(botThumb.length, 10);
  assert.equal(botThumb[0], false);
  assert.equal(botThumb[9], true);
});

test('globalShortcuts documents required keys cleanly in zh and en without duplicates', () => {
  for (const lang of ['zh', 'en']) {
    for (const ascii of [false, true]) {
      const list = Bundle.globalShortcuts(lang, ascii);
      assert.ok(Array.isArray(list) && list.length >= 12);
      const keys = list.map((h) => h.key);
      assert.equal(new Set(keys).size, keys.length, `duplicate key in globalShortcuts (${lang}, ascii=${ascii})`);
      const keysJoined = keys.join('\n');
      for (const expected of ['I', 'Ctrl+K', '?', 'c', '[', '\\', 'Ctrl+R', 'Ctrl+D/U', 'g/G', 'Ctrl+S']) {
        assert.ok(keysJoined.includes(expected), `missing ${expected} in ${lang} (ascii=${ascii})`);
      }
      const ctrlSItem = list.find((item) => item.key === 'Ctrl+S');
      assert.ok(
        ctrlSItem && ctrlSItem.label.includes('Ctrl+J') && ctrlSItem.label.includes('Shift+Enter'),
        `globalShortcuts Ctrl+S must document Ctrl+J / Shift+Enter newline alternative in ${lang}`,
      );
      for (const item of list) {
        assert.ok(item.key.trim().length > 0);
        assert.ok(item.label.trim().length > 0);
        if (ascii) {
          assert.match(item.key, /^[\x20-\x7e]+$/, `non-ASCII key in asciiMode: ${item.key}`);
        }
      }
    }
  }
});

test('featureShortcuts documents Rounds 5-26 & PR #1297 shortcuts cleanly in zh and en without duplicates', () => {
  for (const lang of ['zh', 'en']) {
    const sections = Bundle.featureShortcuts(lang);
    assert.equal(sections.length, 15);
    const titles = sections.map((s) => s.title);
    assert.equal(new Set(titles).size, titles.length, `duplicate section title in ${lang}`);
    for (const sec of sections) {
      assert.ok(sec.title.trim().length > 0, `empty section title in ${lang}`);
      assert.ok(sec.items.length > 0, `empty section items for ${sec.title} in ${lang}`);
      const secKeys = sec.items.map((i) => i.key);
      const secLabels = sec.items.map((i) => i.label);
      assert.equal(new Set(secKeys).size, secKeys.length, `duplicate shortcut key in ${sec.title} (${lang})`);
      assert.equal(new Set(secLabels).size, secLabels.length, `duplicate shortcut label in ${sec.title} (${lang})`);
      for (const item of sec.items) {
        assert.ok(item.key.trim().length > 0, `empty key in ${sec.title} (${lang})`);
        assert.ok(item.label.trim().length > 0, `empty label in ${sec.title} (${lang})`);
        assert.match(item.key, /^[\x20-\x7e]+$/, `non-ASCII feature shortcut key: ${item.key}`);
      }
    }

    const titlesJoined = titles.join('\n');
    assert.ok(titlesJoined.includes('Generate'), `missing Generate section in ${lang}`);
    assert.ok(titlesJoined.includes('Review Book') || titlesJoined.includes('复习全书'), `missing Book section in ${lang}`);
    assert.ok(titlesJoined.includes('Wrong Book'), `missing Wrong Book section in ${lang}`);
    assert.ok(titlesJoined.includes('Dashboard'), `missing Dashboard section in ${lang}`);
    assert.ok(
      titles.some((title) => title.includes('Exam') && !title.includes('Coach') && !title.includes('Prep')),
      `missing Exam section in ${lang}`,
    );
    assert.ok(titlesJoined.includes('Exam Coach'), `missing Exam Coach section in ${lang}`);
    assert.ok(titlesJoined.includes('Exam Prep'), `missing Exam Prep section in ${lang}`);
    assert.ok(titlesJoined.includes('Skeleton') && titlesJoined.includes('Notes'), `missing Skeleton/Notes section in ${lang}`);
    assert.ok(titlesJoined.includes('Sources'), `missing Sources section in ${lang}`);
    assert.ok(titlesJoined.includes('Board'), `missing Board section in ${lang}`);
    assert.ok(titlesJoined.includes('Tasks'), `missing Tasks section in ${lang}`);
    assert.ok(titlesJoined.includes('Settings'), `missing Settings section in ${lang}`);
    assert.ok(titlesJoined.includes('Palette'), `missing Palette section in ${lang}`);
    if (lang === 'zh') {
      assert.ok(titlesJoined.includes('出题与草稿'), 'missing 出题与草稿 section in zh');
      assert.ok(titlesJoined.includes('复习全书'), 'missing 复习全书 section in zh');
      assert.ok(titlesJoined.includes('错题本'), 'missing 错题本 section in zh');
      assert.ok(titlesJoined.includes('学习统计'), 'missing 学习统计 section in zh');
      assert.ok(titlesJoined.includes('模拟考'), 'missing 模拟考 section in zh');
      assert.ok(titlesJoined.includes('考试教练'), 'missing 考试教练 section in zh');
      assert.ok(titlesJoined.includes('备考补习'), 'missing 备考补习 section in zh');
      assert.ok(titlesJoined.includes('骨架与笔记'), 'missing 骨架与笔记 section in zh');
      assert.ok(titlesJoined.includes('待办看板'), 'missing 待办看板 section in zh');
      assert.ok(titlesJoined.includes('后台任务'), 'missing 后台任务 section in zh');
      assert.ok(titlesJoined.includes('设置'), 'missing 设置 section in zh');
      assert.ok(titlesJoined.includes('命令面板'), 'missing 命令面板 section in zh');
    }

    const allKeys = sections.flatMap((s) => s.items.map((i) => i.key));
    for (const k of ['p', 'g', 'C', 'o', 'R', 'm: + / k', 'm: Space/F/S', '0-5', 'T', 'S', 'D', 'F', 'G', 'L', 'A', 'Q', '*', 'u', 'X', 'i', 'S / R', 'Ctrl+S/J', 'w', 'P', 'e', 'x', 'Space / B', 'Enter/p', 'f', 's', 'H', 'E', 'V', 'm', 'M', 'O', 'B', 'P / Space', '+/-', 'R', 'w / o / m', '/#?@:']) {
      assert.ok(allKeys.includes(k), `missing feature shortcut ${k} in ${lang}`);
    }
    const keysJoined = allKeys.join('\n');
    for (const token of ['o', 'g', '+', 'k', 'L', 'A', 'Q', '*', 'u', 'i', 'w', 'P', 'p', 'f', 's', 'H', 'F', 'G', 'V', 'M', 'S', 'R', 'x', 'B', '/#?@:']) {
      assert.ok(keysJoined.includes(token), `missing token ${token} in ${lang}`);
    }

    const librarySec = sections.find((s) => s.title.includes('Library'));
    const reviewSec = sections.find((s) => s.title.includes('Review') && !s.title.includes('Book'));
    const generateSec = sections.find((s) => s.title.includes('Generate'));
    const sourcesSec = sections.find((s) => s.title.includes('Sources'));
    const bookSec = sections.find((s) => s.title.includes('Review Book') || s.title.includes('复习全书'));
    const wrongBookSec = sections.find((s) => s.title.includes('Wrong Book'));
    const dashboardSec = sections.find((s) => s.title.includes('Dashboard'));
    const examSec = sections.find((s) => s.title.includes('Exam') && !s.title.includes('Coach') && !s.title.includes('Prep'));
    const coachSec = sections.find((s) => s.title.includes('Exam Coach'));
    const examPrepSec = sections.find((s) => s.title.includes('Exam Prep'));
    const skelNotesSec = sections.find((s) => s.title.includes('Skeleton') && s.title.includes('Notes'));
    const boardSec = sections.find((s) => s.title.includes('Board'));
    const tasksSec = sections.find((s) => s.title.includes('Tasks'));
    const paletteSec = sections.find((s) => s.title.includes('Palette'));
    assert.ok(librarySec?.items.some((i) => i.key === 'g' && (i.label.includes('带学') || i.label.includes('Guided Study'))), `missing Library [g] label in ${lang}`);
    assert.ok(librarySec?.items.some((i) => i.key === 'R' && (i.label.includes('定制本轮') || i.label.includes('Custom round'))), `missing Library [R] label in ${lang}`);
    assert.ok(librarySec?.items.some((i) => i.key === 'm: + / k' && (i.label.includes('补题') || i.label.includes('supplement'))), `missing Library [m: + / k] label in ${lang}`);
    assert.ok(librarySec?.items.some((i) => i.key === 'm: Space/F/S' && (i.label.includes('批量') || i.label.includes('batch'))), `missing Library [m: Space/F/S] label in ${lang}`);
    assert.ok(reviewSec?.items.some((i) => i.key === '0-5' && (i.label.includes('六级') || i.label.includes('six-grade'))), `missing Review [0-5] label in ${lang}`);
    assert.ok(!reviewSec?.items.some((i) => i.key.includes('1-4') || i.label.includes('1-4')), `stale [1-4] rating text in Review (${lang})`);
    assert.ok(reviewSec?.items.some((i) => i.key === 't' && (i.label.includes('带学') || i.label.includes('Guided'))), `missing Review [t] Guided/Retell label in ${lang}`);
    assert.ok(reviewSec?.items.some((i) => i.key === 'A' && (i.label.includes('答题卡') || i.label.includes('Answer card'))), `missing Review [A] label in ${lang}`);
    assert.ok(reviewSec?.items.some((i) => i.key === 'Q' && (i.label.includes('队列编辑') || i.label.includes('Edit queue'))), `missing Review [Q] label in ${lang}`);
    assert.ok(reviewSec?.items.some((i) => i.key === '*' && (i.label.includes('重点') || i.label.includes('focus'))), `missing Review [*] label in ${lang}`);
    assert.ok(reviewSec?.items.some((i) => i.key === 'u' && (i.label.includes('撤销') || i.label.includes('Undo'))), `missing Review [u] label in ${lang}`);
    assert.ok(reviewSec?.items.some((i) => i.key === 'X' && (i.label.includes('结束本轮') || i.label.includes('End round'))), `missing Review [X] label in ${lang}`);
    assert.ok(generateSec?.items.some((i) => i.key === 'i' && (i.label.includes('录题') || i.label.includes('Capture'))), `missing Generate [i] label in ${lang}`);
    assert.ok(generateSec?.items.some((i) => i.key === 'S / R' && (i.label.includes('查重') || i.label.includes('similar'))), `missing Generate [S / R] label in ${lang}`);
    assert.ok(generateSec?.items.some((i) => i.key === 'u' && (i.label.includes('撤销') || i.label.includes('Undo'))), `missing Generate [u] undo label in ${lang}`);
    assert.ok(generateSec?.items.some((i) => i.key === 'Ctrl+S/J' && i.label.includes('Shift+Enter')), `missing Generate [Ctrl+S/J] multiline newline label in ${lang}`);
    assert.ok(sourcesSec?.items.some((i) => i.key === 'G' && (i.label.includes('归类') || i.label.includes('organize'))), `missing Sources [G] label in ${lang}`);
    assert.ok(sourcesSec?.items.some((i) => i.key === 'V' && (i.label.includes('覆盖率') || i.label.includes('Coverage'))), `missing Sources [V] label in ${lang}`);
    assert.ok(sourcesSec?.items.some((i) => i.key === 'M' && i.label.includes('MinerU')), `missing Sources [M] label in ${lang}`);
    assert.ok(bookSec?.items.some((i) => i.key === 'w' && (i.label.includes('期末一周') || i.label.includes('Final-week'))), `missing Book [w] label in ${lang}`);
    assert.ok(bookSec?.items.some((i) => i.key === 'P' && (i.label.includes('精选问答') || i.label.includes('book QA'))), `missing Book [P] label in ${lang}`);
    assert.ok(bookSec?.items.some((i) => i.key === 'e' && (i.label.includes('编辑/回退全书') || i.label.includes('Edit/revert section'))), `missing Book [e] label in ${lang}`);
    assert.ok(bookSec?.items.some((i) => i.key === 'x' && (i.label.includes('导出 Markdown') || i.label.includes('Export Markdown'))), `missing Book [x] label in ${lang}`);
    assert.ok(wrongBookSec?.items.some((i) => i.key === 'Space / B' && (i.label.includes('批量') || i.label.includes('batch'))), `missing Wrong Book [Space / B] label in ${lang}`);
    assert.ok(dashboardSec?.items.some((i) => i.key === 'Enter/p' && (i.label.includes('钻取练习') || i.label.includes('Drill practice'))), `missing Dashboard [Enter/p] label in ${lang}`);
    assert.ok(dashboardSec?.items.some((i) => i.key === 'f' && (i.label.includes('7天预测') || i.label.includes('7d forecast'))), `missing Dashboard [f] label in ${lang}`);
    assert.ok(examSec?.items.some((i) => i.key === 's' && (i.label.includes('切换材料') || i.label.includes('Toggle case'))), `missing Exam [s] label in ${lang}`);
    assert.ok(examSec?.items.some((i) => i.key === 'H' && (i.label.includes('标亮段落') || i.label.includes('Highlight'))), `missing Exam [H] label in ${lang}`);
    assert.ok(coachSec?.items.some((i) => i.key === 'p' && (i.label.includes('画像与偏好') || i.label.includes('profile'))), `missing Exam Coach [p] label in ${lang}`);
    assert.ok(examPrepSec?.items.some((i) => i.key === 'P' && (i.label.includes('定制向导') || i.label.includes('custom wizard'))), `missing Exam Prep [P] custom wizard label in ${lang}`);
    assert.ok(skelNotesSec?.items.some((i) => i.key === 'R' && (i.label.includes('课程学习路线') || i.label.includes('Course route'))), `missing Skeleton/Notes [R] label in ${lang}`);
    assert.ok(skelNotesSec?.items.some((i) => i.key === 'G' && (i.label.includes('主题分组') || i.label.includes('Topic groups'))), `missing Skeleton/Notes [G] label in ${lang}`);
    assert.ok(skelNotesSec?.items.some((i) => i.key === 'E' && (i.label.includes('编辑骨架节点') || i.label.includes('Edit skeleton node'))), `missing Skeleton/Notes [E] label in ${lang}`);
    assert.ok(skelNotesSec?.items.some((i) => i.key === 'L' && (i.label.includes('骨架自检') || i.label.includes('Skeleton lint'))), `missing Skeleton/Notes [L] label in ${lang}`);
    assert.ok(skelNotesSec?.items.some((i) => i.key === 'o' && (i.label.includes('跳转关联') || i.label.includes('Jump linked ref'))), `missing Skeleton/Notes [o] label in ${lang}`);
    assert.ok(boardSec?.items.some((i) => i.key === 'S' && (i.label.includes('同步') || i.label.includes('Sync'))), `missing Board [S] label in ${lang}`);
    assert.ok(tasksSec?.items.some((i) => i.key === 'w / o / m' && (i.label.includes('工作流') || i.label.includes('Workflows'))), `missing Tasks [w / o / m] label in ${lang}`);
    assert.ok(paletteSec?.items.some((i) => i.key === '/#?@:' && (i.label.includes('筛选') || i.label.includes('course/page'))), `missing Palette [/#?@:] label in ${lang}`);
  }
});
