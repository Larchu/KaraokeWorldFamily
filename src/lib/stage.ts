/** Countdown and announcement both finish before the karaoke audio starts. */
export const STAGE_COUNTDOWN_SECONDS = 5;

/** Current performance Like-QR dimension in CSS pixels (must be 116x116). */
export const STAGE_LIKE_QR_SIZE = 116;

/** Exact swarm particles spawned per valid new like in normal motion mode. */
export const STAGE_HEARTS_PER_LIKE = 40;
export const STAGE_STARS_PER_LIKE = 40;
export const STAGE_PARTICLES_PER_LIKE = STAGE_HEARTS_PER_LIKE + STAGE_STARS_PER_LIKE;

export function countdownRemaining(startedAt: number, now: number): number {
  return Math.max(0, STAGE_COUNTDOWN_SECONDS - Math.floor(Math.max(0, now - startedAt) / 1000));
}

/**
 * Computes newly arrived likes without inflating initial historical totals
 * and without dropping rapid consecutive likes.
 */
export function addedHearts(previous: number | null, current: number): number {
  if (previous === null) return 0;
  return Math.max(0, Math.floor(current) - Math.floor(previous));
}

export interface LikeDeltaTracker {
  baselineSet: boolean;
  lastProcessedTotal: number;
}

export function createLikeTracker(): LikeDeltaTracker {
  return { baselineSet: false, lastProcessedTotal: 0 };
}

/**
 * Deduplicates duplicate or out-of-order total notifications while ensuring
 * no valid new like is silently dropped during rapid bursts or reconnects.
 */
export function consumeLikeTotal(
  tracker: LikeDeltaTracker,
  incomingTotal: number,
  options?: { isInitialSnapshot?: boolean },
): { delta: number; total: number } {
  const safeTotal = Math.max(0, Math.floor(incomingTotal));

  if (!tracker.baselineSet) {
    tracker.baselineSet = true;
    tracker.lastProcessedTotal = safeTotal;
    // Initial load never explodes historical likes.
    if (options?.isInitialSnapshot !== false) {
      return { delta: 0, total: safeTotal };
    }
    return { delta: safeTotal, total: safeTotal };
  }

  if (safeTotal <= tracker.lastProcessedTotal) {
    // Handles duplicate SSE/poll delivery or out-of-order stale counts;
    // if likes were actually removed, keep lastProcessedTotal clamped to safeTotal
    // so subsequent new likes still trigger.
    if (safeTotal < tracker.lastProcessedTotal) {
      tracker.lastProcessedTotal = safeTotal;
    }
    return { delta: 0, total: safeTotal };
  }

  const delta = safeTotal - tracker.lastProcessedTotal;
  tracker.lastProcessedTotal = safeTotal;
  return { delta, total: safeTotal };
}
