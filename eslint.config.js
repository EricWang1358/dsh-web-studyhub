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
      "node_modules/**",
      "*.tgz",
      "scripts/probe*.mjs",
      "scripts/snap-*.mjs",
    ],
  },
  {
    files: ["lib/**/*.js", "scripts/**/*.mjs", "tests/**/*.mjs", "eslint.config.js"],
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
