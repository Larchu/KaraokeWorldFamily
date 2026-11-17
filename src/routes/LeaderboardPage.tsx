import { useCallback, useEffect, useRef, useState } from "react";
import { Award, Heart, Mic, Sparkles, TrendingDown, TrendingUp, Trophy } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { SiteHeader } from "@/components/SiteHeader";
import { apiJson } from "@/lib/api";
import type { RoundEvaluationSummary } from "@/lib/applause-meter";
import { useI18n } from "@/lib/i18n";
import { loadAppSettings } from "@/lib/settings";
import {
  computeRankDeltas,
  sortLeaderboard,
  type LeaderboardEntry,
  type RankDeltaInfo,
} from "@/lib/singer";

type Period = "night" | "month" | "all";

interface LeaderboardStreamPayload {
  period?: string;
  evaluation?: RoundEvaluationSummary | null;
  rows?: LeaderboardEntry[];
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const sync = () => {
      const appReduced = loadAppSettings().reducedEffects;
      const mq =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      setReduced(Boolean(appReduced || mq));
    };
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);

  return reduced;
}

function AnimatedScore({ value, instant }: { value: number; instant: boolean }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);

  useEffect(() => {
    if (instant || typeof requestAnimationFrame !== "function") {
      fromRef.current = value;
      setDisplay(value);
      return;
    }
    const startVal = fromRef.current;
    if (startVal === value) return;

    let rafId = 0;
    const duration = 520;
    const startTime = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = Math.round(startVal + (value - startVal) * eased);
      setDisplay(current);
      if (t < 1) {
        rafId = requestAnimationFrame(tick);
      } else {
        fromRef.current = value;
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      fromRef.current = value;
    };
  }, [value, instant]);

  return <>{display}</>;
}

