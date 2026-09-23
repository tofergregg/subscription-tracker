-- ============================================================================
-- Subscription Tracker, Module 3: subscription status
--
-- WHAT THIS FILE IS
--   A migration. It adds ONE new column to a table that already exists and
--   already holds data. Unlike the Module 2 migration, this one is additive
--   and safe: nothing that works today stops working after you run it.
--
-- HOW TO RUN IT
--   1. Supabase dashboard -> SQL Editor -> "New query"
--   2. Paste this whole file in
--   3. Click "Run"
--   Wrapped in a transaction, so a failure anywhere leaves the database
--   exactly as it was.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. THE STATUS COLUMN
--
-- Why a new column rather than reusing something we already have.
--
-- The app already stores a `rating`: Love it, Like it, Meh, Cancel soon. That
-- is an OPINION. It records how you feel about a subscription. Nowhere does
-- the app record the FACT of whether you are still paying for it. "Cancel
-- soon" means "I have decided I am done." It does not mean you have actually
-- cancelled anything.
--
-- So status and rating stay separate and neither one is derived from the
-- other. The rating carries the intent; the status carries the fact.
--
-- There is also an `is_active` boolean already on this table, and the two are
-- easy to confuse, so be clear about the difference:
--
--   is_active  = is this row still in your list at all? It exists for a future
--                "archive instead of delete" feature. The app filters on it.
--   status     = are you still PAYING for this subscription?
--
-- A Cancelled subscription is still is_active = true. It stays in your list,
-- visibly cancelled, because the whole point is to keep the history.
--
-- A default of 'Active' is what quietly migrates your existing rows: every
-- subscription already in the table gets 'Active' the moment this runs, which
-- is the correct reading of the data you have. The default stays afterwards so
-- the app does not have to send a status on every insert.
-- ----------------------------------------------------------------------------

alter table public.subscriptions
  add column status text not null default 'Active'
    check (status in ('Active', 'Cancelled'));

comment on column public.subscriptions.status is
  'Whether this subscription is still being paid for. Active or Cancelled. '
  'Cancelled is terminal: see the rule enforced in index.html. Distinct from '
  'rating, which records an opinion, and from is_active, which records whether '
  'the row is in the list at all.';

-- ----------------------------------------------------------------------------
-- 2. AN INDEX, BECAUSE THE APP WILL FILTER ON THIS
--
-- Module 6 adds a scheduled job that looks for upcoming renewals, and Module 7
-- computes totals from Active rows only. Both of those filter on status, and a
-- column you filter on routinely is a column that wants an index.
-- ----------------------------------------------------------------------------

create index subscriptions_status_idx
  on public.subscriptions (household_id, status);

commit;

-- ============================================================================
-- OPTIONAL: THE SAME RULE, ENFORCED IN THE DATABASE
--
-- The app enforces "Cancelled is terminal" in its logic layer, which is the
-- right place for it in this course and is what you will see on screen.
--
-- But it is worth knowing that the question exists, because a rule that must
-- NEVER be violated, no matter what code is talking to the database, belongs
-- in the database too. App logic protects you from your app's mistakes. A
-- database constraint protects you from every other client as well: a script,
-- a colleague in the SQL Editor, a second app you write next year.
--
-- This is the same rule as a trigger. It is left commented out on purpose: if
-- you enable it, a bug in the app surfaces as a raw Postgres error rather than
-- the friendly message the app shows, which is a worse experience for someone
-- learning. Enable it when the app is no longer the only thing writing here.
--
-- create or replace function public.enforce_terminal_cancelled()
-- returns trigger
-- language plpgsql
-- as $$
-- begin
--   if old.status = 'Cancelled' and new.status <> 'Cancelled' then
--     raise exception
--       'Cancelled is final. Add a new subscription instead, because signing '
--       'up again usually means a different price and renewal date.';
--   end if;
--   return new;
-- end;
-- $$;
--
-- create trigger subscriptions_terminal_cancelled
--   before update on public.subscriptions
--   for each row
--   execute function public.enforce_terminal_cancelled();
-- ============================================================================
