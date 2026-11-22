// Static keymap conflict, barrel-bypass & bounded-modal TextInput audit:
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
      `export { globalShortcuts, featureShortcuts } from './src/shell/HelpOverlay.tsx';`,
      `export { DIGIT_KEYS } from './src/components/focus.ts';`,
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

function extractAppShellGlobalKeys(sf) {
  const switchCases = [];
  const ctrlKeys = [];
  let hasBackspace = false;
  let usesPageRegistryMap = false;

  function visit(node) {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Map' &&
      node.getText(sf).includes('PAGE_REGISTRY')
    ) {
      usesPageRegistryMap = true;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useInput') {
      function scanInputFn(n) {
        if (ts.isSwitchStatement(n) && ts.isIdentifier(n.expression) && n.expression.text === 'input') {
          for (const clause of n.caseBlock.clauses) {
            if (ts.isCaseClause(clause) && (ts.isStringLiteral(clause.expression) || ts.isNoSubstitutionTemplateLiteral(clause.expression))) {
              switchCases.push(clause.expression.text);
            }
          }
        }
        if (ts.isPropertyAccessExpression(n) && n.expression.getText(sf) === 'key' && n.name.text === 'backspace') {
          hasBackspace = true;
        }
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
          const left = n.left.getText(sf);
          const right = n.right.getText(sf);
          if (left === 'key.ctrl') {
            const m = /^input\s*===\s*['"]([a-zA-Z])['"]$/.exec(right);
            if (m) ctrlKeys.push(m[1]);
          }
        }
        ts.forEachChild(n, scanInputFn);
      }
      if (node.arguments[0]) scanInputFn(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  return { switchCases, ctrlKeys, hasBackspace, usesPageRegistryMap };
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
      const rangeMatch = /^\^\[(\d)-(\d)\]\$$/.exec(pattern.slice(1, -1));
      if (rangeMatch) {
        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        for (let d = start; d <= end; d += 1) recordHit(String(d), line);
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
  const appShellPath = path.join(srcRoot, 'shell/AppShell.tsx');
  const appShellSf = parseTsx(appShellPath);
  const { switchCases, ctrlKeys, hasBackspace, usesPageRegistryMap } = extractAppShellGlobalKeys(appShellSf);

  assert.equal(usesPageRegistryMap, true, 'AppShell must build SHORTCUTS from PAGE_REGISTRY');
  assert.equal(hasBackspace, true, 'AppShell must handle Backspace goBack');
  assert.ok(ctrlKeys.includes('k') && ctrlKeys.includes('r'), 'AppShell must handle Ctrl+K and Ctrl+R');

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
