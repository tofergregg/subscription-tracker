-- ============================================================================
-- Subscription Tracker, Module 6: automation and monitoring
--
-- WHAT THIS FILE DOES
--   1. Adds a runs log, so an unattended failure leaves a trace
--   2. Adds one column that stops the same reminder being sent twice
--   3. Schedules the job that replaces the button press
--
-- HOW TO RUN IT
--   Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
--   Section 3 needs one value from you. Read its note before running.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. THE RUNS LOG
--
-- Up to now, a person clicked and a person watched what happened. From here
-- the job runs while nobody is there, which removes the only monitoring the
-- app ever had: your eyes. This table replaces them.
--
-- Four things it has to answer at eight in the morning: WHEN it ran, WHAT set
-- it off, WHAT it did, and WHETHER it worked. Everything else is decoration.
--
-- Note that a failure writes a row too. A log that only records successes is
-- not a log, it is a highlight reel.
-- ----------------------------------------------------------------------------
create table public.workflow_runs (
  id             uuid primary key default gen_random_uuid(),

  -- Null when a run failed before it could tell which household it was for.
  -- Recording a broken run anonymously beats not recording it.
  household_id   uuid references public.households(id) on delete cascade,

  ran_at         timestamptz not null default now(),

  -- 'manual' means somebody pressed the button. 'schedule' means the clock
  -- did. Worth separating: "it only ever works when I run it myself" is a
  -- diagnosis you can read straight off this column.
  trigger_source text not null check (trigger_source in ('manual', 'schedule')),

  reminders_sent integer not null default 0 check (reminders_sent >= 0),
  succeeded      boolean not null,

  -- Whatever the service actually said. Resist the urge to tidy this into a
  -- friendly message: the raw text is what tells you which of five possible
  -- problems you have.
  error          text
);

create index workflow_runs_recent_idx
  on public.workflow_runs (household_id, ran_at desc);

alter table public.workflow_runs enable row level security;

-- Members can read their own household's runs. Nobody writes from the browser:
-- rows are written by the edge functions using the service role, which is not
-- subject to these rules. No insert or update policy exists, on purpose, so a
-- compromised page cannot forge a clean run history.
create policy "workflow_runs: read own"
  on public.workflow_runs for select
  to authenticated
  using (household_id in (select h from public.my_household_ids() h));

-- ----------------------------------------------------------------------------
-- 2. NOT SENDING THE SAME REMINDER TWICE
--
-- The job runs daily and the reminder window is seven days wide, so without
-- this every upcoming renewal would email you seven mornings in a row. People
-- do not read the seventh email. They make a filter rule, and then they do not
-- read the one that matters either.
--
-- Storing the renewal DATE we last reminded about, rather than a yes/no flag,
-- means the next renewal of the same subscription reminds again on its own.
-- ----------------------------------------------------------------------------
alter table public.subscriptions
  add column last_reminded_for date;

comment on column public.subscriptions.last_reminded_for is
  'The next_renewal value we most recently sent a reminder about. Null means '
  'never reminded. Compared against next_renewal to decide whether a reminder '
  'is still owed for the current cycle.';

commit;

-- ============================================================================
-- 3. THE SCHEDULE
--
-- RUN THIS SECTION SEPARATELY, and read this first.
--
-- pg_cron runs a piece of SQL on a timer inside your database. pg_net lets
-- that SQL make an HTTP call. Together they are how a Postgres database wakes
-- your edge function up.
--
-- The credential problem, and why the vault is here. The scheduled function
-- has to prove the call came from your schedule rather than from a stranger
-- who found the URL. That proof is a shared secret, and a secret written
-- directly into a cron job definition is a secret stored in plain text in your
-- database, readable by anyone who can list your jobs.
--
-- So it goes in Supabase Vault, which is encrypted, and the job reads it out
-- at run time. Same principle as the Resend key in Module 3: the credential
-- lives somewhere built to hold credentials, and the thing that needs it
-- fetches it rather than embedding it.
--
-- BEFORE RUNNING: choose a long random string. Generate one with
--   openssl rand -hex 32
-- Use the SAME value in both places below:
--   supabase secrets set CRON_SECRET=<that string>
--   the create_secret call here
-- ============================================================================

-- create extension if not exists pg_cron  with schema extensions;
-- create extension if not exists pg_net   with schema extensions;
--
-- select vault.create_secret('PASTE_THE_SAME_RANDOM_STRING_HERE', 'cron_secret');
--
-- select cron.schedule(
--   'daily-renewal-reminders',
--   '0 15 * * *',                -- 15:00 UTC daily, which is 8am Pacific
--   $$
--   select net.http_post(
--     url     := 'https://rjmgqrnkuooqqitwbbrz.supabase.co/functions/v1/scheduled-reminders',
--     headers := jsonb_build_object(
--                  'Content-Type',  'application/json',
--                  'x-cron-secret', (select decrypted_secret
--                                      from vault.decrypted_secrets
--                                     where name = 'cron_secret')
--                ),
--     body    := '{}'::jsonb
--   );
--   $$
-- );

-- Useful afterwards:
--   select * from cron.job;                                  -- what is scheduled
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select cron.unschedule('daily-renewal-reminders');        -- turn it off
--
-- Note that cron.job_run_details tells you whether the HTTP call was MADE.
-- workflow_runs tells you whether the work SUCCEEDED. Those are different
-- questions and you will want both.
