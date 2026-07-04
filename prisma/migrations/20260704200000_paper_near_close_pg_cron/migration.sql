-- Near-close paper-stage scheduling moves from GitHub Actions cron to pg_cron.
--
-- Why: GH cron is best-effort — on 2026-07-02 the 19:30 UTC entry drifted +69 min
-- (fired 20:39, after the 20:00 close) and every run missed the 30-min trade
-- window; on 2026-07-03 (early close, 17:00 UTC) the fixed 19:30/20:30 entries
-- structurally couldn't hit the window at all. Two consecutive skipped trading
-- days. pg_cron fires with minute precision from inside our own Postgres.
--
-- Schedule: every 5 minutes, 16:00–21:59 UTC, weekdays — covers the EDT (20:00
-- UTC) and EST (21:00 UTC) closes AND early closes (17:00/18:00 UTC). The dense
-- tick is safe: the paper stage self-gates (out-of-window calls no-op without
-- writing the idempotency snapshot; in-window repeats are no-ops after the day's
-- first success). A pg_net timeout does NOT kill the serverless run — the stage
-- finishes server-side; the next tick's idempotency check sees the result.
--
-- Requires two Supabase Vault secrets (create once, SQL editor — NOT in the repo):
--   select vault.create_secret('<CRON_SECRET value>', 'pipeline_cron_secret');
--   select vault.create_secret('https://<app-domain>/api/pipeline/paper', 'pipeline_paper_url');
-- Until both exist every tick is a silent no-op (the WHERE clause below), so this
-- migration is safe to apply before the secrets are in place.
--
-- No RLS implications: no app tables are created (cron/net are system schemas).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Re-runnable: replace any previous definition of the job.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'paper-near-close-tick') then
    perform cron.unschedule('paper-near-close-tick');
  end if;
end
$$;

select cron.schedule(
  'paper-near-close-tick',
  '*/5 16-21 * * 1-5',
  $job$
  select net.http_post(
    url := s.url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || s.secret,
      'x-pipeline-run-id', 'pg-cron-' || to_char(now(), 'YYYYMMDDHH24MI')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  )
  from (
    select
      (select decrypted_secret from vault.decrypted_secrets where name = 'pipeline_paper_url') as url,
      (select decrypted_secret from vault.decrypted_secrets where name = 'pipeline_cron_secret') as secret
  ) s
  where s.url is not null and s.secret is not null;
  $job$
);
