import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    // The macOS companion uses the built-in node:test runner and its own
    // Electron-oriented test setup. Keep Vitest focused on the TypeScript core.
    exclude: ['apps/**', '**/node_modules/**', '**/dist/**'],
  },
});
