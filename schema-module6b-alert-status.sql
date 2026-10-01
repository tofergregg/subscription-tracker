-- ============================================================================
-- Subscription Tracker, Module 6b: record whether the failure alert was sent
--
-- WHAT THIS FILE IS
--   An additive migration. Two new columns on reminder_runs, two rules about
--   them, and a lock that keeps a run's original record from ever changing.
--   Nothing else is touched.
--
-- HOW TO RUN IT
--   Supabase dashboard -> SQL Editor -> New query -> paste this whole file ->
--   Run. Wrapped in a transaction: if anything fails, nothing is applied.
--
-- RUN THIS BEFORE redeploying send-renewal-reminder.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. THE TWO NEW COLUMNS
--
-- alert_sent
--   true   the failure alert went out
--   false  the alert was attempted and did not go out (see alert_error)
--   null   on a successful run: no alert was needed
--   null   on a failed run: the alert's outcome could not be saved; the
--          function logs say why
--
-- alert_error
--   What went wrong with the alert. Only ever filled in when alert_sent is
--   false. This is a separate column from `error` on purpose: the run's
--   original failure lives in `error` and is never overwritten.
--
-- Existing rows get null in both, which reads correctly as "not recorded".
-- ----------------------------------------------------------------------------

alter table public.reminder_runs
  add column alert_sent  boolean,
  add column alert_error text;

alter table public.reminder_runs
  add constraint reminder_runs_no_alert_on_success
    check (not succeeded or (alert_sent is null and alert_error is null)),
  add constraint reminder_runs_alert_error_only_when_unsent
    check (alert_error is null or alert_sent = false);

comment on column public.reminder_runs.alert_sent is
  'Failed runs only: true if the operator alert email went out, false if it '
  'was attempted and failed. Null on successful runs, or if the outcome could '
  'not be saved.';
comment on column public.reminder_runs.alert_error is
  'Why the operator alert failed. Separate from error, which holds the run''s '
  'own failure and is never changed.';


-- ----------------------------------------------------------------------------
-- 2. THE LOCK
--
-- Once a run's row is written, its original record (when, trigger, sent,
-- succeeded, error) can never be changed, by the function or by anyone else.
-- Only the two alert columns may be filled in afterwards. This makes "the
-- alert's error must never replace the original" a rule the database
-- enforces, not just a promise in the code.
--
-- Deleting rows is not affected.
-- ----------------------------------------------------------------------------

create or replace function public.reminder_runs_lock_original()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id        is distinct from old.id
  or new.ran_at    is distinct from old.ran_at
  or new.trigger   is distinct from old.trigger
  or new.sent      is distinct from old.sent
  or new.succeeded is distinct from old.succeeded
  or new.error     is distinct from old.error
  then
    raise exception
      'reminder_runs rows are a permanent record. Only alert_sent and '
      'alert_error can be filled in after a row is written.';
  end if;
  return new;
end;
$$;

create trigger reminder_runs_lock_original
  before update on public.reminder_runs
  for each row execute function public.reminder_runs_lock_original();


commit;


-- ============================================================================
-- UNDO (run on its own)
--
--   begin;
--     drop trigger if exists reminder_runs_lock_original on public.reminder_runs;
--     drop function if exists public.reminder_runs_lock_original();
--     alter table public.reminder_runs
--       drop constraint if exists reminder_runs_alert_error_only_when_unsent,
--       drop constraint if exists reminder_runs_no_alert_on_success,
--       drop column if exists alert_error,
--       drop column if exists alert_sent;
--   commit;
--
-- To correct a row by hand, drop just the trigger, make the fix, then run
-- section 2 of this file again to put the lock back.
-- ============================================================================
