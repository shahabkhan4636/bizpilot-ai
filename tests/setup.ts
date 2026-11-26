import { beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Each test file runs against a throwaway SQLite file so unit tests never touch
 * a developer's real data. The DB module reads BIZPILOT_DB_FILE lazily.
 */
const TEST_DB = path.join(process.cwd(), "data", "test.db");

function freshFile() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${TEST_DB}${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file);
  }
}

process.env.BIZPILOT_DB_FILE = TEST_DB;
(process.env as Record<string, string>).NODE_ENV = "test";
freshFile();

beforeEach(() => {
  // nothing global: individual tests call resetDatabaseForTests() when they need a clean slate
});

afterAll(() => {
  freshFile();
});
