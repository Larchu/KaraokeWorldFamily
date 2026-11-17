import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { DbClient } from "./db.ts";

const DJ_COOKIE = "mh-dj";
const SINGER_COOKIE = "mh-singer";
const DJ_MAX_AGE_SECONDS = 60 * 60 * 14;
const SINGER_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

let ephemeralDevSecret: string | null = null;

function getSessionSecret(): string {
  const configured = process.env["DJ_SESSION_SECRET"]?.trim();
  if (configured && configured.length >= 16) return configured;
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("DJ_SESSION_SECRET is required in production");
  }
  if (!ephemeralDevSecret) {
    ephemeralDevSecret = crypto.randomBytes(32).toString("hex");
    console.warn(
      "[auth] DJ_SESSION_SECRET not set — using ephemeral development secret (sessions reset on server restart).",
    );
  }
  return ephemeralDevSecret;
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function signToken(payload: string): string {
  return crypto
    .createHmac("sha256", getSessionSecret())
    .update(payload)
    .digest("base64url");
}

function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers["x-forwarded-proto"];
  if (typeof proto === "string") return proto.split(",")[0]?.trim() === "https";
  return false;
}

function cookieOptions(req: Request, maxAgeSeconds: number) {
  const https = isHttpsRequest(req);
  return {
    httpOnly: true,
    secure: https,
    sameSite: (https ? "none" : "lax") as "none" | "lax",
    ...(https ? { partitioned: true } : {}),
    path: "/",
    maxAge: maxAgeSeconds * 1000,
  };
}

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    return token || null;
  }
  return null;
}

export function isDjConfigured(): boolean {
  return Boolean(process.env["DJ_PASSWORD"]?.trim());
}

export function checkDjPassword(input: string): { ok: boolean; reason?: "config" | "wrong" } {
  const pw = process.env["DJ_PASSWORD"];
  if (!pw || !pw.trim()) {
    return { ok: false, reason: "config" };
  }
  if (!safeEqual(input, pw)) {
    return { ok: false, reason: "wrong" };
  }
  return { ok: true };
}

export async function startDjSession(db: DbClient, req: Request, res: Response): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + DJ_MAX_AGE_SECONDS;
  const sid = crypto.randomUUID();
  await db.query(`INSERT INTO public.dj_sessions (id, expires_at) VALUES ($1, $2)`, [
    sid,
    new Date(exp * 1000).toISOString(),
  ]);
  const payload = `${exp}.${sid}`;
  const token = `${payload}.${signToken(payload)}`;
  res.cookie(DJ_COOKIE, token, cookieOptions(req, DJ_MAX_AGE_SECONDS));
  return token;
}

export async function endDjSession(db: DbClient, req: Request, res: Response): Promise<void> {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[DJ_COOKIE] ?? extractBearerToken(req);
  if (raw) {
    const [exp, sid, sig] = raw.split(".");
    if (exp && sid && sig && safeEqual(sig, signToken(`${exp}.${sid}`))) {
      await db.query(`DELETE FROM public.dj_sessions WHERE id = $1`, [sid]);
    }
  }
  const https = isHttpsRequest(req);
  res.clearCookie(DJ_COOKIE, {
    path: "/",
    ...(https ? { secure: true, sameSite: "none" as const, partitioned: true } : {}),
  });
}

export async function verifyDjRequest(db: DbClient, req: Request): Promise<boolean> {
  const cookies = parseCookies(req.headers.cookie);
  const queryToken = typeof req.query["djToken"] === "string" ? req.query["djToken"].trim() : null;
  const raw = cookies[DJ_COOKIE] ?? extractBearerToken(req) ?? queryToken;
  if (!raw) return false;
  const parts = raw.split(".");
  if (parts.length !== 3) return false;
  const [exp, sid, sig] = parts;
  if (!exp || !sid || !sig) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now() / 1000) return false;
  let expectedSig: string;
  try {
    expectedSig = signToken(`${exp}.${sid}`);
  } catch {
    return false;
  }
  if (!safeEqual(sig, expectedSig)) return false;
  const result = await db.query<{ id: string }>(
    `SELECT id FROM public.dj_sessions WHERE id = $1 AND expires_at > now() LIMIT 1`,
    [sid],
  );
  return result.rows.length > 0;
}

export function setSingerCookie(req: Request, res: Response, userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + SINGER_MAX_AGE_SECONDS;
  const payload = `${exp}.${userId}`;
  const token = `${payload}.${signToken(payload)}`;
  res.cookie(SINGER_COOKIE, token, cookieOptions(req, SINGER_MAX_AGE_SECONDS));
  return token;
}

export function clearSingerCookie(res: Response, req?: Request): void {
  const https = req ? isHttpsRequest(req) : false;
  res.clearCookie(SINGER_COOKIE, {
    path: "/",
    ...(https ? { secure: true, sameSite: "none" as const, partitioned: true } : {}),
  });
}

export function getSingerUserId(req: Request): string | null {
  const cookies = parseCookies(req.headers.cookie);
  const headerToken =
    typeof req.headers["x-singer-token"] === "string" ? req.headers["x-singer-token"].trim() : null;
  const raw = cookies[SINGER_COOKIE] ?? headerToken;
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [exp, userId, sig] = parts;
  if (!exp || !userId || !sig) return null;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now() / 1000) return null;
  try {
    if (!safeEqual(sig, signToken(`${exp}.${userId}`))) return null;
  } catch {
    return null;
  }
  return userId;
}
