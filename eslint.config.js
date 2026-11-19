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

/* Lint guards against real bugs (unused vars, stale hooks deps, undefined
   globals); style is deliberately not enforced — formatting stays manual. */
export default [
  {
    ignores: [
      "dist/**",
      "output/**",
      "packages/*/dist/**",
      "packages/*/node_modules/**",
      "packages/*/src-tauri/target/**",
      "packages/*/src-tauri/resources/**",
      "lib/client.js",
      "lib/client.*.js",
      "node_modules/**",
      "*.tgz",
      "scripts/probe*.mjs",
      "scripts/snap-*.mjs",
    ],
  },
  {
    files: ["lib/**/*.js", "scripts/**/*.mjs", "tests/**/*.mjs", "packages/**/*.js", "packages/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": [
        "error",
        { args: "none", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-undef": "error",
      // A repeated key silently drops the earlier value (message tables merged from several lanes).
      "no-dupe-keys": "error",
    },
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
    settings: { react: { version: "detect" } },
    rules: {
      "no-unused-vars": [
        "error",
        { args: "none", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-undef": "error",
      "react/jsx-uses-react": "error",
      "react/jsx-uses-vars": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react/jsx-key": "error",
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
    },
  },
  // M0 Anti-Bad-Smell & DDD Guardrails for StudyHub Desktop (built-in rules only; no custom ESLint plugin).
  {
    files: ["packages/studyhub-desktop/**/*.{js,mjs}", "ui/desktop/**/*.{js,jsx}"],
    rules: {
      complexity: ["error", 12],
      "max-depth": ["error", 3],
      "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true }],
      "max-params": ["error", 4],
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      "no-empty": "error",
      "no-throw-literal": "error",
      "no-param-reassign": "error",
      "consistent-return": "error",
    },
  },
  {
    files: ["packages/studyhub-desktop/**/*.{js,mjs}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportDeclaration[source.value=/^(node:)?child_process$/] ImportSpecifier[imported.name=/^(exec|execSync)$/]",
          message: "Do not import exec or execSync; use spawn/execFile without a shell inside adapters/cli/process-runner.mjs.",
        },
        {
          selector: "CallExpression[callee.property.name='execSync']",
          message: "Do not call execSync; use spawn/execFile without a shell inside adapters/cli/process-runner.mjs.",
        },
        {
          selector: "Property[key.name='shell'][value.value=true], Property[key.value='shell'][value.value=true]",
          message: "Never pass shell: true when spawning child processes.",
        },
      ],
    },
  },
  {
    files: ["packages/studyhub-desktop/**/*.{js,mjs}"],
    ignores: ["packages/studyhub-desktop/adapters/cli/process-runner.mjs"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "node:child_process", message: "Only adapters/cli/process-runner.mjs may import node:child_process." },
          { name: "child_process", message: "Only adapters/cli/process-runner.mjs may import child_process." },
        ],
      }],
    },
  },
  {
    files: ["packages/studyhub-desktop/adapters/cli/process-runner.mjs"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "node:child_process", importNames: ["exec", "execSync"], message: "Never import exec or execSync; use spawn or execFile without a shell." },
          { name: "child_process", importNames: ["exec", "execSync"], message: "Never import exec or execSync; use spawn or execFile without a shell." },
        ],
        patterns: [
          { group: ["../application/*", "../application/**", "**/application/**"], message: "Desktop adapters cannot import application layer." },
          { group: ["../entry/*", "../entry/**", "**/entry/**"], message: "Desktop adapters cannot import entry layer." },
          { group: ["ui/*", "ui/**", "**/ui/**"], message: "Desktop adapters cannot import UI modules." },
        ],
      }],
    },
  },
  {
    files: ["packages/studyhub-desktop/adapters/**/*.{js,mjs}"],
    ignores: ["packages/studyhub-desktop/adapters/cli/process-runner.mjs"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "node:child_process", message: "Only adapters/cli/process-runner.mjs may import node:child_process." },
          { name: "child_process", message: "Only adapters/cli/process-runner.mjs may import child_process." },
        ],
        patterns: [
          { group: ["../application/*", "../application/**", "**/application/**"], message: "Desktop adapters cannot import application layer." },
          { group: ["../entry/*", "../entry/**", "**/entry/**"], message: "Desktop adapters cannot import entry layer." },
          { group: ["ui/*", "ui/**", "**/ui/**"], message: "Desktop adapters cannot import UI modules." },
        ],
      }],
    },
  },
  {
    files: ["packages/studyhub-desktop/application/**/*.{js,mjs}"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "node:child_process", message: "Desktop application layer cannot import node:child_process." },
          { name: "child_process", message: "Desktop application layer cannot import child_process." },
          { name: "node:fs", message: "Desktop application layer cannot import node:fs; inject a port." },
          { name: "fs", message: "Desktop application layer cannot import fs; inject a port." },
          { name: "node:fs/promises", message: "Desktop application layer cannot import node:fs/promises; inject a port." },
          { name: "fs/promises", message: "Desktop application layer cannot import fs/promises; inject a port." },
          { name: "node:http", message: "Desktop application layer cannot import node:http; inject a port." },
          { name: "http", message: "Desktop application layer cannot import http; inject a port." },
          { name: "node:https", message: "Desktop application layer cannot import node:https; inject a port." },
          { name: "https", message: "Desktop application layer cannot import https; inject a port." },
          { name: "node:net", message: "Desktop application layer cannot import node:net; inject a port." },
          { name: "net", message: "Desktop application layer cannot import net; inject a port." },
        ],
        patterns: [
          { group: ["../adapters/*", "../adapters/**", "**/adapters/**"], message: "Desktop application layer cannot import adapters layer; depend on domain ports." },
          { group: ["../entry/*", "../entry/**", "**/entry/**"], message: "Desktop application layer cannot import entry layer." },
          { group: ["ui/*", "ui/**", "**/ui/**"], message: "Desktop application layer cannot import UI modules." },
        ],
      }],
    },
  },
  {
    files: ["packages/studyhub-desktop/domain/**/*.{js,mjs}"],
    rules: {
      "no-console": "error",
      "no-restricted-imports": ["error", {
        paths: [
          { name: "child_process", message: "Desktop domain must be pure and cannot import Node built-ins." },
          { name: "fs", message: "Desktop domain must be pure and cannot import Node built-ins." },
          { name: "fs/promises", message: "Desktop domain must be pure and cannot import Node built-ins." },
          { name: "http", message: "Desktop domain must be pure and cannot import Node built-ins." },
          { name: "https", message: "Desktop domain must be pure and cannot import Node built-ins." },
          { name: "net", message: "Desktop domain must be pure and cannot import Node built-ins." },
          { name: "path", message: "Desktop domain must be pure and cannot import Node built-ins." },
          { name: "os", message: "Desktop domain must be pure and cannot import Node built-ins." },
          { name: "crypto", message: "Desktop domain must be pure and cannot import Node built-ins." },
          { name: "url", message: "Desktop domain must be pure and cannot import Node built-ins." },
          { name: "stream", message: "Desktop domain must be pure and cannot import Node built-ins." },
          { name: "events", message: "Desktop domain must be pure and cannot import Node built-ins." },
          { name: "util", message: "Desktop domain must be pure and cannot import Node built-ins." },
        ],
        patterns: [
          { group: ["node:*", "node:**"], message: "Desktop domain must be pure and cannot import any node:* built-in." },
          { group: ["../application/*", "../application/**", "**/application/**"], message: "Desktop domain cannot import application layer." },
          { group: ["../adapters/*", "../adapters/**", "**/adapters/**"], message: "Desktop domain cannot import adapters layer." },
          { group: ["../entry/*", "../entry/**", "**/entry/**"], message: "Desktop domain cannot import entry layer." },
          { group: ["ui/*", "ui/**", "**/ui/**"], message: "Desktop domain cannot import UI modules." },
        ],
      }],
    },
  },
];
