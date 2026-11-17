import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  Globe,
  Mic,
  MicOff,
  RotateCcw,
  Settings,
  ShieldAlert,
  Sparkles,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { apiJson } from "@/lib/api";
import {
  computeFrameEnergyFromFloatSamples,
  normalizeRmsLevel,
  smoothLevelAsymmetric,
} from "@/lib/applause-meter";
import { useI18n, type Lang } from "@/lib/i18n";
import {
  buildAudioConstraints,
  isEmbeddedIframe,
  isMicrophoneAllowedByPolicy,
  loadAppSettings,
  resetAppSettings,
  saveAppSettings,
  subscribeAppSettings,
  type ApplauseDurationSec,
  type AppSettings,
} from "@/lib/settings";
import type { StageCommand, StageControl } from "@/lib/stage-control";

type MicPermStatus = "granted" | "prompt" | "denied" | "iframe_blocked" | "unknown";

interface AudioDeviceItem {
  deviceId: string;
  label: string;
}

export interface DjSettingsBridge {
  externalStage: boolean;
  onExternalStageChange: (next: boolean) => void;
  control: StageControl;
  command: (cmd: StageCommand, volume?: number, lang?: StageControl["lang"]) => Promise<void>;
}

export function SettingsDialog({
  open,
  onOpenChange,
  djBridge,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  djBridge?: DjSettingsBridge;
}) {
  const { t, lang, setLang } = useI18n();
  const [settings, setSettings] = useState<AppSettings>(() => loadAppSettings());
  const [micStatus, setMicStatus] = useState<MicPermStatus>("unknown");
  const [devices, setDevices] = useState<AudioDeviceItem[]>([]);
  const [testingMic, setTestingMic] = useState(false);
  const [testLevel, setTestLevel] = useState(0);
  const [volDraft, setVolDraft] = useState<number | null>(null);
  const [testingVoice, setTestingVoice] = useState(false);
  const inIframe = isEmbeddedIframe();

  const stopTestRef = useRef<() => void>(() => {});

  const refreshDevicesAndPermission = useCallback(async () => {
    const policyAllows = isMicrophoneAllowedByPolicy();
    if (policyAllows === false) {
      setMicStatus("iframe_blocked");
    } else if (typeof navigator !== "undefined" && navigator.permissions?.query) {
      try {
        const res = await navigator.permissions.query({
          name: "microphone" as PermissionName,
        });
        if (res.state === "granted" || res.state === "prompt") {
          setMicStatus(res.state);
        } else {
          setMicStatus(inIframe ? "iframe_blocked" : "denied");
        }
      } catch {
        setMicStatus("unknown");
      }
    }

    if (typeof navigator !== "undefined" && navigator.mediaDevices?.enumerateDevices) {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        const inputs = all
          .filter((d) => d.kind === "audioinput")
          .map((d, idx) => ({
            deviceId: d.deviceId,
            label: d.label || `Microphone ${idx + 1}`,
          }));
        setDevices(inputs);
      } catch {
        setDevices([]);
      }
    }
  }, [inIframe]);

  useEffect(() => subscribeAppSettings(setSettings), []);

  useEffect(() => {
    if (!open) {
      stopTestRef.current();
      return;
    }
    void refreshDevicesAndPermission();
    return () => {
      stopTestRef.current();
    };
  }, [open, refreshDevicesAndPermission]);

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const next = saveAppSettings({ [key]: value });
    setSettings(next);
  };

  const startMicTest = async () => {
    if (testingMic) {
      stopTestRef.current();
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error(t.applauseErrUnsupported);
      return;
    }

    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (stream) {
        for (const tr of stream.getTracks()) tr.stop();
        stream = null;
      }
      if (ctx) {
        ctx.close().catch(() => {});
        ctx = null;
      }
      setTestingMic(false);
      setTestLevel(0);
    };

    stopTestRef.current = cleanup;

    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: buildAudioConstraints(settings),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        if (name === "OverconstrainedError" || name === "TypeError") {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw err;
        }
      }

      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new Ctx();
      if (ctx.state === "suspended") await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.15;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let smoothed = 0;

      setTestingMic(true);
      await refreshDevicesAndPermission();
      setMicStatus("granted");

      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        const { energy } = computeFrameEnergyFromFloatSamples(buf);
        const norm = normalizeRmsLevel(energy);
        smoothed = smoothLevelAsymmetric(smoothed, norm, 0.9, 0.25);
        setTestLevel(smoothed);
      }, 33);
    } catch (err) {
      cleanup();
      const name = err instanceof Error ? err.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
        const blocked = isMicrophoneAllowedByPolicy() === false || inIframe;
        setMicStatus(blocked ? "iframe_blocked" : "denied");
        toast.error(blocked ? t.applauseErrIframeBlocked : t.applauseErrPermission);
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        toast.error(t.applauseErrNoMic);
      } else {
        toast.error(t.errGeneric);
      }
    }
  };

  const testVoice = async () => {
    setTestingVoice(true);
    try {
      const sample = t.announce("The World Family", "Karaoke Night");
      const res = await apiJson<{ audio: string | null }>("/api/tts/announce", {
        method: "POST",
        body: JSON.stringify({ text: sample, lang }),
      });
      if (res.audio) {
        const audio = new Audio(`data:audio/mpeg;base64,${res.audio}`);
        await audio.play();
      } else if (settings.stageVoiceFallback && "speechSynthesis" in window) {
        const u = new SpeechSynthesisUtterance(sample);
        u.lang = lang === "es" ? "es-ES" : lang === "de" ? "de-DE" : "en-US";
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } else {
        toast.error(t.stageAudioFallback);
      }
    } catch {
      if (settings.stageVoiceFallback && "speechSynthesis" in window) {
        const sample = t.announce("The World Family", "Karaoke Night");
        const u = new SpeechSynthesisUtterance(sample);
        u.lang = lang === "es" ? "es-ES" : lang === "de" ? "de-DE" : "en-US";
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } else {
        toast.error(t.errGeneric);
      }
    } finally {
      setTestingVoice(false);
    }
  };

  const statusMeta: Record<
    MicPermStatus,
    { label: string; badgeClass: string; Icon: typeof Mic }
  > = {
    granted: {
      label: t.settingsMicGranted,
      badgeClass: "border-success/50 bg-success/15 text-success",
      Icon: CheckCircle2,
    },
    prompt: {
      label: t.settingsMicPrompt,
      badgeClass: "border-accent/50 bg-accent/15 text-accent",
      Icon: Mic,
    },
    denied: {
      label: t.settingsMicDenied,
      badgeClass: "border-destructive/50 bg-destructive/15 text-destructive",
      Icon: MicOff,
    },
    iframe_blocked: {
      label: t.settingsMicIframeBlocked,
      badgeClass: "border-destructive/50 bg-destructive/15 text-destructive",
      Icon: ShieldAlert,
    },
    unknown: {
      label: t.settingsMicUnknown,
      badgeClass: "border-border bg-muted/40 text-muted-foreground",
      Icon: Mic,
    },
  };

  const currentStatus = statusMeta[micStatus];
  const StatusIcon = currentStatus.Icon;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="settings-dialog"
        className="max-h-[90vh] max-w-2xl overflow-y-auto border-primary/50 bg-card p-5 text-foreground neon-border"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-2xl text-primary neon-text">
            <Settings className="size-5" />
            {t.settingsTitle}
          </DialogTitle>
          <DialogDescription>{t.settingsSubtitle}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5 pt-1">
          {/* 1. Microphone & Permissions */}
          <section className="space-y-2.5 rounded-2xl border border-border bg-background/60 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 font-semibold text-accent">
                <Mic className="size-4" />
                {t.settingsMicSection}
              </h3>
              <span
                data-testid="settings-mic-status-badge"
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${currentStatus.badgeClass}`}
              >
                <StatusIcon className="size-3.5" />
                {currentStatus.label}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                data-testid="settings-mic-test-btn"
                variant={testingMic ? "destructive" : "default"}
                onClick={() => void startMicTest()}
              >
                {testingMic ? (
                  <>
                    <MicOff className="size-4" />
                    {t.settingsMicStopTestBtn}
                  </>
                ) : (
                  <>
                    <Mic className="size-4" />
                    {t.settingsMicRequestBtn}
                  </>
                )}
              </Button>

              {inIframe && (
                <Button asChild type="button" size="sm" variant="secondary">
                  <a
                    href={djBridge ? "/dj" : typeof window !== "undefined" ? window.location.pathname : "/"}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="size-4" />
                    {t.openDjNewTab}
                  </a>
                </Button>
              )}
            </div>

            {testingMic && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
                  <span>{t.settingsMicTestHint}</span>
                  <span className="font-semibold text-foreground">{(testLevel * 100).toFixed(1)}%</span>
                </div>
                <div
                  data-testid="settings-mic-test-level"
                  className="flex gap-[2px] rounded-lg border border-border bg-background p-1"
                >
                  {Array.from({ length: 24 }, (_, idx) => {
                    const lit = idx < Math.round(testLevel * 24);
                    const cls =
                      idx < 10 ? "bg-success" : idx < 18 ? "bg-primary" : "bg-destructive";
                    return (
                      <div
                        key={idx}
                        className={`h-3 flex-1 rounded-[1px] transition-none ${lit ? cls : "bg-muted/45"}`}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            <label className="block space-y-1.5 text-xs">
              <span className="text-muted-foreground">{t.settingsMicSelect}</span>
              <select
                data-testid="settings-mic-device"
                value={settings.micDeviceId}
                onChange={(e) => updateSetting("micDeviceId", e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground"
              >
                <option value="">{t.settingsMicDefaultDevice}</option>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="space-y-2 border-t border-border/60 pt-2 text-sm">
              <label className="flex items-center justify-between gap-3">
                <span>{t.settingsMicEcho}</span>
                <Switch
                  checked={settings.echoCancellation}
                  onCheckedChange={(v) => updateSetting("echoCancellation", v)}
                />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span>{t.settingsMicNoise}</span>
                <Switch
                  checked={settings.noiseSuppression}
                  onCheckedChange={(v) => updateSetting("noiseSuppression", v)}
                />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span>{t.settingsMicAgc}</span>
                <Switch
                  checked={settings.autoGainControl}
                  onCheckedChange={(v) => updateSetting("autoGainControl", v)}
                />
              </label>
            </div>
          </section>

          {/* 2. Applausometer & Stage */}
          <section className="space-y-2.5 rounded-2xl border border-border bg-background/60 p-3.5">
            <h3 className="flex items-center gap-2 font-semibold text-accent">
              <Volume2 className="size-4" />
              {t.settingsApplauseSection}
            </h3>

            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>{t.settingsDurationLabel}</span>
              <div className="flex gap-1.5" role="group" aria-label={t.settingsDurationLabel}>
                {([5, 10, 15] as ApplauseDurationSec[]).map((sec) => (
                  <Button
                    key={sec}
                    type="button"
                    size="sm"
                    data-testid={`settings-duration-${sec}`}
                    variant={settings.applauseDurationSec === sec ? "default" : "secondary"}
                    onClick={() => updateSetting("applauseDurationSec", sec)}
                  >
                    {sec} {t.settingsSeconds}
                  </Button>
                ))}
              </div>
            </div>

            {djBridge && (
              <>
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span>{t.settingsStageMode}</span>
                  <Switch
                    checked={djBridge.externalStage}
                    onCheckedChange={djBridge.onExternalStageChange}
                  />
                </label>

                <div className="space-y-2 text-sm">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{t.settingsStageVolume}</span>
                    <span className="tabular-nums">{volDraft ?? djBridge.control.volume}%</span>
                  </div>
                  <Slider
                    min={0}
                    max={100}
                    step={5}
                    value={[volDraft ?? djBridge.control.volume]}
                    onValueChange={(v) => setVolDraft(v[0] ?? null)}
                    onValueCommit={(v) => {
                      const nextVol = v[0] ?? 100;
                      setVolDraft(null);
                      djBridge.command("volume", nextVol).catch(() => toast.error(t.errGeneric));
                    }}
                  />
                </div>
              </>
            )}

            <label className="flex items-center justify-between gap-3 text-sm">
              <span>{t.settingsVoiceFallback}</span>
              <Switch
                checked={settings.stageVoiceFallback}
                onCheckedChange={(v) => updateSetting("stageVoiceFallback", v)}
              />
            </label>

            {djBridge && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={testingVoice}
                onClick={() => void testVoice()}
              >
                <Volume2 className="size-4" />
                {t.settingsTestVoiceBtn}
              </Button>
            )}
          </section>

          {/* 3. Language & Accessibility */}
          <section className="space-y-2.5 rounded-2xl border border-border bg-background/60 p-3.5">
            <h3 className="flex items-center gap-2 font-semibold text-accent">
              <Globe className="size-4" />
              {t.settingsPrefsSection}
            </h3>

            <div className="flex items-center justify-between gap-3 text-sm">
              <span>{t.settingsLanguage}</span>
              <div className="flex gap-1.5">
                {(["es", "de", "en"] as Lang[]).map((l) => (
                  <Button
                    key={l}
                    type="button"
                    size="sm"
                    data-testid={`settings-lang-${l}`}
                    variant={lang === l ? "default" : "secondary"}
                    onClick={() => {
                      if (djBridge) {
                        setLang(l, { skipRemote: true });
                        djBridge.command("lang", djBridge.control.volume, l).catch(() => {});
                      } else {
                        setLang(l);
                      }
                    }}
                    className="uppercase"
                  >
                    {l}
                  </Button>
                ))}
              </div>
            </div>

            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-1.5">
                <Sparkles className="size-4 text-primary" />
                {t.settingsReducedEffects}
              </span>
              <Switch
                data-testid="settings-reduced-effects"
                checked={settings.reducedEffects}
                onCheckedChange={(v) => updateSetting("reducedEffects", v)}
              />
            </label>
          </section>

          <div className="flex items-center justify-between gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setSettings(resetAppSettings());
                toast.success(t.settingsSaved);
              }}
            >
              <RotateCcw className="size-4" />
              {t.settingsResetBtn}
            </Button>
            <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
              {t.djClose}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
