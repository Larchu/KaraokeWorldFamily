export const LIKE_POINTS_MULTIPLIER = 10;

/**
 * Binding formula per performance:
 * Total Points = Applause Score (0..100, missing counts as 0) + (Likes * 10)
 */
export function performancePoints(
  applauseScore: number | null | undefined,
  receivedLikes: number,
): number {
  const applause =
    typeof applauseScore === "number" && Number.isFinite(applauseScore)
      ? Math.min(100, Math.max(0, Math.round(applauseScore)))
      : 0;
  const likes = Math.max(0, Math.floor(Number.isFinite(receivedLikes) ? receivedLikes : 0));
  return applause + likes * LIKE_POINTS_MULTIPLIER;
}

export function singerPoints(receivedLikes: number, applauseScore: number | null = 0): number {
  return performancePoints(applauseScore, receivedLikes);
}

export function canLikePerformance(
  userId: string | undefined,
  singerId: string | null,
  status: string,
  updatedAt: string,
  now: number,
): boolean {
  return (
    !!userId &&
    singerId !== userId &&
    (status === "playing" || status === "done") &&
    new Date(updatedAt).getTime() > now - 12 * 3600 * 1000
  );
}

export interface LeaderboardEntry {
  singer_id: string;
  display_name: string;
  card_code: string;
  likes: number;
  applause_points: number;
  total_points: number;
  performances: number;
}

/**
 * Deterministic leaderboard tie-breaker ordering:
 * 1. total_points DESC
 * 2. applause_points DESC
 * 3. likes DESC
 * 4. performances DESC
 * 5. display_name ASC, singer_id ASC
 */
export function sortLeaderboard(rows: LeaderboardEntry[]): LeaderboardEntry[] {
  return [...rows].sort(
    (a, b) =>
      b.total_points - a.total_points ||
      b.applause_points - a.applause_points ||
      b.likes - a.likes ||
      b.performances - a.performances ||
      a.display_name.localeCompare(b.display_name) ||
      a.singer_id.localeCompare(b.singer_id),
  );
}
