import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

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
  {
    files: ["lib/**/*.js", "scripts/**/*.mjs", "tests/**/*.mjs", "packages/**/*.js", "eslint.config.js"],
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
    },
  },
  {
    files: ["lib/contexts/**/*.js"],
    rules: {
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
];
