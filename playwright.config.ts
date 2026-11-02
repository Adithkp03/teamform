import { defineConfig } from '@playwright/test';

// End-to-end: real API (tsx) + real Postgres + production web build (vite preview).
// Serial workers: specs share one database. The API runs with dev-login enabled
// and a log-only mailer; nothing external is contacted.
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/teamform_e2e';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'http://localhost:3101' },
  webServer: [
    {
      // CI ships the Vercel bundle: build it, then serve it through the
      // adapter so e2e exercises the deployed artifact cross-origin. Locally
      // the tsx watcher is the fast default (E2E_BUNDLE=1 opts into bundle).
      command: process.env.E2E_BUNDLE === '1'
        ? 'npm run bundle -w @teamform/api && node scripts/serve-bundle.mjs'
        : 'npm run start -w @teamform/api',
      env: {
        DATABASE_URL: DB,
        JWT_SECRET: 'e2e-secret',
        ALLOW_DEV_LOGIN: 'true',
        EVENTS_POLL_MS: '250',
        MAIL_PROVIDER: 'log',
        APP_ORIGIN: 'http://localhost:3101',
        PORT: '3100',
      },
      port: 3100,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'npm run preview -w @teamform/web -- --port 3101 --strictPort',
      port: 3101,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
