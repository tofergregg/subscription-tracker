// ============================================================================
// Module 5 + 6: send-renewal-reminder
//
// WHAT THIS IS
//   The action behind the "Email reminders" button, and (since Module 6) the
//   action the daily schedule runs. It looks for subscriptions renewing in the
//   next seven days and emails one reminder for each one.
//
// TWO WAYS IN, ONE ACTION
//   manual   : a signed-in person clicks the button. Reads THEIR household's
//              subscriptions (the database's security rules still apply) and
//              emails them. Sends everything in the window, every time.
//   schedule : pg_cron calls this once a day with a shared secret header. No
//              one is signed in, so it uses the server-side admin key to read
//              every household, skips renewals already reminded about, and
//              emails every member of the owning household.
//
//   Both paths send through the same sendReminderEmail() below. There is
//   only one copy of the email.
//
// WHAT IT WRITES
//   reminders_sent : one row per (subscription, renewal date), written only
//                    after Resend accepts the email.
//   reminder_runs  : one row per run, success or failure.
//   It never cancels, deletes, or edits a subscription.
//
// SETUP
//   Uses the same RESEND_API_KEY secret as notify-cancellation. Nothing new.
//   SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided
//   to every edge function automatically.
//   supabase functions deploy send-renewal-reminder
// ============================================================================

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const FROM = "Subscription Tracker <onboarding@resend.dev>";
const WINDOW_DAYS = 7;

// "Today" is your calendar day in California, not the server's (UTC). Without
// this, an evening click in Pacific time would count from tomorrow.
const TIME_ZONE = "America/Los_Angeles";

// The header the schedule uses to prove itself. Its value lives in Vault.
const SECRET_HEADER = "x-reminder-secret";

type Trigger = "schedule" | "manual";

type Sub = {
  id: string;
  household_id?: string;
  name: string;
  cost: number;
  billing_period: string;
  next_renewal: string; // YYYY-MM-DD
  auto_renew: boolean | null;
};

// Shared counters, so that even if a run crashes halfway, the log can record
// how many emails had already gone out.
type Tally = { sent: number; failures: string[]; statuses: number[] };

function money(n: number): string {
  return "$" + Number(n).toFixed(2);
}

// Today's date in TIME_ZONE, as YYYY-MM-DD.
function todayInZone(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Calendar arithmetic on a YYYY-MM-DD string. Done in UTC so that daylight
// saving changes can never make a "day" 23 or 25 hours long.
function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// ----------------------------------------------------------------------------
// THE EMAIL. The one and only copy. Subject and body are exactly what the
// button has always sent.
// ----------------------------------------------------------------------------
async function sendReminderEmail(
  apiKey: string,
  to: string[],
  sub: Sub,
): Promise<{ ok: true } | { ok: false; status: number }> {
  const verb = sub.auto_renew === false ? "expires" : "renews";
  const subject = `${sub.name} ${verb} soon`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to,
      subject,
      text:
        `${sub.name} ${verb} on ${sub.next_renewal}.\n\n` +
        `Cost: ${money(sub.cost)} per ${sub.billing_period === "yearly" ? "year" : "month"}.\n\n` +
        (sub.auto_renew === false
          ? `This one does not renew on its own. If you want to keep it, you have to act.\n`
          : `This one charges you automatically. If you do not want it, now is the time.\n`),
    }),
  });

  if (res.ok) return { ok: true };
  const detail = await res.text();
  console.error(`Reminder failed for ${sub.name}:`, res.status, detail);
  return { ok: false, status: res.status };
}

// Record that this renewal has been covered. Called ONLY after Resend accepts
// the email. If the row already exists (the button sent it earlier), this
// quietly does nothing.
async function markSent(admin: SupabaseClient, sub: Sub): Promise<void> {
  const { error } = await admin
    .from("reminders_sent")
    .upsert(
      { subscription_id: sub.id, renewal_date: sub.next_renewal },
      { onConflict: "subscription_id,renewal_date", ignoreDuplicates: true },
    );
  if (error) {
    // The email DID go out, so it still counts as sent. The only consequence
    // is that tomorrow's run may send it once more.
    console.error(`Could not record reminder for ${sub.id}:`, error.message);
  }
}

