-- Idempotent migration for server-side DJ sessions

CREATE TABLE IF NOT EXISTS public.dj_sessions (
  id TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.dj_sessions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.dj_sessions TO service_role;
  END IF;
END $$;
