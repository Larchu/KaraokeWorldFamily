-- Support 5-second pre-measurement Beamer countdown before Applausometer starts recording

ALTER TABLE public.applause_measurements
  DROP CONSTRAINT IF EXISTS applause_measurements_status_check;

ALTER TABLE public.applause_measurements
  ADD CONSTRAINT applause_measurements_status_check
  CHECK (status IN ('countdown', 'measuring', 'completed', 'cancelled', 'failed'));

ALTER TABLE public.applause_measurements
  ADD COLUMN IF NOT EXISTS countdown_ends_at TIMESTAMPTZ;
