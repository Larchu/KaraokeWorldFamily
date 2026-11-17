# The World Family Karaoke

Lokale, vollständig reproduzierbare Full-Stack-Karaoke-Anwendung mit Gästewunschliste, DJ-Pult, externer Bar-Bühne (`/stage`), Echtzeit-Likes per QR-Code, Schwarm-/Feuerwerkseffekten, echtem 10-Sekunden-Applausometer, Sänger-Konto (`/konto`) und Rangliste (`/rangliste`).

---

## 1. Lokaler Start & Umgebung

### Voraussetzungen
- Node.js 20+ (getestet mit v22)
- `npm install`

### Umgebungsvariablen (`.env.example` → `.env`)
| Variable | Pflicht? | Zweck |
|---|---|---|
| `PORT` | Nein (Standard `3000`) | HTTP-Port des Express+Vite-Servers |
| `PGLITE_DATA_DIR` | Nein (Standard `./.data/pglite`) | Lokales eingebettetes PostgreSQL-Datenverzeichnis (alternativ `memory://` für Tests) |
| `DATABASE_URL` | Nein | Externe PostgreSQL-/Supabase-URL; ersetzt PGlite, falls gesetzt |
| `DJ_PASSWORD` | **Ja für DJ/Stage** | Server-Passwort für `/dj` und `/stage` (ohne Wert meldet `/api/dj/login` ehrlich Konfigurationsfehler `503`) |
| `DJ_SESSION_SECRET` | Empfohlen | HMAC-Signaturschlüssel für `mh-dj` / `mh-singer` Cookies |
| `YOUTUBE_API_KEY` | Optional | Serverseitige YouTube-Suche (`/api/youtube/search`). Ohne Schlüssel gibt die UI ehrlich den Konfigurationshinweis aus; direkte YouTube-Links/IDs bleiben jederzeit nutzbar |
| `GEMINI_API_KEY` | Optional | Serverseitige KI-Songvorschläge (`gemini-2.5-flash` über `/api/ai/suggest`) |
| `ELEVENLABS_API_KEY` | Optional | Serverseitige Bühnen-Ansagen über `/api/tts/announce`; fällt bei fehlendem Key sauber auf Browser-`speechSynthesis` zurück |
| `ELEVENLABS_VOICE_ID` | Optional | Ziel-Stimmen-ID für ElevenLabs-Ansagen |

> **Sicherheit:** Alle API-Schlüssel bleiben ausschließlich serverseitig (`/server/*`). Es werden niemals echte Geheimnisse ins Repository eingecheckt.

### Startbefehle
```bash
npm install
npm run db:setup   # Schema & Migrationen reproduzierbar anwenden
npm run dev        # Startet Server + Frontend auf http://localhost:3000
npm test           # Startet alle Unit-, DB/API-Integrations- und UI-Tests
npm run lint       # TypeScript-Prüfung (tsc --noEmit)
npm run build      # Produktions-Build erstellen
```

---

## 2. Datenbankaufbau & Migrationssicherheit

- **Schema:** `drizzle/schema.ts`
- **Migrationen (`drizzle/migrations/*.sql`):**
  1. `0000_karaoke_schema.sql`: Kerntabellen (`profiles`, `song_requests`, `favorite_songs`, `performance_likes`, `stage_control`), Trigger und Basis-RPCs (`dj_set_status`, `dj_reorder`, `dj_complete_current`, `dj_stage_command`).
  2. `0001_guest_device_likes.sql`: Gerätebasierte Gast-Likes und `guest_like`.
  3. `0002_dj_sessions.sql`: Serverseitige `dj_sessions` + `local_accounts`.
  4. `0003_applausometer_and_scoring.sql`: Spalten `applause_score` (`CHECK 0..100`), `applause_measured_at`, `applause_measurement_id`, Tabelle `applause_measurements`, atomares `dj_record_applause`, sowie vor-aggregierte `leaderboard(period)` und `my_singer_stats()`.
- **Frische vs. bestehende Datenbank:** `applyMigrations()` in `server/db.ts` protokolliert ausgeführte Dateien in `public._app_migrations`. Trifft es auf eine bestehende Alt-Datenbank (z. B. `song_requests` existiert bereits ohne `_app_migrations`), werden historische Basis-Skripte (`0000`–`0002`) übersprungen, bestehende Daten bleiben unberührt und ausschließlich fehlende idempotente Erweiterungen (`0003`) werden eingespielt.

---

## 3. Bühnen-Effekte (`/stage`) & Audio-Koordination

- **Aktueller Like-QR:** Exakt `116 × 116` CSS-Pixel (`STAGE_LIKE_QR_SIZE = 116`) mit heller Ruhezone (`bg-foreground p-2`) und Ziel `/like/<requestId>`.
- **Schwarm & Neon-Feuerwerk (`StageHearts.tsx` & `src/lib/stage.ts`):**
  - Verwendet verlustfreie Deltaverfolgung (`consumeLikeTotal`): historische Likes beim initialen Laden lösen keinen Partikelschwarm aus; schnelle Like-Bursts werden vollständig eingereiht; doppelte/veraltete SSE- oder Poll-Zustände zählen nicht doppelt.
  - Pro gültigem neuen Like (im normalen Animationsmodus): **exakt 40 Herzen + 40 Sterne = 80 Partikel** im breiten Fächer nach unten mit weichem Ausfaden sowie **gleichzeitig** ein aus derselben Like-Verarbeitung ausgelöstes Neon-Feuerwerk aus der unteren linken Ecke (`<canvas>`).
  - Bei `prefers-reduced-motion: reduce` wird stattdessen ein dezentes reduziertes Like-Emblem eingeblendet.
