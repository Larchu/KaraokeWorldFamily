-- Include unregistered guest singers (user_id IS NULL) in Tonight's daily ranking ('night')
-- while keeping 'month' and 'all' scoped to registered singer accounts.

DROP FUNCTION IF EXISTS public.leaderboard(text);
CREATE OR REPLACE FUNCTION public.leaderboard(p_period text)
RETURNS TABLE (
  singer_id text,
  display_name text,
  card_code text,
  is_guest boolean,
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
      trim(s.singer_name) AS clean_name,
      lower(trim(s.singer_name)) AS name_key,
      s.status,
      coalesce(s.applause_score, 0)::bigint AS applause_score,
      coalesce(l.like_count, 0)::bigint AS req_likes,
      (coalesce(s.applause_score, 0)::bigint + coalesce(l.like_count, 0)::bigint * 10) AS req_points,
      coalesce(s.applause_measured_at, s.updated_at, s.created_at) AS perf_ts
    FROM public.song_requests s
    LEFT JOIN likes_by_req l ON l.request_id = s.id
    CROSS JOIN since
    WHERE s.status IN ('playing', 'done')
      AND coalesce(s.applause_measured_at, s.updated_at, s.created_at) >= since.t
  ),
  registered_rows AS (
    SELECT
      p.id::text AS singer_id,
      p.display_name,
      p.card_code,
      false AS is_guest,
      coalesce(sum(r.req_likes), 0)::bigint AS likes,
      coalesce(sum(r.applause_score), 0)::bigint AS applause_points,
      coalesce(sum(r.req_points), 0)::bigint AS total_points,
      count(r.id) FILTER (WHERE r.status = 'done')::bigint AS performances
    FROM public.profiles p
    JOIN per_req r ON r.user_id = p.id
    GROUP BY p.id, p.display_name, p.card_code
    HAVING coalesce(sum(r.req_points), 0) > 0
       OR count(r.id) FILTER (WHERE r.status = 'done') > 0
  ),
  guest_rows AS (
    SELECT
      ('guest:' || r.name_key)::text AS singer_id,
      max(r.clean_name)::text AS display_name,
      ''::text AS card_code,
      true AS is_guest,
      coalesce(sum(r.req_likes), 0)::bigint AS likes,
      coalesce(sum(r.applause_score), 0)::bigint AS applause_points,
      coalesce(sum(r.req_points), 0)::bigint AS total_points,
      count(r.id) FILTER (WHERE r.status = 'done')::bigint AS performances
    FROM per_req r
    WHERE p_period = 'night'
      AND r.user_id IS NULL
      AND length(r.name_key) > 0
    GROUP BY r.name_key
    HAVING coalesce(sum(r.req_points), 0) > 0
       OR count(r.id) FILTER (WHERE r.status = 'done') > 0
  ),
  combined AS (
    SELECT * FROM registered_rows
    UNION ALL
    SELECT * FROM guest_rows
  )
  SELECT
    c.singer_id,
    c.display_name,
    c.card_code,
    c.is_guest,
    c.likes,
    c.applause_points,
    c.total_points,
    c.performances
  FROM combined c
  ORDER BY
    c.total_points DESC,
    c.applause_points DESC,
    c.likes DESC,
    c.performances DESC,
    c.display_name ASC,
    c.singer_id ASC
  LIMIT 50;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.leaderboard(text) TO anon, authenticated;
  END IF;
END $$;
