-- ============================================================================
-- Subscription Tracker, Module 6, part 2 of 2: the daily schedule
--
-- RUN THIS LAST, after part 1, after the Vault secrets exist, after the
-- function is deployed, and after you have tested it by hand.
--
-- WHEN IT RUNS
--   '0 15 * * *' means minute 0, hour 15, every day, in UTC. That is 8am
--   Pacific in summer and 7am Pacific in winter. pg_cron only speaks UTC.
--
-- WHERE THE SECRET IS
--   Not here. Each time the job runs it reads the project URL and the shared
--   secret from Vault. Anyone who reads this job definition (for example in
--   cron.job) sees only the names of the Vault entries.
--
-- Safe to re-run: scheduling a job with a name that already exists replaces
-- it rather than creating a second one.
-- ============================================================================

select cron.schedule(
  'daily-renewal-reminders',
  '0 15 * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/send-renewal-reminder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-reminder-secret',
        (select decrypted_secret from vault.decrypted_secrets where name = 'reminder_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $job$
);


-- ============================================================================
-- CHECKING ON IT
--
--   Is it scheduled?
--     select jobid, jobname, schedule, active from cron.job;
--
--   Did it fire? (This is where you look if no reminder_runs row appears.)
--     select status, return_message, start_time
--     from cron.job_run_details order by start_time desc limit 5;
--
--   What did the function answer? (Kept for a few hours only.)
--     select status_code, content, created
--     from net._http_response order by created desc limit 5;
--
-- PAUSE / UNDO
--   Pause:  select cron.alter_job(
--             (select jobid from cron.job where jobname = 'daily-renewal-reminders'),
--             active := false);
--   Remove: select cron.unschedule('daily-renewal-reminders');
-- ============================================================================
