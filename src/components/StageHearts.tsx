import { useCallback, useEffect, useRef, useState } from "react";
import { Heart, Star } from "lucide-react";
import { apiJson } from "@/lib/api";
import { playApplause } from "@/lib/applause";
import { useI18n } from "@/lib/i18n";
import { loadAppSettings } from "@/lib/settings";
import {
  STAGE_HEARTS_PER_LIKE,
  STAGE_STARS_PER_LIKE,
  consumeLikeTotal,
  createLikeTracker,
} from "@/lib/stage";

type Particle = {
  id: number;
  burstId: number;
  star: boolean;
  midX: number;
  midY: number;
  endX: number;
  endY: number;
  rot: number;
  delay: number;
  dur: number;
  size: number;
  color: number;
};

type FireworkSpark = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  alpha: number;
  decay: number;
  size: number;
  color: string;
  trail: Array<{ x: number; y: number }>;
};

type FireworkRocket = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetY: number;
  color: string;
  exploded: boolean;
};

const NEON_COLORS = [
  "#ff3d8b",
  "#2ee6ff",
  "#ffd93d",
  "#a855f7",
  "#34d399",
  "#ff7a2f",
  "#60a5fa",
];

const MAX_ACTIVE_PARTICLES = 400; // 5 concurrent bursts * 80 particles

function buildBurstParticles(burstId: number, nextId: () => number): Particle[] {
  const particles: Particle[] = [];
  const total = STAGE_HEARTS_PER_LIKE + STAGE_STARS_PER_LIKE;
  for (let i = 0; i < total; i++) {
    const star = i >= STAGE_HEARTS_PER_LIKE;
    // Fan wide across the entire stage downward (from top-right corner toward bottom-left..bottom-right)
    const spreadRatio = (i % 40) / 39; // 0..1 deterministic fan distribution + organic jitter
    const jitter = (Math.random() - 0.5) * 14;
    const endX = -88 * spreadRatio + 6 + jitter; // vw from top-right anchor
    const midX = endX * 0.52 + (Math.random() - 0.5) * 18;
    const midY = 24 + Math.random() * 24;
    const endY = 66 + Math.random() * 28;
    particles.push({
      id: nextId(),
      burstId,
      star,
      midX,
      midY,
      endX,
      endY,
      rot: (Math.random() - 0.5) * 760,
      delay: Math.random() * 650,
      dur: 2800 + Math.random() * 1700,
      size: 24 + Math.random() * 26,
      color: (star ? 4 : 0) + Math.floor(Math.random() * 4),
    });
  }
  return particles;
}

