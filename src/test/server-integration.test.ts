// @vitest-environment node
import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createPgliteClient, type DbClient } from "../../server/db.ts";
import { createExpressApp } from "../../server/app.ts";
import { resetApplauseStateForTests } from "../../server/applause-service.ts";

class CookieJar {
  private cookies = new Map<string, string>();

  capture(res: Response) {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const entry of raw) {
      const pair = entry.split(";")[0];
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq > 0) {
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        if (v === "") this.cookies.delete(k);
        else this.cookies.set(k, v);
      }
    }
  }

  header(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

async function api(
  baseUrl: string,
  jar: CookieJar | null,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (init?.body) headers["Content-Type"] = "application/json";
  if (jar && jar.header()) headers["Cookie"] = jar.header();
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string>) },
  });
  jar?.capture(res);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

describe("Server, Database & Applausometer integration", () => {
  let db: DbClient;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env["DJ_PASSWORD"] = "test-dj-pw";
    process.env["DJ_SESSION_SECRET"] = "test-session-secret-1234";

    db = await createPgliteClient("memory://");
    const mig = await applyMigrations(db);
    expect(mig.applied).toEqual([
      "0000_karaoke_schema.sql",
      "0001_guest_device_likes.sql",
      "0002_dj_sessions.sql",
      "0003_applausometer_and_scoring.sql",
    ]);

    const app = createExpressApp(db);
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  });

  beforeEach(async () => {
    resetApplauseStateForTests();
    await db.exec(`
      TRUNCATE TABLE
        public.applause_measurements,
        public.performance_likes,
        public.favorite_songs,
        public.song_requests,
        public.dj_sessions,
        public.profiles,
        public.local_accounts
      RESTART IDENTITY CASCADE;
    `);
  });

  it("enforces DJ auth on protected queue and applause endpoints", async () => {
    const anon = new CookieJar();
    const res1 = await api(baseUrl, anon, "/api/applause/state");
    expect(res1.status).toBe(401);

    const badLogin = await api(baseUrl, anon, "/api/dj/login", {
      method: "POST",
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(badLogin.json["ok"]).toBe(false);

    const dj = new CookieJar();
    const goodLogin = await api(baseUrl, dj, "/api/dj/login", {
      method: "POST",
      body: JSON.stringify({ password: "test-dj-pw" }),
    });
    expect(goodLogin.json["ok"]).toBe(true);

    const status = await api(baseUrl, dj, "/api/dj/status");
    expect(status.json["ok"]).toBe(true);
  });

  it("runs complete lifecycle: request -> play -> likes -> 10s applause -> score persistence -> leaderboard & stats", async () => {
    const dj = new CookieJar();
    await api(baseUrl, dj, "/api/dj/login", {
      method: "POST",
      body: JSON.stringify({ password: "test-dj-pw" }),
    });

    // Three registered singers testing the exact binding point formula:
    // Singer A: 0 applause + 0 likes = 0
    // Singer B: 70 applause + 3 likes = 100
    // Singer C: 100 applause + 20 likes = 300
    const singerB = new CookieJar();
    await api(baseUrl, singerB, "/api/auth/local-login", {
      method: "POST",
      body: JSON.stringify({ email: "bea@example.com", displayName: "Bea" }),
    });
    const reqBRes = await api(baseUrl, singerB, "/api/requests", {
      method: "POST",
      body: JSON.stringify({
        singer_name: "Bea",
        song_title: "Song B",
        video_id: "bbbbbbbbbbb",
      }),
    });
    const reqBId = String(reqBRes.json["id"]);

    const singerC = new CookieJar();
    await api(baseUrl, singerC, "/api/auth/local-login", {
      method: "POST",
      body: JSON.stringify({ email: "carla@example.com", displayName: "Carla" }),
    });
    const reqCRes = await api(baseUrl, singerC, "/api/requests", {
      method: "POST",
      body: JSON.stringify({
        singer_name: "Carla",
        song_title: "Song C",
        video_id: "ccccccccccc",
      }),
    });
    const reqCId = String(reqCRes.json["id"]);

    const singerA = new CookieJar();
    await api(baseUrl, singerA, "/api/auth/local-login", {
      method: "POST",
      body: JSON.stringify({ email: "alex@example.com", displayName: "Alex" }),
    });
    const reqARes = await api(baseUrl, singerA, "/api/requests", {
      method: "POST",
      body: JSON.stringify({
        singer_name: "Alex",
        song_title: "Song A",
        video_id: "aaaaaaaaaaa",
      }),
    });
    const reqAId = String(reqARes.json["id"]);

    // DJ starts Song B
    await api(baseUrl, dj, "/api/dj/requests/status", {
      method: "POST",
      body: JSON.stringify({ id: reqBId, status: "playing" }),
    });

    // 3 guests like Song B
    for (let i = 1; i <= 3; i++) {
      const devId = `00000000-0000-4000-8000-00000000000${i}`;
      const lk = await api(baseUrl, null, "/api/likes/guest", {
        method: "POST",
        body: JSON.stringify({ requestId: reqBId, deviceId: devId }),
      });
      expect(lk.json["ok"]).toBe(true);
    }

    // Start applause measurement on Song B
    const mId1 = "99999999-9999-4999-8999-999999999991";
    const mStart = await api(baseUrl, dj, "/api/applause/start", {
      method: "POST",
      body: JSON.stringify({ requestId: reqBId, measurementId: mId1, durationMs: 10000 }),
    });
    expect(mStart.status).toBe(200);

    // Concurrent measurement is rejected with 409
    const mIdBusy = "99999999-9999-4999-8999-999999999992";
    const busyStart = await api(baseUrl, dj, "/api/applause/start", {
      method: "POST",
      body: JSON.stringify({ requestId: reqBId, measurementId: mIdBusy }),
    });
    expect(busyStart.status).toBe(409);

    // Push seq=2 then stale seq=1 (stale rejected)
    const seq2 = await api(baseUrl, dj, "/api/applause/level", {
      method: "POST",
      body: JSON.stringify({ measurementId: mId1, requestId: reqBId, seq: 2, level: 0.7, peak: 0.8 }),
    });
    expect(seq2.json["accepted"]).toBe(true);

    const seq1 = await api(baseUrl, dj, "/api/applause/level", {
      method: "POST",
      body: JSON.stringify({ measurementId: mId1, requestId: reqBId, seq: 1, level: 0.2, peak: 0.2 }),
    });
    expect(seq1.json["accepted"]).toBe(false);

    // Complete measurement yielding exact ~70/100 score (all samples = 0.65 -> 0.55*0.65 + 0.30*0.65 + 0.15*1.0 = 0.7025 -> 70)
    const samplesB = Array(50).fill(0.65);
    const completedB = await api(baseUrl, dj, "/api/applause/complete", {
      method: "POST",
      body: JSON.stringify({ measurementId: mId1, requestId: reqBId, samples: samplesB }),
    });
    expect(completedB.status).toBe(200);
    const stateB = completedB.json["state"] as Record<string, unknown>;
    expect(stateB["score"]).toBe(70);
    expect(stateB["likes"]).toBe(3);
    expect(stateB["totalPoints"]).toBe(100);

    // A subsequent failed/cancelled retry MUST NOT overwrite Song B's saved 70/100 score!
    const mIdRetry = "99999999-9999-4999-8999-999999999993";
    await api(baseUrl, dj, "/api/applause/start", {
      method: "POST",
      body: JSON.stringify({ requestId: reqBId, measurementId: mIdRetry }),
    });
    await api(baseUrl, dj, "/api/applause/cancel", {
      method: "POST",
      body: JSON.stringify({ measurementId: mIdRetry, requestId: reqBId, reason: "cancelled" }),
    });
    const reqBAfterCancel = await api(baseUrl, null, `/api/requests/${reqBId}`);
    expect((reqBAfterCancel.json["row"] as Record<string, unknown>)["applause_score"]).toBe(70);

    // Complete Song B twice using dj_complete_current: second call is idempotent no-op
    const comp1 = await api(baseUrl, dj, "/api/dj/requests/complete-current", {
      method: "POST",
      body: JSON.stringify({ id: reqBId }),
    });
    expect(comp1.json["ok"]).toBe(true);
    const comp2 = await api(baseUrl, dj, "/api/dj/requests/complete-current", {
      method: "POST",
      body: JSON.stringify({ id: reqBId }),
    });
    expect(comp2.json["ok"]).toBe(false);
    expect(comp2.json["reason"]).toBe("stale");

    // Finish Song C with 100 applause + 20 likes = 300 points
    await api(baseUrl, dj, "/api/dj/requests/status", {
      method: "POST",
      body: JSON.stringify({ id: reqCId, status: "playing" }),
    });
    for (let i = 1; i <= 20; i++) {
      const hex = i.toString(16).padStart(12, "0");
      await api(baseUrl, null, "/api/likes/guest", {
        method: "POST",
        body: JSON.stringify({
          requestId: reqCId,
          deviceId: `00000000-0000-4000-8000-${hex}`,
        }),
      });
    }
    await db.query(`SELECT public.dj_record_applause($1, $2, $3)`, [
      reqCId,
      "99999999-9999-4999-8999-999999999994",
      100,
    ]);
    await api(baseUrl, dj, "/api/dj/requests/complete-current", {
      method: "POST",
      body: JSON.stringify({ id: reqCId }),
    });

    // Finish Song A with 0 applause + 0 likes = 0 points (score stays null -> counts as 0)
    await api(baseUrl, dj, "/api/dj/requests/status", {
      method: "POST",
      body: JSON.stringify({ id: reqAId, status: "playing" }),
    });
    await api(baseUrl, dj, "/api/dj/requests/complete-current", {
      method: "POST",
      body: JSON.stringify({ id: reqAId }),
    });

    // Verify Leaderboard aggregation (no join multiplication of applause_score * likes!)
    const lb = await api(baseUrl, null, "/api/leaderboard?period=night");
    const rows = lb.json["rows"] as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r["display_name"], r["applause_points"], r["likes"], r["total_points"]])).toEqual([
      ["Carla", 100, 20, 300],
      ["Bea", 70, 3, 100],
      ["Alex", 0, 0, 0],
    ]);

    // Verify Singer B stats in /api/account match exact points
    const accB = await api(baseUrl, singerB, "/api/account");
    expect(accB.json["stats"]).toEqual({
      likes: 3,
      applause_points: 70,
      total_points: 100,
      performances: 1,
      requests: 1,
    });
  });

  it("enforces DB score range constraint 0..100 and separates leaderboard periods accurately", async () => {
    const pRes = await db.query<{ id: string }>(
      `INSERT INTO public.local_accounts (id, email, display_name)
       VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'p@example.com', 'Pedro')
       RETURNING id`,
    );
    const uid = pRes.rows[0]!.id;
    await db.query(`INSERT INTO public.profiles (id, display_name) VALUES ($1, 'Pedro')`, [uid]);

    const r1 = "11111111-0000-4000-8000-000000000001";
    const r2 = "11111111-0000-4000-8000-000000000002";

    // r1 happened 3 days ago (still in month if day >= 4, or test explicit timestamps safely inside month & last year)
    const now = new Date();
    const inThisMonthNotNight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.max(1, now.getUTCDate() - 1) === now.getUTCDate() ? 1 : now.getUTCDate(), 0, 0, 0),
    );
    // Use 40 hours ago ONLY if same month; otherwise 14h ago (always outside 12h night window!)
    const olderThanNight =
      now.getUTCDate() >= 2
        ? new Date(now.getTime() - 20 * 3600 * 1000)
        : new Date(now.getTime() - 13 * 3600 * 1000);
    const oldAllTime = new Date(Date.UTC(now.getUTCFullYear() - 1, 5, 15));

    await db.query(
      `INSERT INTO public.song_requests (id, user_id, singer_name, song_title, video_id, status, applause_score, applause_measured_at, updated_at, created_at)
       VALUES
       ($1, $3, 'Pedro', 'Last Night Song', 'v1111111111', 'done', 50, $4, $4, $4),
       ($2, $3, 'Pedro', 'Last Year Song', 'v2222222222', 'done', 80, $5, $5, $5)`,
      [r1, r2, uid, olderThanNight.toISOString(), oldAllTime.toISOString()],
    );

    const nightRes = await db.query<{ total_points: string }>(
      `SELECT * FROM public.leaderboard('night')`,
    );
    expect(nightRes.rows).toHaveLength(0);

    // If same month, r1 (50 pts) appears in 'month' while r2 (80 pts from last year) only appears in 'all'
    if (olderThanNight.getUTCMonth() === now.getUTCMonth() && olderThanNight.getUTCFullYear() === now.getUTCFullYear()) {
      const monthRes = await db.query<{ total_points: string }>(
        `SELECT * FROM public.leaderboard('month')`,
      );
      expect(Number(monthRes.rows[0]?.total_points)).toBe(50);
    }

    const allRes = await db.query<{ total_points: string }>(
      `SELECT * FROM public.leaderboard('all')`,
    );
    expect(Number(allRes.rows[0]?.total_points)).toBe(130);

    // Invalid score rejected by CHECK constraint
    await expect(
      db.query(`UPDATE public.song_requests SET applause_score = 101 WHERE id = $1`, [r1]),
    ).rejects.toThrow();
    await expect(
      db.query(`UPDATE public.song_requests SET applause_score = -1 WHERE id = $1`, [r1]),
    ).rejects.toThrow();

    void inThisMonthNotNight;
  });

  it("preserves legacy baseline data on existing databases when applying 0003 migration", async () => {
    const legacyDb = await createPgliteClient("memory://");
    // Simulate a legacy database that already ran 0000..0002 BEFORE _app_migrations existed
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const mDir = path.resolve(process.cwd(), "drizzle", "migrations");
    for (const f of [
      "0000_karaoke_schema.sql",
      "0001_guest_device_likes.sql",
      "0002_dj_sessions.sql",
    ]) {
      await legacyDb.exec(await fs.readFile(path.join(mDir, f), "utf-8"));
    }

    await legacyDb.query(
      `INSERT INTO public.song_requests (id, singer_name, song_title, video_id, status)
       VALUES ('deadbeef-dead-4ead-8ead-deadbeef0001', 'Legacy Singer', 'Legacy Hit', 'vid12345678', 'done')`,
    );

    const mig = await applyMigrations(legacyDb);
    expect(mig.existingBaselineDetected).toBe(true);
    expect(mig.skipped).toEqual([
      "0000_karaoke_schema.sql",
      "0001_guest_device_likes.sql",
      "0002_dj_sessions.sql",
    ]);
    expect(mig.applied).toEqual(["0003_applausometer_and_scoring.sql"]);

    // Existing row survived untouched and new column exists
    const check = await legacyDb.query<{ singer_name: string; applause_score: number | null }>(
      `SELECT singer_name, applause_score FROM public.song_requests`,
    );
    expect(check.rows).toEqual([{ singer_name: "Legacy Singer", applause_score: null }]);
    await legacyDb.close();
  });
});