export function LeaderboardPage() {
  const { t } = useI18n();
  const [period, setPeriod] = useState<Period>("night");
  const [rows, setRows] = useState<LeaderboardEntry[] | null>(null);
  const [deltas, setDeltas] = useState<Record<string, RankDeltaInfo>>({});
  const [latestEval, setLatestEval] = useState<RoundEvaluationSummary | null>(null);
  const reduced = usePrefersReducedMotion();

  const prevRowsRef = useRef<LeaderboardEntry[] | null>(null);
  const loadedPeriodRef = useRef<Period | null>(null);

  const applyRows = useCallback((incoming: LeaderboardEntry[], targetPeriod: Period) => {
    const sorted = sortLeaderboard(incoming);
    if (loadedPeriodRef.current === targetPeriod && prevRowsRef.current) {
      const nextDeltas = computeRankDeltas(prevRowsRef.current, sorted);
      const hasAnyChange = Object.values(nextDeltas).some(
        (d) => d.rankDelta !== 0 || d.pointsDelta !== 0 || d.isNew,
      );
      if (hasAnyChange) {
        setDeltas(nextDeltas);
      }
    } else {
      setDeltas({});
    }
    prevRowsRef.current = sorted;
    loadedPeriodRef.current = targetPeriod;
    setRows(sorted);
  }, []);

  const load = useCallback(
    async (targetPeriod: Period, resetFirst = false) => {
      if (resetFirst) {
        setRows(null);
        setDeltas({});
        prevRowsRef.current = null;
        loadedPeriodRef.current = null;
      }
      try {
        const res = await apiJson<{ rows: LeaderboardEntry[] }>(
          `/api/leaderboard?period=${targetPeriod}`,
        );
        applyRows(res.rows ?? [], targetPeriod);
      } catch {
        if (resetFirst) setRows([]);
      }
    },
    [applyRows],
  );

  // Auto-clear rank delta highlights and round evaluation banner after 10s
  useEffect(() => {
    if (Object.keys(deltas).length === 0) return;
    const timer = setTimeout(() => setDeltas({}), 10_000);
    return () => clearTimeout(timer);
  }, [deltas]);

  useEffect(() => {
    if (!latestEval) return;
    const timer = setTimeout(() => {
      setLatestEval((curr) => (curr?.evaluatedAt === latestEval.evaluatedAt ? null : curr));
    }, 10_000);
    return () => clearTimeout(timer);
  }, [latestEval]);

  useEffect(() => {
    let alive = true;
    void load(period, true);

    let source: EventSource | null = null;
    if (typeof EventSource !== "undefined") {
      source = new EventSource("/api/stream/queue", { withCredentials: true });
      source.addEventListener("leaderboard_updated", (e: MessageEvent) => {
        if (!alive) return;
        try {
          const payload = JSON.parse(e.data) as LeaderboardStreamPayload;
          if (payload.evaluation && period === "night") {
            setLatestEval(payload.evaluation);
          }
          if (period === "night" && Array.isArray(payload.rows)) {
            applyRows(payload.rows, "night");
            return;
          }
        } catch {
          /* fallback to fetch */
        }
        void load(period, false);
      });
      source.addEventListener("queue_changed", () => {
        if (alive) void load(period, false);
      });
      source.addEventListener("like_changed", () => {
        if (alive) void load(period, false);
      });
    }

    const poll = setInterval(() => {
      if (alive) void load(period, false);
    }, 8000);

    return () => {
      alive = false;
      source?.close();
      clearInterval(poll);
    };
  }, [period, load, applyRows]);

  const medal = ["text-gold", "text-silver", "text-bronze"];
  const tabs: [Period, string][] = [
    ["night", t.tonight],
    ["month", t.month],
    ["all", t.allTime],
  ];

  return (
    <div className="pb-20">
      <SiteHeader />
      <main className="mx-auto max-w-3xl space-y-6 px-4">
        <h1 className="text-center font-display text-4xl text-primary neon-text">
          <Trophy className="mr-2 inline size-8" />
          {t.leaderboard}
        </h1>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <div className="flex w-fit rounded-full border border-border p-1">
            {tabs.map(([p, label]) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={`rounded-full px-4 py-2 text-sm font-bold whitespace-nowrap ${
                  period === p ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-success">
            <span className="size-2 rounded-full bg-success" aria-hidden="true" />
            {t.liveSyncActive}
          </span>
        </div>

        <p className="text-center text-xs text-muted-foreground">{t.leaderboardFormulaNote}</p>

        <AnimatePresence>
          {period === "night" && latestEval && (
            <motion.div
              key={latestEval.evaluatedAt}
              data-testid="leaderboard-round-eval"
              initial={reduced ? false : { opacity: 0, y: -10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduced ? undefined : { opacity: 0, y: -8 }}
              transition={{ duration: 0.28 }}
              className="rounded-2xl border-2 border-accent bg-card/95 p-4 shadow-lg"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold uppercase tracking-wider text-accent">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="size-4 text-primary" />
                  {t.roundEvaluatedTitle}
                </span>
                {latestEval.rank && (
                  <span className="text-primary tabular-nums">
                    {t.rankPosition} #{latestEval.rank}
                    {latestEval.rankDelta > 0
                      ? ` · ▲ +${latestEval.rankDelta}`
                      : latestEval.previousRank === null
                        ? ` · ${t.rankNewBadge}`
                        : ""}
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-display text-xl text-foreground">
                    {latestEval.singerName}
                  </span>
                  <span className="ml-2 text-sm text-muted-foreground">
                    {latestEval.songTitle}
                  </span>
                </div>
                <div className="text-sm font-bold text-foreground tabular-nums">
                  {latestEval.applauseScore} + ({latestEval.likes} × 10) ={" "}
                  <span className="text-primary">+{latestEval.roundPoints} {t.points}</span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {rows === null ? (
          <p className="text-center text-muted-foreground">…</p>
        ) : rows.length === 0 ? (
          <p className="text-center text-muted-foreground">{t.noRanking}</p>
        ) : (
          <motion.ol layout={!reduced} className="space-y-2">
            {rows.map((r, i) => {
              const d = deltas[r.singer_id];
              const movedUp = (d?.rankDelta ?? 0) > 0;
              const movedDown = (d?.rankDelta ?? 0) < 0;
              const isNew = Boolean(d?.isNew);
              const gainedPoints = (d?.pointsDelta ?? 0) > 0;
              const isHighlighted = movedUp || isNew || gainedPoints;

              return (
                <motion.li
                  layout={!reduced}
                  key={r.singer_id}
                  initial={reduced ? false : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={
                    reduced
                      ? { duration: 0 }
                      : {
                          layout: { type: "spring", stiffness: 320, damping: 28 },
                          duration: 0.24,
                        }
                  }
                  data-testid={`leaderboard-row-${i}`}
                  data-singer-id={r.singer_id}
                  className={`flex flex-wrap items-center gap-4 rounded-2xl border bg-card p-4 transition-colors duration-300 ${
                    isHighlighted
                      ? "border-accent ring-1 ring-accent/50"
                      : i < 3
                        ? "border-primary neon-border"
                        : "border-border"
                  }`}
                >
                  <div className="flex w-12 flex-col items-center">
                    <span
                      className={`text-center font-display text-3xl leading-none tabular-nums ${
                        medal[i] ?? "text-muted-foreground"
                      }`}
                    >
                      {i + 1}
                    </span>
                    {d && (movedUp || movedDown || isNew) && (
                      <span
                        data-testid={`leaderboard-delta-${r.singer_id}`}
                        className={`mt-1 inline-flex items-center gap-0.5 text-[11px] font-bold tabular-nums ${
                          movedUp
                            ? "text-success"
                            : movedDown
                              ? "text-destructive"
                              : "text-accent"
                        }`}
                      >
                        {movedUp && (
                          <>
                            <TrendingUp className="size-3" />+{d.rankDelta}
                          </>
                        )}
                        {movedDown && (
                          <>
                            <TrendingDown className="size-3" />
                            {d.rankDelta}
                          </>
                        )}
                        {isNew && t.rankNewBadge}
                      </span>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="truncate font-display text-lg">{r.display_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.is_guest ? t.guestSingerBadge : r.card_code}
                    </div>
                  </div>

                  <div className="flex w-full flex-wrap items-center justify-between gap-3 text-sm sm:w-auto sm:justify-end">
                    <span className="flex items-center gap-1 text-accent tabular-nums">
                      <Award className="size-4" />
                      {r.applause_points}
                    </span>
                    <span className="flex items-center gap-1 text-primary/90 tabular-nums">
                      <Heart className="size-4 fill-current" />
                      {r.likes}×10
                    </span>
                    <span className="flex items-center gap-1 text-muted-foreground tabular-nums">
                      <Mic className="size-4" />
                      {r.performances}
                    </span>
                    <span className="rounded-lg bg-primary/15 px-2.5 py-1 font-bold text-primary tabular-nums">
                      <AnimatedScore value={r.total_points} instant={reduced} />{" "}
                      <span className="text-xs font-normal">{t.points}</span>
                    </span>
                  </div>
                </motion.li>
              );
            })}
          </motion.ol>
        )}
      </main>
    </div>
  );
}
