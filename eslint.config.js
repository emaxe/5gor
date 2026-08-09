import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, Tone: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    ignores: [
      'index.html',
      'node_modules/**',
      '.worktrees/**',
      '.agents/**',
      '.claude/**',
      '.cursor/**',
      '.codex/**',
      '.grill-plan/**',
      '.duma/**',
      '.superpowers/**',
      '.github/**',
      'docs/**',
    ],
  },
];
