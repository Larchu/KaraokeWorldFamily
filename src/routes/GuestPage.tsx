import { useEffect, useMemo, useState } from "react";
import { useSearch } from "@tanstack/react-router";
import { Search, Loader2, Play, Star, X, Link2 } from "lucide-react";
import { toast } from "sonner";
import { SiteHeader } from "@/components/SiteHeader";
import { StageBanner } from "@/components/StageBanner";
import { AiSuggest } from "@/components/AiSuggest";
import { MyRequestStatus } from "@/components/MyRequestStatus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiJson, extractYouTubeVideoId, type VideoResult } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useQueue } from "@/hooks/use-queue";
import { useAuthUser } from "@/hooks/use-auth-user";
import { playOrder } from "@/lib/queue";

const MY_KEY = "pm-my-request";

export function GuestPage() {
  const { t } = useI18n();
  const searchParams = useSearch({ strict: false }) as { q?: string };
  const initialQ = typeof searchParams?.q === "string" ? searchParams.q : "";
  const { rows, reload } = useQueue();
  const { user } = useAuthUser();

  const [query, setQuery] = useState(initialQ);
  const [results, setResults] = useState<VideoResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [configError, setConfigError] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [preview, setPreview] = useState<VideoResult | null>(null);
  const [picked, setPicked] = useState<VideoResult | null>(null);
  const [name, setName] = useState("");
  const [sending, setSending] = useState(false);
  const [myId, setMyId] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState("");
  const [manualTitle, setManualTitle] = useState("");

  useEffect(() => {
    try {
      setRecent(JSON.parse(localStorage.getItem("pm-recent") ?? "[]"));
    } catch {
      setRecent([]);
    }
    setName(localStorage.getItem("pm-name") ?? "");
    setMyId(localStorage.getItem(MY_KEY));
  }, []);

  useEffect(() => {
    if (!user || localStorage.getItem("pm-name")) return;
    setName((n) => n || user.display_name);
  }, [user]);

  const run = async (q: string) => {
    const term = q.trim();
    if (!term) return;
    setQuery(term);
    setLoading(true);
    setSearched(true);
    setConfigError(false);
    try {
      const r = await apiJson<{ results: VideoResult[]; error: string | null }>(
        "/api/youtube/search",
        {
          method: "POST",
          body: JSON.stringify({ q: term }),
        },
      );
      setResults(r.results ?? []);
      if (r.error === "config") {
        setConfigError(true);
        toast.error(t.errYoutubeConfig);
      } else if (r.error === "quota") {
        toast.error(t.errQuota);
      } else if (r.error) {
        toast.error(t.errGeneric);
      }
      const next = [term, ...recent.filter((x) => x !== term)].slice(0, 6);
      setRecent(next);
      localStorage.setItem("pm-recent", JSON.stringify(next));
    } catch {
      toast.error(t.errGeneric);
    } finally {
      setLoading(false);
    }
  };

  useEffect((): (() => void) | undefined => {
    if (query.trim().length < 3) return undefined;
    const h = setTimeout(() => void run(query), 700);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const order = useMemo(() => playOrder(rows), [rows]);
  const current = order.find((r) => r.status === "playing");
  const mine = myId ? rows.find((r) => r.id === myId) : undefined;

  const submit = async (): Promise<void> => {
    if (!picked || !name.trim()) return;
    setSending(true);
    localStorage.setItem("pm-name", name.trim());
    try {
      const data = await apiJson<{ id: string }>("/api/requests", {
        method: "POST",
        body: JSON.stringify({
          singer_name: name.trim().slice(0, 60),
          song_title: picked.title.slice(0, 200),
          video_id: picked.videoId,
          channel_title: picked.channelTitle || null,
          thumbnail_url: picked.thumbnail || null,
          duration: picked.duration || null,
        }),
      });
      localStorage.setItem(MY_KEY, data.id);
      setMyId(data.id);
      setPicked(null);
      toast.success(t.sent);
      await reload();
    } catch {
      toast.error(t.errGeneric);
    } finally {
      setSending(false);
    }
  };

  const addFav = async (v: VideoResult): Promise<void> => {
    if (!user) {
      toast(t.signIn);
      return;
    }
    try {
      await apiJson("/api/favorites", {
        method: "POST",
        body: JSON.stringify({
          video_id: v.videoId,
          song_title: v.title,
          channel_title: v.channelTitle,
          thumbnail_url: v.thumbnail,
          duration: v.duration,
        }),
      });
      toast.success(t.addedFav);
    } catch {
      toast.error(t.errGeneric);
    }
  };

  const pickManual = () => {
    const videoId = extractYouTubeVideoId(manualUrl);
    if (!videoId) {
      toast.error(t.manualYoutubeInvalid);
      return;
    }
    setPicked({
      videoId,
      title: manualTitle.trim() || `Karaoke (${videoId})`,
      channelTitle: "YouTube",
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      duration: "",
    });
    setManualUrl("");
    setManualTitle("");
  };

  const showStatus =
    mine &&
    ((mine.status !== "done" && mine.status !== "skipped") ||
      Date.now() - new Date(mine.updated_at).getTime() < 15 * 60 * 1000);

  return (
    <div className="pb-20">
      <SiteHeader />
      <main className="mx-auto max-w-5xl space-y-6 px-4">
        <StageBanner current={current} />
        {showStatus && myId ? (
          <MyRequestStatus
            rows={rows}
            id={myId}
            onNew={() => {
              localStorage.removeItem(MY_KEY);
              setMyId(null);
            }}
          />
        ) : null}

        <section className="space-y-4">
          <h1 className="text-center font-display text-4xl text-primary neon-text sm:text-5xl">
            Karaoke Night
          </h1>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(query);
            }}
            className="relative"
          >
            <Search className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.searchPh}
              className="h-14 rounded-2xl border-primary/50 bg-card pl-12 pr-28 text-lg neon-border"
            />
            <Button
              type="submit"
              className="absolute right-2 top-1/2 -translate-y-1/2"
              disabled={loading}
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : t.search}
            </Button>
          </form>

          {configError && (
            <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {t.errYoutubeConfig}
            </p>
          )}

          {recent.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t.recent}:</span>
              {recent.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => void run(r)}
                  className="rounded-full bg-secondary px-3 py-1 hover:bg-primary hover:text-primary-foreground"
                >
                  {r}
                </button>
              ))}
            </div>
          )}

          <AiSuggest onPick={(term) => void run(term)} />

          {/* Direct YouTube URL / Video ID entry when YouTube search quota/API key is unavailable */}
          <div className="rounded-2xl border border-border bg-card/70 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
              <Link2 className="size-3.5 text-accent" />
              {t.manualYoutubeTitle}
            </div>
            <div className="flex flex-wrap gap-2">
              <Input
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                placeholder={t.manualYoutubePh}
                className="min-w-52 flex-1"
              />
              <Input
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                placeholder={t.djSearchTitle}
                className="w-full sm:w-56"
              />
              <Button
                type="button"
                variant="secondary"
                disabled={!manualUrl.trim()}
                onClick={pickManual}
              >
                {t.choose}
              </Button>
            </div>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {results.map((v) => (
            <div
              key={v.videoId}
              className="group overflow-hidden rounded-2xl border border-border bg-card transition hover:border-primary"
            >
              <button
                type="button"
                onClick={() => setPreview(v)}
                className="relative block aspect-video w-full overflow-hidden"
              >
                <img
                  src={v.thumbnail}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="size-full object-cover transition group-hover:scale-105"
                />
                <span className="absolute inset-0 flex items-center justify-center bg-background/40 opacity-0 transition group-hover:opacity-100">
                  <Play className="size-10 text-primary" />
                </span>
                {v.duration && (
                  <span className="absolute bottom-2 right-2 rounded bg-background/80 px-1.5 text-xs">
                    {v.duration}
                  </span>
                )}
              </button>
              <div className="space-y-2 p-3">
                <div className="line-clamp-2 text-sm font-semibold">{v.title}</div>
                <div className="truncate text-xs text-muted-foreground">{v.channelTitle}</div>
                <div className="flex gap-2">
                  <Button size="sm" className="flex-1" onClick={() => setPicked(v)}>
                    {t.choose}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void addFav(v)}
                    aria-label={t.favorite}
                  >
                    <Star className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {searched && !loading && !configError && results.length === 0 && (
            <p className="col-span-full text-center text-muted-foreground">{t.noResults}</p>
          )}
        </section>

        {order.length > 0 && (
          <section className="rounded-2xl border border-border bg-card/60 p-4">
            <h2 className="mb-3 text-xl text-accent">{t.upcoming}</h2>
            <ol className="space-y-1 text-sm">
              {order.slice(0, 8).map((r, i) => (
                <li
                  key={r.id}
                  className={`flex gap-3 rounded-lg px-2 py-1 ${
                    r.id === myId ? "bg-primary/20" : ""
                  }`}
                >
                  <span className="w-6 font-bold text-primary">{i + 1}</span>
                  <span className="font-semibold">{r.singer_name}</span>
                  <span className="truncate text-muted-foreground">{r.song_title}</span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </main>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="line-clamp-1">{preview?.title}</DialogTitle>
          </DialogHeader>
          {preview && (
            <div className="aspect-video">
              <iframe
                className="size-full rounded-lg border-0"
                src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(preview.videoId)}?autoplay=1&playsinline=1`}
                referrerPolicy="strict-origin-when-cross-origin"
                allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                allowFullScreen
                title={preview.title}
              />
            </div>
          )}
          <Button
            onClick={() => {
              setPicked(preview);
              setPreview(null);
            }}
          >
            {t.choose}
          </Button>
        </DialogContent>
      </Dialog>

      <Dialog open={!!picked} onOpenChange={(o) => !o && setPicked(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{picked?.title}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="space-y-4"
          >
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.yourName}
              maxLength={60}
              className="h-12 text-lg"
            />
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => setPicked(null)}>
                <X className="size-4" />
                {t.cancel}
              </Button>
              <Button type="submit" className="flex-1" disabled={sending || !name.trim()}>
                {sending ? <Loader2 className="size-4 animate-spin" /> : t.send}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
