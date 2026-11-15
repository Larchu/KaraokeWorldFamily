import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/api";
import {
  IDLE_APPLAUSE_STATE,
  shouldAcceptApplauseUpdate,
  type ApplauseStateSnapshot,
} from "@/lib/applause-meter";
import { defaultStageControl, type StageCommand, type StageControl } from "@/lib/stage-control";

export function useStageControl(enabled = true) {
  const [control, setControl] = useState<StageControl>(defaultStageControl);
  const [applause, setApplause] = useState<ApplauseStateSnapshot>(IDLE_APPLAUSE_STATE);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const [nextStage, nextApplause] = await Promise.all([
        apiJson<StageControl>("/api/dj/stage"),
        apiJson<ApplauseStateSnapshot>("/api/applause/state"),
      ]);
      setControl((old) => (nextStage.revision >= old.revision ? nextStage : old));
      setApplause((old) => {
        if (nextApplause.status === "idle") return nextApplause;
        if (!old.measurementId || old.measurementId !== nextApplause.measurementId) {
          return nextApplause.updatedAt >= old.updatedAt ? nextApplause : old;
        }
        return shouldAcceptApplauseUpdate(old, {
          measurementId: nextApplause.measurementId,
          requestId: nextApplause.requestId ?? "",
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
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();

    let source: EventSource | null = null;
    if (typeof EventSource !== "undefined") {
      source = new EventSource("/api/stream/stage", { withCredentials: true });
      source.onopen = () => setConnected(true);
      source.onerror = () => setConnected(false);
      source.addEventListener("stage_control", (e: MessageEvent) => {
        try {
          const next = JSON.parse(e.data) as StageControl;
          setControl((old) => (next.revision >= old.revision ? next : old));
          setConnected(true);
        } catch {
          /* ignore */
        }
      });
      source.addEventListener("applause_state", (e: MessageEvent) => {
        try {
          const next = JSON.parse(e.data) as ApplauseStateSnapshot;
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
          setConnected(true);
        } catch {
          /* ignore */
        }
      });
    }

    const timer = setInterval(() => {
      void refresh();
    }, 2500);

    return () => {
      source?.close();
      clearInterval(timer);
    };
  }, [enabled, refresh]);

  const command = useCallback(async (cmd: StageCommand, volume?: number) => {
    setBusy(true);
    try {
      const next = await apiJson<StageControl>("/api/dj/stage/command", {
        method: "POST",
        body: JSON.stringify({ command: cmd, volume: volume ?? 100 }),
      });
      setControl((old) => (next.revision >= old.revision ? next : old));
      setConnected(true);
    } finally {
      setBusy(false);
    }
  }, []);

  return { control, applause, command, connected, busy, refresh };
}
