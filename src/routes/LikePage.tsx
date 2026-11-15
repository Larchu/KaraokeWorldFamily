import { useEffect, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { SiteHeader } from "@/components/SiteHeader";
import { StageBanner } from "@/components/StageBanner";
import { Button } from "@/components/ui/button";
import { apiJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { SongRequest } from "@/lib/queue";

export function LikePage() {
  const params = useParams({ strict: false }) as { requestId?: string };
  const requestId = params.requestId ?? "";
  const { t } = useI18n();
  const [song, setSong] = useState<SongRequest | null | undefined>(undefined);

  useEffect(() => {
    if (!requestId) {
      setSong(null);
      return;
    }
    let alive = true;
    apiJson<{ row: SongRequest | null }>(`/api/requests/${encodeURIComponent(requestId)}`)
      .then((res) => {
        if (alive) setSong(res.row ?? null);
      })
      .catch(() => {
        if (alive) setSong(null);
      });
    return () => {
      alive = false;
    };
  }, [requestId]);

  return (
    <div className="pb-20">
      <SiteHeader />
      <main className="mx-auto max-w-md space-y-6 px-4 text-center">
        <h1 className="font-display text-3xl text-primary neon-text">{t.likeTitle}</h1>
        {song === undefined ? (
          <p className="text-muted-foreground">…</p>
        ) : song ? (
          <StageBanner current={song} />
        ) : (
          <p className="text-muted-foreground">{t.likeGone}</p>
        )}
        {song && <p className="text-sm text-muted-foreground">{t.likeTap}</p>}
        <Button asChild variant="link">
          <Link to="/rangliste">{t.leaderboard}</Link>
        </Button>
      </main>
    </div>
  );
}
