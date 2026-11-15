import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";

export interface SqlQueryResult<T = Record<string, unknown>> {
  rows: T[];
}

export interface DbClient {
  kind: "pglite" | "postgres";
  query<T = Record<string, unknown>>(sqlText: string, params?: unknown[]): Promise<SqlQueryResult<T>>;
  exec(sqlText: string): Promise<void>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = path.resolve(process.cwd(), "drizzle", "migrations");

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export async function createPgliteClient(dataDir?: string): Promise<DbClient> {
  const dir = dataDir ?? process.env["PGLITE_DATA_DIR"] ?? path.resolve(process.cwd(), ".data", "pglite");
  if (dir !== "memory://" && !dir.startsWith("memory://")) {
    await fs.mkdir(dir, { recursive: true });
  }
  const pg = dir === "memory://" ? new PGlite() : new PGlite(dir);
  await pg.waitReady;
  return {
    kind: "pglite",
    async query<T = Record<string, unknown>>(sqlText: string, params: unknown[] = []) {
      const res = await pg.query<T>(sqlText, params);
      return { rows: res.rows };
    },
    async exec(sqlText: string) {
      await pg.exec(sqlText);
    },
    async close() {
      await pg.close();
    },
  };
}

export async function createPostgresClient(databaseUrl: string): Promise<DbClient> {
  const sql = postgres(databaseUrl, { max: 10, idle_timeout: 20 });
  return {
    kind: "postgres",
    async query<T = Record<string, unknown>>(sqlText: string, params: unknown[] = []) {
      const rows = (await sql.unsafe(sqlText, params as never[])) as unknown as T[];
      return { rows };
    },
    async exec(sqlText: string) {
      await sql.unsafe(sqlText);
    },
    async close() {
      await sql.end();
    },
  };
}

export async function applyMigrations(db: DbClient): Promise<{ applied: string[]; skipped: string[]; existingBaselineDetected: boolean }> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS public._app_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const existingSongTable = await db.query<{ exists: boolean }>(
    `SELECT to_regclass('public.song_requests') IS NOT NULL AS exists`,
  );
  const existingDjSessions = await db.query<{ exists: boolean }>(
    `SELECT to_regclass('public.dj_sessions') IS NOT NULL AS exists`,
  );
  const appliedRows = await db.query<{ name: string; checksum: string }>(
    `SELECT name, checksum FROM public._app_migrations`,
  );
  const appliedMap = new Map(appliedRows.rows.map((r) => [r.name, r.checksum]));
  const existingBaselineDetected =
    Boolean(existingSongTable.rows[0]?.exists) && appliedMap.size === 0;

  const entries = await fs.readdir(MIGRATIONS_DIR);
  const files = entries.filter((f) => f.endsWith(".sql")).sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const fullPath = path.join(MIGRATIONS_DIR, file);
    const sqlContent = await fs.readFile(fullPath, "utf-8");
    const checksum = sha256(sqlContent);

    if (appliedMap.has(file)) {
      skipped.push(file);
      continue;
    }

    // If connecting to an already-populated legacy Supabase DB that already has
    // 0000..0002 objects without _app_migrations history, preserve all existing
    // data/triggers and only apply idempotent missing additions (0003+).
    if (
      existingBaselineDetected &&
      (file.startsWith("0000_") ||
        file.startsWith("0001_") ||
        (file.startsWith("0002_") && Boolean(existingDjSessions.rows[0]?.exists)))
    ) {
      await db.query(
        `INSERT INTO public._app_migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
        [file, checksum],
      );
      skipped.push(file);
      continue;
    }

    await db.exec(sqlContent);
    await db.query(
      `INSERT INTO public._app_migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [file, checksum],
    );
    applied.push(file);
  }

  return { applied, skipped, existingBaselineDetected };
}

let singletonPromise: Promise<DbClient> | null = null;

export async function getDb(): Promise<DbClient> {
  if (!singletonPromise) {
    singletonPromise = (async () => {
      const databaseUrl = process.env["DATABASE_URL"]?.trim();
      const client = databaseUrl
        ? await createPostgresClient(databaseUrl)
        : await createPgliteClient();
      await applyMigrations(client);
      return client;
    })();
  }
  return singletonPromise;
}
