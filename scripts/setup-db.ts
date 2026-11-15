import "dotenv/config";
import { applyMigrations, createPgliteClient, createPostgresClient } from "../server/db.ts";

async function main() {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  const db = databaseUrl
    ? await createPostgresClient(databaseUrl)
    : await createPgliteClient();

  try {
    const result = await applyMigrations(db);
    console.log(
      `[db:setup] Backend=${db.kind} existingBaseline=${result.existingBaselineDetected} applied=${JSON.stringify(result.applied)} skipped=${JSON.stringify(result.skipped)}`,
    );
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("[db:setup] Failed:", err);
  process.exit(1);
});
