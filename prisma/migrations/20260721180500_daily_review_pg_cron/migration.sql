-- Schedule the daily post-close review from pg_cron, alongside the near-close
-- paper tick (see 20260704200000_paper_near_close_pg_cron for the full rationale
-- on why GH Actions cron is the backup and not the primary trigger).
--
-- Timing: the review wants to run about an hour after the *actual* close, and that
-- instant moves across a five-hour UTC band — 16:00 ET is 20:00 UTC in EDT and
-- 21:00 in EST, while an early close at 13:00 ET lands at 17:00/18:00 UTC. So the
-- window is decided at runtime from the broker calendar (afterCloseWindow in
-- src/lib/pipeline/review.ts, which reads the day's real close time and therefore
-- handles half-days), and cron only has to tick often enough to land inside it.
--
-- Schedule: every 10 minutes, 17:00–22:59 UTC, weekdays — a superset of every
-- possible close+55m..close+115m window. The dense tick is safe: out-of-window
-- calls return without writing the DailyReview row, and once the day's report
-- exists every further call is a no-op.
--
-- Requires one more Supabase Vault secret alongside the two the paper job already
-- uses (create once, SQL editor — NOT in the repo):
--   select vault.create_secret('https://<app-domain>/api/pipeline/review', 'pipeline_review_url');
-- Until it exists every tick is a silent no-op (the WHERE clause below), so this
-- migration is safe to apply before the secret is in place.
--
-- No RLS implications: no app tables are created (cron/net are system schemas).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Re-runnable: replace any previous definition of the job.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'daily-review-tick') then
    perform cron.unschedule('daily-review-tick');
  end if;
end
$$;

select cron.schedule(
  'daily-review-tick',
  '*/10 17-22 * * 1-5',
  $job$
  select net.http_post(
    url := s.url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || s.secret,
      'x-pipeline-run-id', 'pg-cron-review-' || to_char(now(), 'YYYYMMDDHH24MI')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  )
  from (
    select
      (select decrypted_secret from vault.decrypted_secrets where name = 'pipeline_review_url') as url,
      (select decrypted_secret from vault.decrypted_secrets where name = 'pipeline_cron_secret') as secret
  ) s
  where s.url is not null and s.secret is not null;
  $job$
);
