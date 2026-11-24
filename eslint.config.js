import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'data/', '.aihub/', '.claude/'] },
  js.configs.recommended,
  {
    files: ['server/**/*.mjs', 'cli/**/*.mjs', 'test/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }], 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    files: ['web/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: globals.browser },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^(api|reduced)$' }], 'no-empty': ['error', { allowEmptyCatch: true }], 'no-control-regex': 'off' }, // \x00/\x01 are placeholder marks in the markdown renderer
  },
];
