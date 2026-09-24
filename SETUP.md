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

---

# Modules 3, 4 and 5: the backend half

Everything above got the app storing data. This section adds the three things
that run on a server rather than in your browser: the cancellation email, the
AI summary, and the renewal reminders.

Do these in order. Steps 1 and 2 take about ten minutes and are one-time
account setup. Steps 3 to 6 are the ones you will repeat whenever a function
changes.

## Step 1: Run the Module 3 migration

Supabase dashboard -> SQL Editor -> New query. Paste `schema-module3-status.sql`
and Run. It adds the `status` column, sets every existing subscription to
Active, and adds an index that Modules 6 and 7 rely on.

Safe to run on live data: it is additive and wrapped in a transaction.

## Step 2: Get the two keys

**Resend**, for email. Sign up at resend.com on the free tier and create an API
key. You do **not** need a domain. The functions send from Resend's shared
`onboarding@resend.dev` address, which can only deliver to the address you
signed up with. That is exactly right for a course app and it is why nobody
following along has to buy anything.

**Anthropic**, for the AI summary. Create an API key at console.anthropic.com.

Neither key goes anywhere near `index.html`. That is the entire point of the
next three steps.

## Step 3: Install and link the Supabase CLI

```
brew install supabase/tap/supabase
supabase login
supabase link --project-ref rjmgqrnkuooqqitwbbrz
```

Run these from this folder. `link` is what connects the `supabase/` directory
here to the project in the dashboard.

## Step 4: Store the keys as secrets

```
supabase secrets set RESEND_API_KEY=re_your_key_here
supabase secrets set ANTHROPIC_API_KEY=sk-ant-your_key_here
```

These live on Supabase's servers. They are not in this repository, they are not
in the deployed page, and `supabase secrets list` shows you the names without
the values. Confirm with that command before moving on.

**Or do it in the dashboard**, which is the path the videos show and the one to
follow if you would rather not install the CLI: Dashboard -> your project ->
Edge Functions -> Secrets. Enter a Key and a Value, save, done. The list has a
reveal toggle so a stored value stays masked until you ask for it.

Either way, secrets take effect on the very next call. Changing one never needs
a redeploy.

## Step 5: Deploy the functions

```
supabase functions deploy
```

That deploys all three at once. To do one at a time:

```
supabase functions deploy notify-cancellation
supabase functions deploy summarize-subscriptions
supabase functions deploy send-renewal-reminder
```

## Step 6: Prove each one works

**Cancellation email.** Edit any subscription, set Status to Cancelled, save.
The row greys out, the countdown disappears, and an email arrives. Then edit it
again and try to set it back to Active: the app should refuse, in words,
without saving anything.

**AI summary.** Click Summarize. Three or four bullets appear, the first naming
your monthly total.

**Renewal reminders.** Set one subscription's renewal date to tomorrow, then
click Email reminders. One email arrives and the pill reads "1 reminder sent".
If nothing is due it says "Nothing due", which is correct behavior, not a
failure.

## Things that will confuse you later

**A function call fails with nothing in the logs.** That is almost always CORS,
which means the browser blocked the response before your code ever saw it.
Check `supabase/functions/_shared/cors.ts` is imported and that the function
answers the `OPTIONS` request.

**The AI summary returns a model error.** Model names get retired. Do not edit
the function; set a current one as a secret instead:

```
supabase secrets set CLAUDE_MODEL=<current-model-id>
```

**Your key is from a university or company rather than from Anthropic.** Many
organizations run a gateway in front of the AI providers so that billing and
access go through one place, and a key issued that way works only against the
gateway. Sending it to Anthropic directly returns a 401 saying the key is
invalid, which is true from Anthropic's point of view: they have never seen it.

Gateways almost always speak the OpenAI dialect rather than Anthropic's, so
this is not just a different address. Two secrets switch the function over:

```
supabase secrets set AI_GATEWAY_URL=https://your-gateway/v1/chat/completions
supabase secrets set CLAUDE_MODEL=<the model id your gateway lists>
```

For Stanford's AI API Gateway that URL is
`https://aiapi-prod.stanford.edu/v1/chat/completions`, and the model ids are
the gateway's own aliases rather than Anthropic's, listed in the Stanford KB
article. Leave `AI_GATEWAY_URL` unset to talk to Anthropic directly, which is
what you want with a personal key.

**Telling these two apart is worth learning.** A 401 means your request
arrived somewhere real and was refused, so the address is right and the
credential is wrong. A 404, or a connection that never opens, means you are
talking to the wrong place entirely. People conflate these constantly and
spend an afternoon regenerating a key that was fine.

**Email stops arriving after a burst.** The Resend free tier is rate limited.
Fine for one person testing. It is also why Module 6 builds a runs log: once
this is on a schedule, you need to see the failures you are no longer present
for.

**Changing a secret does not need a redeploy.** Functions read secrets at run
time. Changing a key takes effect on the next call.
