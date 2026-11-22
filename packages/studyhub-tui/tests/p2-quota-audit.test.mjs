// Permanent P2 Quota-Guard Static Audit across src/views/ and src/shell/:
// `node --test tests/p2-quota-audit.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const srcRoot = path.join(pkgRoot, 'src');

const EFFECT_GUARDED_ACTIONS = new Set([
  'deck.merge.suggest',
  'source.organize.suggest',
  'draft.import.propose',
  'generate.suggest',
  'focus.suggest',
  'book.retell',
  'generation.courseBook.explain',
  'coach.debrief',
  'coach.prepare',
  'coach.rewrite.retry',
  'materials.translation.translate',
  'note.generate',
  'audio.corrections.review',
]);

const CONFIRM_GUARDED_ACTIONS = new Set([
  ...EFFECT_GUARDED_ACTIONS,
  'source.folder.suggest',
]);

function walkSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSourceFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

function parseSource(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  return ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function getStringLiteralText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function isUseEffectCall(node, sf) {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text === 'useEffect';
  }
  if (ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.getText(sf) === 'React.useEffect';
  }
  return false;
}

function listAuditFiles() {
  return [
    ...walkSourceFiles(path.join(srcRoot, 'views')),
    ...walkSourceFiles(path.join(srcRoot, 'shell')),
  ];
}

describe('Permanent P2 Quota-Guard Static Audit', () => {
  test('1. Zero silent LLM/paid backend calls inside useEffect(...) across src/views/ and src/shell/', () => {
    const files = listAuditFiles();
    assert.ok(files.length >= 80, `Expected at least 80 source files under src/views and src/shell, got ${files.length}`);

    let effectCount = 0;
    const violations = [];

    for (const file of files) {
      const sf = parseSource(file);
      const rel = path.relative(pkgRoot, file);

      function scanEffectBody(node) {
        const text = getStringLiteralText(node);
        if (text !== null && EFFECT_GUARDED_ACTIONS.has(text)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push(`${rel}:L${line + 1}: "${text}" referenced inside useEffect(...)`);
        }
        ts.forEachChild(node, scanEffectBody);
      }

      function visit(node) {
        if (isUseEffectCall(node, sf)) {
          effectCount += 1;
          if (node.arguments[0]) {
            scanEffectBody(node.arguments[0]);
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sf);
    }

    assert.ok(effectCount >= 50, `Expected at least 50 useEffect blocks across src/views and src/shell, got ${effectCount}`);
    assert.deepEqual(
      violations,
      [],
      `Found silent guarded LLM actions inside useEffect(...):\n${violations.join('\n')}`,
    );
  });

  test('2. Every view/modal invoking guarded LLM actions imports ConfirmDialog directly and renders <ConfirmDialog', () => {
    const files = listAuditFiles();
    const guardedFiles = [];
    const violations = [];

    for (const file of files) {
      const sf = parseSource(file);
      const rel = path.relative(pkgRoot, file);
      const calledActions = new Set();
      let hasDirectConfirmImport = false;
      let hasBarrelConfirmImport = false;
      let rendersConfirmDialog = false;

      function visit(node) {
        if (ts.isImportDeclaration(node)) {
          const spec = getStringLiteralText(node.moduleSpecifier);
          const clause = node.importClause;
          const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
            ? clause.namedBindings.elements.map((el) => (el.propertyName ?? el.name).text)
            : [];
          if (named.includes('ConfirmDialog') && spec) {
            if (/(?:^|\/)components\/ConfirmDialog\.js$/.test(spec)) {
              hasDirectConfirmImport = true;
            }
            if (/(?:^|\/)components\/index(?:\.js|\.ts)?$/.test(spec)) {
              hasBarrelConfirmImport = true;
            }
          }
        }

        if (ts.isCallExpression(node)) {
          for (const arg of node.arguments) {
            const action = getStringLiteralText(arg);
            if (action !== null && CONFIRM_GUARDED_ACTIONS.has(action)) {
              calledActions.add(action);
            }
          }
        }

        if (
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          node.tagName.getText(sf) === 'ConfirmDialog'
        ) {
          rendersConfirmDialog = true;
        }

        ts.forEachChild(node, visit);
      }

      visit(sf);

      if (calledActions.size > 0) {
        const actionsList = [...calledActions].sort().join(', ');
        guardedFiles.push(`${rel} (${actionsList})`);
        if (hasBarrelConfirmImport) {
          violations.push(`${rel} (${actionsList}): must not import ConfirmDialog from components/index.js barrel`);
        }
        if (!hasDirectConfirmImport) {
          violations.push(`${rel} (${actionsList}): missing direct import { ConfirmDialog } from '...components/ConfirmDialog.js'`);
        }
        if (!rendersConfirmDialog) {
          violations.push(`${rel} (${actionsList}): missing <ConfirmDialog JSX render`);
        }
      }
    }

    assert.ok(
      guardedFiles.length >= 11,
      `Expected at least 11 guarded view/modal files, got ${guardedFiles.length}: ${guardedFiles.join(', ')}`,
    );
    assert.deepEqual(
      violations,
      [],
      `ConfirmDialog co-location violations:\n${violations.join('\n')}`,
    );
  });

  test('3. Zero target: "中文" / "English" regression in DocumentReader.tsx materials.translation.* calls', () => {
    const readerPath = path.join(srcRoot, 'views/sources/DocumentReader.tsx');
    assert.ok(fs.existsSync(readerPath), 'missing src/views/sources/DocumentReader.tsx');
    const sf = parseSource(readerPath);

    let translationListCalls = 0;
    let translationTranslateCalls = 0;
    const violations = [];

    function visit(node) {
      if (ts.isCallExpression(node)) {
        const actionArg = node.arguments.find((arg) => {
          const val = getStringLiteralText(arg);
          return val !== null && val.startsWith('materials.translation.');
        });
        if (actionArg) {
          const actionName = getStringLiteralText(actionArg);
          if (actionName === 'materials.translation.list') translationListCalls += 1;
          if (actionName === 'materials.translation.translate') translationTranslateCalls += 1;

          for (const arg of node.arguments) {
            if (!ts.isObjectLiteralExpression(arg)) continue;
            for (const prop of arg.properties) {
              if (!ts.isPropertyAssignment(prop)) continue;
              const propName = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
                ? prop.name.text
                : null;
              if (propName !== 'target') continue;
              const lit = getStringLiteralText(prop.initializer);
              if (lit !== null && lit !== 'zh' && lit !== 'en') {
                const { line } = sf.getLineAndCharacterOfPosition(prop.getStart(sf));
                violations.push(`L${line + 1}: ${actionName} passed invalid literal target "${lit}" (expected 'zh' or 'en')`);
              }
            }
          }
        }
      }

      if (ts.isPropertyAssignment(node)) {
        const propName = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
          ? node.name.text
          : null;
        if (propName === 'target') {
          const lit = getStringLiteralText(node.initializer);
          if (lit === '中文' || lit === 'English') {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            violations.push(`L${line + 1}: forbidden target literal "${lit}" in DocumentReader.tsx`);
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sf);

    assert.ok(translationListCalls >= 1, 'Expected at least 1 materials.translation.list call in DocumentReader.tsx');
    assert.ok(translationTranslateCalls >= 1, 'Expected at least 1 materials.translation.translate call in DocumentReader.tsx');
    assert.deepEqual(
      violations,
      [],
      `DocumentReader.tsx translation target regressions:\n${violations.join('\n')}`,
    );
  });
});
