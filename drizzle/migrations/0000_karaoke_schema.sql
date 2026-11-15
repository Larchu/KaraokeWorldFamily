-- Idempotent base schema for Karaoke World Family (compatible with PostgreSQL, PGlite, and Supabase)

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $fn$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $fn$;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.song_requests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID,
  singer_name TEXT NOT NULL,
  song_title TEXT NOT NULL,
  video_id TEXT NOT NULL,
  channel_title TEXT,
  thumbnail_url TEXT,
  duration TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',
  position DOUBLE PRECISION NOT NULL DEFAULT (extract(epoch from now()) * 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS song_requests_order_idx ON public.song_requests (status, position, created_at);
CREATE INDEX IF NOT EXISTS song_requests_user_idx ON public.song_requests (user_id);

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'song_requests_touch') THEN
    CREATE TRIGGER song_requests_touch
    BEFORE UPDATE ON public.song_requests
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT 'Cantante',
  card_code TEXT NOT NULL UNIQUE DEFAULT ('PM-' || upper(substr(md5(gen_random_uuid()::text), 1, 6))),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT display_name_len CHECK (length(trim(display_name)) BETWEEN 1 AND 40)
);

CREATE TABLE IF NOT EXISTS public.local_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.handle_new_guest()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (
    NEW.id,
    left(coalesce(nullif(trim(NEW.raw_user_meta_data->>'full_name'), ''), nullif(split_part(NEW.email, '@', 1), ''), 'Cantante'), 40)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'profiles_id_fkey'
    ) THEN
      ALTER TABLE public.profiles
        ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created_profile') THEN
      CREATE TRIGGER on_auth_user_created_profile
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_guest();
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.performance_likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.song_requests(id) ON DELETE CASCADE,
  liker_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id, liker_id)
);

CREATE TABLE IF NOT EXISTS public.favorite_songs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  video_id TEXT NOT NULL,
  song_title TEXT NOT NULL,
  channel_title TEXT,
  thumbnail_url TEXT,
  duration TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, video_id)
);

