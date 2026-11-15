import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/api";
import type { SongRequest } from "@/lib/queue";

/** Live list of tonight's requests (last 12h), kept fresh via SSE + fallback sync. */
export function useQueue() {
  const [rows, setRows] = useState<SongRequest[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiJson<{ rows: SongRequest[] }>("/api/queue");
      setRows(data.rows ?? []);
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();

    let source: EventSource | null = null;
    if (typeof EventSource !== "undefined") {
      source = new EventSource("/api/stream/queue", { withCredentials: true });
      source.addEventListener("queue_changed", () => {
        void load();
      });
      source.addEventListener("like_changed", (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data) as { requestId: string; likes: number };
          setRows((prev) =>
            prev.map((r) =>
              r.id === payload.requestId ? { ...r, likes_count: payload.likes } : r,
            ),
          );
        } catch {
          /* ignore */
        }
      });
    }

    const fallback = setInterval(() => {
      void load();
    }, 8000);

    return () => {
      source?.close();
      clearInterval(fallback);
    };
  }, [load]);

  return { rows, setRows, loaded, reload: load };
}
