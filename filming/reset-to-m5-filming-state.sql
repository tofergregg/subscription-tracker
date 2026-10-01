-- ============================================================================
-- Reset the BACKEND to Module 5 state, ready to film video 6.3
--
-- Git rewinds with a checkout. This does not: your database, your deployed
-- functions and your scheduled jobs are shared state that no tag touches.
-- Run this whenever a rehearsal or a previous take has moved them forward.
--
-- Safe to run more than once. Every statement tolerates the thing already
-- being absent.
--
-- WHAT IT DOES NOT TOUCH
--   The Module 3 status column, your households, your categories, or any
--   subscription's name, cost or dates. This rewinds Module 6 and 7 only.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Stop the schedule
-- ----------------------------------------------------------------------------
do $$
begin
  perform cron.unschedule('daily-renewal-reminders');
exception
  when others then
    raise notice 'No schedule to remove, which is fine.';
end $$;

-- ----------------------------------------------------------------------------
-- 2. Remove the Module 6 objects
--
-- These are the objects the filmed 6.3 and 6.4 takes actually created
-- (schema-module6-scheduled-reminders.sql and schema-module6b-alert-status.sql
-- at tag m6-end). Dropping the tables throws away your rehearsal run history,
-- which is the point: 6.3 has to open with no runs log in existence.
-- ----------------------------------------------------------------------------

-- 6.4: the trigger that locks finished runs, and its function.
drop trigger if exists reminder_runs_lock_original on public.reminder_runs;
drop function if exists public.reminder_runs_lock_original();

-- 6.3: the helper functions, then the two tables.
drop function if exists public.reminder_recipients(uuid[]);
drop function if exists public.reminder_cron_secret_ok(text);
drop table if exists public.reminders_sent;
drop table if exists public.reminder_runs;

-- 6.3: the Vault entries the schedule reads. The video creates the cron
-- secret on camera, so it must not already be listed. project_url is
-- recreated by the same build.
delete from vault.secrets where name in ('reminder_cron_secret', 'project_url');

-- Older rehearsals used these names. Harmless if they never existed.
delete from vault.secrets where name = 'cron_secret';
drop table if exists public.workflow_runs;
alter table public.subscriptions drop column if exists last_reminded_for;

-- ----------------------------------------------------------------------------
-- 3. Put the data back to a filmable state
--
-- Cancelled is TERMINAL in the app, deliberately, so a subscription you
-- cancelled during a rehearsal cannot be reactivated from the interface. That
-- rule protects your real data; it is not meant to stop you resetting a set.
-- Going around it here, in SQL, is exactly the escape hatch the Module 3 video
-- describes when it says a rule belongs in the logic layer.
-- ----------------------------------------------------------------------------
update public.subscriptions
   set status = 'Active'
 where status = 'Cancelled';

-- Remove anything a rehearsal added. Adjust the pattern if you named your
-- adversarial entry something else.
delete from public.subscriptions
 where name ilike 'ignore previous instructions%'
    or name ilike 'disregard%';

-- ----------------------------------------------------------------------------
-- 4. Set up the shot
--
-- 6.3 needs exactly one subscription renewing tomorrow, so the live test sends
-- one email and the runs log shows one reminder. More than one and the demo
-- gets noisy; none and there is nothing to show.
--
-- Change the name to whichever subscription you want on camera.
-- ----------------------------------------------------------------------------
update public.subscriptions
   set next_renewal = current_date + 1
 where name = 'FitTrack+';

-- Push everything else comfortably out of the seven-day window.
update public.subscriptions
   set next_renewal = current_date + 25
 where name <> 'FitTrack+'
   and next_renewal < current_date + 8;

-- ----------------------------------------------------------------------------
-- NOT DONE HERE: the deployed function, and the dashboard secrets
--
-- The function. A checkout does not change what is running on the server.
-- From a checkout of m5-end, run:
--
--   supabase functions deploy send-renewal-reminder
--
-- That puts the Module 5 version back, along with verify_jwt = true from that
-- checkout's config.toml. Skip it and the Email reminders button still runs
-- the Module 6 code. The other two functions did not change in Module 6.
--
-- The secrets. SQL cannot reach the Edge Function secrets, so delete these by
-- hand under Dashboard -> Edge Functions -> Secrets. The Custom secrets panel
-- lists every key by name, so one sitting there beforehand contradicts a take:
--
--   ALERT_EMAIL    created during video 6.4
--   CRON_SECRET    only if an older rehearsal created it (the filmed build
--                  keeps its cron secret in Vault, which section 2 removes)
--
-- Leave RESEND_API_KEY, ANTHROPIC_API_KEY, AI_GATEWAY_URL and CLAUDE_MODEL
-- alone. Those exist by Module 5 and belong on screen.
--
-- Note also that the secrets panel shows a truncated prefix of every value with
-- no way to hide it. Use a throwaway Resend key for the shoot and delete it
-- afterwards.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 5. Confirm where you are
--
-- Expect: has_status true, has_runs_log false, has_sent_log false,
-- has_schedule false, due_tomorrow 1.
-- ----------------------------------------------------------------------------
select
  exists (select 1 from information_schema.columns
           where table_name = 'subscriptions' and column_name = 'status')
    as has_status,
  to_regclass('public.reminder_runs') is not null
    as has_runs_log,
  to_regclass('public.reminders_sent') is not null
    as has_sent_log,
  exists (select 1 from cron.job where jobname = 'daily-renewal-reminders')
    as has_schedule,
  (select count(*) from public.subscriptions
    where status = 'Active' and next_renewal = current_date + 1)
    as due_tomorrow;
