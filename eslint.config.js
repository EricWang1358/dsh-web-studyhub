import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const contextOwnerOf = (filePath) =>
  relative(repoRoot, resolve(filePath))
    .replaceAll("\\", "/")
    .match(/^lib\/contexts\/([^/]+)(?:\/|$)/)?.[1];

const staticSpecifier = (sourceNode) => {
  if (typeof sourceNode?.value === "string") return sourceNode.value;
  if (sourceNode?.type === "TemplateLiteral" && sourceNode.expressions.length === 0) {
    return sourceNode.quasis[0]?.value?.cooked ?? null;
  }
  return null;
};

const contextBoundaries = {
  rules: {
    "no-private-context-import": {
      meta: { type: "problem", schema: [] },
      create(context) {
        const owner = contextOwnerOf(context.filename);
        if (!owner) return {};
        const check = (sourceNode) => {
          const raw = staticSpecifier(sourceNode);
          if (typeof raw !== "string" || !raw.startsWith(".")) return;
          const clean = raw.split(/[?#]/)[0];
          const target = resolve(dirname(context.filename), clean);
          const foreign = contextOwnerOf(target);
          if (foreign && foreign !== owner && !target.replaceAll("\\", "/").endsWith(`/lib/contexts/${foreign}/contracts.js`)) {
            context.report({
              node: sourceNode,
              message: `Context "${owner}" must not import private module "${raw}" from context "${foreign}"; import "../${foreign}/contracts.js" or use a declared runtime API port.`,
            });
          }
        };
        return {
          ImportDeclaration: (node) => check(node.source),
          ExportNamedDeclaration: (node) => check(node.source),
          ExportAllDeclaration: (node) => check(node.source),
          ImportExpression: (node) => check(node.source),
        };
      },
    },
  },
};

/* Cheap correctness rules (code audit, 2026-11): each had few or no violations when it was switched on, and those were fixed, so every
   one is an error from here on. Fix the code a rule points at. An exception is a line in this file with its reason, never an inline
   eslint-disable: tests/lint-guard.test.mjs fails on one outside ui/, and ui/ holds its old ones on a ratchet that may only fall
   (rule lintDisable in scripts/qa/guardrail-baseline.mjs). */
const cheapRules = {
  // A trailing parameter nobody reads is deleted or named _like, so a signature says what the function uses.
  "no-unused-vars": [
    "error",
    { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
  ],
  "no-undef": "error",
  // A repeated key silently drops the earlier value (message tables merged from several lanes).
  "no-dupe-keys": "error",
  // An empty block hides a failure: handle it, or say in a comment inside the block why nothing is done.
  "no-empty": "error",
  // Not flagged: a name declared ahead of a closure that reads it (`let timer; const stop = () => clearTimeout(timer); timer = …`),
  // and a destructuring where only some of the names are reassigned.
  "prefer-const": ["error", { destructuring: "all", ignoreReadBeforeAssign: true }],
  "no-var": "error",
  eqeqeq: ["error", "always", { null: "ignore" }],
  // In a string, "\d" or "\." is only "d" or ".": the author nearly always meant "\\d". Check which before deleting the backslash.
  "no-useless-escape": "error",
  "no-useless-catch": "error",
  "no-unreachable": "error",
  "no-unused-expressions": ["error", { allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true, enforceForJSX: true }],
  "no-constant-condition": ["error", { checkLoops: "allExceptWhileTrue" }],
  "no-fallthrough": "error",
  "no-case-declarations": "error",
  "no-prototype-builtins": "error",
  "no-async-promise-executor": "error",
  "no-self-assign": "error",
  "no-unsafe-optional-chaining": "error",
  "no-cond-assign": "error",
  "no-loss-of-precision": "error",
  "no-sparse-arrays": "error",
  "no-misleading-character-class": "error",
};

/* Lint guards against real bugs (unused vars, stale hooks deps, undefined
   globals); style is deliberately not enforced — formatting stays manual. */
export default [
  {
    ignores: [
      "dist/**",
      "output/**",
      "lib/client.js",
      "lib/client.*.js",
      "node_modules/**",
      "*.tgz",
      "scripts/probe*.mjs",
      "scripts/snap-*.mjs",
    ],
  },
  // A disable comment that silences nothing is a leftover: it goes when the code it excused is fixed.
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  {
    files: ["lib/**/*.js", "scripts/**/*.mjs", "tests/**/*.mjs", "packages/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: cheapRules,
  },
  {
    files: ["lib/contexts/**/*.js"],
    plugins: { "context-boundaries": contextBoundaries },
    rules: {
      "context-boundaries/no-private-context-import": "error",
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/legacy-kernel.js", "**/legacy-registration.js", "**/store.js"],
          message: "Contexts use runtime-injected scoped services and declared API ports; legacy authority and raw storage are forbidden.",
        }, {
          group: ["**/live.js"],
          importNames: ["activeSession", "registered", "register", "unregister", "listSaved"],
          message: "Use the runtime's owned live registry rather than the standalone compatibility registry.",
        }, {
          group: ["**/audio-upload.js"],
          importNames: ["startUpload", "appendUpload", "finishUpload", "cancelUpload", "claimUpload", "releaseUpload", "discardUpload"],
          message: "Use the runtime's owned upload registry.",
        }, {
          group: ["**/panel-bridge.js"],
          importNames: ["queuePanelIntent", "takePanelIntent", "panelObservation", "hasPanelVisibility", "setPanelVisible", "registerPanelNotifier", "observePanelReview"],
          message: "Use the runtime's owned panel bridge.",
        }],
      }],
    },
  },
  {
    // These Playwright scripts include callbacks evaluated in the browser page.
    files: ["scripts/site-crop.mjs", "scripts/site-qa.mjs", "scripts/site-shots.mjs"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["ui/**/*.jsx", "ui/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, "react-hooks": reactHooks },
    // The host seeds React 18. Spelled out: "detect" calls an API ESLint 10 removed, and the rules that read the version crash on it.
    settings: { react: { version: "18.3" } },
    rules: {
      ...cheapRules,
      "react/jsx-uses-react": "error",
      "react/jsx-uses-vars": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react/jsx-key": "error",
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      // A component declared inside another is a new type on every render: its subtree remounts and loses state and focus.
      // A render prop is a function the component calls, not a component: `trigger` is the one of Menu and Popover.
      "react/no-unstable-nested-components": ["error", { propNamePattern: "{render*,trigger}" }],
      "react/jsx-no-useless-fragment": "error",
    },
  },
];
