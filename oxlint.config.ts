import { defineConfig } from 'oxlint'

export default defineConfig({
  plugins: ['typescript', 'unicorn', 'oxc', 'vitest'],
  categories: {
    correctness: 'error',
  },
  rules: {
    'func-style': ['error', 'declaration', { allowTypeAnnotation: true }],
    'prefer-arrow-callback': 'error',
    'typescript/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
    'typescript/consistent-type-definitions': ['error', 'interface'],
  },
  ignorePatterns: ['dist/**', 'coverage/**', '.vitest/**'],
})
