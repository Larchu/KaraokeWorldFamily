import { describe, expect, it } from "vitest";
import {
  STAGE_HEARTS_PER_LIKE,
  STAGE_IDLE_QR_SIZE,
  STAGE_LIKE_QR_SIZE,
  STAGE_PARTICLES_PER_LIKE,
  STAGE_STARS_PER_LIKE,
  addedHearts,
  consumeLikeTotal,
  countdownRemaining,
  createLikeTracker,
} from "./stage";

describe("stage constants and lossless like processing", () => {
  it("enforces large low-res-beamer QR sizes (>=220px) and 40+40=80 swarm particle constants", () => {
    expect(STAGE_LIKE_QR_SIZE).toBe(220);
    expect(STAGE_IDLE_QR_SIZE).toBe(250);
    expect(STAGE_HEARTS_PER_LIKE).toBe(40);
    expect(STAGE_STARS_PER_LIKE).toBe(40);
    expect(STAGE_PARTICLES_PER_LIKE).toBe(80);
  });

  it("computes remaining countdown seconds", () => {
    expect(countdownRemaining(1000, 1000)).toBe(5);
    expect(countdownRemaining(1000, 3500)).toBe(3);
    expect(countdownRemaining(1000, 7000)).toBe(0);
  });

  it("does not explode historical likes on first snapshot and never drops rapid likes", () => {
    const tracker = createLikeTracker();
    // Initial load has 14 historical likes -> delta must be 0
    expect(consumeLikeTotal(tracker, 14, { isInitialSnapshot: true })).toEqual({
      delta: 0,
      total: 14,
    });

    // Duplicate poll / SSE delivery with same count -> delta 0
    expect(consumeLikeTotal(tracker, 14, { isInitialSnapshot: false })).toEqual({
      delta: 0,
      total: 14,
    });

    // Rapid burst: 6 likes arrive between updates -> all 6 processed
    expect(consumeLikeTotal(tracker, 20, { isInitialSnapshot: false })).toEqual({
      delta: 6,
      total: 20,
    });

    // Stale lower count resets baseline without false positive burst, subsequent like counts
    expect(consumeLikeTotal(tracker, 19, { isInitialSnapshot: false })).toEqual({
      delta: 0,
      total: 19,
    });
    expect(consumeLikeTotal(tracker, 20, { isInitialSnapshot: false })).toEqual({
      delta: 1,
      total: 20,
    });
  });

  it("addedHearts never drops above an artificial cap", () => {
    expect(addedHearts(null, 10)).toBe(0);
    expect(addedHearts(5, 25)).toBe(20);
  });
});
