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
-- Dropping workflow_runs throws away your rehearsal run history, which is the
-- point: 6.3 has to open with no runs log in existence.
-- ----------------------------------------------------------------------------
drop table if exists public.workflow_runs;

alter table public.subscriptions
  drop column if exists last_reminded_for;

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
-- 5. Confirm where you are
--
-- Expect: has_status true, has_runs_log false, has_reminded_column false,
-- due_tomorrow 1.
-- ----------------------------------------------------------------------------
select
  exists (select 1 from information_schema.columns
           where table_name = 'subscriptions' and column_name = 'status')
    as has_status,
  to_regclass('public.workflow_runs') is not null
    as has_runs_log,
  exists (select 1 from information_schema.columns
           where table_name = 'subscriptions' and column_name = 'last_reminded_for')
    as has_reminded_column,
  (select count(*) from public.subscriptions
    where status = 'Active' and next_renewal = current_date + 1)
    as due_tomorrow;
