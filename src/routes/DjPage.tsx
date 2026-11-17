import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  GripVertical,
  Play,
  Star,
  Check,
  SkipForward,
  Trash2,
  LogOut,
  Loader2,
  Lock,
  ChevronUp,
  ChevronDown,
  Monitor,
  Mic2,
  Trophy,
  UserRound,
  Pause,
  RotateCcw,
  Volume2,
  CheckCheck,
  Mic,
  Award,
  Square,
  Heart,
  Settings,
  ExternalLink,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { StagePlayer } from "@/components/StagePlayer";
import { DjSongSearch } from "@/components/DjSongSearch";
import { SettingsDialog } from "@/components/SettingsDialog";
import { useQueue } from "@/hooks/use-queue";
import { useStageControl } from "@/hooks/use-stage-control";
import { useApplauseRecorder, type RecorderErrorCode } from "@/hooks/use-applause-recorder";
import { ApiError, apiJson, setDjToken } from "@/lib/api";
import { setApplauseAudioSuppressed } from "@/lib/applause";
import { computeSpectrumColumns } from "@/lib/applause-meter";
import { LOGO_URL } from "@/lib/assets";
import { DJ_ACTIVE_STORAGE_KEY, useI18n, type Lang } from "@/lib/i18n";
import { playOrder, type SongRequest } from "@/lib/queue";
import { performancePoints } from "@/lib/singer";

export function DjPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [djConfigured, setDjConfigured] = useState(true);

  useEffect(() => {
    apiJson<{ ok: boolean; configured?: boolean }>("/api/dj/status")
      .then((r) => {
        setAuthed(r.ok);
        setDjConfigured(r.configured !== false);
        try {
          if (r.ok) localStorage.setItem(DJ_ACTIVE_STORAGE_KEY, "1");
          else localStorage.removeItem(DJ_ACTIVE_STORAGE_KEY);
        } catch {
          /* ignore */
        }
      })
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) return null;
  return authed ? (
    <Desk onLogout={() => setAuthed(false)} />
  ) : (
    <Login djConfigured={djConfigured} onOk={() => setAuthed(true)} />
  );
}

function Login({ djConfigured, onOk }: { djConfigured: boolean; onOk: () => void }) {
  const { t } = useI18n();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await apiJson<{ ok: boolean; token?: string; reason?: string }>("/api/dj/login", {
        method: "POST",
        body: JSON.stringify({ password: pw }),
      });
      if (r.ok) {
        if (r.token) setDjToken(r.token);
        try {
          localStorage.setItem(DJ_ACTIVE_STORAGE_KEY, "1");
        } catch {
          /* ignore */
        }
        onOk();
      } else {
        toast.error(r.reason === "config" ? t.errGeneric : t.djWrong);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "config") {
        toast.error("DJ_PASSWORD is not configured on the server (.env)");
      } else {
        toast.error(t.djWrong);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="w-full max-w-xs space-y-4 rounded-2xl border border-primary bg-card p-6 text-center neon-border"
      >
        <img src={LOGO_URL} alt="" width={80} height={80} className="logo-glow mx-auto size-20" />
        <h1 className="font-display text-2xl text-primary neon-text">DJ Desk</h1>
        {!djConfigured && (
          <p className="rounded-lg border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            DJ_PASSWORD missing in server environment
          </p>
        )}
        <Input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder={t.djPassword}
        />
        <Button type="submit" className="w-full" disabled={busy || !pw}>
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <>
              <Lock className="size-4" /> {t.djEnter}
            </>
          )}
        </Button>
      </form>
    </div>
  );
}

function recorderErrorText(code: RecorderErrorCode, t: ReturnType<typeof useI18n>["t"]): string | null {
  switch (code) {
    case "iframe_blocked":
      return t.applauseErrIframeBlocked;
    case "permission":
      return t.applauseErrPermission;
    case "no_mic":
      return t.applauseErrNoMic;
    case "unsupported":
      return t.applauseErrUnsupported;
    case "busy":
      return t.applauseErrBusy;
    case "insufficient":
      return t.applauseErrNoMic;
    case "network":
      return t.applauseErrNetwork;
    case "unauthorized":
      return t.djExpired;
    default:
      return null;
  }
}

