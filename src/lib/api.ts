const DJ_TOKEN_KEY = "pm-dj-token";
const SINGER_TOKEN_KEY = "pm-singer-token";

export class ApiError extends Error {
  status: number;
  code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function readStorage(key: string): string | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (value) {
      window.localStorage.setItem(key, value);
      window.sessionStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
      window.sessionStorage.removeItem(key);
    }
  } catch {
    /* ignore storage quota or private mode failures */
  }
}

export function getDjToken(): string | null {
  return readStorage(DJ_TOKEN_KEY);
}

export function setDjToken(token: string | null): void {
  writeStorage(DJ_TOKEN_KEY, token);
}

export function getSingerToken(): string | null {
  return readStorage(SINGER_TOKEN_KEY);
}

export function setSingerToken(token: string | null): void {
  writeStorage(SINGER_TOKEN_KEY, token);
}

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const djToken = getDjToken();
  const singerToken = getSingerToken();
  const headers: Record<string, string> = {};
  if (init?.body) headers["Content-Type"] = "application/json";
  if (djToken) headers["Authorization"] = `Bearer ${djToken}`;
  if (singerToken) headers["X-Singer-Token"] = singerToken;

  const res = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      ...headers,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 401) {
      if (
        url.startsWith("/api/dj/") ||
        url.startsWith("/api/applause/") ||
        url.startsWith("/api/tts/")
      ) {
        setDjToken(null);
      } else if (url.startsWith("/api/account") || url.startsWith("/api/favorites")) {
        setSingerToken(null);
      }
    }
    const code =
      typeof data["reason"] === "string"
        ? data["reason"]
        : typeof data["error"] === "string"
          ? data["error"]
          : undefined;
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
