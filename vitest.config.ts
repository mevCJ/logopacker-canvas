import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Vitest config kept separate from the Cloudflare-enabled vite.config.ts so
// tests run in a plain happy-dom environment without the Workers plugin.
export default defineConfig({
  // Cast avoids a spurious type clash between vitest's bundled Vite and the
  // project's Vite 8 (rolldown) plugin types; runtime behavior is unaffected.
  plugins: [vue() as unknown as never],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/__tests__/**/*.{test,spec}.{ts,js}'],
    globals: true,
  },
})
