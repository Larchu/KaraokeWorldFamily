import { describe, expect, it } from "vitest";
import {
  canLikePerformance,
  performancePoints,
  sortLeaderboard,
  type LeaderboardEntry,
} from "./singer";

describe("scoring and leaderboard helpers", () => {
  it("computes binding formula examples: Gesamtpunkte = Applaus-Score + (Likes * 10)", () => {
    expect(performancePoints(0, 0)).toBe(0);
    expect(performancePoints(70, 3)).toBe(100);
    expect(performancePoints(100, 20)).toBe(300);
    // Missing applause score counts mathematically as 0
    expect(performancePoints(null, 3)).toBe(30);
    expect(performancePoints(undefined, 0)).toBe(0);
  });

  it("clamps applause score cleanly to 0..100", () => {
    expect(performancePoints(-15, 2)).toBe(20);
    expect(performancePoints(150, 2)).toBe(120);
  });

  it("applies deterministic tie-breakers cleanly", () => {
    const a: LeaderboardEntry = {
      singer_id: "2",
      display_name: "Bea",
      card_code: "WF-002",
      likes: 5,
      applause_points: 50,
      total_points: 100,
      performances: 1,
    };
    const b: LeaderboardEntry = {
      singer_id: "1",
      display_name: "Alex",
      card_code: "WF-001",
      likes: 3,
      applause_points: 70,
      total_points: 100,
      performances: 1,
    };
    // Both have 100 total_points; higher applause_points wins tie
    expect(sortLeaderboard([a, b]).map((r) => r.singer_id)).toEqual(["1", "2"]);
  });

  it("checks like eligibility", () => {
    const now = Date.now();
    const recent = new Date(now - 60_000).toISOString();
    const old = new Date(now - 13 * 3600 * 1000).toISOString();
    expect(canLikePerformance("u1", "u2", "playing", recent, now)).toBe(true);
    expect(canLikePerformance("u1", "u1", "playing", recent, now)).toBe(false);
    expect(canLikePerformance("u1", "u2", "waiting", recent, now)).toBe(false);
    expect(canLikePerformance("u1", "u2", "done", old, now)).toBe(false);
  });
});
