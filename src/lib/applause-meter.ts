/**
 * Pure, deterministic 10-second Applausometer signal processing and state helpers.
 *
 * Calibration & Normalization:
 * - Time-domain PCM samples x[i] in [-1, 1] yield frame RMS = sqrt(mean(x[i]^2)).
 * - Converted to dBFS = 20 * log10(max(rms, 1e-5)), bounded to [-100, 0].
 * - Normalized over [NOISE_FLOOR_DB = -58 dBFS, CEILING_DB = -10 dBFS] -> [0, 1].
 * - Perceptual gamma exponent 0.85 prevents quiet rooms from pegging near 0 while
 *   keeping headroom for loud crowd cheering.
 * - Real-time UI bar applies exponential moving average smoothing (alpha = 0.35).
 *
 * Final Score (0..100) over the full 10-second measurement period:
 * - mean (55%): arithmetic mean across all captured frames (rewards sustained cheering).
 * - p75  (30%): 75th percentile frame level (captures peaks without letting one short
 *               100ms clap/mic-bump dominate the whole score).
 * - activeRatio (15%): fraction of frames >= 0.15 normalized level (rewards continuous applause).
 * - score = clamp(0, 100, round((0.55 * mean + 0.30 * p75 + 0.15 * activeRatio) * 100)).
 */

export const APPLAUSE_DURATION_MS = 10_000;
export const APPLAUSE_CELEBRATION_MS = 6_500;
export const APPLAUSE_NOISE_FLOOR_DB = -58;
export const APPLAUSE_CEILING_DB = -10;
export const APPLAUSE_MIN_SAMPLES = 5;

export type ApplauseMeasurementStatus =
  | "idle"
  | "measuring"
  | "completed"
  | "cancelled"
  | "failed";

export interface ApplauseStateSnapshot {
  measurementId: string | null;
  requestId: string | null;
  singerName: string | null;
  songTitle: string | null;
  status: ApplauseMeasurementStatus;
  startedAt: number | null;
  endsAt: number | null;
  durationMs: number;
  latestLevel: number;
  latestPeak: number;
  lastSeq: number;
  score: number | null;
  likes: number;
  totalPoints: number | null;
  updatedAt: number;
}

export interface ApplauseScoreBreakdown {
  score: number;
  mean: number;
  p75: number;
  activeRatio: number;
  peak: number;
  samplesCount: number;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function computeRmsFromFloatSamples(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / samples.length);
}

export function computeRmsFromByteTimeDomain(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const centered = ((samples[i] ?? 128) - 128) / 128;
    sumSq += centered * centered;
  }
  return Math.sqrt(sumSq / samples.length);
}

export function rmsToDbfs(rms: number): number {
  const safe = Math.max(rms, 1e-5);
  return Math.max(-100, Math.min(0, 20 * Math.log10(safe)));
}

export function normalizeDbfs(
  dbfs: number,
  floorDb = APPLAUSE_NOISE_FLOOR_DB,
  ceilingDb = APPLAUSE_CEILING_DB,
): number {
  if (!Number.isFinite(dbfs)) return 0;
  const span = Math.max(1, ceilingDb - floorDb);
  const linear = clamp01((dbfs - floorDb) / span);
  if (linear <= 0.02) return 0;
  return clamp01(Math.pow(linear, 0.85));
}

export function normalizeRmsLevel(rms: number): number {
  return normalizeDbfs(rmsToDbfs(rms));
}

export function smoothLevel(previous: number, raw: number, alpha = 0.35): number {
  const prev = clamp01(previous);
  const next = clamp01(raw);
  const a = clamp01(alpha);
  return clamp01(prev * (1 - a) + next * a);
}

export function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const clampedP = clamp01(p);
  const idx = clampedP * (sortedValues.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo] ?? 0;
  const frac = idx - lo;
  return (sortedValues[lo] ?? 0) * (1 - frac) + (sortedValues[hi] ?? 0) * frac;
}

export function computeApplauseScore(samples: readonly number[]): ApplauseScoreBreakdown {
  const clean = samples.map(clamp01);
  const count = clean.length;
  if (count === 0) {
    return { score: 0, mean: 0, p75: 0, activeRatio: 0, peak: 0, samplesCount: 0 };
  }

  let sum = 0;
  let active = 0;
  let peak = 0;
  for (const s of clean) {
    sum += s;
    if (s >= 0.15) active++;
    if (s > peak) peak = s;
  }

  const mean = sum / count;
  const sorted = [...clean].sort((a, b) => a - b);
  const p75 = percentile(sorted, 0.75);
  const activeRatio = active / count;

  const composite = 0.55 * mean + 0.30 * p75 + 0.15 * activeRatio;
  const score = Math.min(100, Math.max(0, Math.round(composite * 100)));

  return {
    score,
    mean,
    p75,
    activeRatio,
    peak,
    samplesCount: count,
  };
}

export function remainingApplauseSeconds(endsAtMs: number | null, nowMs: number): number {
  if (!endsAtMs || !Number.isFinite(endsAtMs)) return 0;
  const diff = Math.max(0, endsAtMs - nowMs);
  return Math.min(10, Math.ceil(diff / 1000));
}

export function shouldAcceptApplauseUpdate(
  current: Pick<ApplauseStateSnapshot, "measurementId" | "requestId" | "lastSeq" | "updatedAt" | "status">,
  incoming: {
    measurementId: string;
    requestId: string;
    seq?: number;
    updatedAt?: number;
  },
): boolean {
  if (!incoming.measurementId || !incoming.requestId) return false;
  if (current.measurementId && current.measurementId !== incoming.measurementId) {
    // Allow newer measurement only if its updatedAt is strictly newer than current
    if (
      typeof incoming.updatedAt === "number" &&
      incoming.updatedAt > current.updatedAt &&
      incoming.seq === 0
    ) {
      return true;
    }
    return false;
  }
  if (current.requestId && current.requestId !== incoming.requestId) return false;
  if (typeof incoming.seq === "number" && current.measurementId === incoming.measurementId) {
    if (incoming.seq <= current.lastSeq) return false;
  }
  if (typeof incoming.updatedAt === "number" && incoming.updatedAt < current.updatedAt) {
    return false;
  }
  return true;
}

export const IDLE_APPLAUSE_STATE: ApplauseStateSnapshot = {
  measurementId: null,
  requestId: null,
  singerName: null,
  songTitle: null,
  status: "idle",
  startedAt: null,
  endsAt: null,
  durationMs: APPLAUSE_DURATION_MS,
  latestLevel: 0,
  latestPeak: 0,
  lastSeq: 0,
  score: null,
  likes: 0,
  totalPoints: null,
  updatedAt: 0,
};