- **Externer Bühnenmodus vs. lokaler DJ-Player:** Ist „Bar-Bildschirm aktiv“ aktiviert (`pm-external-stage = true`), wird kein zweiter `StagePlayer` im DJ-Pult gemountet und das DJ-Pult spielt keinen doppelten Ton ab.

---

## 4. Echtes 10-Sekunden-Applausometer

### Signalverarbeitung & Kalibrierung (`src/lib/applause-meter.ts`)
- **Mikrofonzugriff:** Erfolgt ausschließlich am DJ-Gerät über `navigator.mediaDevices.getUserMedia` + Web Audio API (`AudioContext` + `AnalyserNode`, ca. 15 Hz Zeitbereichs-RMS-Abtastung). Der 10-Sekunden-Countdown startet erst **nach** erteilter Mikrofonberechtigung und laufender Audiopipeline. Es werden zu keinem Zeitpunkt Roh-Audiodaten gespeichert oder übertragen — nur normalisierte Pegelwerte `[0..1]`.
- **Pegel-Normalisierung:**
  - Frame-RMS → `dBFS = 20 * log10(max(rms, 1e-5))`
  - Normierung auf `[NOISE_FLOOR_DB = -58 dBFS, CEILING_DB = -10 dBFS]` mit Gamma-Kurve (`^0.85`).
  - Live-Anzeige über exponentielle Glättung (`alpha = 0.35`).
- **Relativer End-Score (`0..100` über volle 10 Sekunden):**
  - `score = round((0.55 * mean + 0.30 * p75 + 0.15 * activeRatio) * 100)`
  - `mean` (55 %): Durchschnitt über alle Frames des gesamten 10s-Fensters.
  - `p75` (30 %): 75.-Perzentil (erfasst echte Jubel-Spitzen, verhindert aber, dass ein einziger kurzer Klatschen-/Mikrofonstoß das Gesamtergebnis dominiert).
  - `activeRatio` (15 %): Anteil der Frames mit Pegel `>= 0.15`.
- **Transport, Autorisierung & Songende-Koordination (`server/applause-service.ts`, `StagePage.tsx`):**
  - Geschützte DJ-Endpunkte (`/api/applause/start|level|complete|cancel|state`, `/api/stream/stage`) prüfen den signierten `mh-dj`-Cookie.
  - Parallelmessungen werden serverseitig mit HTTP `409` abgewiesen; veraltete/ausser-Reihenfolge-Pakete (`seq`) verworfen.
  - Abgebrochene oder fehlgeschlagene Wiederholungsmessungen überschreiben **niemals** einen bereits gespeicherten gültigen `applause_score`.
  - Während einer aktiven Messung werden Bühnen-Video (YouTube) stumm/pausiert und synthetischer Applaus/Fanfaren unterdrückt (`setApplauseAudioSuppressed(true)`).
  - Endet das Video während einer aktiven Messung oder direkt anschließenden Ergebnisfeier (`completed`), hält `/stage` den Übergang zum nächsten Song (`awaitingAdvanceId`), zeigt die Live-Anzeige/Ergebniskarte vollständig an und schließt erst danach per einmalig dedupliziertem `/api/dj/requests/complete-current` ab.

---

## 5. Punktesystem & Rangliste

- **Verbindliche Formel pro Auftritt:**
  $$\text{Gesamtpunkte} = \text{Applaus-Score } (0\text{–}100) + (\text{Likes} \times 10)$$
  - Beispiele: `0 + 0×10 = 0`, `70 + 3×10 = 100`, `100 + 20×10 = 300`.
  - Wurde noch kein Applaus gemessen (`applause_score IS NULL`), zählt er rechnerisch als `0` und wird in der UI klar als „noch nicht gemessen“ gekennzeichnet.
- **Zeiträume (`public.leaderboard`):**
  - `night`: letzte 12 Stunden (`now() - interval '12 hours'`)
  - `month`: laufender Kalendermonat (`date_trunc('month', now())`)
  - `all`: gesamte Historie
- **Tie-Breaker-Reihenfolge:**
  1. `total_points DESC`
  2. `applause_points DESC`
  3. `likes DESC`
  4. `performances DESC`
  5. `display_name ASC, singer_id ASC`
- **Auftritte ohne Benutzerkonto:** Jeder Auftritt (auch ohne Anmeldung) kann geliked, per Applausometer bewertet und im DJ-Pult / auf der Bühne mit seiner Gesamtpunktzahl angezeigt werden. In der Sänger-Rangliste (`/rangliste`) erscheinen gemäß Datenmodell nur Auftritte mit verknüpftem Benutzerkonto (`user_id IS NOT NULL`).
