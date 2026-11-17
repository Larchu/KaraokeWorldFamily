import { useCallback, useEffect, useState } from "react";
import { apiJson, getDjToken } from "@/lib/api";
import {
  IDLE_APPLAUSE_STATE,
  shouldAcceptApplauseUpdate,
  type ApplauseStateSnapshot,
  type RoundEvaluationSummary,
} from "@/lib/applause-meter";
import { sortLeaderboard, type LeaderboardEntry } from "@/lib/singer";
import { defaultStageControl, type StageCommand, type StageControl } from "@/lib/stage-control";

interface LeaderboardEventPayload {
  period?: string;
  reason?: string;
  evaluation?: RoundEvaluationSummary | null;
  rows?: LeaderboardEntry[];
  topRankings?: LeaderboardEntry[];
}

export function useStageControl(enabled = true) {
  const [control, setControl] = useState<StageControl>(defaultStageControl);
  const [applause, setApplause] = useState<ApplauseStateSnapshot>(IDLE_APPLAUSE_STATE);
  const [topRankings, setTopRankings] = useState<LeaderboardEntry[]>([]);
  const [roundEvaluation, setRoundEvaluation] = useState<RoundEvaluationSummary | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);

  const applyLeaderboardRows = useCallback((rows: LeaderboardEntry[] | undefined) => {
    if (!rows) return;
    setTopRankings(sortLeaderboard(rows).slice(0, 5));
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const [nextStage, nextApplause, nextLb] = await Promise.all([
        apiJson<StageControl>("/api/dj/stage"),
        apiJson<ApplauseStateSnapshot>("/api/applause/state"),
        apiJson<{ rows: LeaderboardEntry[] }>("/api/leaderboard?period=night").catch(() => ({
          rows: undefined,
        })),
      ]);
      setControl((old) => (nextStage.revision >= old.revision ? nextStage : old));
      if (nextLb.rows) applyLeaderboardRows(nextLb.rows);
      setApplause((old) => {
        if (nextApplause.status === "idle") return nextApplause;
        if (!old.measurementId || old.measurementId !== nextApplause.measurementId) {
          return nextApplause.updatedAt >= old.updatedAt ? nextApplause : old;
        }
        if (
          nextApplause.likes !== old.likes &&
          nextApplause.updatedAt >= old.updatedAt
        ) {
          return nextApplause;
        }
        return shouldAcceptApplauseUpdate(old, {
          measurementId: nextApplause.measurementId,
          requestId: nextApplause.requestId ?? "",
          status: nextApplause.status,
          seq: nextApplause.lastSeq,
          updatedAt: nextApplause.updatedAt,
        })
          ? nextApplause
          : old;
      });
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, [enabled, applyLeaderboardRows]);

  useEffect(() => {
    if (!roundEvaluation) return;
    const timer = setTimeout(() => {
      setRoundEvaluation((curr) =>
        curr?.evaluatedAt === roundEvaluation.evaluatedAt ? null : curr,
      );
    }, 9500);
    return () => clearTimeout(timer);
  }, [roundEvaluation]);

  useEffect(() => {
    if (!enabled) return;
    let pollOk = false;
    let sseOk = false;

    const syncConnection = () => {
      setConnected(pollOk || sseOk);
    };

    const runPoll = async () => {
      try {
        const [nextStage, nextApplause, nextLb] = await Promise.all([
          apiJson<StageControl>("/api/dj/stage"),
          apiJson<ApplauseStateSnapshot>("/api/applause/state"),
          apiJson<{ rows: LeaderboardEntry[] }>("/api/leaderboard?period=night").catch(() => ({
            rows: undefined,
          })),
        ]);
        setControl((old) => (nextStage.revision >= old.revision ? nextStage : old));
        if (nextLb.rows) applyLeaderboardRows(nextLb.rows);
        setApplause((old) => {
          if (nextApplause.status === "idle") return nextApplause;
          if (!old.measurementId || old.measurementId !== nextApplause.measurementId) {
            return nextApplause.updatedAt >= old.updatedAt ? nextApplause : old;
          }
          if (
            nextApplause.likes !== old.likes &&
            nextApplause.updatedAt >= old.updatedAt
          ) {
            return nextApplause;
          }
          return shouldAcceptApplauseUpdate(old, {
            measurementId: nextApplause.measurementId,
            requestId: nextApplause.requestId ?? "",
            status: nextApplause.status,
            seq: nextApplause.lastSeq,
            updatedAt: nextApplause.updatedAt,
          })
            ? nextApplause
            : old;
        });
        pollOk = true;
      } catch {
        pollOk = false;
      }
      syncConnection();
    };

    void runPoll();

    let source: EventSource | null = null;
    if (typeof EventSource !== "undefined") {
      const djToken = getDjToken();
      const streamUrl = djToken
        ? `/api/stream/stage?djToken=${encodeURIComponent(djToken)}`
        : "/api/stream/stage";
      source = new EventSource(streamUrl, { withCredentials: true });
      source.onopen = () => {
        sseOk = true;
        syncConnection();
      };
      source.onerror = () => {
        sseOk = false;
        syncConnection();
      };
      source.addEventListener("stage_control", (e: MessageEvent) => {
        try {
          const next = JSON.parse(e.data) as StageControl;
          setControl((old) => (next.revision >= old.revision ? next : old));
          sseOk = true;
          syncConnection();
        } catch {
          /* ignore */
        }
      });
      source.addEventListener("applause_state", (e: MessageEvent) => {
        try {
          const next = JSON.parse(e.data) as ApplauseStateSnapshot;
          if (next.topRankings) {
            applyLeaderboardRows(next.topRankings);
          }
          setApplause((old) => {
            if (next.status === "idle") return next;
            if (next.status === "completed") return next;
            if (!old.measurementId || old.measurementId !== next.measurementId) {
              return next.updatedAt >= old.updatedAt ? next : old;
            }
            if (next.lastSeq >= old.lastSeq && next.updatedAt >= old.updatedAt) {
              return next;
            }
            return old;
          });
          sseOk = true;
          syncConnection();
        } catch {
          /* ignore */
        }
      });
      source.addEventListener("leaderboard_updated", (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data) as LeaderboardEventPayload;
          if (payload.topRankings ?? payload.rows) {
            applyLeaderboardRows(payload.topRankings ?? payload.rows);
          }
          if (payload.evaluation) {
            setRoundEvaluation(payload.evaluation);
          }
          sseOk = true;
          syncConnection();
        } catch {
          /* ignore */
        }
      });
    }

    const timer = setInterval(() => {
      void runPoll();
    }, 2500);

    let liveChannel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      liveChannel = new BroadcastChannel("pm-applause-live");
      liveChannel.onmessage = (e: MessageEvent) => {
        const msg = e.data as {
          type?: string;
          measurementId?: string;
          requestId?: string;
          seq?: number;
          latestLevel?: number;
          latestPeak?: number;
          latestBands?: number[];
          updatedAt?: number;
        } | null;
        if (!msg || msg.type !== "level" || !msg.measurementId || !msg.requestId) return;
        setApplause((old) => {
          if (old.status !== "measuring") return old;
          if (old.measurementId !== msg.measurementId || old.requestId !== msg.requestId) return old;
          if (typeof msg.seq === "number" && msg.seq <= old.lastSeq) return old;
          return {
            ...old,
            latestLevel: typeof msg.latestLevel === "number" ? msg.latestLevel : old.latestLevel,
            latestPeak:
              typeof msg.latestPeak === "number"
                ? Math.max(old.latestPeak, msg.latestPeak)
                : old.latestPeak,
            latestBands: Array.isArray(msg.latestBands) ? msg.latestBands : old.latestBands,
            lastSeq: typeof msg.seq === "number" ? msg.seq : old.lastSeq,
            updatedAt: typeof msg.updatedAt === "number" ? msg.updatedAt : Date.now(),
          };
        });
      };
    }

    return () => {
      source?.close();
      liveChannel?.close();
      clearInterval(timer);
    };
  }, [enabled, applyLeaderboardRows]);

  const command = useCallback(
    async (cmd: StageCommand, volume?: number, lang?: StageControl["lang"]) => {
      setBusy(true);
      try {
        const next = await apiJson<StageControl>("/api/dj/stage/command", {
          method: "POST",
          body: JSON.stringify({
            command: cmd,
            volume: volume ?? 100,
            ...(lang ? { lang } : {}),
          }),
        });
        setControl((old) => (next.revision >= old.revision ? next : old));
        setConnected(true);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return { control, applause, topRankings, roundEvaluation, command, connected, busy, refresh };
}
