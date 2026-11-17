import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Heart, Loader2, Maximize, Minimize, Monitor, Sparkles, Trophy, Volume2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StageHearts } from "@/components/StageHearts";
import { StageVideo } from "@/components/StageVideo";
import { StageApplauseOverlay } from "@/components/StageApplauseOverlay";
import { useQueue } from "@/hooks/use-queue";
import { useStageControl } from "@/hooks/use-stage-control";
import { ApiError, apiJson } from "@/lib/api";
import { setApplauseAudioSuppressed } from "@/lib/applause";
import { LOGO_URL, SCANSING_VIDEO_URL } from "@/lib/assets";
import { DJ_ACTIVE_STORAGE_KEY, useI18n, type Lang } from "@/lib/i18n";
import { playOrder, type SongRequest } from "@/lib/queue";
import { countdownRemaining, STAGE_IDLE_QR_SIZE, STAGE_LIKE_QR_SIZE } from "@/lib/stage";
import { playShowOpener } from "@/lib/stage-audio";
import type { StageControl } from "@/lib/stage-control";

export function StagePage() {
  const { t } = useI18n();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const screen = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const refresh = () =>
      apiJson<{ ok: boolean }>("/api/dj/status")
        .then((r) => {
          setAuthed(r.ok);
          try {
            if (r.ok) localStorage.setItem(DJ_ACTIVE_STORAGE_KEY, "1");
            else localStorage.removeItem(DJ_ACTIVE_STORAGE_KEY);
          } catch {
            /* ignore */
          }
        })
        .catch(() => setAuthed(false));
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => {
    const changed = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  const toggleFullscreen = () => {
    const result = document.fullscreenElement
      ? document.exitFullscreen()
      : screen.current?.requestFullscreen?.();
    result?.catch?.(() => {
      /* fullscreen optional in embedded/headless contexts */
    });
  };

  const activate = () => {
    // Prime audio in direct user gesture before remote DJ commands arrive.
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      ctx.resume().then(() => ctx.close()).catch(() => {});
    } catch {
      /* ignore */
    }
    setEnabled(true);
    toggleFullscreen();
  };

  return (
    <div
      ref={screen}
      className="stage-screen relative h-dvh min-h-80 overflow-hidden bg-background text-foreground"
    >
      {enabled && authed ? (
        <StageShow
          onUnauthorized={() => {
            setAuthed(false);
            setEnabled(false);
          }}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-6 px-6 pb-16 text-center">
          <img src={LOGO_URL} alt="The World Family" className="logo-glow size-28 sm:size-40" />
          <div>
            <h1 className="font-display text-4xl text-rainbow sm:text-6xl">The World Family</h1>
            <p className="mt-3 text-lg text-accent">{t.stageView}</p>
          </div>
          {authed === null ? (
            <Loader2 className="size-7 animate-spin text-accent" />
          ) : authed ? (
            <Button data-testid="stage-enable-btn" size="lg" onClick={activate}>
              <Volume2 />
              {t.stageEnable}
            </Button>
          ) : (
            <Button asChild size="lg">
              <Link to="/dj">{t.stageLogin}</Link>
            </Button>
          )}
        </div>
      )}

      <div className="stage-toolbar absolute right-5 top-5 z-40 flex gap-2 opacity-0 focus-within:opacity-100">
        <Button asChild variant="secondary" size="icon" title={t.dj} aria-label={t.dj}>
          <Link to="/dj">
            <Monitor className="size-5" />
          </Link>
        </Button>
        <Button
          variant="secondary"
          size="icon"
          title={fullscreen ? t.stageExitFullscreen : t.stageFullscreen}
          aria-label={fullscreen ? t.stageExitFullscreen : t.stageFullscreen}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
        </Button>
      </div>
    </div>
  );
}

