import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiJson } from "@/lib/api";
import {
  APPLAUSE_DURATION_MS,
  APPLAUSE_MIN_SAMPLES,
  computeApplauseScore,
  computeRmsFromFloatSamples,
  normalizeRmsLevel,
  remainingApplauseSeconds,
  smoothLevel,
  type ApplauseStateSnapshot,
} from "@/lib/applause-meter";

export type RecorderPhase = "idle" | "preparing" | "measuring" | "saving";
export type RecorderErrorCode =
  | "unsupported"
  | "permission"
  | "no_mic"
  | "busy"
  | "unauthorized"
  | "network"
  | "insufficient"
  | null;

export interface CompletedMeasurement {
  requestId: string;
  measurementId: string;
  score: number;
  likes: number;
  totalPoints: number;
}

export function useApplauseRecorder(options?: {
  onCompleted?: (result: CompletedMeasurement) => void;
  onUnauthorized?: () => void;
}) {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [liveLevel, setLiveLevel] = useState(0);
  const [peakLevel, setPeakLevel] = useState(0);
  const [remainingSec, setRemainingSec] = useState(10);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<RecorderErrorCode>(null);

  const phaseRef = useRef<RecorderPhase>("idle");
  const cleanupRef = useRef<() => void>(() => {});
  const onCompletedRef = useRef(options?.onCompleted);
  const onUnauthRef = useRef(options?.onUnauthorized);
  onCompletedRef.current = options?.onCompleted;
  onUnauthRef.current = options?.onUnauthorized;

  const setPhaseSync = (next: RecorderPhase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  useEffect(() => {
    return () => {
      cleanupRef.current();
    };
  }, []);

  const cancel = useCallback(async () => {
    cleanupRef.current();
  }, []);

  const start = useCallback(async (requestId: string): Promise<boolean> => {
    if (phaseRef.current !== "idle") {
      setErrorCode("busy");
      return false;
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setErrorCode("unsupported");
      return false;
    }

    setErrorCode(null);
    setLiveLevel(0);
    setPeakLevel(0);
    setRemainingSec(10);
    setActiveRequestId(requestId);
    setPhaseSync("preparing");

    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let sampleTimer: ReturnType<typeof setInterval> | null = null;
    let finishTimer: ReturnType<typeof setTimeout> | null = null;
    let cleaned = false;

    const measurementId = crypto.randomUUID();
    let startedOnServer = false;

    const teardownMedia = () => {
      if (sampleTimer) {
        clearInterval(sampleTimer);
        sampleTimer = null;
      }
      if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = null;
      }
      try {
        source?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        analyser?.disconnect();
      } catch {
        /* ignore */
      }
      if (stream) {
        for (const track of stream.getTracks()) {
          track.onended = null;
          track.stop();
        }
        stream = null;
      }
      if (audioCtx) {
        audioCtx.close().catch(() => {});
        audioCtx = null;
      }
    };

    const fullCancel = async (reason: "cancelled" | "failed" = "cancelled") => {
      if (cleaned) return;
      cleaned = true;
      teardownMedia();
      if (startedOnServer) {
        await apiJson("/api/applause/cancel", {
          method: "POST",
          body: JSON.stringify({ measurementId, requestId, reason }),
        }).catch(() => {});
      }
      setPhaseSync("idle");
      setActiveRequestId(null);
      setLiveLevel(0);
    };

    cleanupRef.current = () => {
      void fullCancel("cancelled");
    };

    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
          },
        });
      } catch (err) {
        // Retry with minimal constraint if specific audio processing flags are unsupported
        const name = err instanceof Error ? err.name : "";
        if (name === "OverconstrainedError" || name === "TypeError") {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw err;
        }
      }

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0 || audioTracks[0]?.readyState === "ended") {
        throw Object.assign(new Error("no_mic"), { name: "NotFoundError" });
      }

      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx = new Ctx();
      if (audioCtx.state === "suspended") {
        await audioCtx.resume();
      }
      source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      // Verify microphone pipeline yields readable frames before starting the 10-second clock
      const timeDomain = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(timeDomain);

      // Start authoritative server measurement ONLY AFTER mic is live and ready
      const startRes = await apiJson<{ ok: boolean; state: ApplauseStateSnapshot }>(
        "/api/applause/start",
        {
          method: "POST",
          body: JSON.stringify({
            requestId,
            measurementId,
            durationMs: APPLAUSE_DURATION_MS,
          }),
        },
      );
      startedOnServer = true;

      const serverEndsAt = startRes.state.endsAt ?? Date.now() + APPLAUSE_DURATION_MS;
      const localEndsAt = Date.now() + APPLAUSE_DURATION_MS;
      setPhaseSync("measuring");

      const rawSamples: number[] = [];
      let smoothed = 0;
      let peak = 0;
      let seq = 0;
      let inFlightLevel = false;

      audioTracks[0]!.onended = () => {
        setErrorCode("no_mic");
        void fullCancel("failed");
      };

      // ~15 Hz frame sampling over exact 10-second window (NO raw audio stored/sent)
      sampleTimer = setInterval(() => {
        if (cleaned || !analyser) return;
        analyser.getFloatTimeDomainData(timeDomain);
        const rms = computeRmsFromFloatSamples(timeDomain);
        const norm = normalizeRmsLevel(rms);
        smoothed = smoothLevel(smoothed, norm, 0.35);
        peak = Math.max(peak, norm);
        rawSamples.push(norm);

        setLiveLevel(smoothed);
        setPeakLevel(peak);
        setRemainingSec(remainingApplauseSeconds(localEndsAt, Date.now()));

        seq += 1;
        if (!inFlightLevel) {
          inFlightLevel = true;
          apiJson("/api/applause/level", {
            method: "POST",
            body: JSON.stringify({
              measurementId,
              requestId,
              seq,
              level: smoothed,
              peak,
            }),
          })
            .catch((err) => {
              if (err instanceof ApiError && err.status === 401) {
                setErrorCode("unauthorized");
                onUnauthRef.current?.();
                void fullCancel("failed");
              }
            })
            .finally(() => {
              inFlightLevel = false;
            });
        }
      }, 66);

      finishTimer = setTimeout(async () => {
        if (cleaned) return;
        cleaned = true;
        teardownMedia();
        setPhaseSync("saving");

        if (rawSamples.length < APPLAUSE_MIN_SAMPLES) {
          setErrorCode("insufficient");
          await apiJson("/api/applause/cancel", {
            method: "POST",
            body: JSON.stringify({ measurementId, requestId, reason: "failed" }),
          }).catch(() => {});
          setPhaseSync("idle");
          setActiveRequestId(null);
          return;
        }

        try {
          const completed = await apiJson<{
            ok: boolean;
            state: ApplauseStateSnapshot;
            breakdown: ReturnType<typeof computeApplauseScore>;
          }>("/api/applause/complete", {
            method: "POST",
            body: JSON.stringify({
              measurementId,
              requestId,
              samples: rawSamples,
            }),
          });
          setPhaseSync("idle");
          setActiveRequestId(null);
          setLiveLevel(0);
          onCompletedRef.current?.({
            requestId,
            measurementId,
            score: completed.state.score ?? completed.breakdown.score,
            likes: completed.state.likes,
            totalPoints: completed.state.totalPoints ?? completed.breakdown.score,
          });
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            setErrorCode("unauthorized");
            onUnauthRef.current?.();
          } else {
            setErrorCode("network");
          }
          setPhaseSync("idle");
          setActiveRequestId(null);
        }
      }, Math.max(1000, serverEndsAt ? Math.min(APPLAUSE_DURATION_MS, Math.max(1000, localEndsAt - Date.now())) : APPLAUSE_DURATION_MS));

      return true;
    } catch (err) {
      teardownMedia();
      if (startedOnServer) {
        await apiJson("/api/applause/cancel", {
          method: "POST",
          body: JSON.stringify({ measurementId, requestId, reason: "failed" }),
        }).catch(() => {});
      }
      setPhaseSync("idle");
      setActiveRequestId(null);

      if (err instanceof ApiError) {
        if (err.status === 401) {
          setErrorCode("unauthorized");
          onUnauthRef.current?.();
        } else if (err.status === 409) {
          setErrorCode("busy");
        } else {
          setErrorCode("network");
        }
        return false;
      }

      const name = err instanceof Error ? err.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
        setErrorCode("permission");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setErrorCode("no_mic");
      } else {
        setErrorCode("network");
      }
      return false;
    }
  }, []);

  return {
    phase,
    liveLevel,
    peakLevel,
    remainingSec,
    activeRequestId,
    errorCode,
    start,
    cancel,
    clearError: () => setErrorCode(null),
  };
}
