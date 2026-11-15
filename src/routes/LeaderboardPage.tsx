import { useEffect, useState } from "react";
import { Award, Heart, Mic, Trophy } from "lucide-react";
import { SiteHeader } from "@/components/SiteHeader";
import { apiJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { sortLeaderboard, type LeaderboardEntry } from "@/lib/singer";

type Period = "night" | "month" | "all";

export function LeaderboardPage() {
  const { t } = useI18n();
  const [period, setPeriod] = useState<Period>("night");
  const [rows, setRows] = useState<LeaderboardEntry[] | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    apiJson<{ rows: LeaderboardEntry[] }>(`/api/leaderboard?period=${period}`)
      .then((res) => {
        if (alive) setRows(sortLeaderboard(res.rows ?? []));
      })
      .catch(() => {
        if (alive) setRows([]);
      });
    return () => {
      alive = false;
    };
  }, [period]);

  const medal = ["text-gold", "text-silver", "text-bronze"];
  const tabs: [Period, string][] = [
    ["night", t.tonight],
    ["month", t.month],
    ["all", t.allTime],
  ];

  return (
    <div className="pb-20">
      <SiteHeader />
      <main className="mx-auto max-w-3xl space-y-6 px-4">
        <h1 className="text-center font-display text-4xl text-primary neon-text">
          <Trophy className="mr-2 inline size-8" />
          {t.leaderboard}
        </h1>
        <div className="mx-auto flex w-fit rounded-full border border-border p-1">
          {tabs.map(([p, label]) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`rounded-full px-4 py-2 text-sm font-bold ${
                period === p ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <p className="text-center text-xs text-muted-foreground">{t.leaderboardFormulaNote}</p>

        {rows === null ? (
          <p className="text-center text-muted-foreground">…</p>
        ) : rows.length === 0 ? (
          <p className="text-center text-muted-foreground">{t.noRanking}</p>
        ) : (
          <ol className="space-y-2">
            {rows.map((r, i) => (
              <li
                key={r.singer_id}
                data-testid={`leaderboard-row-${i}`}
                className={`flex flex-wrap items-center gap-4 rounded-2xl border bg-card p-4 ${
                  i < 3 ? "border-primary neon-border" : "border-border"
                }`}
              >
                <span
                  className={`w-10 text-center font-display text-3xl ${
                    medal[i] ?? "text-muted-foreground"
                  }`}
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-display text-lg">{r.display_name}</div>
                  <div className="text-xs text-muted-foreground">{r.card_code}</div>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="flex items-center gap-1 text-accent tabular-nums">
                    <Award className="size-4" />
                    {r.applause_points}
                  </span>
                  <span className="flex items-center gap-1 text-primary/90 tabular-nums">
                    <Heart className="size-4 fill-current" />
                    {r.likes}×10
                  </span>
                  <span className="flex items-center gap-1 text-muted-foreground tabular-nums">
                    <Mic className="size-4" />
                    {r.performances}
                  </span>
                  <span className="rounded-lg bg-primary/15 px-2.5 py-1 font-bold text-primary tabular-nums">
                    {r.total_points} <span className="text-xs font-normal">{t.points}</span>
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </main>
    </div>
  );
}
