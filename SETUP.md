# Setup

Three steps, about ten minutes. Do them in order: the app will show you a clear
error message if step 1 hasn't happened yet.

---

## Step 1: Create the tables

1. Open your Supabase dashboard: <https://supabase.com/dashboard/project/rjmgqrnkuooqqitwbbrz>
2. Left sidebar → **SQL Editor** → **New query**
3. Open `schema.sql` from this folder, copy the whole thing, paste it in
4. Click **Run**

You should see "Success. No rows returned." That is what success looks like for
this kind of script.

To confirm: left sidebar → **Table Editor**. You should see three tables:
`households`, `household_members`, `subscriptions`. All three will show a
green **RLS enabled** label. If any table says RLS is *not* enabled, stop and
tell me, because that would mean the data is publicly readable.

---

## Step 2: Tell Supabase where your app lives

Left sidebar → **Authentication** → **URL Configuration**.

**Site URL:**

```
https://subscription-tracker-five-flax.vercel.app
```

**Redirect URLs** — click "Add URL" and add these two, exactly as written,
including the `/**` on the end:

```
http://localhost:8000/**
https://subscription-tracker-five-flax.vercel.app/**
```

The `/**` means "any path on this domain." Without it you get a baffling
"requested path is invalid" error when you click your sign-in link.

Click **Save**.

> One thing not to do: do not add the long Vercel URL with the random hash in
> it (`subscription-tracker-9plflm09q-...`). Vercel generates a fresh one on
> every deploy, so it would work today and break tomorrow.

---

## Step 3: Run it on your machine

**This part changed.** The old version opened by double-clicking the file.
That no longer works, because browsers refuse to run sign-in code from a
`file://` address. You need a local web server, which sounds heavier than it is:

```
cd "/Users/cgregg/Documents/Claude/Projects/Subscription Tracker"
python3 -m http.server 8000
```

Then open <http://localhost:8000> in your browser. Press `Ctrl-C` in the
terminal to stop it.

Port 8000 matters: it has to match the `localhost:8000` you allow-listed in
step 2.

---

## First sign-in

Type your email, click the button, wait for the email, click the link. You land
back in the app signed in.

If your browser still has subscriptions from the old version, you'll get a
one-time prompt offering to copy them into your account. Your browser copy is
never deleted, so if the import goes wrong nothing is lost.

You stay signed in for weeks. The session refreshes itself.

---

## Deploying

Nothing new to configure. Commit and push, and Vercel picks it up:

```
git add -A
git commit -m "Store data in Supabase, add magic-link sign-in"
git push
```

The app asks the browser where it is running and sends your sign-in link back
to the same place, so localhost and production both work from this one file.

---

## Things that will confuse you later

**Sign-in emails stop arriving.** Supabase's built-in mailer is rate-limited to
a handful of messages per hour and is explicitly meant for testing. Fine for
you alone. The moment you share this with a few people, connect a real email
provider under Authentication → Emails → SMTP Settings. Resend and Postmark
both have free tiers.

**On a phone, tapping the link opens a different browser.** The link opens in
whatever browser your mail app prefers, and you end up signed in over there
rather than where you started. Usually harmless. If it becomes annoying, the
fix is switching the email to send a 6-digit code you type instead. Small
change, just ask.

**The key in `index.html` is public and that is correct.** It is committed to
your public repo on purpose. It identifies the project; it does not grant
access. The Row Level Security rules from step 1 are the actual lock. The key
that must never go in this file is the **secret** key, which bypasses those
rules entirely.

**Renewal dates don't advance on their own.** When a date passes, the app now
shows a grey "Renewal date has passed" badge rather than silently pretending it
is upcoming, but you still have to edit the date yourself. Making renewals roll
forward automatically is a real feature worth doing next.

---

## If something goes wrong

**"Your account has no subscription list yet"** — step 1 didn't run, or ran
before you signed up. Run `schema.sql`, then sign out and back in.

**Clicking the sign-in link gives "requested path is invalid"** — the URL you
opened the app at isn't in the step 2 allow list. Check the port is 8000.

**Sign-in seems to work but the app hangs on "Loading…"** — open your browser's
developer console (Cmd-Option-J in Chrome) and send me what it says in red.

**Anything else** — the console is the first place to look, and its output is
usually enough for me to identify the problem.
