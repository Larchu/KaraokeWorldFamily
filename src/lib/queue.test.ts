import { describe, expect, it } from "vitest";
import {
  durationToSeconds,
  formatIsoDuration,
  normalizeQuery,
  playOrder,
  waitInfo,
  type SongRequest,
} from "./queue";

const row = (partial: Partial<SongRequest>): SongRequest => ({
  id: partial.id ?? "1",
  user_id: null,
  singer_name: "Ana",
  song_title: "Song",
  video_id: "vid12345678",
  channel_title: null,
  thumbnail_url: null,
  duration: partial.duration ?? "4:00",
  status: partial.status ?? "waiting",
  position: partial.position ?? 1000,
  created_at: partial.created_at ?? "2026-01-01T20:00:00Z",
  updated_at: partial.updated_at ?? "2026-01-01T20:00:00Z",
});

describe("queue helpers", () => {
  it("orders active entries playing -> next -> waiting by position", () => {
    const list = [
      row({ id: "w2", status: "waiting", position: 2000 }),
      row({ id: "done", status: "done", position: 100 }),
      row({ id: "n1", status: "next", position: 3000 }),
      row({ id: "p1", status: "playing", position: 5000 }),
      row({ id: "w1", status: "waiting", position: 1000 }),
    ];
    expect(playOrder(list).map((r) => r.id)).toEqual(["p1", "n1", "w1", "w2"]);
  });

  it("parses song and ISO durations and computes wait info", () => {
    expect(durationToSeconds("3:45")).toBe(225);
    expect(durationToSeconds("1:02:03")).toBe(3723);
    expect(durationToSeconds(null)).toBe(240);
    expect(formatIsoDuration("PT3M5S")).toBe("3:05");
    expect(formatIsoDuration("PT1H2M3S")).toBe("1:02:03");

    const rows = [
      row({ id: "p", status: "playing", duration: "3:00" }),
      row({ id: "w", status: "waiting", duration: "4:00" }),
    ];
    expect(waitInfo(rows, "w")).toEqual({ place: 2, seconds: 180 });
    expect(waitInfo(rows, "missing")).toBeNull();
  });

  it("normalizes search query with karaoke suffix unless already present", () => {
    expect(normalizeQuery("Queen")).toBe("Queen karaoke");
    expect(normalizeQuery("Queen Karaoke")).toBe("Queen Karaoke");
    expect(normalizeQuery("Beatles instrumental")).toBe("Beatles instrumental");
  });
});