function Desk({ onLogout }: { onLogout: () => void }) {
  const { t, lang, setLang } = useI18n();
  const [externalStage, setExternalStage] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { rows, setRows, reload } = useQueue();
  const stageCtrl = useStageControl(true);
  const [stage, setStage] = useState<SongRequest | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const completedLocalIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const saved = localStorage.getItem("pm-external-stage");
    if (saved === "true" || saved === "false") {
      setExternalStage(saved === "true");
    } else {
      setExternalStage(stageCtrl.control.external);
    }
  }, [stageCtrl.control.external]);

  const changeStage = (value: boolean) => {
    setExternalStage(value);
    localStorage.setItem("pm-external-stage", String(value));
    if (value) setStage(null);
    stageCtrl.command(value ? "external" : "local").catch(() => {});
  };

  const recorder = useApplauseRecorder({
    onCompleted: async (res) => {
      toast.success(`${t.applauseSavedToast}: ${res.score}/100`);
      await reload();
    },
    onUnauthorized: () => {
      toast.error(t.djExpired);
      onLogout();
    },
  });

  // Pause synthetic stage audio during applause countdown or measurement
  useEffect(() => {
    setApplauseAudioSuppressed(
      recorder.phase === "countdown" ||
        recorder.phase === "measuring" ||
        stageCtrl.applause.status === "countdown" ||
        stageCtrl.applause.status === "measuring",
    );
    return () => setApplauseAudioSuppressed(false);
  }, [recorder.phase, stageCtrl.applause.status]);

  const order = useMemo(() => playOrder(rows), [rows]);
  const done = useMemo(
    () =>
      rows
        .filter((r) => r.status === "done" || r.status === "skipped")
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 10),
    [rows],
  );

  const playingSong = order.find((r) => r.status === "playing");
  const recentCompletedSong = done.find((r) => r.status === "done");
  const applauseTarget = playingSong ?? recentCompletedSong ?? null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const act = useCallback(
    async (id: string, s: "next" | "playing" | "done" | "skipped" | "waiting") => {
      try {
        const r = await apiJson<{ ok: boolean; reason?: string; advanced?: string }>(
          "/api/dj/requests/status",
          {
            method: "POST",
            body: JSON.stringify({ id, status: s }),
          },
        );
        if (!r.ok) {
          toast.error(r.reason ?? t.errGeneric);
          return;
        }
        await reload();
        if (!externalStage) {
          if (s === "playing") {
            const song = rows.find((x) => x.id === id);
            if (song) setStage(song);
          }
          if ((s === "done" || s === "skipped") && stage?.id === id) {
            const nxt = r.advanced ? rows.find((x) => x.id === r.advanced) : undefined;
            setStage(nxt ?? null);
          }
        } else {
          setStage(null);
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          toast.error(t.djExpired);
          onLogout();
        } else {
          toast.error(e instanceof Error ? e.message : t.errGeneric);
        }
      }
    },
    [rows, stage, externalStage, reload, onLogout, t],
  );

  const completeLocalStageSong = useCallback(
    async (id: string) => {
      if (completedLocalIdsRef.current.has(id)) return;
      completedLocalIdsRef.current.add(id);
      try {
        const r = await apiJson<{ ok: boolean; advanced?: string }>(
          "/api/dj/requests/complete-current",
          {
            method: "POST",
            body: JSON.stringify({ id }),
          },
        );
        await reload();
        if (r.advanced) {
          const nextSong = rows.find((x) => x.id === r.advanced) ?? null;
          setStage(nextSong);
        } else {
          setStage(null);
        }
      } catch (e) {
        completedLocalIdsRef.current.delete(id);
        if (e instanceof ApiError && e.status === 401) {
          toast.error(t.djExpired);
          onLogout();
        }
      }
    },
    [reload, rows, onLogout, t.djExpired],
  );

  const persistOrder = async (ids: string[]) => {
    try {
      const r = await apiJson<{ ok: boolean }>("/api/dj/requests/reorder", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      if (!r.ok) {
        toast.error(t.djQueueChanged);
        await reload();
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        toast.error(t.djExpired);
        onLogout();
      } else {
        toast.error(t.djQueueChanged);
        await reload();
      }
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const oldI = order.findIndex((r) => r.id === e.active.id);
    const overId = e.over.id;
    const newI = order.findIndex((r) => r.id === overId);
    const next = arrayMove(order, oldI, newI);
    setRows((prev) =>
      prev.map((r) => {
        const i = next.findIndex((n) => n.id === r.id);
        return i >= 0 ? { ...r, position: (i + 1) * 1000 } : r;
      }),
    );
    void persistOrder(next.map((r) => r.id));
  };

  const move = (id: string, dir: -1 | 1) => {
    const i = order.findIndex((r) => r.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = arrayMove(order, i, j);
    setRows((prev) =>
      prev.map((r) => {
        const k = next.findIndex((n) => n.id === r.id);
        return k >= 0 ? { ...r, position: (k + 1) * 1000 } : r;
      }),
    );
    void persistOrder(next.map((r) => r.id));
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const playing = order.find((r) => r.status === "playing");
      const sel = selected ?? order.find((r) => r.status !== "playing")?.id;
      if (e.code === "Space") {
        e.preventDefault();
        if (externalStage) return;
        if (stage) setStage(null);
        else if (playing) setStage(playing);
        else if (sel) void act(sel, "playing");
      } else if (e.key === "n" && sel) {
        void act(sel, "next");
      } else if (e.key === "d" && playing) {
        void act(playing.id, "done");
      } else if (e.key === "s" && playing) {
        void act(playing.id, "skipped");
      } else if (e.key === "ArrowDown") {
        const i = order.findIndex((r) => r.id === sel);
        setSelected(order[Math.min(order.length - 1, i + 1)]?.id ?? null);
      } else if (e.key === "ArrowUp") {
        const i = order.findIndex((r) => r.id === sel);
        setSelected(order[Math.max(0, i - 1)]?.id ?? null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, selected, stage, externalStage, act]);

  const guestUrl = typeof window !== "undefined" ? `${window.location.origin}/` : "";
  const isMeasuring =
    recorder.phase !== "idle" ||
    stageCtrl.applause.status === "countdown" ||
    stageCtrl.applause.status === "measuring";
  const errMsg = recorderErrorText(recorder.errorCode, t);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <img src={LOGO_URL} alt="" width={48} height={48} className="logo-glow size-12" />
        <h1 className="flex-1 font-display text-3xl text-primary neon-text">DJ Desk</h1>
        <div
          className="flex rounded-full border border-border p-0.5"
          role="group"
          aria-label={t.settingsLanguage}
        >
          {(["es", "de", "en"] as Lang[]).map((l) => (
            <button
              key={l}
              type="button"
              data-testid={`dj-lang-${l}`}
              onClick={() => {
                setLang(l, { skipRemote: true });
                stageCtrl.command("lang", stageCtrl.control.volume, l).catch(() => {});
              }}
              className={`rounded-full px-2.5 py-1 text-xs font-bold uppercase ${
                lang === l ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              {l}
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant="secondary"
          data-testid="dj-settings-btn"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings className="size-4" />
          {t.settingsTitle}
        </Button>
        <Button asChild variant="secondary">
          <Link
            to="/stage"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => changeStage(true)}
          >
            <Monitor className="size-4" />
            {t.stageOpen}
          </Link>
        </Button>
        <Button
          variant="secondary"
          onClick={async () => {
            await apiJson("/api/dj/logout", { method: "POST" }).catch(() => {});
            setDjToken(null);
            try {
              localStorage.removeItem(DJ_ACTIVE_STORAGE_KEY);
            } catch {
              /* ignore */
            }
            onLogout();
          }}
        >
          <LogOut className="size-4" /> {t.djLogout}
        </Button>
      </header>

      <nav className="mb-4 flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to="/">
            <Mic2 className="size-4" />
            {t.home}
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to="/rangliste">
            <Trophy className="size-4" />
            {t.leaderboard}
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to="/konto">
            <UserRound className="size-4" />
            {t.account}
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to="/stage" target="_blank" rel="noopener noreferrer">
            <Monitor className="size-4" />
            {t.stageView}
          </Link>
        </Button>
      </nav>

      <label className="mb-6 flex w-fit items-center gap-3 text-sm text-muted-foreground">
        <Switch checked={externalStage} onCheckedChange={changeStage} />
        {externalStage ? t.stageExternal : t.stageLocal}
      </label>

      {externalStage && (
        <StageControls playing={playingSong} act={act} stageCtrl={stageCtrl} />
      )}

      {/* 10-Second Applausometer Control Panel */}
      <section
        data-testid="dj-applause-panel"
        className="mb-6 rounded-2xl border border-primary/50 bg-card p-4"
        aria-label={t.applauseStageTitle}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 font-display text-lg text-primary">
              <Mic className="size-5" />
              {t.applauseStageTitle}
            </div>
            {applauseTarget ? (
              <div className="mt-0.5 text-sm text-muted-foreground">
                <span>{t.applauseTargetSong}: </span>
                <strong className="text-foreground">{applauseTarget.singer_name}</strong> —{" "}
                <span className="truncate">{applauseTarget.song_title}</span>
              </div>
            ) : (
              <div className="mt-0.5 text-sm text-muted-foreground">{t.applauseErrNoTarget}</div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {recorder.phase === "idle" ? (
              <Button
                data-testid="dj-applause-start"
                disabled={!applauseTarget || isMeasuring}
                onClick={() => applauseTarget && void recorder.start(applauseTarget.id)}
              >
                <Mic className="size-4" />
                {typeof applauseTarget?.applause_score === "number"
                  ? t.applauseRemeasureBtn
                  : t.applauseMeasureBtn}
              </Button>
            ) : (
              <Button
                data-testid="dj-applause-cancel"
                variant="destructive"
                onClick={() => {
                  void recorder.cancel();
                  toast(t.applauseCancelledToast);
                }}
              >
                <Square className="size-4" />
                {t.applauseCancel}
              </Button>
            )}
          </div>
        </div>

        {recorder.phase === "preparing" && (
          <div
            data-testid="dj-applause-preparing"
            className="mt-3 flex items-center gap-2 text-sm text-accent"
          >
            <Loader2 className="size-4 animate-spin" />
            {t.applausePreparing}
          </div>
        )}

        {recorder.phase === "countdown" && (
          <div
            data-testid="dj-applause-precountdown"
            className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-primary/50 bg-background/70 px-4 py-3"
          >
            <span className="font-semibold text-primary">{t.applauseDjCountdown}</span>
            <span className="font-display text-3xl text-accent tabular-nums">
              {recorder.countdownSec}s
            </span>
          </div>
        )}

        {recorder.phase === "measuring" && (
          <div className="mt-4 space-y-2.5 rounded-xl border border-accent/50 bg-background/70 p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-accent">{t.applauseMeasuring}</span>
              <span
                data-testid="dj-applause-countdown"
                className="font-display text-2xl text-primary tabular-nums"
              >
                {recorder.remainingSec}s
              </span>
            </div>
            {/* Mini 32-band real-time spectrum */}
            <div
              className="flex h-12 items-end gap-[2px] rounded-lg border border-border/70 bg-background/95 p-1.5"
              aria-hidden="true"
            >
              {(recorder.liveBands.length >= 16
                ? recorder.liveBands.filter((_, idx) => idx % 3 !== 2).slice(0, 32)
                : computeSpectrumColumns(
                    recorder.liveLevel,
                    recorder.peakLevel,
                    Math.round(recorder.liveLevel * 100),
                    32,
                  )
              ).map((val, idx) => (
                <div
                  key={idx}
                  className="flex h-full flex-1 flex-col justify-end rounded-[1px] bg-muted/25"
                >
                  <div
                    className={`w-full rounded-t-[1px] transition-none ${
                      val >= 0.78 ? "bg-destructive" : val >= 0.42 ? "bg-primary" : "bg-accent"
                    }`}
                    style={{ height: `${Math.round(val * 1000) / 10}%` }}
                  />
                </div>
              ))}
            </div>
            {/* 32-segment precision meter with peak marker */}
            <div className="relative overflow-hidden rounded-lg border border-border/70 bg-background/95 p-1">
              <div
                data-testid="dj-applause-level"
                className="flex gap-[2px]"
                data-level={Math.round(recorder.liveLevel * 100)}
              >
                {Array.from({ length: 32 }, (_, idx) => {
                  const lit = idx < Math.round(recorder.liveLevel * 32);
                  const cls =
                    idx < 14 ? "bg-success" : idx < 24 ? "bg-primary" : "bg-destructive";
                  return (
                    <div
                      key={idx}
                      className={`h-3.5 flex-1 rounded-[1px] transition-none ${lit ? cls : "bg-muted/45"}`}
                    />
                  );
                })}
              </div>
              {recorder.peakLevel > 0.02 && (
                <div
                  className="absolute bottom-0.5 top-0.5 w-0.5 bg-foreground"
                  style={{ left: `${Math.min(99, Math.round(recorder.peakLevel * 1000) / 10)}%` }}
                  aria-hidden="true"
                />
              )}
            </div>
            <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
              <span>
                {t.applauseLevelLabel}:{" "}
                <strong className="text-foreground">
                  {(recorder.liveLevel * 100).toFixed(1)}%
                </strong>
              </span>
              <span>
                {t.applausePeakShort}:{" "}
                <strong className="text-foreground">
                  {Math.round(recorder.peakLevel * 100)}%
                </strong>
              </span>
            </div>
          </div>
        )}

        {recorder.phase === "saving" && (
          <div className="mt-3 flex items-center gap-2 text-sm text-primary">
            <Loader2 className="size-4 animate-spin" />
            {t.applauseSaving}
          </div>
        )}

        {errMsg && (
          <div
            data-testid="dj-applause-error"
            className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <span className="min-w-0 flex-1">{errMsg}</span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings className="size-3.5" />
                {t.settingsTitle}
              </Button>
              {recorder.errorCode === "iframe_blocked" && (
                <Button asChild type="button" size="sm" variant="outline">
                  <a href="/dj" target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="size-3.5" />
                    {t.openDjNewTab}
                  </a>
                </Button>
              )}
              <button
                type="button"
                onClick={() => recorder.clearError()}
                className="text-xs underline"
              >
                {t.djClose}
              </button>
            </div>
          </div>
        )}

        {applauseTarget && (
          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1 tabular-nums">
              <Award className="size-3.5 text-accent" />
              {t.applauseScoreLabel}:{" "}
              <strong className="text-foreground">
                {typeof applauseTarget.applause_score === "number"
                  ? `${applauseTarget.applause_score}/100`
                  : t.applauseNotMeasured}
              </strong>
            </span>
            <span className="flex items-center gap-1 tabular-nums">
              <Heart className="size-3.5 text-primary" />
              {t.likes}: <strong className="text-foreground">{applauseTarget.likes_count ?? 0}</strong>
            </span>
            <span className="tabular-nums">
              {t.applauseTotalPoints}:{" "}
              <strong className="text-primary">
                {performancePoints(applauseTarget.applause_score, applauseTarget.likes_count ?? 0)}
              </strong>
            </span>
          </div>
        )}
      </section>

      <DjSongSearch queueLength={order.length} onAdded={() => void reload()} />

      <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
        <section>
          <div className="mb-2 flex justify-between text-sm text-muted-foreground">
            <span>
              {order.length} {t.djInQueue}
            </span>
            <span className="hidden md:inline">{t.djShortcuts}</span>
          </div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={order.map((r) => r.id)} strategy={verticalListSortingStrategy}>
              <ul className="space-y-2">
                {order.map((r, i) => (
                  <Row
                    key={r.id}
                    r={r}
                    index={i}
                    selected={selected === r.id}
                    onSelect={() => setSelected(r.id)}
                    act={act}
                    move={move}
                    onDelete={async () => {
                      await apiJson(`/api/dj/requests/${r.id}`, { method: "DELETE" });
                      setRows((p) => p.filter((x) => x.id !== r.id));
                    }}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          {order.length === 0 && (
            <p className="rounded-2xl border border-dashed border-border p-10 text-center text-muted-foreground">
              {t.djEmpty}
            </p>
          )}
          {done.length > 0 && (
            <div className="mt-8">
              <h2 className="mb-2 text-lg text-muted-foreground">{t.djLast}</h2>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {done.map((r) => {
                  const hasScore = typeof r.applause_score === "number";
                  const likes = r.likes_count ?? 0;
                  const pts = performancePoints(r.applause_score, likes);
                  return (
                    <li key={r.id} className="flex flex-wrap items-center gap-2 border-b border-border/40 py-1.5">
                      <span className={r.status === "done" ? "text-success" : "text-destructive"}>
                        {r.status === "done" ? "✓" : "⏭"}
                      </span>
                      <span className="font-semibold text-foreground">{r.singer_name}</span>
                      <span className="truncate">{r.song_title}</span>
                      <span className="ml-auto text-xs tabular-nums">
                        {hasScore ? `${r.applause_score}/100` : t.applauseNotMeasured} · ♥ {likes} ·{" "}
                        <strong className="text-primary">{pts} {t.points}</strong>
                      </span>
                      <button
                        type="button"
                        className="text-xs underline"
                        onClick={() => void act(r.id, "waiting")}
                      >
                        {t.djRequeue}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>

        <aside className="space-y-3 rounded-2xl border border-border bg-card p-4 text-center">
          <div className="font-display text-lg text-accent">{t.djScan}</div>
          <div className="mx-auto w-fit rounded-xl bg-foreground p-3">
            {guestUrl && <QRCodeSVG value={guestUrl} size={180} />}
          </div>
          <div className="break-all text-xs text-muted-foreground">{guestUrl}</div>
        </aside>
      </div>

      {stage && !externalStage && (
        <StagePlayer
          song={stage}
          onClose={() => setStage(null)}
          onEnded={() => void completeLocalStageSong(stage.id)}
        />
      )}

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        djBridge={{
          externalStage,
          onExternalStageChange: changeStage,
          control: stageCtrl.control,
          command: stageCtrl.command,
        }}
      />
    </div>
  );
}

function Row({
  r,
  index,
  selected,
  onSelect,
  act,
  move,
  onDelete,
}: {
  r: SongRequest;
  index: number;
  selected: boolean;
  onSelect: () => void;
  act: (id: string, s: "next" | "playing" | "done" | "skipped") => void;
  move: (id: string, dir: -1 | 1) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: r.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const playing = r.status === "playing";
  const next = r.status === "next";
  const hasScore = typeof r.applause_score === "number";
  const likes = r.likes_count ?? 0;

  return (
    <li
      ref={setNodeRef}
      style={style}
      onClick={onSelect}
      className={`flex items-center gap-3 rounded-2xl border bg-card p-3 ${
        playing
          ? "animate-neon-pulse border-primary"
          : next
            ? "border-accent"
            : selected
              ? "border-ring"
              : "border-border"
      } ${isDragging ? "opacity-60" : ""}`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="cursor-grab text-muted-foreground"
        aria-label={t.djDrag}
      >
        <GripVertical className="size-5" />
      </button>
      <span className="w-6 text-center font-bold text-primary">{index + 1}</span>
      {r.thumbnail_url && (
        <img
          src={r.thumbnail_url}
          alt=""
          referrerPolicy="no-referrer"
          className="hidden h-12 w-20 rounded object-cover sm:block"
          loading="lazy"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">
          {r.singer_name}{" "}
          {playing && <span className="text-xs text-primary">{t.djOnStage}</span>}
          {next && <span className="text-xs text-accent">{t.djNextTag}</span>}
        </div>
        <div className="truncate text-sm text-muted-foreground">
          {r.song_title} {r.duration && `· ${r.duration}`}
        </div>
        {(likes > 0 || hasScore) && (
          <div className="text-xs text-muted-foreground tabular-nums">
            {hasScore ? `${t.applausePointsShort}: ${r.applause_score}/100` : t.applauseNotMeasured} · ♥{" "}
            {likes} · {performancePoints(r.applause_score, likes)} {t.points}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <IconBtn label={t.djUp} onClick={() => move(r.id, -1)}>
          <ChevronUp className="size-4" />
        </IconBtn>
        <IconBtn label={t.djDown} onClick={() => move(r.id, 1)}>
          <ChevronDown className="size-4" />
        </IconBtn>
        <IconBtn label={t.djPlay} onClick={() => act(r.id, "playing")} hot>
          <Play className="size-4" />
        </IconBtn>
        <IconBtn label={t.djNext} onClick={() => act(r.id, "next")}>
          <Star className="size-4" />
        </IconBtn>
        <IconBtn label={t.djDone} onClick={() => act(r.id, "done")}>
          <Check className="size-4" />
        </IconBtn>
        <IconBtn label={t.djSkip} onClick={() => act(r.id, "skipped")}>
          <SkipForward className="size-4" />
        </IconBtn>
        <IconBtn label={t.djDelete} onClick={onDelete}>
          <Trash2 className="size-4 text-destructive" />
        </IconBtn>
      </div>
    </li>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  hot,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  hot?: boolean;
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant={hot ? "default" : "ghost"}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="size-8"
    >
      {children}
    </Button>
  );
}

function StageControls({
  playing,
  act,
  stageCtrl,
}: {
  playing: SongRequest | undefined;
  act: (id: string, s: "done" | "skipped") => void;
  stageCtrl: ReturnType<typeof useStageControl>;
}) {
  const { t } = useI18n();
  const { control, command, connected, busy } = stageCtrl;
  const [vol, setVol] = useState<number | null>(null);

  const run = (c: Parameters<typeof command>[0], v?: number) => {
    command(c, v).catch(() => toast.error(t.errGeneric));
  };

  return (
    <section
      className="mb-6 rounded-2xl border border-accent/50 bg-card p-4"
      aria-label={t.stageControls}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-display text-lg text-accent">{t.stageControls}</span>
        <span className={connected ? "text-success" : "text-destructive"}>
          ● {connected ? t.stageConnected : t.stageDisconnected}
        </span>
        {control.paused && <span className="text-muted-foreground">· {t.stagePaused}</span>}
        {playing && (
          <span className="ml-auto truncate text-muted-foreground">
            {playing.singer_name} · {playing.song_title}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {control.paused ? (
          <Button disabled={busy} onClick={() => run("play")}>
            <Play className="size-4" />
            {t.stageResume}
          </Button>
        ) : (
          <Button disabled={busy} variant="secondary" onClick={() => run("pause")}>
            <Pause className="size-4" />
            {t.stagePause}
          </Button>
        )}
        <Button disabled={busy || !playing} variant="secondary" onClick={() => run("restart")}>
          <RotateCcw className="size-4" />
          {t.stageRestart}
        </Button>
        <Button
          disabled={!playing}
          variant="secondary"
          onClick={() => playing && act(playing.id, "done")}
        >
          <CheckCheck className="size-4" />
          {t.stageFinish}
        </Button>
        <Button
          disabled={!playing}
          variant="secondary"
          onClick={() => playing && act(playing.id, "skipped")}
        >
          <SkipForward className="size-4" />
          {t.stageNext}
        </Button>
        <label className="ml-auto flex min-w-48 flex-1 items-center gap-3 text-sm text-muted-foreground sm:max-w-xs">
          <Volume2 className="size-4 shrink-0" />
          <span className="sr-only">{t.stageVolume}</span>
          <Slider
            min={0}
            max={100}
            step={5}
            value={[vol ?? control.volume]}
            onValueChange={(v) => setVol(v[0] ?? null)}
            onValueCommit={(v) => {
              run("volume", v[0] ?? 100);
              setVol(null);
            }}
          />
          <span className="w-9 tabular-nums">{vol ?? control.volume}</span>
        </label>
      </div>
    </section>
  );
}