function prefersReducedMotion(): boolean {
  if (loadAppSettings().reducedEffects) return true;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function StageHearts({ requestId }: { requestId: string }) {
  const { t } = useI18n();
  const [count, setCount] = useState(0);
  const [parts, setParts] = useState<Particle[]>([]);
  const [reducedPulseKey, setReducedPulseKey] = useState(0);
  const [fireworkCount, setFireworkCount] = useState(0);
  const [burstCount, setBurstCount] = useState(0);

  const sequence = useRef(0);
  const burstSeq = useRef(0);
  const trackerRef = useRef(createLikeTracker());
  const pendingQueueRef = useRef<number>(0);
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Canvas firework refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rocketsRef = useRef<FireworkRocket[]>([]);
  const sparksRef = useRef<FireworkSpark[]>([]);
  const rafRef = useRef<number | null>(null);

  const launchFirework = useCallback(() => {
    setFireworkCount((c) => c + 1);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = canvas.width || window.innerWidth || 1280;
    const h = canvas.height || window.innerHeight || 720;

    // Launch from bottom-left corner arching diagonally upward toward stage center-left
    const rocket: FireworkRocket = {
      x: Math.max(24, w * 0.04),
      y: h - 18,
      vx: 3.4 + Math.random() * 3.8,
      vy: -(11.5 + Math.random() * 3.5),
      targetY: h * (0.22 + Math.random() * 0.24),
      color: NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)] ?? "#2ee6ff",
      exploded: false,
    };
    rocketsRef.current.push(rocket);
    if (rocketsRef.current.length > 12) {
      rocketsRef.current = rocketsRef.current.slice(-12);
    }

    if (rafRef.current !== null) return;

    const tick = () => {
      const c = canvasRef.current;
      if (!c) {
        rafRef.current = null;
        return;
      }
      const ctx = c.getContext("2d");
      if (!ctx) {
        rafRef.current = null;
        return;
      }

      ctx.clearRect(0, 0, c.width, c.height);

      const nextRockets: FireworkRocket[] = [];
      for (const r of rocketsRef.current) {
        r.x += r.vx;
        r.y += r.vy;
        r.vy += 0.16;

        ctx.save();
        ctx.beginPath();
        ctx.arc(r.x, r.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = r.color;
        ctx.shadowBlur = 16;
        ctx.shadowColor = r.color;
        ctx.fill();
        ctx.restore();

        if (!r.exploded && (r.y <= r.targetY || r.vy >= -1.2)) {
          r.exploded = true;
          const sparkCount = 46;
          for (let i = 0; i < sparkCount; i++) {
            const angle = (Math.PI * 2 * i) / sparkCount + (Math.random() - 0.5) * 0.16;
            const speed = 2.4 + Math.random() * 5.6;
            const color =
              i % 3 === 0
                ? r.color
                : (NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)] ?? r.color);
            sparksRef.current.push({
              x: r.x,
              y: r.y,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed,
              alpha: 1,
              decay: 0.014 + Math.random() * 0.012,
              size: 2.2 + Math.random() * 2.4,
              color,
              trail: [],
            });
          }
          if (sparksRef.current.length > 420) {
            sparksRef.current = sparksRef.current.slice(-420);
          }
        } else if (!r.exploded) {
          nextRockets.push(r);
        }
      }
      rocketsRef.current = nextRockets;

      const nextSparks: FireworkSpark[] = [];
      for (const s of sparksRef.current) {
        s.trail.push({ x: s.x, y: s.y });
        if (s.trail.length > 5) s.trail.shift();
        s.x += s.vx;
        s.y += s.vy;
        s.vx *= 0.982;
        s.vy = s.vy * 0.982 + 0.07;
        s.alpha -= s.decay;

        if (s.alpha > 0.02) {
          ctx.save();
          ctx.globalAlpha = Math.max(0, s.alpha);
          ctx.strokeStyle = s.color;
          ctx.fillStyle = s.color;
          ctx.shadowBlur = 12;
          ctx.shadowColor = s.color;
          ctx.lineWidth = s.size * 0.75;
          if (s.trail.length > 1) {
            ctx.beginPath();
            ctx.moveTo(s.trail[0]!.x, s.trail[0]!.y);
            for (let k = 1; k < s.trail.length; k++) {
              ctx.lineTo(s.trail[k]!.x, s.trail[k]!.y);
            }
            ctx.lineTo(s.x, s.y);
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          nextSparks.push(s);
        }
      }
      sparksRef.current = nextSparks;

      if (rocketsRef.current.length > 0 || sparksRef.current.length > 0) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        ctx.clearRect(0, 0, c.width, c.height);
        rafRef.current = null;
      }
    };

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const triggerSingleLikeEffect = useCallback(() => {
    playApplause();
    setBurstCount((c) => c + 1);

    if (prefersReducedMotion()) {
      setReducedPulseKey((k) => k + 1);
      setFireworkCount((c) => c + 1);
      return;
    }

    const burstId = ++burstSeq.current;
    const fresh = buildBurstParticles(burstId, () => ++sequence.current);
    setParts((prev) => [...prev.slice(-(MAX_ACTIVE_PARTICLES - fresh.length)), ...fresh]);

    // Trigger bottom-left neon firework from the exact same processed like event
    launchFirework();

    // Fallback cleanup timer so particles never leak even if animationend doesn't fire (e.g. background tab)
    const cleanupTimer = setTimeout(() => {
      cleanupTimersRef.current.delete(cleanupTimer);
      setParts((prev) => prev.filter((p) => p.burstId !== burstId));
    }, 5500);
    cleanupTimersRef.current.add(cleanupTimer);
  }, [launchFirework]);

  const scheduleDrain = useCallback(() => {
    if (drainTimerRef.current !== null || pendingQueueRef.current <= 0) return;

    const step = () => {
      drainTimerRef.current = null;
      if (pendingQueueRef.current <= 0) return;
      pendingQueueRef.current -= 1;
      triggerSingleLikeEffect();
      if (pendingQueueRef.current > 0) {
        drainTimerRef.current = setTimeout(step, 180);
      }
    };

    // Fire the first like effect immediately without delay
    step();
  }, [triggerSingleLikeEffect]);

  const enqueueIncomingTotal = useCallback(
    (incomingTotal: number, isInitial: boolean) => {
      const { delta, total } = consumeLikeTotal(trackerRef.current, incomingTotal, {
        isInitialSnapshot: isInitial,
      });
      setCount(total);
      if (delta > 0) {
        pendingQueueRef.current += delta;
        scheduleDrain();
      }
    },
    [scheduleDrain],
  );

  useEffect(() => {
    const syncSize = () => {
      const c = canvasRef.current;
      if (!c) return;
      c.width = window.innerWidth;
      c.height = window.innerHeight;
    };
    syncSize();
    window.addEventListener("resize", syncSize);
    return () => window.removeEventListener("resize", syncSize);
  }, []);

  useEffect(() => {
    let alive = true;
    let initialLoaded = false;
    trackerRef.current = createLikeTracker();
    pendingQueueRef.current = 0;
    setCount(0);
    setParts([]);
    setBurstCount(0);
    setFireworkCount(0);

    const refresh = async () => {
      try {
        const data = await apiJson<{ counts: Array<{ request_id: string; likes: number }> }>(
          `/api/likes/counts?ids=${encodeURIComponent(requestId)}`,
        );
        if (!alive) return;
        const total = Number(data.counts?.[0]?.likes ?? 0);
        const wasInitial = !initialLoaded;
        initialLoaded = true;
        enqueueIncomingTotal(total, wasInitial);
      } catch {
        /* ignore transient errors */
      }
    };

    void refresh();

    let source: EventSource | null = null;
    if (typeof EventSource !== "undefined") {
      source = new EventSource("/api/stream/queue", { withCredentials: true });
      source.addEventListener("like_changed", (e: MessageEvent) => {
        if (!alive) return;
        try {
          const payload = JSON.parse(e.data) as { requestId?: string; likes?: number };
          if (payload.requestId === requestId && typeof payload.likes === "number") {
            const wasInitial = !initialLoaded;
            initialLoaded = true;
            enqueueIncomingTotal(payload.likes, wasInitial);
          }
        } catch {
          /* ignore */
        }
      });
      source.onopen = () => {
        if (alive && initialLoaded) void refresh();
      };
    }

    const interval = setInterval(() => {
      if (alive) void refresh();
    }, 2500);

    return () => {
      alive = false;
      source?.close();
      clearInterval(interval);
      if (drainTimerRef.current) {
        clearTimeout(drainTimerRef.current);
        drainTimerRef.current = null;
      }
      for (const timer of cleanupTimersRef.current) {
        clearTimeout(timer);
      }
      cleanupTimersRef.current.clear();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      rocketsRef.current = [];
      sparksRef.current = [];
    };
  }, [requestId, enqueueIncomingTotal]);

  const remove = (id: number) => setParts((p) => p.filter((n) => n.id !== id));

  return (
    <>
      <canvas
        ref={canvasRef}
        data-testid="stage-firework-canvas"
        data-firework-launches={fireworkCount}
        className="pointer-events-none absolute inset-0 z-20 size-full"
        aria-hidden="true"
      />
      <div
        data-testid="stage-hearts-swarm"
        data-burst-count={burstCount}
        className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
        aria-hidden="true"
      >
        {parts.map((p) => {
          const Icon = p.star ? Star : Heart;
          return (
            <Icon
              key={p.id}
              data-testid={p.star ? "stage-star-particle" : "stage-heart-particle"}
              data-burst-id={p.burstId}
              className={`stage-swarm swarm-c${p.color} fill-current`}
              onAnimationEnd={() => remove(p.id)}
              style={{
                width: p.size,
                height: p.size,
                ["--mid-x" as string]: `${p.midX}vw`,
                ["--mid-y" as string]: `${p.midY}vh`,
                ["--end-x" as string]: `${p.endX}vw`,
                ["--end-y" as string]: `${p.endY}vh`,
                ["--rot" as string]: `${p.rot}deg`,
                ["--delay" as string]: `${p.delay}ms`,
                ["--dur" as string]: `${p.dur}ms`,
              }}
            />
          );
        })}
      </div>
      {reducedPulseKey > 0 && (
        <div
          key={reducedPulseKey}
          data-testid="stage-reduced-like-emblem"
          className="stage-reduced-emblem pointer-events-none absolute bottom-10 left-8 z-20 flex items-center gap-2 rounded-2xl border border-primary/60 bg-background/90 px-4 py-2 text-primary neon-border"
          aria-hidden="true"
        >
          <Heart className="size-6 fill-current" />
          <Star className="size-6 fill-current text-accent" />
          <span className="font-display text-lg">+1</span>
        </div>
      )}
      <div className="pointer-events-none absolute right-6 top-20 z-20 text-primary">
        <div
          data-testid="stage-like-count"
          className="flex items-center gap-3 rounded-lg border border-primary/40 bg-background/90 px-5 py-3"
          aria-label={t.likes}
        >
          <Heart className="size-7 fill-current" />
          <span className="text-2xl font-bold tabular-nums">{count}</span>
        </div>
      </div>
    </>
  );
}
