-- Idempotent migration for 10-second Applausometer, score persistence, and updated points leaderboard

ALTER TABLE public.song_requests
  ADD COLUMN IF NOT EXISTS applause_score INTEGER,
  ADD COLUMN IF NOT EXISTS applause_measured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS applause_measurement_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'song_requests_applause_score_range'
  ) THEN
    ALTER TABLE public.song_requests
      ADD CONSTRAINT song_requests_applause_score_range
      CHECK (applause_score IS NULL OR (applause_score >= 0 AND applause_score <= 100));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.applause_measurements (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES public.song_requests(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('measuring', 'completed', 'cancelled', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 10000 CHECK (duration_ms BETWEEN 1000 AND 30000),
  latest_level DOUBLE PRECISION NOT NULL DEFAULT 0,
  latest_peak DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0,
  score INTEGER CHECK (score IS NULL OR (score BETWEEN 0 AND 100)),
  samples_count INTEGER NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS applause_measurements_request_idx
  ON public.applause_measurements (request_id, started_at DESC);

ALTER TABLE public.applause_measurements ENABLE ROW LEVEL SECURITY;

-- Atomically save a validated 0..100 applause score to a performance.
-- Preserves any existing score if called with an invalid score or non-existent request.
CREATE OR REPLACE FUNCTION public.dj_record_applause(
  p_request_id uuid,
  p_measurement_id uuid,
  p_score integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.song_requests;
  v_likes bigint;
BEGIN
  IF p_score IS NULL OR p_score < 0 OR p_score > 100 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_score');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('applause_' || p_request_id::text));

  SELECT * INTO v_req FROM public.song_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  UPDATE public.song_requests
  SET applause_score = p_score,
      applause_measured_at = now(),
      applause_measurement_id = p_measurement_id
  WHERE id = p_request_id
  RETURNING * INTO v_req;

  SELECT count(*)::bigint INTO v_likes
  FROM public.performance_likes
  WHERE request_id = p_request_id;

  RETURN jsonb_build_object(
    'ok', true,
    'request_id', v_req.id,
    'applause_score', v_req.applause_score,
    'likes', v_likes,
    'total_points', coalesce(v_req.applause_score, 0) + (v_likes * 10)
  );
END;
$$;

-- Leaderboard: aggregates points per registered singer without join-multiplying likes or applause.
-- Binding formula per performance: total_points = coalesce(applause_score, 0) + (likes * 10)
-- Tie-breaker: total_points DESC, applause_points DESC, likes DESC, performances DESC, display_name ASC, singer_id ASC
DROP FUNCTION IF EXISTS public.leaderboard(text);
CREATE OR REPLACE FUNCTION public.leaderboard(p_period text)
RETURNS TABLE (
  singer_id uuid,
  display_name text,
  card_code text,
  likes bigint,
  applause_points bigint,
  total_points bigint,
  performances bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH since AS (
    SELECT CASE p_period
      WHEN 'night' THEN now() - interval '12 hours'
      WHEN 'month' THEN date_trunc('month', now())
      ELSE '-infinity'::timestamptz
    END AS t
  ),
  likes_by_req AS (
    SELECT l.request_id, count(*)::bigint AS like_count
    FROM public.performance_likes l
    GROUP BY l.request_id
  ),
  per_req AS (
    SELECT
      s.id,
      s.user_id,
      s.status,
      coalesce(s.applause_score, 0)::bigint AS applause_score,
      coalesce(l.like_count, 0)::bigint AS req_likes,
      (coalesce(s.applause_score, 0)::bigint + coalesce(l.like_count, 0)::bigint * 10) AS req_points,
      coalesce(s.applause_measured_at, s.updated_at, s.created_at) AS perf_ts
    FROM public.song_requests s
    LEFT JOIN likes_by_req l ON l.request_id = s.id
    CROSS JOIN since
    WHERE s.user_id IS NOT NULL
      AND s.status IN ('playing', 'done')
      AND coalesce(s.applause_measured_at, s.updated_at, s.created_at) >= since.t
  )
  SELECT
    p.id AS singer_id,
    p.display_name,
    p.card_code,
    coalesce(sum(r.req_likes), 0)::bigint AS likes,
    coalesce(sum(r.applause_score), 0)::bigint AS applause_points,
    coalesce(sum(r.req_points), 0)::bigint AS total_points,
    count(r.id) FILTER (WHERE r.status = 'done')::bigint AS performances
  FROM public.profiles p
  JOIN per_req r ON r.user_id = p.id
  GROUP BY p.id, p.display_name, p.card_code
  HAVING coalesce(sum(r.req_points), 0) > 0
     OR count(r.id) FILTER (WHERE r.status = 'done') > 0
  ORDER BY total_points DESC, applause_points DESC, likes DESC, performances DESC, p.display_name ASC, p.id ASC
  LIMIT 50;
$$;

DROP FUNCTION IF EXISTS public.my_singer_stats();
DROP FUNCTION IF EXISTS public.my_singer_stats(uuid);
CREATE OR REPLACE FUNCTION public.my_singer_stats(p_user_id uuid DEFAULT NULL)
RETURNS TABLE (
  likes bigint,
  applause_points bigint,
  total_points bigint,
  performances bigint,
  requests bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH target AS (
    SELECT coalesce(p_user_id, auth.uid()) AS uid
  ),
  likes_by_req AS (
    SELECT l.request_id, count(*)::bigint AS like_count
    FROM public.performance_likes l
    GROUP BY l.request_id
  ),
  user_reqs AS (
    SELECT
      s.id,
      s.status,
      coalesce(s.applause_score, 0)::bigint AS applause_score,
      coalesce(l.like_count, 0)::bigint AS req_likes
    FROM public.song_requests s
    CROSS JOIN target
    LEFT JOIN likes_by_req l ON l.request_id = s.id
    WHERE s.user_id = target.uid
  )
  SELECT
    coalesce(sum(req_likes), 0)::bigint AS likes,
    coalesce(sum(applause_score), 0)::bigint AS applause_points,
    coalesce(sum(applause_score + req_likes * 10), 0)::bigint AS total_points,
    count(*) FILTER (WHERE status = 'done')::bigint AS performances,
    count(*)::bigint AS requests
  FROM user_reqs;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.dj_record_applause(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.leaderboard(text) TO anon, authenticated;
    REVOKE ALL ON FUNCTION public.my_singer_stats(uuid) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.my_singer_stats(uuid) TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.applause_measurements TO service_role;
    GRANT EXECUTE ON FUNCTION public.dj_record_applause(uuid, uuid, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION public.my_singer_stats(uuid) TO service_role;
  END IF;
END $$;
