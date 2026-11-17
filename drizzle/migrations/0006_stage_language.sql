-- Persist and broadcast selected show language ('es' | 'de' | 'en') to Stage Monitor

ALTER TABLE public.stage_control
  ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT 'es';

ALTER TABLE public.stage_control
  DROP CONSTRAINT IF EXISTS stage_control_lang_check;

ALTER TABLE public.stage_control
  ADD CONSTRAINT stage_control_lang_check
  CHECK (lang IN ('es', 'de', 'en'));

DROP FUNCTION IF EXISTS public.dj_stage_command(text, integer);

CREATE OR REPLACE FUNCTION public.dj_stage_command(
  p_command text,
  p_volume integer DEFAULT 100,
  p_lang text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.stage_control;
BEGIN
  IF p_command NOT IN ('play','pause','restart','volume','external','local','lang') THEN
    RAISE EXCEPTION 'bad_command';
  END IF;
  INSERT INTO public.stage_control(id) VALUES(true) ON CONFLICT DO NOTHING;
  UPDATE public.stage_control SET
    paused = CASE WHEN p_command = 'pause' THEN true WHEN p_command IN ('play','restart') THEN false ELSE paused END,
    volume = CASE WHEN p_command = 'volume' THEN greatest(0,least(100,p_volume)) ELSE volume END,
    external = CASE WHEN p_command = 'external' THEN true WHEN p_command = 'local' THEN false ELSE external END,
    lang = CASE WHEN p_command = 'lang' AND p_lang IN ('es','de','en') THEN p_lang ELSE lang END,
    restart_revision = restart_revision + CASE WHEN p_command = 'restart' THEN 1 ELSE 0 END,
    revision = revision + 1,
    updated_at = now()
  WHERE id = true
  RETURNING * INTO v;
  RETURN to_jsonb(v);
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.dj_stage_command(text, integer, text) FROM PUBLIC, anon, authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.dj_stage_command(text, integer, text) TO service_role;
  END IF;
END $$;
