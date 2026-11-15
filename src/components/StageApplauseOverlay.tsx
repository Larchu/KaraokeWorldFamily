import { useEffect, useState } from "react";
import { Award, Heart, Sparkles, Volume2 } from "lucide-react";
import {
  remainingApplauseSeconds,
  type ApplauseStateSnapshot,
} from "@/lib/applause-meter";
import { useI18n } from "@/lib/i18n";

const BAR_SEGMENTS = 24;

export function StageApplauseOverlay({
  applause,
}: {
  applause: ApplauseStateSnapshot;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (applause.status !== "measuring") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 120);
    return () => clearInterval(timer);
  }, [applause.status, applause.endsAt]);

  if (applause.status === "measuring") {
    const countdown = remainingApplauseSeconds(applause.endsAt, now);
    const levelPct = Math.round(applause.latestLevel * 100);
    const peakPct = Math.round(applause.latestPeak * 100);
    const activeSegments = Math.round(applause.latestLevel * BAR_SEGMENTS);

    return (
      <div
        data-testid="stage-applause-measuring"
        className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background/80 px-6 backdrop-blur-md"
      >
        <div className="w-full max-w-3xl rounded-3xl border border-accent bg-card/95 p-8 text-center neon-border">
          <div className="flex items-center justify-center gap-2 text-sm font-bold uppercase tracking-[0.25em] text-accent">
            <Volume2 className="size-5" />
            {t.applauseStageTitle}
          </div>
          {applause.singerName && (
            <div className="mt-3 font-display text-3xl text-primary neon-text sm:text-5xl">
              {applause.singerName}
            </div>
          )}
          {applause.songTitle && (
            <div className="mt-1 truncate text-lg text-muted-foreground sm:text-xl">
              {applause.songTitle}
            </div>
          )}

          <div
            data-testid="stage-applause-countdown"
            className="mt-6 font-display text-8xl text-accent neon-text-cyan tabular-nums sm:text-9xl"
          >
            {countdown}
          </div>
          <p className="mt-1 text-base font-semibold text-foreground">{t.applauseStageCheer}</p>

          {/* Animated Neon Volume Meter driven by live measured levels */}
          <div className="mt-8 space-y-3">
            <div
              data-testid="stage-applause-meter"
              data-level={levelPct}
              className="grid grid-cols-24 gap-1.5 rounded-2xl border border-border bg-background/90 p-3"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={levelPct}
              aria-label={t.applauseLevelLabel}
            >
              {Array.from({ length: BAR_SEGMENTS }, (_, idx) => {
                const lit = idx < activeSegments;
                const hueClass =
                  idx < 10
                    ? "bg-success shadow-[0_0_12px_var(--color-success)]"
                    : idx < 18
                      ? "bg-primary shadow-[0_0_14px_var(--color-primary)]"
                      : "bg-destructive shadow-[0_0_16px_var(--color-destructive)]";
                return (
                  <div
                    key={idx}
                    className={`h-12 rounded-sm transition-all duration-100 sm:h-16 ${
                      lit ? hueClass : "bg-muted/50"
                    }`}
                  />
                );
              })}
            </div>
            <div className="flex justify-between text-xs font-semibold text-muted-foreground tabular-nums">
              <span>
                {t.applauseLevelLabel}: {levelPct}%
              </span>
              <span>Peak: {peakPct}%</span>
            </div>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">{t.applauseAudioPausedNote}</p>
        </div>
      </div>
    );
  }

  if (applause.status === "completed" && applause.score !== null) {
    const likesPoints = applause.likes * 10;
    const totalPoints = applause.totalPoints ?? applause.score + likesPoints;
    return (
      <div
        data-testid="stage-applause-celebration"
        className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background/85 px-6 backdrop-blur-md"
      >
        <div className="animate-applause-celebrate w-full max-w-2xl rounded-3xl border border-primary bg-card/95 p-8 text-center neon-border">
          <div className="flex items-center justify-center gap-2 text-sm font-bold uppercase tracking-[0.25em] text-primary">
            <Sparkles className="size-5" />
            {t.applauseResultTitle}
            <Sparkles className="size-5" />
          </div>
          {applause.singerName && (
            <div className="mt-3 font-display text-3xl text-foreground sm:text-5xl">
              {applause.singerName}
            </div>
          )}
          {applause.songTitle && (
            <div className="mt-1 truncate text-base text-muted-foreground sm:text-lg">
              {applause.songTitle}
            </div>
          )}

          <div className="mt-6 flex flex-col items-center">
            <div className="text-xs uppercase tracking-widest text-accent">
              {t.applauseRelativeScore}
            </div>
            <div
              data-testid="stage-applause-score"
              className="mt-1 font-display text-7xl text-primary neon-text tabular-nums sm:text-8xl"
            >
              {applause.score}
              <span className="text-3xl text-muted-foreground"> / 100</span>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-2xl border border-border bg-background/70 p-3">
              <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
                <Award className="size-4 text-accent" />
                {t.applausePointsShort}
              </div>
              <div className="mt-1 font-display text-2xl text-accent tabular-nums">
                {applause.score}
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-background/70 p-3">
              <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
                <Heart className="size-4 text-primary" />
                {t.applauseLikesBonus}
              </div>
              <div className="mt-1 font-display text-2xl text-primary tabular-nums">
                {applause.likes} × 10 = {likesPoints}
              </div>
            </div>
            <div className="rounded-2xl border border-primary/70 bg-primary/15 p-3">
              <div className="text-xs font-bold text-primary">{t.applauseTotalPoints}</div>
              <div
                data-testid="stage-applause-total-points"
                className="mt-1 font-display text-2xl text-primary neon-text tabular-nums"
              >
                {totalPoints}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
