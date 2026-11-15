import { describe, expect, it } from "vitest";
import {
  computeApplauseScore,
  computeRmsFromFloatSamples,
  normalizeDbfs,
  normalizeRmsLevel,
  remainingApplauseSeconds,
  rmsToDbfs,
  shouldAcceptApplauseUpdate,
  smoothLevel,
} from "./applause-meter";

describe("applause meter signal processing & state rules", () => {
  it("computes accurate RMS and dBFS scaling", () => {
    const silent = new Float32Array(256).fill(0);
    expect(computeRmsFromFloatSamples(silent)).toBe(0);
    expect(normalizeRmsLevel(0)).toBe(0);

    const loud = new Float32Array(256).fill(0.5);
    const rms = computeRmsFromFloatSamples(loud);
    expect(rms).toBeCloseTo(0.5, 4);
    expect(rmsToDbfs(rms)).toBeCloseTo(-6.02, 1);
    expect(normalizeDbfs(-6)).toBe(1);
  });

  it("prevents a single brief spike from dominating the full 10s score", () => {
    // 149 silent frames + 1 brief 1.0 spike (~10 seconds @ 15Hz)
    const spikeOnly = [...Array(149).fill(0), 1.0];
    const sustained = Array(150).fill(0.75);

    const spikeResult = computeApplauseScore(spikeOnly);
    const sustainedResult = computeApplauseScore(sustained);

    expect(spikeResult.score).toBeLessThan(10);
    expect(sustainedResult.score).toBeGreaterThanOrEqual(75);
    expect(sustainedResult.score).toBeLessThanOrEqual(100);
  });

  it("smooths live meter changes and computes remaining countdown", () => {
    expect(smoothLevel(0, 1, 0.35)).toBeCloseTo(0.35, 3);
    expect(remainingApplauseSeconds(10_000, 1)).toBe(10);
    expect(remainingApplauseSeconds(10_000, 9_500)).toBe(1);
    expect(remainingApplauseSeconds(10_000, 11_000)).toBe(0);
  });

  it("rejects out-of-order or stale updates", () => {
    const current = {
      measurementId: "m1",
      requestId: "r1",
      lastSeq: 12,
      updatedAt: 5000,
      status: "measuring" as const,
    };

    expect(
      shouldAcceptApplauseUpdate(current, {
        measurementId: "m1",
        requestId: "r1",
        seq: 11,
        updatedAt: 5100,
      }),
    ).toBe(false);

    expect(
      shouldAcceptApplauseUpdate(current, {
        measurementId: "m1",
        requestId: "r2",
        seq: 13,
        updatedAt: 5100,
      }),
    ).toBe(false);

    expect(
      shouldAcceptApplauseUpdate(current, {
        measurementId: "m1",
        requestId: "r1",
        seq: 13,
        updatedAt: 5100,
      }),
    ).toBe(true);
  });
});