function requireApiKey(): string {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY is not set on this project.");
  return apiKey;
}

// ----------------------------------------------------------------------------
// MANUAL: the button. Same query and same recipient as before Module 6.
// ----------------------------------------------------------------------------
async function runManual(
  userClient: SupabaseClient,
  admin: SupabaseClient,
  email: string,
  today: string,
  horizon: string,
  tally: Tally,
): Promise<void> {
  // `status = Active` because a cancelled subscription is not renewing.
  // `is_active` because the row might have been archived out of the list.
  const { data: rows, error } = await userClient
    .from("subscriptions")
    .select("id, name, cost, billing_period, next_renewal, auto_renew")
    .eq("is_active", true)
    .eq("status", "Active")
    .gte("next_renewal", today)
    .lte("next_renewal", horizon)
    .order("next_renewal", { ascending: true });

  if (error) throw new Error(error.message);
  const due = (rows ?? []) as Sub[];
  if (due.length === 0) return;

  const apiKey = requireApiKey();

  for (const sub of due) {
    const result = await sendReminderEmail(apiKey, [email], sub);
    if (result.ok) {
      tally.sent++;
      await markSent(admin, sub);
    } else {
      tally.failures.push(`${sub.name}: ${result.status}`);
      tally.statuses.push(result.status);
    }
  }
}

// ----------------------------------------------------------------------------
// SCHEDULE: every household, skipping renewals already reminded about.
// ----------------------------------------------------------------------------
async function runScheduled(
  admin: SupabaseClient,
  today: string,
  horizon: string,
  tally: Tally,
): Promise<void> {
  const { data: rows, error } = await admin
    .from("subscriptions")
    .select("id, household_id, name, cost, billing_period, next_renewal, auto_renew")
    .eq("is_active", true)
    .eq("status", "Active")
    .gte("next_renewal", today)
    .lte("next_renewal", horizon)
    .order("next_renewal", { ascending: true });

  if (error) throw new Error(error.message);
  const upcoming = (rows ?? []) as Sub[];
  if (upcoming.length === 0) return;

  // Which of these renewals already have a reminder on record?
  const { data: done, error: doneError } = await admin
    .from("reminders_sent")
    .select("subscription_id, renewal_date")
    .in("subscription_id", upcoming.map((s) => s.id));
  if (doneError) throw new Error(doneError.message);

  const covered = new Set(
    (done ?? []).map((r: { subscription_id: string; renewal_date: string }) =>
      `${r.subscription_id}|${r.renewal_date}`
    ),
  );
  const due = upcoming.filter((s) => !covered.has(`${s.id}|${s.next_renewal}`));
  if (due.length === 0) return;

  // Who should hear about each household's renewals? Every member.
  const householdIds = [...new Set(due.map((s) => s.household_id!))];
  const { data: people, error: peopleError } = await admin.rpc(
    "reminder_recipients",
    { p_household_ids: householdIds },
  );
  if (peopleError) throw new Error(peopleError.message);

  const recipients = new Map<string, string[]>();
  for (const p of (people ?? []) as { household_id: string; email: string }[]) {
    const list = recipients.get(p.household_id) ?? [];
    list.push(p.email);
    recipients.set(p.household_id, list);
  }

  const apiKey = requireApiKey();

  for (const sub of due) {
    const to = recipients.get(sub.household_id!) ?? [];
    if (to.length === 0) {
      // Not marked, so it is retried tomorrow rather than silently dropped.
      tally.failures.push(`${sub.name}: no recipients`);
      continue;
    }
    const result = await sendReminderEmail(apiKey, to, sub);
    if (result.ok) {
      tally.sent++;
      await markSent(admin, sub);
    } else {
      tally.failures.push(`${sub.name}: ${result.status}`);
      tally.statuses.push(result.status);
    }
  }
}

