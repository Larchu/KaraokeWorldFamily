import { useEffect, useRef, useState } from "react";
import { Award, Heart, Mic, Sparkles, Timer, TrendingUp, Trophy, Volume2 } from "lucide-react";
import { motion } from "motion/react";
import {
  clamp01,
  computeScoreDistribution,
  computeSpectrumColumns,
  remainingApplauseSeconds,
  remainingCountdownSeconds,
  type ApplauseStateSnapshot,
} from "@/lib/applause-meter";
import { useI18n } from "@/lib/i18n";
import { loadAppSettings } from "@/lib/settings";

const METER_SEGMENTS = 48;
const SPECTRUM_BARS = 48;

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

function useAnimatedValue(target: number, active: boolean, instant: boolean, durationMs = 480): number {
  const [value, setValue] = useState(instant ? target : 0);

  useEffect(() => {
    if (!active) return;
    if (instant || typeof requestAnimationFrame !== "function") {
      setValue(target);
      return;
    }

    let rafId = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) {
        rafId = requestAnimationFrame(step);
      }
    };
    setValue(0);
    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [target, active, instant, durationMs]);

  return value;
}

export function StageApplauseOverlay({
  applause,
}: {
  applause: ApplauseStateSnapshot;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const reduced = usePrefersReducedMotion();
  const bandPeaksRef = useRef<number[]>(Array.from({ length: SPECTRUM_BARS }, () => 0));
  const lastSeqPeaksRef = useRef<number>(-1);

  useEffect(() => {
    if (applause.status !== "countdown" && applause.status !== "measuring") {
      bandPeaksRef.current.fill(0);
      lastSeqPeaksRef.current = -1;
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 50);
    return () => clearInterval(timer);
  }, [applause.status, applause.countdownEndsAt, applause.endsAt]);

  const isCompleted = applause.status === "completed" && applause.score !== null;
  const dist = computeScoreDistribution(applause.score, applause.likes);
  const animatedApplause = useAnimatedValue(dist.applausePoints, isCompleted, reduced);
  const animatedLikesPts = useAnimatedValue(dist.likesPoints, isCompleted, reduced);
  const animatedTotal = useAnimatedValue(dist.totalPoints, isCompleted, reduced);

  if (applause.status === "countdown") {
    const countdown = remainingCountdownSeconds(applause.countdownEndsAt, now);
    const totalCountdownMs = 5_000;
    const remainingMs = Math.max(0, (applause.countdownEndsAt ?? now) - now);
    const progress = Math.min(1, Math.max(0, 1 - remainingMs / totalCountdownMs));
    const radius = 64;
    const circumference = 2 * Math.PI * radius;
    const dashOffset = circumference * (1 - progress);

    return (
      <div
        data-testid="stage-applause-countdown-screen"
        className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background/85 px-4 py-6 backdrop-blur-md md:pl-[300px] md:pr-8"
      >
        <div className="w-full max-w-3xl rounded-3xl border-2 border-accent bg-card/95 p-6 text-center shadow-2xl sm:p-8 neon-border">
          <div className="flex flex-wrap items-center justify-center gap-3 text-sm font-bold uppercase tracking-[0.22em] text-accent">
            <Timer className="size-5" />
            <span>{t.applauseStageTitle}</span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1.5 text-primary tabular-nums">
              <Heart className="size-4 fill-current" />
              {t.applauseScanVotes}: {applause.likes}
            </span>
          </div>

          {applause.singerName && (
            <h2
              data-testid="stage-applause-singer"
              className="mt-3 break-words font-display text-4xl text-primary neon-text sm:text-6xl"
            >
              {applause.singerName}
            </h2>
          )}
          {applause.songTitle && (
            <p className="mt-1 truncate text-lg text-muted-foreground sm:text-2xl">
              {applause.songTitle}
            </p>
          )}

          <div className="my-6 flex flex-col items-center justify-center">
            <div className="relative flex size-44 items-center justify-center sm:size-52">
              <svg className="size-full -rotate-90" viewBox="0 0 160 160" aria-hidden="true">
                <circle
                  cx="80"
                  cy="80"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="12"
                  className="text-muted/40"
                />
                <circle
                  cx="80"
                  cy="80"
                  r={radius}
                  fill="none"
                  stroke="var(--color-accent)"
                  strokeWidth="12"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                />
              </svg>
              <span
                key={countdown}
                data-testid="stage-applause-precountdown"
                className="animate-countdown absolute font-display text-8xl text-accent neon-text-cyan tabular-nums sm:text-9xl"
              >
                {countdown}
              </span>
            </div>
            <p className="mt-3 text-xl font-bold text-foreground sm:text-2xl">
              {t.applauseCountdownTitle}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.applauseCountdownSubtitle}{" "}
              <strong className="text-accent tabular-nums">{countdown}s</strong> ·{" "}
              {t.applauseAudioPausedNote}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (applause.status === "measuring") {
    const countdown = remainingApplauseSeconds(applause.endsAt, now);
    const durationTotalMs = Math.max(1000, applause.durationMs || 10_000);
    const remainingMs = Math.max(0, (applause.endsAt ?? now) - now);
    const timeProgress = Math.min(1, Math.max(0, 1 - remainingMs / durationTotalMs));
    const ringRadius = 38;
    const ringCirc = 2 * Math.PI * ringRadius;
    const ringOffset = ringCirc * (1 - timeProgress);

    const levelPct = Math.round(applause.latestLevel * 100);
    const levelExactPct = Math.round(applause.latestLevel * 1000) / 10;
    const peakPct = Math.round(applause.latestPeak * 100);
    const activeSegments = Math.round(applause.latestLevel * METER_SEGMENTS);
    const rawBands =
      applause.latestBands && applause.latestBands.length >= 8
        ? Array.from({ length: SPECTRUM_BARS }, (_, i) => {
            const srcIdx = Math.min(
              applause.latestBands!.length - 1,
              Math.floor((i / SPECTRUM_BARS) * applause.latestBands!.length),
            );
            return clamp01(applause.latestBands![srcIdx] ?? 0);
          })
        : computeSpectrumColumns(
            applause.latestLevel,
            applause.latestPeak,
            applause.lastSeq,
            SPECTRUM_BARS,
          );

    if (applause.lastSeq !== lastSeqPeaksRef.current) {
      lastSeqPeaksRef.current = applause.lastSeq;
      for (let i = 0; i < SPECTRUM_BARS; i++) {
        const val = rawBands[i] ?? 0;
        const prev = bandPeaksRef.current[i] ?? 0;
        bandPeaksRef.current[i] = val >= prev ? val : Math.max(0, prev - 0.035);
      }
    }

    const energyLabel =
      levelPct >= 80
        ? t.applauseEnergyMax
        : levelPct >= 55
          ? t.applauseEnergyHigh
          : levelPct >= 25
            ? t.applauseEnergyMid
            : t.applauseEnergyLow;

    return (
      <div
        data-testid="stage-applause-measuring"
        className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background/85 px-4 py-6 backdrop-blur-md md:pl-[300px] md:pr-8"
      >
        <div className="w-full max-w-4xl rounded-3xl border-2 border-accent bg-card/95 p-6 shadow-2xl sm:p-8 neon-border">
          {/* Top Broadcast Header: Singer Attribution + Countdown Ring */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/70 pb-5">
            <div className="min-w-0 flex-1 text-left">
              <div className="flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-accent sm:text-sm">
                <Mic className="size-4" />
                <span>{t.applauseStageTitle}</span>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1 text-primary tabular-nums">
                  <Heart className="size-4 fill-current" />
                  {t.applauseScanVotes}: {applause.likes}
                </span>
              </div>
              {applause.singerName && (
                <h2
                  data-testid="stage-applause-singer"
                  className="mt-1.5 truncate font-display text-3xl text-primary neon-text sm:text-5xl"
                >
                  {applause.singerName}
                </h2>
              )}
              {applause.songTitle && (
                <p className="mt-0.5 truncate text-base text-muted-foreground sm:text-xl">
                  {applause.songTitle}
                </p>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-3 rounded-2xl border border-accent/40 bg-background/80 px-4 py-2">
              <div className="relative flex size-20 items-center justify-center sm:size-24">
                <svg className="size-full -rotate-90" viewBox="0 0 96 96" aria-hidden="true">
                  <circle
                    cx="48"
                    cy="48"
                    r={ringRadius}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="8"
                    className="text-muted/40"
                  />
                  <circle
                    cx="48"
                    cy="48"
                    r={ringRadius}
                    fill="none"
                    stroke="var(--color-accent)"
                    strokeWidth="8"
                    strokeLinecap="round"
                    strokeDasharray={ringCirc}
                    strokeDashoffset={ringOffset}
                  />
                </svg>
                <span
                  data-testid="stage-applause-countdown"
                  className="absolute font-display text-4xl text-accent neon-text-cyan tabular-nums sm:text-5xl"
                >
                  {countdown}
                </span>
              </div>
              <div className="text-left">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t.applauseTimeRemaining}
                </div>
                <div className="mt-0.5 text-sm font-bold text-foreground">{t.applauseStageCheer}</div>
              </div>
            </div>
          </div>

          {/* Synchronized 48-Band High-Resolution Spectrum Analyzer (Zero-Lag Rise) */}
          <div className="mt-6 space-y-3">
            <div
              data-testid="stage-applause-spectrum"
              data-level={levelPct}
              data-bands={SPECTRUM_BARS}
              className="relative flex h-40 items-end gap-[3px] rounded-2xl border border-border bg-background/95 p-3 sm:h-48 sm:gap-1 sm:p-4"
              aria-hidden="true"
            >
              {/* Subtle reference lines at 25%, 50%, 75% */}
              <div className="pointer-events-none absolute inset-x-3 bottom-1/4 border-t border-border/35" />
              <div className="pointer-events-none absolute inset-x-3 bottom-1/2 border-t border-border/45" />
              <div className="pointer-events-none absolute inset-x-3 bottom-3/4 border-t border-border/35" />

              {rawBands.map((col, idx) => {
                const heightPct = Math.round(col * 1000) / 10;
                const peakBandPct = Math.round((bandPeaksRef.current[idx] ?? col) * 1000) / 10;
                const barTone =
                  col >= 0.78
                    ? "from-success via-primary to-destructive"
                    : col >= 0.42
                      ? "from-success via-accent to-primary"
                      : "from-success to-accent";
                return (
                  <div
                    key={idx}
                    data-testid="stage-spectrum-bar"
                    className="relative flex h-full flex-1 flex-col justify-end overflow-hidden rounded-[2px] bg-muted/25"
                  >
                    <div
                      className={`w-full rounded-t-[2px] bg-gradient-to-t transition-none ${barTone}`}
                      style={{ height: `${heightPct}%` }}
                    />
                    {peakBandPct > 3 && (
                      <div
                        className="absolute inset-x-0 h-[3px] bg-foreground/95 transition-none"
                        style={{ bottom: `min(97%, ${peakBandPct}%)` }}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/* 48-Segment Precision LED Loudness Strip + Continuous Sub-Percent Layer */}
            <div className="space-y-1">
              <div className="relative overflow-hidden rounded-xl border border-border bg-background/95 p-2">
                {/* Continuous background fill for instant sub-segment accuracy */}
                <div
                  className="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-success/20 via-primary/20 to-destructive/25 transition-none"
                  style={{ width: `${levelExactPct}%` }}
                  aria-hidden="true"
                />
                <div
                  data-testid="stage-applause-meter"
                  data-level={levelPct}
                  data-segments={METER_SEGMENTS}
                  className="relative flex gap-[3px]"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={levelPct}
                  aria-label={t.applauseLevelLabel}
                >
                  {Array.from({ length: METER_SEGMENTS }, (_, idx) => {
                    const lit = idx < activeSegments;
                    const hueClass =
                      idx < 20
                        ? "bg-success shadow-[0_0_8px_var(--color-success)]"
                        : idx < 36
                          ? "bg-primary shadow-[0_0_10px_var(--color-primary)]"
                          : "bg-destructive shadow-[0_0_12px_var(--color-destructive)]";
                    return (
                      <div
                        key={idx}
                        data-testid="stage-meter-segment"
                        className={`h-7 flex-1 rounded-[2px] transition-none sm:h-9 ${lit ? hueClass : "bg-muted/45"}`}
                      />
                    );
                  })}
                </div>
                {peakPct > 2 && (
                  <div
                    className="absolute bottom-1 top-1 w-1 rounded-full bg-foreground shadow-[0_0_8px_#fff] transition-none"
                    style={{ left: `calc(${Math.min(98.5, peakPct)}% - 2px)` }}
                    aria-hidden="true"
                  />
                )}
              </div>

              <div className="flex justify-between px-1 text-[10px] font-semibold text-muted-foreground tabular-nums">
                <span>0%</span>
                <span>25%</span>
                <span>50%</span>
                <span>75%</span>
                <span>100%</span>
              </div>
            </div>

            {/* Live Digital Level Telemetry */}
            <div className="flex flex-wrap items-baseline justify-between gap-3 pt-0.5">
              <div className="flex items-baseline gap-3">
                <span
                  data-testid="stage-applause-live-pct"
                  className="font-display text-4xl text-primary neon-text tabular-nums sm:text-5xl"
                >
                  {levelExactPct.toFixed(1)}%
                </span>
                <span className="text-base font-bold uppercase tracking-wider text-accent sm:text-lg">
                  {energyLabel}
                </span>
              </div>
              <div className="flex items-center gap-4 text-sm font-semibold text-muted-foreground tabular-nums sm:text-base">
                <span>
                  <Volume2 className="mr-1 inline size-4 text-accent" />
                  {t.applausePeakShort}: <strong className="text-foreground">{peakPct}%</strong>
                </span>
                <span className="hidden sm:inline">· {t.applauseAudioPausedNote}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (isCompleted) {
    const chartRadius = 72;
    const chartCirc = 2 * Math.PI * chartRadius;
    const applauseArcLen =
      dist.totalPoints > 0 ? (dist.applausePoints / dist.totalPoints) * chartCirc : chartCirc * 0.5;
    const likesArcLen =
      dist.totalPoints > 0 ? (dist.likesPoints / dist.totalPoints) * chartCirc : chartCirc * 0.5;

    const topList = (applause.topRankings ?? []).slice(0, 5);

    return (
      <div
        data-testid="stage-applause-celebration"
        className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background/88 px-4 py-4 backdrop-blur-md md:pl-[300px] md:pr-8"
      >
        <div className="animate-applause-celebrate max-h-[calc(100dvh-2rem)] w-full max-w-4xl overflow-hidden rounded-3xl border-2 border-primary bg-card/95 p-5 shadow-2xl sm:p-6 neon-border">
          {/* Header: Singer Assignment & Live Rank */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-3.5">
            <div className="min-w-0 text-left">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.22em] text-primary sm:text-sm">
                <Trophy className="size-4" />
                <span>{t.applauseResultTitle}</span>
              </div>
              {applause.singerName && (
                <h2
                  data-testid="stage-applause-singer"
                  className="mt-1 truncate font-display text-3xl text-foreground sm:text-4xl"
                >
                  {applause.singerName}
                </h2>
              )}
              {applause.songTitle && (
                <p className="mt-0.5 truncate text-sm text-muted-foreground sm:text-base">
                  {applause.songTitle}
                </p>
              )}
            </div>
            <div className="flex flex-col items-end gap-1 text-right">
              {applause.rank ? (
                <div
                  data-testid="stage-applause-rank"
                  className="flex items-center gap-2 font-display text-2xl text-accent tabular-nums sm:text-3xl"
                >
                  <span>
                    {t.rankPosition} #{applause.rank}
                  </span>
                  {(applause.rankDelta ?? 0) > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-base font-bold text-success">
                      <TrendingUp className="size-4" />+{applause.rankDelta}
                    </span>
                  )}
                  {applause.previousRank === null && (
                    <span className="text-sm font-bold uppercase tracking-wider text-primary">
                      {t.rankNewBadge}
                    </span>
                  )}
                </div>
              ) : null}
              <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground sm:text-sm">
                <Sparkles className="size-4 text-primary" />
                <span>{t.applauseFormulaLabel}</span>
              </div>
            </div>
          </div>

          {/* Graphical Total Score Presentation: Donut Chart + Breakdown Bars */}
          <div className="mt-4 grid items-center gap-5 md:grid-cols-[210px_1fr]">
            {/* Left: Dual-Segment Radial Donut Chart */}
            <div className="mx-auto flex flex-col items-center">
              <div
                data-testid="stage-score-donut"
                className="relative flex size-44 items-center justify-center sm:size-48"
              >
                <svg className="size-full -rotate-90" viewBox="0 0 180 180" aria-hidden="true">
                  <circle
                    cx="90"
                    cy="90"
                    r={chartRadius}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="16"
                    className="text-muted/35"
                  />
                  {/* Segment 1: Applause Score (Cyan) */}
                  <circle
                    cx="90"
                    cy="90"
                    r={chartRadius}
                    fill="none"
                    stroke="var(--color-accent)"
                    strokeWidth="16"
                    strokeDasharray={`${applauseArcLen} ${chartCirc}`}
                    strokeDashoffset={0}
                  />
                  {/* Segment 2: Scan-Vote Likes Bonus (Primary Gold / Rose) */}
                  <circle
                    cx="90"
                    cy="90"
                    r={chartRadius}
                    fill="none"
                    stroke="var(--color-primary)"
                    strokeWidth="16"
                    strokeDasharray={`${likesArcLen} ${chartCirc}`}
                    strokeDashoffset={-applauseArcLen}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
                  <span className="max-w-[96px] text-[10px] font-bold uppercase leading-tight tracking-wider text-muted-foreground">
                    {t.applauseTotalPoints}
                  </span>
                  <span
                    data-testid="stage-applause-total-points"
                    className="font-display text-5xl leading-none text-primary neon-text tabular-nums"
                  >
                    {animatedTotal}
                  </span>
                  <span className="mt-1 text-[11px] font-bold tracking-widest text-accent">
                    {t.applausePointsUnit}
                  </span>
                </div>
              </div>
            </div>

            {/* Right: Detailed Formula & Graphical Comparison */}
            <div className="space-y-3 text-left">
              {/* Row 1: Applause Score */}
              <div className="rounded-2xl border border-accent/40 bg-background/80 p-3.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-bold text-accent">
                    <Award className="size-4" />
                    {t.applauseScoreLabel}
                  </span>
                  <span
                    data-testid="stage-applause-score"
                    className="font-display text-2xl text-accent tabular-nums sm:text-3xl"
                  >
                    {animatedApplause}
                    <span className="text-sm text-muted-foreground"> / 100</span>
                  </span>
                </div>
                <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-muted/60">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${dist.applausePoints}%` }}
                  />
                </div>
              </div>

              {/* Row 2: Scan-Vote Likes Bonus */}
              <div className="rounded-2xl border border-primary/40 bg-background/80 p-3.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-bold text-primary">
                    <Heart className="size-4 fill-current" />
                    {t.applauseScanVotes} ({applause.likes} × 10)
                  </span>
                  <span className="font-display text-2xl text-primary tabular-nums sm:text-3xl">
                    +{animatedLikesPts}
                  </span>
                </div>
                <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-muted/60">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${dist.totalPoints > 0 ? dist.likesSharePct : 0}%` }}
                  />
                </div>
              </div>

              {/* Stacked Proportional Comparison Bar */}
              <div className="space-y-1 rounded-2xl border border-border bg-background/70 px-4 py-2.5">
                <div className="flex justify-between text-xs font-semibold text-muted-foreground tabular-nums">
                  <span>
                    {t.applausePointsShort}: {dist.applauseSharePct}%
                  </span>
                  <span>
                    {t.applauseScanVotes}: {dist.likesSharePct}%
                  </span>
                </div>
                <div className="flex h-3.5 w-full overflow-hidden rounded-full bg-muted/50">
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${dist.applauseSharePct}%` }}
                  />
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${dist.likesSharePct}%` }}
                  />
                </div>
                <div className="pt-0.5 text-right text-xs font-bold text-foreground tabular-nums sm:text-sm">
                  {dist.applausePoints} + ({dist.likesCount} × 10) ={" "}
                  <span className="text-primary">{dist.totalPoints}</span>
                  {typeof applause.totalSingerPoints === "number" &&
                    applause.totalSingerPoints > dist.totalPoints && (
                      <span className="ml-2 text-accent">
                        · {t.singerTotalTonight}: {applause.totalSingerPoints}
                      </span>
                    )}
                </div>
              </div>
            </div>
          </div>

          {/* Animated Live Top-5 Ranking Strip */}
          {topList.length > 0 && (
            <div
              data-testid="stage-applause-top-ranking"
              className="mt-4 rounded-2xl border border-border bg-background/80 px-4 py-3 text-left"
            >
              <div className="mb-2 flex items-center justify-between text-xs font-bold uppercase tracking-wider text-accent">
                <span className="flex items-center gap-1.5">
                  <Trophy className="size-3.5 text-primary" />
                  {t.liveRankingTop}
                </span>
                <span className="text-muted-foreground">{t.liveSyncActive}</span>
              </div>
              <motion.ol layout={!reduced} className="grid gap-1.5 sm:grid-cols-5">
                {topList.map((entry, idx) => {
                  const isCurrent =
                    applause.rank === idx + 1 &&
                    entry.display_name.toLowerCase() === (applause.singerName ?? "").toLowerCase();
                  return (
                    <motion.li
                      layout={!reduced}
                      key={entry.singer_id}
                      transition={
                        reduced
                          ? { duration: 0 }
                          : { layout: { type: "spring", stiffness: 320, damping: 28 } }
                      }
                      className={`flex items-center justify-between gap-2 rounded-xl border px-2.5 py-1.5 text-xs ${
                        isCurrent
                          ? "border-accent bg-accent/15 text-foreground"
                          : "border-border/70 bg-card/80 text-muted-foreground"
                      }`}
                    >
                      <span className="min-w-0 truncate">
                        <strong className="mr-1 font-display text-sm text-primary tabular-nums">
                          #{idx + 1}
                        </strong>
                        <span className="font-semibold text-foreground">{entry.display_name}</span>
                      </span>
                      <span className="shrink-0 font-bold text-primary tabular-nums">
                        {entry.total_points}
                      </span>
                    </motion.li>
                  );
                })}
              </motion.ol>
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