function StageShow({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { t, setLang } = useI18n();
  const { rows, loaded, reload } = useQueue();
  const { control, applause, topRankings, roundEvaluation } = useStageControl(true);
  const current = playOrder(rows).find((r) => r.status === "playing");

  const completedIdsRef = useRef<Set<string>>(new Set());
  const [awaitingAdvanceId, setAwaitingAdvanceId] = useState<string | null>(null);
  const lastControlLangRef = useRef<Lang | null>(null);

  useEffect(() => {
    if (!control.lang) return;
    if (control.revision === 0 && control.lang === "es") return;
    if (lastControlLangRef.current !== control.lang) {
      lastControlLangRef.current = control.lang;
      setLang(control.lang, { skipRemote: true });
    }
  }, [control.lang, control.revision, setLang]);

  useEffect(() => {
    const timer = setInterval(() => void reload(), 4000);
    return () => clearInterval(timer);
  }, [reload]);

  // Suppress synthetic applause/fanfare audio whenever the DJ is running countdown or measuring applause
  useEffect(() => {
    setApplauseAudioSuppressed(
      applause.status === "countdown" || applause.status === "measuring",
    );
    return () => setApplauseAudioSuppressed(false);
  }, [applause.status]);

  const completeCurrent = useCallback(
    async (id: string) => {
      if (completedIdsRef.current.has(id)) return;
      completedIdsRef.current.add(id);
      try {
        await apiJson<{ ok: boolean; reason?: string; advanced?: string }>(
          "/api/dj/requests/complete-current",
          {
            method: "POST",
            body: JSON.stringify({ id }),
          },
        );
        await reload();
      } catch (err) {
        completedIdsRef.current.delete(id);
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized();
        } else {
          toast.error(t.errGeneric);
        }
      }
    },
    [reload, onUnauthorized, t.errGeneric],
  );

  // Coordinated song end handler: defer advancing queue while Applausometer countdown, measurement, or celebration is active
  const handleSongEnded = useCallback(
    (songId: string) => {
      const applauseBusyForStage =
        applause.status === "countdown" ||
        applause.status === "measuring" ||
        (applause.status === "completed" && applause.requestId === songId);
      if (applauseBusyForStage) {
        setAwaitingAdvanceId(songId);
        return;
      }
      void completeCurrent(songId);
    },
    [applause.status, applause.requestId, completeCurrent],
  );

  // Resume deferred queue advancement once applause celebration/cancellation settles
  useEffect(() => {
    if (!awaitingAdvanceId) return;
    const stillActive =
      applause.status === "countdown" ||
      applause.status === "measuring" ||
      (applause.status === "completed" && applause.requestId === awaitingAdvanceId);
    if (!stillActive) {
      const id = awaitingAdvanceId;
      setAwaitingAdvanceId(null);
      void completeCurrent(id);
    }
  }, [awaitingAdvanceId, applause.status, applause.requestId, completeCurrent]);

  const next = playOrder(rows)[0];

  return (
    <div className="relative size-full">
      {current ? (
        <StagePerformance
          key={current.id}
          song={current}
          control={control}
          mutedForApplause={applause.status === "countdown" || applause.status === "measuring"}
          onEnded={() => handleSongEnded(current.id)}
        />
      ) : (
        <div className="animate-in fade-in absolute inset-0 overflow-hidden duration-1000">
          <video
            src={SCANSING_VIDEO_URL}
            autoPlay
            muted
            loop
            playsInline
            className="absolute inset-0 size-full object-cover"
            aria-hidden="true"
          />
          <div className="absolute bottom-8 left-8 flex flex-col items-center gap-2.5 rounded-2xl border-2 border-accent bg-background/95 p-3 shadow-2xl">
            <div className="rounded-xl bg-white p-4">
              <QRCodeSVG
                value={typeof window !== "undefined" ? window.location.origin : ""}
                size={STAGE_IDLE_QR_SIZE}
                bgColor="#FFFFFF"
                fgColor="#000000"
                level="L"
                shapeRendering="crispEdges"
              />
            </div>
            <p className="text-lg font-extrabold tracking-wide text-accent">{t.ssScan}</p>
          </div>
          <div className="absolute bottom-8 right-8 max-w-md rounded-xl border border-border bg-background/80 p-4 text-right">
            {!loaded ? (
              <p className="text-muted-foreground">{t.stageLoading}</p>
            ) : next ? (
              <>
                <p className="text-sm uppercase text-muted-foreground">{t.upcoming}</p>
                <p className="mt-1 break-words font-display text-2xl sm:text-3xl">
                  {next.singer_name}
                </p>
                <p className="break-words text-muted-foreground">{next.song_title}</p>
              </>
            ) : (
              <p className="text-muted-foreground">{t.stageWaiting}</p>
            )}
          </div>

          {(topRankings.length > 0 || roundEvaluation) && (
            <div
              data-testid="stage-idle-leaderboard"
              className="pointer-events-none absolute right-8 top-16 hidden w-full max-w-sm rounded-2xl border border-primary/50 bg-background/88 p-4 backdrop-blur-md md:block"
            >
              <AnimatePresence>
                {roundEvaluation && applause.status === "idle" && (
                  <motion.div
                    key={roundEvaluation.evaluatedAt}
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    className="mb-3 rounded-xl border border-accent/60 bg-card/90 p-3 text-left"
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-wider text-accent">
                      <span className="flex items-center gap-1">
                        <Sparkles className="size-3.5 text-primary" />
                        {t.roundEvaluatedTitle}
                      </span>
                      {roundEvaluation.rank && (
                        <span className="text-primary tabular-nums">
                          {t.rankPosition} #{roundEvaluation.rank}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate font-display text-lg text-foreground">
                      {roundEvaluation.singerName}
                    </div>
                    <div className="text-xs font-semibold text-muted-foreground tabular-nums">
                      {roundEvaluation.applauseScore} + ({roundEvaluation.likes} × 10) ={" "}
                      <span className="text-primary">+{roundEvaluation.roundPoints} {t.points}</span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="mb-2 flex items-center justify-between text-xs font-bold uppercase tracking-wider text-primary">
                <span className="flex items-center gap-1.5">
                  <Trophy className="size-4" />
                  {t.liveRankingTop}
                </span>
                <span className="text-accent">{t.liveSyncActive}</span>
              </div>
              <motion.ol layout className="space-y-1.5">
                {topRankings.map((entry, idx) => {
                  const isEvaluated = roundEvaluation?.singerId === entry.singer_id;
                  return (
                    <motion.li
                      layout
                      key={entry.singer_id}
                      transition={{ layout: { type: "spring", stiffness: 320, damping: 28 } }}
                      className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-1.5 text-sm ${
                        isEvaluated
                          ? "border-accent bg-accent/15 text-foreground"
                          : "border-border/60 bg-card/75 text-foreground"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="w-5 font-display text-base text-primary tabular-nums">
                          {idx + 1}
                        </span>
                        <span className="truncate font-semibold">{entry.display_name}</span>
                        {entry.is_guest && (
                          <span className="text-[11px] text-muted-foreground">
                            · {t.guestSingerBadge}
                          </span>
                        )}
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
      )}

      {awaitingAdvanceId && (
        <div
          data-testid="stage-applause-hold"
          className="pointer-events-none absolute bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-full border border-accent bg-background/90 px-4 py-1.5 text-xs font-semibold text-accent"
        >
          {t.applauseVideoFinishedHold}
        </div>
      )}

      {/* Hosted at StageShow level so active 10s measurement & celebration survive song completion or reload */}
      <StageApplauseOverlay applause={applause} />
    </div>
  );
}

function StagePerformance({
  song,
  onEnded,
  control,
  mutedForApplause,
}: {
  song: SongRequest;
  onEnded: () => void;
  control: StageControl;
  mutedForApplause: boolean;
}) {
  const { t, lang } = useI18n();
  const [count, setCount] = useState(5);
  const [announced, setAnnounced] = useState(false);
  const [hasServerVoice, setHasServerVoice] = useState<boolean | null>(null);
  const langRef = useRef(lang);
  const tRef = useRef(t);
  const songTitleRef = useRef(song.song_title);
  const singerNameRef = useRef(song.singer_name);
  langRef.current = lang;
  tRef.current = t;
  songTitleRef.current = song.song_title;
  singerNameRef.current = song.singer_name;

  useEffect(() => {
    let alive = true;
    const started = Date.now();
    const activeLang = langRef.current;
    const text = tRef.current.announce(singerNameRef.current, songTitleRef.current);
    const voice = apiJson<{ audio: string | null }>("/api/tts/announce", {
      method: "POST",
      body: JSON.stringify({ text, lang: activeLang }),
    })
      .then((r) => {
        if (alive) setHasServerVoice(!!r.audio);
        return r.audio;
      })
      .catch(() => {
        if (alive) setHasServerVoice(false);
        return null;
      });
    const opener = playShowOpener(text, activeLang, voice);
    void opener.finished.then(() => {
      if (alive) setAnnounced(true);
    });
    const interval = setInterval(() => setCount(countdownRemaining(started, Date.now())), 100);
    return () => {
      alive = false;
      clearInterval(interval);
      opener.stop();
    };
  }, [song.id]);

  const likeUrl =
    typeof window !== "undefined" ? `${window.location.origin}/like/${song.id}` : `/like/${song.id}`;

  return (
    <>
      {count === 0 && announced ? (
        <StageVideo
          videoId={song.video_id}
          title={song.song_title}
          onEnded={onEnded}
          control={control}
          mutedForApplause={mutedForApplause}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center px-8 pb-16 text-center">
          <div className="mb-7 flex items-center gap-3 text-sm uppercase text-accent">
            <Volume2 className="size-5" />
            {t.onStage}
          </div>
          <h1 className="max-w-5xl break-words font-display text-5xl text-primary neon-text sm:text-7xl">
            {song.singer_name}
          </h1>
          <p className="mt-5 max-w-4xl break-words text-xl text-muted-foreground sm:text-3xl">
            {song.song_title}
          </p>
          <div
            className="mt-8 flex h-36 w-36 items-center justify-center sm:h-48 sm:w-48"
            aria-live="off"
          >
            {count > 0 ? (
              <span
                key={count}
                className="animate-countdown font-display text-8xl text-accent neon-text-cyan sm:text-9xl"
              >
                {count}
              </span>
            ) : (
              <Heart className="stage-welcome-heart size-20 fill-current text-primary" />
            )}
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            {hasServerVoice === false ? t.stageAudioFallback : t.stageVoice}
          </p>
        </div>
      )}

      <StageHearts requestId={song.id} />

      {/* Far-distance high-contrast Vote-QR for low-resolution beamers (z-40 so guests can still scan during applause countdown/measuring) */}
      <div
        data-testid="stage-like-qr-card"
        className="pointer-events-none absolute left-5 top-5 z-40 flex w-min flex-col items-center gap-2 rounded-2xl border-2 border-accent bg-background/95 p-2.5 shadow-2xl"
      >
        <div data-testid="stage-like-qr-box" className="rounded-xl bg-white p-3.5">
          <QRCodeSVG
            value={likeUrl}
            size={STAGE_LIKE_QR_SIZE}
            bgColor="#FFFFFF"
            fgColor="#000000"
            level="L"
            shapeRendering="crispEdges"
          />
        </div>
        <div className="w-full text-center">
          <p className="whitespace-nowrap text-base font-extrabold uppercase tracking-wider text-accent">
            {t.sendLike}
          </p>
          <p className="whitespace-nowrap text-xs font-semibold text-foreground/90">
            {t.scanToLike}
          </p>
        </div>
      </div>
    </>
  );
}
