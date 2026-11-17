import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Trophy, UserRound, Mic2, Headphones, Settings } from "lucide-react";
import { LOGO_URL } from "@/lib/assets";
import { useI18n, type Lang } from "@/lib/i18n";
import { useAuthUser } from "@/hooks/use-auth-user";
import { SettingsDialog } from "@/components/SettingsDialog";

export function SiteHeader() {
  const { t, lang, setLang } = useI18n();
  const { user } = useAuthUser();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <div className="rainbow-bar" aria-hidden />
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-4 py-4">
        <Link to="/" className="flex shrink-0 items-center gap-3">
          <img
            src={LOGO_URL}
            alt="The World Family"
            width={56}
            height={56}
            className="logo-glow size-11 shrink-0 object-cover sm:size-14"
          />
          <div className="hidden sm:block">
            <div className="font-display text-xl leading-none text-primary neon-text">
              The World Family
            </div>
            <div className="text-xs uppercase tracking-[0.25em] text-accent">{t.tagline}</div>
          </div>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link
            to="/"
            className="whitespace-nowrap rounded-full px-2.5 py-2 text-muted-foreground hover:text-foreground sm:px-3"
            activeProps={{ className: "text-primary" }}
            activeOptions={{ exact: true }}
          >
            <Mic2 className="inline size-4 sm:mr-1" />
            <span className="hidden sm:inline">{t.home}</span>
          </Link>
          <Link
            to="/rangliste"
            className="whitespace-nowrap rounded-full px-2.5 py-2 text-muted-foreground hover:text-foreground sm:px-3"
            activeProps={{ className: "text-primary" }}
          >
            <Trophy className="inline size-4 sm:mr-1" />
            <span className="hidden sm:inline">{t.leaderboard}</span>
          </Link>
          <Link
            to="/konto"
            className="whitespace-nowrap rounded-full px-2.5 py-2 text-muted-foreground hover:text-foreground sm:px-3"
            activeProps={{ className: "text-primary" }}
          >
            <UserRound className="inline size-4 sm:mr-1" />
            <span className="hidden sm:inline">{user ? t.account : t.signIn}</span>
          </Link>
          <Link
            to="/dj"
            className="whitespace-nowrap rounded-full px-2.5 py-2 text-muted-foreground hover:text-foreground sm:px-3"
            activeProps={{ className: "text-primary" }}
            title={t.dj}
          >
            <Headphones className="inline size-4 sm:mr-1" />
            <span className="hidden sm:inline">{t.dj}</span>
          </Link>
          <button
            type="button"
            data-testid="header-settings-btn"
            onClick={() => setSettingsOpen(true)}
            aria-label={t.settingsTitle}
            title={t.settingsTitle}
            className="rounded-full p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Settings className="size-4" />
          </button>
          <div className="ml-1 flex rounded-full border border-border p-0.5">
            {(["es", "de", "en"] as Lang[]).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                className={`rounded-full px-2 py-1 text-xs font-bold uppercase ${
                  lang === l ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </nav>
      </header>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}