// ----------------------------------------------------------------------------
// THE RUNS LOG. One row per run. Must never throw: a broken log should not
// turn a successful run into a failed response.
//
// The error text never includes subscription names, because every signed-in
// user can read this table and a scheduled run covers every household.
// ----------------------------------------------------------------------------
async function logRun(
  admin: SupabaseClient,
  trigger: Trigger,
  sent: number,
  succeeded: boolean,
  error: string | null,
): Promise<void> {
  const { error: insertError } = await admin.from("reminder_runs").insert({
    trigger,
    sent,
    succeeded,
    error: error ? error.slice(0, 500) : null,
  });
  if (insertError) {
    console.error("Could not write reminder_runs row:", insertError.message);
  }
}

function failureSummary(tally: Tally): string {
  const n = tally.failures.length;
  const codes = [...new Set(tally.statuses)].join(", ");
  const noRecipients = tally.failures.length - tally.statuses.length;
  let msg = `${n} reminder(s) failed to send.`;
  if (codes) msg += ` Resend status: ${codes}.`;
  if (noRecipients > 0) msg += ` ${noRecipients} had no recipient.`;
  return msg;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;

  // The admin client bypasses row level security. It is used for: checking
  // the schedule's secret, the scheduled read across households, and writing
  // reminders_sent and reminder_runs, which the browser cannot write.
  const admin = createClient(
    supabaseUrl,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // --------------------------------------------------------------------------
  // GATE. Nothing below this runs unless the caller is the schedule (correct
  // secret) or a signed-in person. Rejected calls are not logged, so no one
  // on the internet can fill the runs log.
  // --------------------------------------------------------------------------
  let trigger: Trigger;
  let userClient: SupabaseClient | null = null;
  let userEmail = "";

  const presented = req.headers.get(SECRET_HEADER);
  if (presented) {
    const { data: ok, error } = await admin.rpc("reminder_cron_secret_ok", {
      candidate: presented,
    });
    if (error) {
      console.error("Secret check failed:", error.message);
      return jsonResponse({ error: "Could not verify the request." }, 500);
    }
    if (ok !== true) {
      return jsonResponse({ error: "Not allowed." }, 401);
    }
    trigger = "schedule";
  } else {
    const authHeader = req.headers.get("Authorization") ?? "";
    userClient = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user?.email) {
      return jsonResponse({ error: "Not signed in." }, 401);
    }
    userEmail = user.email;
    trigger = "manual";
  }

  // --------------------------------------------------------------------------
  // RUN. From here on, every outcome writes exactly one reminder_runs row.
  // --------------------------------------------------------------------------
  const tally: Tally = { sent: 0, failures: [], statuses: [] };
  const today = todayInZone();
  const horizon = addDays(today, WINDOW_DAYS);

  try {
    if (trigger === "schedule") {
      await runScheduled(admin, today, horizon, tally);
    } else {
      await runManual(userClient!, admin, userEmail, today, horizon, tally);
    }

    // A partial failure is a failure. Saying "ok" because four of five went
    // out is how a broken thing keeps looking healthy.
    if (tally.failures.length > 0) {
      await logRun(admin, trigger, tally.sent, false, failureSummary(tally));
      return jsonResponse(
        {
          error: `${tally.failures.length} reminder(s) failed to send.`,
          sent: tally.sent,
          failures: tally.failures,
        },
        502,
      );
    }

    await logRun(admin, trigger, tally.sent, true, null);
    return jsonResponse({ ok: true, sent: tally.sent });
  } catch (err) {
    console.error("send-renewal-reminder failed:", err);
    const message = err instanceof Error ? err.message : String(err);
    await logRun(admin, trigger, tally.sent, false, message);
    return jsonResponse({ error: message, sent: tally.sent }, 500);
  }
});
