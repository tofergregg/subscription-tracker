-- ============================================================================
-- Subscription Tracker, Module 6, part 1 of 2: reminder bookkeeping
--
-- WHAT THIS FILE IS
--   An additive migration. It creates two new tables and two small helper
--   functions, and turns on two database extensions. It does not change the
--   subscriptions table or any existing security rule.
--
-- HOW TO RUN IT
--   Supabase dashboard -> SQL Editor -> New query -> paste this whole file ->
--   Run. Wrapped in a transaction: if anything fails, nothing is applied.
--
-- RUN THIS BEFORE deploying the updated send-renewal-reminder function. The
-- new function writes to these tables, so deploying first would break the
-- Email reminders button until this file is run.
--
-- The schedule itself is in part 2 (schema-module6-schedule-job.sql), which
-- you run last, after testing.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. EXTENSIONS
--
-- pg_cron : the database's built-in job scheduler.
-- pg_net  : lets the database make a web request, which is how the scheduled
--           job calls the edge function.
-- ----------------------------------------------------------------------------

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;


-- ----------------------------------------------------------------------------
-- 2. THE RUNS LOG
--
-- One row per run of send-renewal-reminder, whether the button or the
-- schedule started it, and whether it worked or not.
-- ----------------------------------------------------------------------------

create table public.reminder_runs (
  id        bigint generated always as identity primary key,
  ran_at    timestamptz not null default now(),
  trigger   text not null check (trigger in ('schedule', 'manual')),
  sent      integer not null default 0 check (sent >= 0),
  succeeded boolean not null,
  error     text
);

create index reminder_runs_ran_at_idx on public.reminder_runs (ran_at desc);


-- ----------------------------------------------------------------------------
-- 3. WHICH RENEWALS HAVE ALREADY BEEN REMINDED ABOUT
--
-- One row per subscription per renewal date. The primary key on the pair is
-- what makes "never twice" a rule the database enforces, not just a hope.
--
-- A separate table, not a column on subscriptions, for two reasons:
--   - the updated_at trigger on subscriptions would change that column every
--     time a reminder was marked, which would count as editing your data;
--   - the browser is allowed to edit subscription rows, so it could clear a
--     column there. It cannot write to this table at all.
--
-- If you change a subscription's renewal date, the new date has no row here,
-- so it becomes eligible for a reminder again. That is intended.
--
-- "on delete cascade" only matters when YOU delete a subscription in the app:
-- its reminder history goes with it. The scheduled job never deletes.
-- ----------------------------------------------------------------------------

create table public.reminders_sent (
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  renewal_date    date not null,
  sent_at         timestamptz not null default now(),
  primary key (subscription_id, renewal_date)
);


-- ----------------------------------------------------------------------------
-- 4. SECURITY: THE BROWSER CAN READ, NEVER WRITE
--
-- Row level security on, read policies only. With no insert, update or
-- delete policy, the browser is refused every write. The revoke lines are a
-- second lock on the same door. Only the edge function, using the server-side
-- admin key, can write here.
-- ----------------------------------------------------------------------------

alter table public.reminder_runs  enable row level security;
alter table public.reminders_sent enable row level security;

-- Any signed-in user can read the runs log. It holds counts and generic error
-- text only, never subscription names, because one scheduled run covers
-- every household.
create policy "reminder_runs: read"
  on public.reminder_runs for select
  to authenticated
  using (true);

-- You can see reminder records only for your own household's subscriptions.
create policy "reminders_sent: read own"
  on public.reminders_sent for select
  to authenticated
  using (
    exists (
      select 1 from public.subscriptions s
      where s.id = subscription_id
        and s.household_id in (select h from public.my_household_ids() h)
    )
  );

revoke insert, update, delete, truncate on public.reminder_runs  from anon, authenticated;
revoke insert, update, delete, truncate on public.reminders_sent from anon, authenticated;


-- ----------------------------------------------------------------------------
-- 5. HELPER: IS THIS THE RIGHT SECRET?
--
-- The edge function calls this to check the schedule's header against the
-- value in Vault. The secret is kept in exactly one place. Only the server's
-- admin role may call this; the browser cannot use it to guess.
-- ----------------------------------------------------------------------------

create or replace function public.reminder_cron_secret_ok(candidate text)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'reminder_cron_secret'
      and decrypted_secret = candidate
  );
$$;

revoke execute on function public.reminder_cron_secret_ok(text) from public, anon, authenticated;
grant  execute on function public.reminder_cron_secret_ok(text) to service_role;


-- ----------------------------------------------------------------------------
-- 6. HELPER: WHO SHOULD GET A HOUSEHOLD'S REMINDERS?
--
-- Every member's email address. Email addresses live in auth.users, which the
-- edge function cannot read directly. Admin role only.
-- ----------------------------------------------------------------------------

create or replace function public.reminder_recipients(p_household_ids uuid[])
returns table (household_id uuid, email text)
language sql
security definer
stable
set search_path = ''
as $$
  select m.household_id, u.email::text
  from public.household_members m
  join auth.users u on u.id = m.user_id
  where m.household_id = any (p_household_ids)
    and u.email is not null;
$$;

revoke execute on function public.reminder_recipients(uuid[]) from public, anon, authenticated;
grant  execute on function public.reminder_recipients(uuid[]) to service_role;


commit;


-- ============================================================================
-- UNDO (run on its own; run the undo in part 2 first if you ran part 2)
--
--   begin;
--     drop function if exists public.reminder_recipients(uuid[]);
--     drop function if exists public.reminder_cron_secret_ok(text);
--     drop table if exists public.reminders_sent;
--     drop table if exists public.reminder_runs;
--   commit;
--
-- The extensions are left on; they are harmless when nothing uses them.
-- ============================================================================
