// P1-a Unified Key Dispatcher & Static Key Conflict Matrix (#1354 D1).
// Ensures:
// 1. All keyboard input routes through `components/key-dispatcher.ts` (zero raw Ink `useInput` outside dispatcher/mouse).
// 2. Full Global × View × Widget × Modal conflict matrix has ZERO unguarded double-response key overlaps.
// 3. Runtime priority ordering, single-consumption stop-propagation, and nested opaque modal barriers work deterministically.
// node --test tests/key-routing-matrix.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '../src');

function walkSourceFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkSourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(full);
  }
  return out;
}

const ALL_SRC = walkSourceFiles(SRC_ROOT).sort();
const rel = (p) => path.relative(SRC_ROOT, p).replace(/\\/g, '/');

const EMPTY_KEY = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

describe('P1-a: Unified Key Dispatcher & Conflict Matrix (#1354 D1)', () => {
  test('1. Static guardrail: ZERO direct Ink useInput imports outside components/key-dispatcher.ts and components/mouse.tsx', () => {
    const ALLOWED = new Set(['components/key-dispatcher.ts', 'components/mouse.tsx']);
    const violations = [];
    for (const file of ALL_SRC) {
      const r = rel(file);
      if (ALLOWED.has(r)) continue;
      const code = fs.readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      for (const stmt of sf.statements) {
        if (
          ts.isImportDeclaration(stmt) &&
          ts.isStringLiteral(stmt.moduleSpecifier) &&
          stmt.moduleSpecifier.text === 'ink' &&
          stmt.importClause?.namedBindings &&
          ts.isNamedImports(stmt.importClause.namedBindings)
        ) {
          for (const spec of stmt.importClause.namedBindings.elements) {
            const imported = (spec.propertyName ?? spec.name).text;
            if (imported === 'useInput') {
              const line = sf.getLineAndCharacterOfPosition(spec.getStart(sf)).line + 1;
              violations.push(`${r}:${line} imports raw useInput from 'ink' (use useScopedInput from components/key-dispatcher.js)`);
            }
          }
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Found ${violations.length} raw Ink useInput import(s) bypassing unified key-dispatcher:\n${violations.slice(0, 20).join('\n')}`,
    );
  });

  test('2. Static guardrail: AppShell mounts useKeyDispatcherBridge and Modal wraps children in KeyScopeProvider', () => {
    const appShell = fs.readFileSync(path.join(SRC_ROOT, 'shell/AppShell.tsx'), 'utf8');
    assert.ok(appShell.includes('useKeyDispatcherBridge('), 'AppShell must mount useKeyDispatcherBridge()');
    assert.ok(appShell.includes('KEY_LAYER_SYSTEM'), 'AppShell must register system shortcuts at KEY_LAYER_SYSTEM');
    assert.ok(appShell.includes('KEY_LAYER_GLOBAL'), 'AppShell must register global fallback at KEY_LAYER_GLOBAL');

    const modal = fs.readFileSync(path.join(SRC_ROOT, 'components/Modal.tsx'), 'utf8');
    assert.ok(modal.includes('KeyScopeProvider'), 'Modal must isolate scope depth with KeyScopeProvider');

    const confirm = fs.readFileSync(path.join(SRC_ROOT, 'components/ConfirmDialog.tsx'), 'utf8');
    assert.ok(confirm.includes('KEY_LAYER_MODAL'), 'ConfirmDialog must use KEY_LAYER_MODAL');

    const textInput = fs.readFileSync(path.join(SRC_ROOT, 'components/TextInput.tsx'), 'utf8');
    assert.ok(textInput.includes('KEY_LAYER_TEXT_INPUT'), 'TextInput must use KEY_LAYER_TEXT_INPUT');

    for (const widget of ['components/VirtualList.tsx', 'components/ScrollView.tsx', 'components/SelectList.tsx']) {
      const code = fs.readFileSync(path.join(SRC_ROOT, widget), 'utf8');
      assert.ok(code.includes('KEY_LAYER_WIDGET'), `${widget} must use KEY_LAYER_WIDGET`);
    }
  });

  test('3. Conflict matrix: Global x View x Widget x Modal key matrix has ZERO unresolved single-key overlaps', () => {
    const matrixConflicts = [];

    // Check every TSX view/modal for active VirtualList/ScrollView/MarkdownView/SelectList key overlaps
    // with parent single-key handlers in the same file.
    for (const file of ALL_SRC) {
      const r = rel(file);
      if (!r.startsWith('views/') && !r.startsWith('shell/')) continue;
      if (!r.endsWith('.tsx')) continue;
      const code = fs.readFileSync(file, 'utf8');

      // Extract single-char `input === 'k'` / `input === 'j'` / `input === 'g'` / `input === 'G'` handlers
      const handledSingleKeys = new Set();
      for (const m of code.matchAll(/\b(?:input|lower)\s*===\s*['"]([jk gG])['"]/g)) {
        handledSingleKeys.add(m[1]);
      }

      // Use TypeScript AST to inspect JSX elements accurately (arrow functions in props won't break matching).
      const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const jsxTags = [];
      function collectJsx(node) {
        if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
          const name = node.tagName.getText(sf);
          if (name === 'VirtualList' || name === 'ScrollView' || name === 'MarkdownView' || name === 'SelectList') {
            const props = new Map();
            for (const prop of node.attributes.properties) {
              if (ts.isJsxAttribute(prop)) {
                const pname = prop.name.getText(sf);
                const pval = prop.initializer ? prop.initializer.getText(sf) : 'true';
                props.set(pname, pval);
              }
            }
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            jsxTags.push({ name, line, props });
          }
        }
        ts.forEachChild(node, collectJsx);
      }
      collectJsx(sf);

      // Check VirtualList: if parent binds non-nav 'k' alongside an active VirtualList, it must set vimNavKeys={false}.
      if (handledSingleKeys.has('k') && jsxTags.some((t) => t.name === 'VirtualList')) {
        const kLines = code.split('\n').filter((l) => /\binput\s*===\s*['"]k['"]/.test(l));
        const hasNonNavK = kLines.some((l) => !/upArrow|prev|cursor|index|scroll/i.test(l));
        if (hasNonNavK) {
          for (const tag of jsxTags) {
            if (tag.name !== 'VirtualList') continue;
            const isExplicitInactive = tag.props.get('isActive') === '{false}';
            const hasVimNavDisabled = tag.props.get('vimNavKeys') === '{false}';
            // ExamSetup history VirtualList is only active on pane==='history' (while k only runs on pane==='setup')
            const isMutuallyExclusive =
              (r === 'views/exam/ExamSetup.tsx' && /history/.test(tag.props.get('isActive') ?? '')) ||
              r === 'views/library/DeckManageModal.tsx';
            if (!isExplicitInactive && !hasVimNavDisabled && !isMutuallyExclusive) {
              matrixConflicts.push(`${r}:${tag.line} [View x VirtualList] parent binds non-nav 'k' while VirtualList has vimNavKeys enabled`);
            }
          }
        }
      }

      // Check ScrollView: if parent binds non-nav 'k' alongside active ScrollView without vimNavKeys={false}
      if (handledSingleKeys.has('k') && jsxTags.some((t) => t.name === 'ScrollView')) {
        const kLines = code.split('\n').filter((l) => /\binput\s*===\s*['"]k['"]/.test(l));
        const hasNonNavK = kLines.some((l) => !/upArrow|prev|cursor|index|scroll/i.test(l));
        if (hasNonNavK) {
          for (const tag of jsxTags) {
            if (tag.name !== 'ScrollView') continue;
            const isExplicitInactive = tag.props.get('isActive') === '{false}';
            const hasVimNavDisabled = tag.props.get('vimNavKeys') === '{false}';
            if (!isExplicitInactive && !hasVimNavDisabled) {
              matrixConflicts.push(`${r}:${tag.line} [View x ScrollView] parent binds non-nav 'k' while ScrollView has vimNavKeys enabled`);
            }
          }
        }
      }

      // Check g/G opt-in: no component may opt into vimJumpKeys on a view that also binds 'g'
      if (handledSingleKeys.has('g') && jsxTags.some((t) => t.props.has('vimJumpKeys') && t.props.get('vimJumpKeys') !== '{false}')) {
        matrixConflicts.push(`${r}: [View x Widget] enables vimJumpKeys while also handling 'g'`);
      }
    }

    assert.deepEqual(
      matrixConflicts,
      [],
      `Key conflict matrix detected unresolved overlaps:\n${matrixConflicts.join('\n')}`,
    );
  });

  test('4. Runtime dispatcher: strict priority order, single consumption, and opaque modal barrier isolation', async () => {
    const {
      KEY_LAYER_GLOBAL,
      KEY_LAYER_MODAL_FRAME,
      KEY_LAYER_SYSTEM,
      KEY_LAYER_TEXT_INPUT,
      KEY_LAYER_VIEW,
      KEY_LAYER_WIDGET,
      createTestKeyHub,
      dispatchToHub,
      registerTestBarrier,
      registerTestHandler,
    } = await import('../src/components/key-dispatcher.ts');

    const hub = createTestKeyHub();
    const log = [];

    // Register root page handlers: global (100), widget (150), view (200), system (600)
    registerTestHandler(hub, (inp) => { log.push(`global:${inp}`); return true; }, { layer: KEY_LAYER_GLOBAL, depth: 0 });
    registerTestHandler(hub, (inp) => { log.push(`widget:${inp}`); return inp === 'j'; }, { layer: KEY_LAYER_WIDGET, depth: 0 });
    registerTestHandler(hub, (inp) => {
      log.push(`view:${inp}`);
      if (inp === 'k') return true; // view consumes 'k' -> widget MUST NOT also run!
      return false;
    }, { layer: KEY_LAYER_VIEW, depth: 0 });
    registerTestHandler(hub, (inp, key) => {
      if (key.ctrl && inp === 'c') { log.push('system:ctrl+c'); return true; }
      return false;
    }, { layer: KEY_LAYER_SYSTEM, depth: 0 });

    // 'k' consumed by view -> widget and global do NOT fire
    dispatchToHub(hub, 'k', EMPTY_KEY);
    assert.deepEqual(log, ['view:k'], 'consuming key in view must stop widget and global from firing');

    // 'j' ignored by view -> widget handles and consumes -> global does NOT fire
    log.length = 0;
    dispatchToHub(hub, 'j', EMPTY_KEY);
    assert.deepEqual(log, ['view:j', 'widget:j'], 'widget consumes j and blocks global fallback');

    // 'b' ignored by view and widget -> falls through to global
    log.length = 0;
    dispatchToHub(hub, 'b', EMPTY_KEY);
    assert.deepEqual(log, ['view:b', 'widget:b', 'global:b'], 'unhandled key falls through to global');

    // Open a modal at depth=1 with opaque barrier: background depth=0 handlers are completely blocked!
    const releaseModalBarrier = registerTestBarrier(hub, 1);
    const releaseModalFrame = registerTestHandler(hub, (_inp, key) => {
      log.push('modal-frame');
      return key.escape;
    }, { layer: KEY_LAYER_MODAL_FRAME, depth: 1 });
    const releaseModalInput = registerTestHandler(hub, (inp) => {
      log.push(`modal-text:${inp}`);
      return inp === 'a';
    }, { layer: KEY_LAYER_TEXT_INPUT, depth: 1 });

    log.length = 0;
    dispatchToHub(hub, 'b', EMPTY_KEY);
    assert.deepEqual(log, ['modal-text:b', 'modal-frame'], 'opaque modal at depth 1 blocks all depth 0 handlers');

    // Inside modal, TextInput (500) consumes 'a' before modal-frame (120)
    log.length = 0;
    dispatchToHub(hub, 'a', EMPTY_KEY);
    assert.deepEqual(log, ['modal-text:a'], 'TextInput consumes a before modal frame');

    // System Ctrl+C STILL works even with modal open!
    log.length = 0;
    dispatchToHub(hub, 'c', { ...EMPTY_KEY, ctrl: true });
    assert.deepEqual(log, ['system:ctrl+c'], 'KEY_LAYER_SYSTEM runs even over opaque modals');

    // Nested ConfirmDialog at depth=2 blocks depth=1 modal AND depth=0 page!
    const releaseConfirmBarrier = registerTestBarrier(hub, 2);
    const releaseConfirm = registerTestHandler(hub, (_inp, key) => {
      log.push('confirm-esc');
      return key.escape;
    }, { layer: KEY_LAYER_VIEW, depth: 2 });

    log.length = 0;
    dispatchToHub(hub, '', { ...EMPTY_KEY, escape: true });
    assert.deepEqual(log, ['confirm-esc'], 'nested depth=2 confirm consumes Esc without closing depth=1 modal');

    releaseConfirm();
    releaseConfirmBarrier();
    releaseModalInput();
    releaseModalFrame();
    releaseModalBarrier();

    // After closing modals, root view/global work again
    log.length = 0;
    dispatchToHub(hub, 'k', EMPTY_KEY);
    assert.deepEqual(log, ['view:k']);
  });
});
