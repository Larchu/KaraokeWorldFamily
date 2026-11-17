import { useEffect, useRef, useState } from "react";
import { ExternalLink, Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

type Player = {
  destroy: () => void;
  playVideo: () => void;
  pauseVideo: () => void;
  setVolume: (v: number) => void;
  mute?: () => void;
  unMute?: () => void;
  seekTo: (s: number, allow: boolean) => void;
};

export type VideoControl = { paused: boolean; volume: number; restart_revision: number };

type Youtube = { Player: new (element: HTMLElement, options: Record<string, unknown>) => Player };

let apiPromise: Promise<Youtube> | undefined;

function youtubeApi(): Promise<Youtube> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const w = window as typeof window & { YT?: Youtube; onYouTubeIframeAPIReady?: () => void };
    if (w.YT?.Player) {
      resolve(w.YT);
      return;
    }
    const previous = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (w.YT) resolve(w.YT);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => {
      apiPromise = undefined;
      reject(new Error("YouTube unavailable"));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

function isTopLevelWindow(): boolean {
  try {
    return typeof window !== "undefined" && window.self === window.top;
  } catch {
    return false;
  }
}

export function StageVideo({
  videoId,
  title,
  onEnded,
  control,
  mutedForApplause = false,
}: {
  videoId: string;
  title: string;
  onEnded: () => void;
  control?: VideoControl;
  mutedForApplause?: boolean;
}) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const nocookieFrame = useRef<HTMLIFrameElement>(null);
  const player = useRef<Player | null>(null);
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const titleRef = useRef(title);
  titleRef.current = title;

  const [paused, setPaused] = useState(false);
  const [errorCode, setErrorCode] = useState<number | "timeout" | null>(null);
  const [mode, setMode] = useState<"ytapi" | "nocookie">("ytapi");
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const ctl = useRef(control);
  ctl.current = control;
  const mutedRef = useRef(mutedForApplause);
  mutedRef.current = mutedForApplause;
  const restartSeen = useRef(control?.restart_revision ?? 0);

  // Sync DJ controls in JS API mode
  useEffect(() => {
    if (mode !== "ytapi") return;
    const p = player.current;
    if (!ready || !p || !control) return;
    if (mutedForApplause) {
      p.setVolume(0);
      p.mute?.();
      p.pauseVideo();
      return;
    }
    p.unMute?.();
    p.setVolume(control.volume);
    if (control.restart_revision !== restartSeen.current) {
      restartSeen.current = control.restart_revision;
      p.seekTo(0, true);
    }
    if (control.paused) p.pauseVideo();
    else p.playVideo();
  }, [mode, ready, control?.paused, control?.volume, control?.restart_revision, mutedForApplause]);

  // Sync DJ controls via postMessage in nocookie fallback mode
  useEffect(() => {
    if (mode !== "nocookie") return;
    const win = nocookieFrame.current?.contentWindow;
    if (!win || !control) return;
    const post = (func: string, args: unknown[] = []) => {
      win.postMessage(JSON.stringify({ event: "command", func, args }), "*");
    };
    if (mutedForApplause) {
      post("setVolume", [0]);
      post("mute");
      post("pauseVideo");
      return;
    }
    post("unMute");
    post("setVolume", [control.volume]);
    if (control.restart_revision !== restartSeen.current) {
      restartSeen.current = control.restart_revision;
      post("seekTo", [0, true]);
    }
    if (control.paused) post("pauseVideo");
    else post("playVideo");
  }, [mode, control?.paused, control?.volume, control?.restart_revision, mutedForApplause]);

  // Listen for end/error events when running in nocookie iframe fallback mode
  useEffect(() => {
    if (mode !== "nocookie") return;
    const onMsg = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      if (
        e.origin !== "https://www.youtube-nocookie.com" &&
        e.origin !== "https://www.youtube.com"
      ) {
        return;
      }
      if (!nocookieFrame.current || e.source !== nocookieFrame.current.contentWindow) return;
      try {
        const d = JSON.parse(e.data) as {
          event?: string;
          info?: number | { playerState?: number };
        };
        if (d.event === "onStateChange") {
          const state = typeof d.info === "number" ? d.info : d.info?.playerState;
          if (state === 0) ended.current();
          if (state === 2 || state === -1 || state === 5) setPaused(true);
          if (state === 1) setPaused(false);
        } else if (d.event === "infoDelivery" && typeof d.info === "object" && d.info?.playerState === 0) {
          ended.current();
        } else if (d.event === "onError" && typeof d.info === "number") {
          setErrorCode(d.info);
        }
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [mode]);

  useEffect(() => {
    setMode("ytapi");
    setErrorCode(null);
  }, [videoId]);

  useEffect(() => {
    if (mode !== "ytapi") return;
    let alive = true;
    let completed = false;
    let instance: Player | null = null;
    setErrorCode(null);
    setPaused(false);
    setReady(false);
    const element = document.createElement("div");
    host.current?.appendChild(element);
    const timeout = setTimeout(() => {
      if (alive && !player.current) {
        setMode("nocookie");
      }
    }, 10000);

    youtubeApi()
      .then((yt) => {
        if (!alive) return;
        const playerVars: Record<string, string | number> = {
          autoplay: 1,
          playsinline: 1,
          rel: 0,
          enablejsapi: 1,
        };
        // Avoid sending origin inside nested cross-origin preview iframes where origin checks can trigger Error 153
        if (isTopLevelWindow()) {
          playerVars.origin = window.location.origin;
        }
        instance = new yt.Player(element, {
          host: "https://www.youtube.com",
          videoId,
          width: "100%",
          height: "100%",
          playerVars,
          events: {
            onReady: (event: { target: Player }) => {
              clearTimeout(timeout);
              const c = ctl.current;
              if (mutedRef.current) {
                event.target.setVolume(0);
                event.target.mute?.();
                event.target.pauseVideo();
              } else {
                if (c) event.target.setVolume(c.volume);
                if (!c?.paused) event.target.playVideo();
              }
              if (alive) setReady(true);
            },
            onStateChange: (event: { data: number }) => {
              if (!alive) return;
              setPaused(event.data === 2 || event.data === -1 || event.data === 5);
              if (event.data === 0 && !completed) {
                completed = true;
                ended.current();
              }
            },
            onAutoplayBlocked: () => {
              if (alive) setPaused(true);
            },
            onError: (event: { data?: number }) => {
              if (!alive) return;
              clearTimeout(timeout);
              const code = typeof event?.data === "number" ? event.data : 0;
              // Auto-fallback to youtube-nocookie iframe on Error 153 (Referer/origin check), 2, 5, or 0
              if (code === 153 || code === 5 || code === 2 || code === 0) {
                setMode("nocookie");
              } else {
                setErrorCode(code);
              }
            },
          },
        });
        player.current = instance;
        const iframe = host.current?.querySelector("iframe");
        if (iframe) {
          iframe.setAttribute("title", titleRef.current);
          iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
          iframe.setAttribute(
            "allow",
            "autoplay; encrypted-media; fullscreen; picture-in-picture",
          );
        }
      })
      .catch(() => {
        if (alive) setMode("nocookie");
      });

    return () => {
      alive = false;
      clearTimeout(timeout);
      instance?.destroy();
      player.current = null;
      element.remove();
    };
  }, [videoId, attempt, mode]);

  const nocookieUrl = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&playsinline=1&rel=0&enablejsapi=1`;

  return (
    <div className="absolute inset-0 bg-background">
      {mode === "ytapi" ? (
        <div ref={host} className="stage-video absolute inset-0" />
      ) : (
        <iframe
          key={`${videoId}-${attempt}-nc`}
          ref={nocookieFrame}
          className="stage-video absolute inset-0 size-full border-0"
          src={nocookieUrl}
          referrerPolicy="strict-origin-when-cross-origin"
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          title={title}
          onLoad={(e) => {
            e.currentTarget.contentWindow?.postMessage(
              JSON.stringify({ event: "listening" }),
              "*",
            );
          }}
        />
      )}

      {errorCode !== null ? (
        <div
          data-testid="stage-video-error"
          className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-background/95 px-6 text-center"
        >
          <p className="max-w-lg text-xl">{t.stageVideoError}</p>
          <p className="text-xs text-muted-foreground">
            {errorCode === "timeout" ? "YouTube Player Timeout" : `YouTube #${errorCode}`}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button
              onClick={() => {
                setErrorCode(null);
                setMode("ytapi");
                setAttempt((n) => n + 1);
              }}
            >
              <RotateCcw className="size-5" />
              {t.stageRetry}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setErrorCode(null);
                setMode("nocookie");
                setAttempt((n) => n + 1);
              }}
            >
              {t.stageAlternativeEmbed}
            </Button>
            <Button asChild variant="outline">
              <a
                href={`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="size-4" />
                {t.stageOpenYoutube}
              </a>
            </Button>
          </div>
        </div>
      ) : (
        mode === "ytapi" && (
          <Button
            size="icon"
            variant="secondary"
            className={`stage-media-control absolute bottom-24 right-6 size-12 ${
              paused ? "opacity-100" : "opacity-0 focus:opacity-100"
            }`}
            title={paused ? t.stageResume : t.stagePause}
            aria-label={paused ? t.stageResume : t.stagePause}
            onClick={() => (paused ? player.current?.playVideo() : player.current?.pauseVideo())}
          >
            {paused ? <Play /> : <Pause />}
          </Button>
        )
      )}
    </div>
  );
}
