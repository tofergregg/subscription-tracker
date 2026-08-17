-- ============================================================================
-- Subscription Tracker: database schema
--
-- HOW TO RUN THIS:
--   1. Open your Supabase project dashboard
--   2. Left sidebar -> SQL Editor -> "New query"
--   3. Paste this entire file in
--   4. Click "Run"
--
-- You only need to run this once. If you run it a second time it will stop
-- with an error like "relation already exists", which is harmless: it just
-- means the tables are already there.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. TABLES
-- ----------------------------------------------------------------------------

-- A "household" is a container for a list of subscriptions. Today every
-- account gets exactly one and you never see the word in the interface. It
-- exists so subscriptions belong to a GROUP rather than to a PERSON, which is
-- what makes sharing with someone later a small change instead of a migration.
create table public.households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default 'My Subscriptions',
  created_at  timestamptz not null default now()
);

-- Which people belong to which household. One row per person per household.
-- auth.users is the user table Supabase manages for you; you never write to it.
create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id)        on delete cascade,
  role         text not null default 'owner' check (role in ('owner', 'member')),
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- The actual data. One row per subscription.
create table public.subscriptions (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households(id) on delete cascade,

  name           text not null check (char_length(trim(name)) between 1 and 60),

  -- numeric(10,2), never a float. Floats give you 9.99 + 0.01 = 9.999999998.
  cost           numeric(10,2) not null check (cost >= 0),

  currency       text not null default 'USD' check (char_length(currency) = 3),

  -- Add 'weekly' or 'quarterly' to this list later and the app follows along.
  billing_period text not null check (billing_period in ('monthly', 'yearly')),

  next_renewal   date not null,

  rating         text not null default 'Like it'
                 check (rating in ('Love it', 'Like it', 'Meh', 'Cancel soon')),

  notes          text,

  -- For a future "archive instead of delete" feature, so cancelling a
  -- subscription doesn't erase your spending history.
  is_active      boolean not null default true,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);


-- ----------------------------------------------------------------------------
-- 2. INDEXES
--
-- The security rules below filter on these two columns on every single query,
-- so they need indexes or things get slow as the table grows.
-- ----------------------------------------------------------------------------

create index subscriptions_household_id_idx on public.subscriptions (household_id);
create index household_members_user_id_idx  on public.household_members (user_id);


-- ----------------------------------------------------------------------------
-- 3. KEEP updated_at HONEST
--
-- A "trigger" is a small piece of code the database runs automatically when
-- something happens. This one stamps the current time on every edit so you
-- don't have to remember to send it from the app.
-- ----------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger subscriptions_touch_updated_at
  before update on public.subscriptions
  for each row execute function public.touch_updated_at();


-- ----------------------------------------------------------------------------
-- 4. GIVE EVERY NEW USER A HOUSEHOLD
--
-- Fires when someone signs up. Creates their household and makes them its
-- owner, so the app never has to do it. "security definer" means this function
-- runs with elevated privileges, which is how it can write to tables that the
-- user themselves is not allowed to write to.
-- ----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_household_id uuid;
begin
  insert into public.households (name)
  values ('My Subscriptions')
  returning id into new_household_id;

  insert into public.household_members (household_id, user_id, role)
  values (new_household_id, new.id, 'owner');

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- Safety net: if any users already existed in this project before the trigger
-- was created, give them a household too. Does nothing if there are none.
do $$
declare
  u record;
  h uuid;
begin
  for u in
    select id from auth.users
    where id not in (select user_id from public.household_members)
  loop
    insert into public.households (name) values ('My Subscriptions') returning id into h;
    insert into public.household_members (household_id, user_id) values (h, u.id);
  end loop;
end $$;


-- ----------------------------------------------------------------------------
-- 5. ROW LEVEL SECURITY
--
-- This is what actually protects your data. RLS is a rule attached to a table
-- that Postgres enforces on EVERY query regardless of who is asking. A bug in
-- the app's JavaScript cannot leak your data, and neither can someone poking
-- at the API by hand with your publishable key.
--
-- Any table in the public schema WITHOUT this enabled is readable by anyone
-- who has your project URL. So: all three, no exceptions.
-- ----------------------------------------------------------------------------

alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.subscriptions     enable row level security;


-- Helper: which households does the current user belong to?
--
-- This is a separate function rather than an inline subquery for one reason.
-- If it were inline, and you later added a policy letting household members
-- see each other, the rules would reference each other in a loop and Postgres
-- would error with "infinite recursion detected in policy". "security definer"
-- sidesteps that permanently. "stable" lets Postgres call it once per query
-- instead of once per row.
create or replace function public.my_household_ids()
returns setof uuid
language sql
security definer
stable
set search_path = ''
as $$
  select household_id
  from public.household_members
  where user_id = auth.uid();
$$;

grant execute on function public.my_household_ids() to authenticated;


-- Note on style: every policy below names the "authenticated" role explicitly
-- and wraps auth.uid() as (select auth.uid()). The first stops anonymous
-- visitors cleanly; the second lets Postgres evaluate it once per query rather
-- than once per row. Both are current Supabase guidance.

-- You can see your own membership row, and nothing else.
create policy "household_members: read own"
  on public.household_members for select
  to authenticated
  using (user_id = (select auth.uid()));

-- You can see households you belong to.
create policy "households: read own"
  on public.households for select
  to authenticated
  using (id in (select h from public.my_household_ids() h));

-- There are deliberately NO insert/update/delete policies on households or
-- household_members. Nobody can create or reshuffle them from the browser;
-- only the signup trigger does that. Fewer moving parts, less to get wrong.

-- Subscriptions: full read and write, but only inside your own household.
create policy "subscriptions: read own"
  on public.subscriptions for select
  to authenticated
  using (household_id in (select h from public.my_household_ids() h));

create policy "subscriptions: insert own"
  on public.subscriptions for insert
  to authenticated
  with check (household_id in (select h from public.my_household_ids() h));

create policy "subscriptions: update own"
  on public.subscriptions for update
  to authenticated
  using      (household_id in (select h from public.my_household_ids() h))
  with check (household_id in (select h from public.my_household_ids() h));

create policy "subscriptions: delete own"
  on public.subscriptions for delete
  to authenticated
  using (household_id in (select h from public.my_household_ids() h));


-- ============================================================================
-- Done. Next: Authentication -> URL Configuration in the dashboard.
-- See SETUP.md for the exact values.
-- ============================================================================
