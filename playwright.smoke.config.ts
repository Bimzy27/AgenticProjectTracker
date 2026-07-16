import { defineConfig } from '@playwright/test'

/**
 * Config for the packaged-build smoke test (tests/smoke). Kept separate from
 * playwright.config.ts so `npm run test:e2e` never requires a packaged build;
 * run `npm run package` first, then `npm run test:smoke`. The timeout is
 * generous because the asar-packed exe starts slower than the dev build.
 */
export default defineConfig({
  testDir: 'tests/smoke',
  timeout: 120_000,
  workers: 1,
  reporter: 'list'
})
