export class ApiError extends Error {
  status: number;
  code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof data["reason"] === "string" ? data["reason"] : typeof data["error"] === "string" ? data["error"] : undefined;
    throw new ApiError(res.status, code ?? `HTTP ${res.status}`, code);
  }
  return data as T;
}

export interface VideoResult {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnail: string;
  duration: string;
}

export function extractYouTubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
      const v = url.searchParams.get("v");
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const parts = url.pathname.split("/").filter(Boolean);
      const idx = parts.findIndex((p) => p === "embed" || p === "shorts" || p === "live");
      if (idx >= 0 && parts[idx + 1] && /^[\w-]{11}$/.test(parts[idx + 1]!)) {
        return parts[idx + 1]!;
      }
    }
  } catch {
    return null;
  }
  return null;
}