CREATE TABLE IF NOT EXISTS public.stage_control (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  paused BOOLEAN NOT NULL DEFAULT false,
  volume INTEGER NOT NULL DEFAULT 100 CHECK (volume BETWEEN 0 AND 100),
  revision BIGINT NOT NULL DEFAULT 0,
  restart_revision BIGINT NOT NULL DEFAULT 0,
  external BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.stage_control(id) VALUES (true) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.dj_set_status(p_id uuid, p_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_current text; v_next uuid;
BEGIN
  IF p_status NOT IN ('waiting','next','playing','done','skipped') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_status');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('song_requests_queue'));
  SELECT status INTO v_current FROM public.song_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF p_status = 'playing' THEN
    UPDATE public.song_requests SET status = 'done' WHERE status = 'playing' AND id <> p_id;
  ELSIF p_status = 'next' THEN
    UPDATE public.song_requests SET status = 'waiting' WHERE status = 'next' AND id <> p_id;
  END IF;
  UPDATE public.song_requests SET status = p_status WHERE id = p_id;
  IF v_current = 'playing' AND p_status IN ('done','skipped') THEN
    SELECT id INTO v_next FROM public.song_requests
    WHERE status IN ('next','waiting')
    ORDER BY (status = 'next') DESC, position ASC, created_at ASC LIMIT 1;
    IF v_next IS NOT NULL THEN
      UPDATE public.song_requests SET status = 'playing' WHERE id = v_next;
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'advanced', v_next);
END;
$$;

CREATE OR REPLACE FUNCTION public.dj_reorder(p_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_active uuid[]; v_given uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('song_requests_queue'));
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_active
  FROM public.song_requests WHERE status IN ('waiting','next','playing');
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_given FROM unnest(p_ids) AS x;
  IF v_active IS DISTINCT FROM v_given OR cardinality(v_given) <> cardinality(p_ids) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stale');
  END IF;
  UPDATE public.song_requests s SET position = o.ord * 1000
  FROM unnest(p_ids) WITH ORDINALITY AS o(id, ord) WHERE s.id = o.id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.dj_stage_command(p_command text, p_volume integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.stage_control;
BEGIN
  IF p_command NOT IN ('play','pause','restart','volume','external','local') THEN
    RAISE EXCEPTION 'bad_command';
  END IF;
  INSERT INTO public.stage_control(id) VALUES(true) ON CONFLICT DO NOTHING;
  UPDATE public.stage_control SET
    paused = CASE WHEN p_command = 'pause' THEN true WHEN p_command IN ('play','restart') THEN false ELSE paused END,
    volume = CASE WHEN p_command = 'volume' THEN greatest(0,least(100,p_volume)) ELSE volume END,
    external = CASE WHEN p_command = 'external' THEN true WHEN p_command = 'local' THEN false ELSE external END,
    restart_revision = restart_revision + CASE WHEN p_command = 'restart' THEN 1 ELSE 0 END,
    revision = revision + 1,
    updated_at = now()
  WHERE id = true
  RETURNING * INTO v;
  RETURN to_jsonb(v);
END;
$$;

CREATE OR REPLACE FUNCTION public.dj_complete_current(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('song_requests_queue'));
  IF NOT EXISTS (SELECT 1 FROM public.song_requests WHERE id = p_id AND status = 'playing') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stale');
  END IF;
  RETURN public.dj_set_status(p_id, 'done');
END;
$$;

CREATE OR REPLACE FUNCTION public.like_counts(p_ids uuid[])
RETURNS TABLE (request_id uuid, likes bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT request_id, count(*)::bigint FROM public.performance_likes WHERE request_id = ANY(p_ids) GROUP BY request_id;
$$;

-- RLS & Supabase Role Grants (guarded so standalone Postgres/PGlite also succeeds)
ALTER TABLE public.song_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.performance_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.favorite_songs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stage_control ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT, INSERT ON public.song_requests TO anon, authenticated;
    GRANT SELECT, UPDATE ON public.profiles TO authenticated;
    GRANT SELECT, INSERT, DELETE ON public.performance_likes TO authenticated;
    GRANT SELECT, INSERT, DELETE ON public.favorite_songs TO authenticated;
    REVOKE ALL ON FUNCTION public.dj_set_status(uuid, text) FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON FUNCTION public.dj_reorder(uuid[]) FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON FUNCTION public.dj_stage_command(text, integer) FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON FUNCTION public.dj_complete_current(uuid) FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON FUNCTION public.handle_new_guest() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.like_counts(uuid[]) TO anon, authenticated;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'song_requests' AND policyname = 'Anyone can view the queue') THEN
      CREATE POLICY "Anyone can view the queue" ON public.song_requests FOR SELECT USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'song_requests' AND policyname = 'Anyone can add a song request') THEN
      CREATE POLICY "Anyone can add a song request" ON public.song_requests FOR INSERT TO anon, authenticated
      WITH CHECK (
        length(trim(singer_name)) BETWEEN 1 AND 60
        AND length(trim(song_title)) BETWEEN 1 AND 200
        AND length(trim(video_id)) BETWEEN 1 AND 40
        AND status = 'waiting'
        AND (user_id IS NULL OR user_id = auth.uid())
      );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Own profile read') THEN
      CREATE POLICY "Own profile read" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Own profile update') THEN
      CREATE POLICY "Own profile update" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'performance_likes' AND policyname = 'Own likes read') THEN
      CREATE POLICY "Own likes read" ON public.performance_likes FOR SELECT TO authenticated USING (liker_id = auth.uid());
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'performance_likes' AND policyname = 'Like others performances') THEN
      CREATE POLICY "Like others performances" ON public.performance_likes FOR INSERT TO authenticated
      WITH CHECK (
        liker_id = auth.uid()
        AND EXISTS (
          SELECT 1 FROM public.song_requests s
          WHERE s.id = request_id AND (s.user_id IS NULL OR s.user_id <> auth.uid())
            AND s.status IN ('playing', 'done')
            AND s.updated_at > now() - interval '12 hours'
        )
      );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'performance_likes' AND policyname = 'Remove own like') THEN
      CREATE POLICY "Remove own like" ON public.performance_likes FOR DELETE TO authenticated USING (liker_id = auth.uid());
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'favorite_songs' AND policyname = 'Own favorites read') THEN
      CREATE POLICY "Own favorites read" ON public.favorite_songs FOR SELECT TO authenticated USING (user_id = auth.uid());
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'favorite_songs' AND policyname = 'Own favorites add') THEN
      CREATE POLICY "Own favorites add" ON public.favorite_songs FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'favorite_songs' AND policyname = 'Own favorites remove') THEN
      CREATE POLICY "Own favorites remove" ON public.favorite_songs FOR DELETE TO authenticated USING (user_id = auth.uid());
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.song_requests TO service_role;
    GRANT ALL ON public.profiles TO service_role;
    GRANT ALL ON public.performance_likes TO service_role;
    GRANT ALL ON public.favorite_songs TO service_role;
    GRANT ALL ON public.stage_control TO service_role;
    GRANT EXECUTE ON FUNCTION public.dj_set_status(uuid, text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.dj_reorder(uuid[]) TO service_role;
    GRANT EXECUTE ON FUNCTION public.dj_stage_command(text, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION public.dj_complete_current(uuid) TO service_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'song_requests'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.song_requests;
    END IF;
  END IF;
END $$;
