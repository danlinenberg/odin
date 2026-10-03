import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";

// Populate the env vars `src/env.ts` validates at module load so test runtimes
// that boot host-service via `createApp` (instead of `serve.ts`) can import
// modules that transitively load the validated env. Real values come from
// each test's `createTestHost` config; these defaults exist purely to satisfy
// schema validation at import time.

process.env.ORGANIZATION_ID ??= "00000000-0000-4000-8000-000000000000";
process.env.HOST_DB_PATH ??= "/tmp/host-service-test.db";
process.env.HOST_MIGRATIONS_FOLDER ??= "/tmp/host-service-test-migrations";

// Tests must never reach the live Odin app's pty-daemon. Without ODIN_HOME_DIR
// the supervisor adopts whatever ~/.odin's manifest points at, and its socket
// is a hash of the org id under os.tmpdir() — both shared with the running
// app, so a stray bootstrap adopted the live daemon that holds every real
// agent session.
// A private home and tmpdir per run keep whatever a test adopts or spawns its
// own. Assigned, not ??=: a shell inside Odin already exports the real home.
// Short root because Darwin caps a socket path at 104 bytes.
const isolated = mkdtempSync("/tmp/odin-test-");
process.env.TMPDIR = isolated;
process.env.ODIN_HOME_DIR = isolated;
// In a preload this runs once, after the last test file.
afterAll(() => rmSync(isolated, { recursive: true, force: true }));
