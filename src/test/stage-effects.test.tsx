import { act, render, screen } from "@testing-library/react";
import { QRCodeSVG } from "qrcode.react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StageHearts } from "@/components/StageHearts";
import { StageApplauseOverlay } from "@/components/StageApplauseOverlay";
import { IDLE_APPLAUSE_STATE } from "@/lib/applause-meter";
import { I18nProvider, useI18n } from "@/lib/i18n";
import { STAGE_LIKE_QR_SIZE } from "@/lib/stage";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (e: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  emit(type: string, payload: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(payload) });
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }

  close() {}
}

describe("StageHearts & Stage QR effects", () => {
  const originalEventSource = globalThis.EventSource;
  const originalFetch = globalThis.fetch;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    window.matchMedia = ((q: string) =>
      ({
        matches: false,
        media: q,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList) as typeof window.matchMedia;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.EventSource = originalEventSource;
    globalThis.fetch = originalFetch;
    window.matchMedia = originalMatchMedia;
  });

  it("does not explode historical likes on first load, then spawns 40 hearts + 40 stars + firework per new like", async () => {
    const reqId = "11111111-1111-4111-8111-111111111111";
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ counts: [{ request_id: reqId, likes: 5 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    render(
      <I18nProvider>
        <StageHearts requestId={reqId} />
      </I18nProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Historical 5 likes visible in counter, 0 swarm particles or fireworks
    expect(screen.getByTestId("stage-like-count")).toHaveTextContent("5");
    expect(screen.queryAllByTestId("stage-heart-particle")).toHaveLength(0);
    expect(screen.queryAllByTestId("stage-star-particle")).toHaveLength(0);
    expect(screen.getByTestId("stage-firework-canvas")).toHaveAttribute("data-firework-launches", "0");

    // Simulate 1 valid new like via SSE
    const sse = FakeEventSource.instances[0]!;
    act(() => {
      sse.emit("like_changed", { requestId: reqId, likes: 6 });
    });

    expect(screen.getByTestId("stage-like-count")).toHaveTextContent("6");
    expect(screen.getAllByTestId("stage-heart-particle")).toHaveLength(40);
    expect(screen.getAllByTestId("stage-star-particle")).toHaveLength(40);
    expect(screen.getByTestId("stage-firework-canvas")).toHaveAttribute("data-firework-launches", "1");
    expect(screen.getByTestId("stage-hearts-swarm")).toHaveAttribute("data-burst-count", "1");

    // Duplicate delivery for same count=6 does NOT double trigger
    act(() => {
      sse.emit("like_changed", { requestId: reqId, likes: 6 });
    });
    expect(screen.getByTestId("stage-firework-canvas")).toHaveAttribute("data-firework-launches", "1");

    // Rapid burst of 3 more likes (6 -> 9) drains all 3 sequentially without dropping any
    act(() => {
      sse.emit("like_changed", { requestId: reqId, likes: 9 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByTestId("stage-like-count")).toHaveTextContent("9");
    expect(screen.getByTestId("stage-hearts-swarm")).toHaveAttribute("data-burst-count", "4");
    expect(screen.getByTestId("stage-firework-canvas")).toHaveAttribute("data-firework-launches", "4");
    expect(screen.getAllByTestId("stage-heart-particle")).toHaveLength(160);
    expect(screen.getAllByTestId("stage-star-particle")).toHaveLength(160);
  });

  it("uses a lightweight emblem instead of 80 particles when prefers-reduced-motion is active", async () => {
    const reqId = "22222222-2222-4222-8222-222222222222";
    window.matchMedia = ((q: string) =>
      ({
        matches: q.includes("prefers-reduced-motion"),
        media: q,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList) as typeof window.matchMedia;

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ counts: [{ request_id: reqId, likes: 0 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    render(
      <I18nProvider>
        <StageHearts requestId={reqId} />
      </I18nProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const sse = FakeEventSource.instances[0]!;
    act(() => {
      sse.emit("like_changed", { requestId: reqId, likes: 1 });
    });

    expect(screen.queryAllByTestId("stage-heart-particle")).toHaveLength(0);
    expect(screen.queryAllByTestId("stage-star-particle")).toHaveLength(0);
    expect(screen.getByTestId("stage-reduced-like-emblem")).toBeInTheDocument();
  });

  it("renders high-contrast Beamer Like QR SVG at large far-distance dimensions", () => {
    const { container } = render(
      <QRCodeSVG
        value="http://localhost:3000/like/test"
        size={STAGE_LIKE_QR_SIZE}
        bgColor="#FFFFFF"
        fgColor="#000000"
        level="L"
        shapeRendering="crispEdges"
      />,
    );
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", String(STAGE_LIKE_QR_SIZE));
    expect(svg).toHaveAttribute("height", String(STAGE_LIKE_QR_SIZE));
    expect(svg).toHaveAttribute("shape-rendering", "crispEdges");
  });
});

function LangToggleHarness({ applause }: { applause: Parameters<typeof StageApplauseOverlay>[0]["applause"] }) {
  const { setLang } = useI18n();
  return (
    <>
      <button type="button" onClick={() => setLang("de")}>
        Switch DE
      </button>
      <StageApplauseOverlay applause={applause} />
    </>
  );
}

describe("StageApplauseOverlay resolution & language sync", () => {
  it("renders 5s countdown, 48-band live synchronized meter, live language switch, and graphical total score breakdown", () => {
    const now = Date.now();
    const { rerender } = render(
      <I18nProvider>
        <LangToggleHarness
          applause={{
            ...IDLE_APPLAUSE_STATE,
            measurementId: "m-1",
            requestId: "r-1",
            singerName: "Elena",
            songTitle: "Bohemian Rhapsody",
            status: "countdown",
            startedAt: now,
            countdownEndsAt: now + 4500,
            endsAt: now + 14500,
            likes: 3,
          }}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId("stage-applause-countdown-screen")).toBeInTheDocument();
    expect(screen.getByTestId("stage-applause-singer")).toHaveTextContent("Elena");
    expect(screen.getByTestId("stage-applause-precountdown")).toHaveTextContent("5");

    // Switching language to German updates Beamer & Applausometer copy immediately
    act(() => {
      screen.getByText("Switch DE").click();
    });
    expect(screen.getByText("10s-Applausometer!")).toBeInTheDocument();

    const sampleBands = Array.from({ length: 48 }, (_, i) => (i % 2 === 0 ? 0.8 : 0.45));
    rerender(
      <I18nProvider>
        <LangToggleHarness
          applause={{
            ...IDLE_APPLAUSE_STATE,
            measurementId: "m-1",
            requestId: "r-1",
            singerName: "Elena",
            songTitle: "Bohemian Rhapsody",
            status: "measuring",
            startedAt: now,
            countdownEndsAt: now - 100,
            endsAt: now + 9000,
            latestLevel: 0.78,
            latestPeak: 0.89,
            latestBands: sampleBands,
            lastSeq: 12,
            likes: 4,
          }}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId("stage-applause-measuring")).toBeInTheDocument();
    expect(screen.getByTestId("stage-applause-spectrum")).toHaveAttribute("data-level", "78");
    expect(screen.getByTestId("stage-applause-spectrum")).toHaveAttribute("data-bands", "48");
    expect(screen.getAllByTestId("stage-spectrum-bar")).toHaveLength(48);
    expect(screen.getAllByTestId("stage-meter-segment")).toHaveLength(48);
    expect(screen.getByTestId("stage-applause-meter")).toHaveAttribute("aria-valuenow", "78");

    rerender(
      <I18nProvider>
        <LangToggleHarness
          applause={{
            ...IDLE_APPLAUSE_STATE,
            measurementId: "m-1",
            requestId: "r-1",
            singerName: "Elena",
            songTitle: "Bohemian Rhapsody",
            status: "completed",
            score: 84,
            likes: 4,
            totalPoints: 124,
            rank: 1,
            previousRank: 2,
            rankDelta: 1,
            topRankings: [
              {
                singer_id: "guest:elena",
                display_name: "Elena",
                card_code: "",
                is_guest: true,
                likes: 4,
                applause_points: 84,
                total_points: 124,
                performances: 1,
              },
            ],
          }}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId("stage-applause-celebration")).toBeInTheDocument();
    expect(screen.getByTestId("stage-score-donut")).toBeInTheDocument();
    expect(screen.getByTestId("stage-applause-singer")).toHaveTextContent("Elena");
    expect(screen.getByTestId("stage-applause-rank")).toHaveTextContent("#1");
    expect(screen.getByTestId("stage-applause-top-ranking")).toHaveTextContent("Elena");
  });
});

