import { GoogleGenAI, Type } from "@google/genai";
import { formatIsoDuration, normalizeQuery } from "../src/lib/queue.ts";

export interface VideoResult {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnail: string;
  duration: string;
}

const ytCache = new Map<string, { at: number; data: VideoResult[] }>();
const YT_TTL = 10 * 60 * 1000;

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function fetchJson(url: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.status === 403 || res.status === 429) throw new Error("quota");
    if (!res.ok) throw new Error(`youtube_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function searchYouTubeServer(
  rawQuery: string,
): Promise<{ results: VideoResult[]; error: "config" | "quota" | "unavailable" | null }> {
  const apiKey = process.env["YOUTUBE_API_KEY"]?.trim();
  if (!apiKey) {
    return { results: [], error: "config" };
  }

  try {
    const q = normalizeQuery(rawQuery).slice(0, 150);
    const cacheKey = q.toLowerCase();
    const hit = ytCache.get(cacheKey);
    if (hit && Date.now() - hit.at < YT_TTL) {
      return { results: hit.data, error: null };
    }

    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      maxResults: "12",
      q,
      key: apiKey,
    });
    const search = await fetchJson(`https://www.googleapis.com/youtube/v3/search?${params}`);
    const items = (search.items ?? []) as Array<{
      id: { videoId: string };
      snippet: {
        title: string;
        channelTitle: string;
        thumbnails: Record<string, { url: string }>;
      };
    }>;

    const ids = items.map((i) => i.id.videoId).filter(Boolean);
    const durations = new Map<string, string>();
    if (ids.length) {
      const vp = new URLSearchParams({ part: "contentDetails", id: ids.join(","), key: apiKey });
      const vids = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?${vp}`);
      for (const v of vids.items ?? []) {
        durations.set(v.id, formatIsoDuration(v.contentDetails?.duration ?? ""));
      }
    }

    const data: VideoResult[] = items.map((i) => ({
      videoId: i.id.videoId,
      title: decodeHtml(i.snippet.title),
      channelTitle: decodeHtml(i.snippet.channelTitle),
      thumbnail:
        i.snippet.thumbnails?.["medium"]?.url ??
        i.snippet.thumbnails?.["default"]?.url ??
        "",
      duration: durations.get(i.id.videoId) ?? "",
    }));

    if (ytCache.size >= 100) {
      const firstKey = ytCache.keys().next().value;
      if (firstKey) ytCache.delete(firstKey);
    }
    ytCache.set(cacheKey, { at: Date.now(), data });
    return { results: data, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    console.error("[youtube] search failed:", msg);
    return { results: [], error: msg === "quota" ? "quota" : "unavailable" };
  }
}

const AI_SYSTEM = `You help karaoke bar guests find songs on YouTube.
The guest describes a song: a title, an artist, or remembered lyric fragments (any language, may contain typos).
Identify the most likely song(s) and return up to 4 concise YouTube search queries, each formatted as "Artist - Title karaoke".
Order by likelihood. If uncertain, include alternative candidate songs. Never invent nonsense; if nothing fits, return an empty list.`;

export async function suggestSongsServer(
  text: string,
): Promise<{ queries: string[]; error: "config" | "rate" | "unavailable" | null }> {
  const geminiKey = process.env["GEMINI_API_KEY"]?.trim();
  if (!geminiKey) {
    return { queries: [], error: "config" };
  }

  try {
    const ai = new GoogleGenAI({ apiKey: geminiKey });
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: text,
      config: {
        systemInstruction: AI_SYSTEM,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            queries: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ["queries"],
        },
      },
    });
    const parsed = JSON.parse(response.text ?? "{}") as { queries?: unknown };
    const queries = Array.isArray(parsed.queries)
      ? parsed.queries.filter((q): q is string => typeof q === "string").slice(0, 4)
      : [];
    return { queries, error: null };
  } catch (err) {
    const status = (err as { status?: number })?.status;
    console.error("[ai-suggest] Gemini failed:", err instanceof Error ? err.message : err);
    if (status === 429) return { queries: [], error: "rate" };
    return { queries: [], error: "unavailable" };
  }
}

export async function announceTtsServer(
  text: string,
): Promise<{ audio: string | null; configured: boolean }> {
  const key = process.env["ELEVENLABS_API_KEY"]?.trim();
  const voice = process.env["ELEVENLABS_VOICE_ID"]?.trim() || "nPczCjzI2devNBz1zQrb";
  if (!key || !voice) {
    return { audio: null, configured: false };
  }

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.8,
            style: 0.6,
            use_speaker_boost: true,
          },
        }),
      },
    );
    if (!res.ok) {
      console.error(`[tts] ElevenLabs failed [${res.status}]: ${await res.text()}`);
      return { audio: null, configured: true };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { audio: buf.toString("base64"), configured: true };
  } catch (err) {
    console.error("[tts] ElevenLabs error:", err instanceof Error ? err.message : err);
    return { audio: null, configured: true };
  }
}
