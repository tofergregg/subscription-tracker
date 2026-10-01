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
// WHEN A RUN FAILS
//   After the reminder_runs row is written, an alert email goes to the
//   address in the ALERT_EMAIL secret: what triggered the run, when, and the
//   exact error. Whether the alert went out is then saved on that same row
//   (alert_sent, and alert_error if it did not). The row's original error is
//   never touched. Alert problems also go to the function logs.
//
// SETUP
//   Uses the same RESEND_API_KEY secret as notify-cancellation.
//   supabase secrets set ALERT_EMAIL=you@example.com
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
//   failures : short "Name: status" lines, returned to the button as before
//   details  : the full text Resend sent back, for the operator alert only
type Tally = {
  sent: number;
  failures: string[];
  statuses: number[];
  details: string[];
};

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
// THE ONE PLACE THAT TALKS TO RESEND. Both the reminder and the operator
// alert go through here, so there is still a single copy of the sending code.
// ----------------------------------------------------------------------------
type SendResult = { ok: true } | { ok: false; status: number; detail: string };

async function postToResend(
  apiKey: string,
  message: { to: string[]; subject: string; text: string },
  signal?: AbortSignal,
): Promise<SendResult> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM, ...message }),
    signal,
  });
  if (res.ok) return { ok: true };
  return { ok: false, status: res.status, detail: await res.text() };
}

// ----------------------------------------------------------------------------
// THE REMINDER EMAIL. The one and only copy. Subject and body are exactly
// what the button has always sent.
// ----------------------------------------------------------------------------
async function sendReminderEmail(
  apiKey: string,
  to: string[],
  sub: Sub,
): Promise<SendResult> {
  const verb = sub.auto_renew === false ? "expires" : "renews";
  const result = await postToResend(apiKey, {
    to,
    subject: `${sub.name} ${verb} soon`,
    text:
      `${sub.name} ${verb} on ${sub.next_renewal}.\n\n` +
      `Cost: ${money(sub.cost)} per ${sub.billing_period === "yearly" ? "year" : "month"}.\n\n` +
      (sub.auto_renew === false
        ? `This one does not renew on its own. If you want to keep it, you have to act.\n`
        : `This one charges you automatically. If you do not want it, now is the time.\n`),
  });
  if (!result.ok) {
    console.error(`Reminder failed for ${sub.name}:`, result.status, result.detail);
  }
  return result;
}

// Record a failed send in the tally: a short line for the button, and the
// full Resend response for the operator alert.
function recordFailure(tally: Tally, sub: Sub, result: { status: number; detail: string }) {
  tally.failures.push(`${sub.name}: ${result.status}`);
  tally.statuses.push(result.status);
  tally.details.push(
    `${sub.name} (renewal ${sub.next_renewal}): Resend returned HTTP ${result.status}: ${result.detail}`,
  );
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
      recordFailure(tally, sub, result);
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
      tally.details.push(
        `${sub.name} (renewal ${sub.next_renewal}): household ${sub.household_id} has no member with an email address, so nothing was sent.`,
      );
      continue;
    }
    const result = await sendReminderEmail(apiKey, to, sub);
    if (result.ok) {
      tally.sent++;
      await markSent(admin, sub);
    } else {
      recordFailure(tally, sub, result);
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
type RunRow = { id: number; ran_at: string };

async function logRun(
  admin: SupabaseClient,
  trigger: Trigger,
  sent: number,
  succeeded: boolean,
  error: string | null,
): Promise<RunRow | null> {
  const { data, error: insertError } = await admin
    .from("reminder_runs")
    .insert({
      trigger,
      sent,
      succeeded,
      error: error ? error.slice(0, 500) : null,
    })
    .select("id, ran_at")
    .single();
  if (insertError) {
    console.error("Could not write reminder_runs row:", insertError.message);
    return null;
  }
  return data as RunRow;
}

// ----------------------------------------------------------------------------
// OPERATOR ALERT. When a run fails, email the address in the ALERT_EMAIL
// secret (you), never the people who were expecting reminders.
//
// Called only AFTER the reminder_runs row is written, so it cannot change
// that row's original error. It never throws and never changes the response
// the caller gets. It returns what happened, which recordAlertOutcome() then
// saves into the row's two alert columns. Failures are also written to the
// function logs (Edge Functions -> send-renewal-reminder -> Logs).
//
// Unlike the runs log, this email DOES include subscription names and the
// full text Resend sent back, because only you receive it.
// ----------------------------------------------------------------------------
type AlertOutcome = { sent: true } | { sent: false; error: string };

function alertFailed(error: string): AlertOutcome {
  console.error("Alert not sent:", error);
  return { sent: false, error };
}

async function sendFailureAlert(
  trigger: Trigger,
  run: RunRow | null,
  summary: string,
  details: string[],
): Promise<AlertOutcome> {
  try {
    const to = Deno.env.get("ALERT_EMAIL");
    if (!to) return alertFailed("The ALERT_EMAIL secret is not set.");
    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) return alertFailed("RESEND_API_KEY is not set.");

    const when = run ? new Date(run.ran_at) : new Date();
    const pacific = when.toLocaleString("en-US", {
      timeZone: TIME_ZONE,
      dateStyle: "full",
      timeStyle: "long",
    });

    const text =
      `A renewal reminder run failed.\n\n` +
      `Triggered by: ${trigger === "schedule" ? "the daily schedule" : "the Email reminders button"} (${trigger})\n` +
      `When: ${pacific} (${when.toISOString()} UTC)\n` +
      (run
        ? `Runs log row: reminder_runs id ${run.id}\n`
        : `Runs log row: NOT WRITTEN (the log insert failed; see function logs)\n`) +
      `\nSummary:\n${summary}\n` +
      (details.length > 0
        ? `\nWhat the service said:\n${details.map((d) => `- ${d}`).join("\n")}\n`
        : "");

    const result = await postToResend(
      apiKey,
      {
        to: [to],
        subject: `Subscription Tracker: reminder run failed (${trigger})`,
        text,
      },
      // A hung alert must not hold up the response.
      AbortSignal.timeout(10000),
    );
    if (!result.ok) {
      return alertFailed(`Resend returned HTTP ${result.status}: ${result.detail}`);
    }
    return { sent: true };
  } catch (err) {
    // Network errors and the 10 second timeout land here.
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    return alertFailed(`${name}: ${message}`);
  }
}

// Save the alert's outcome on the run's own row. Only the two alert columns
// are sent, and the database refuses any change to the original fields
// anyway (see schema-module6b-alert-status.sql). Never throws.
async function recordAlertOutcome(
  admin: SupabaseClient,
  run: RunRow | null,
  outcome: AlertOutcome,
): Promise<void> {
  if (!run) return; // No row to update; the function logs already say why.
  try {
    const { error } = await admin
      .from("reminder_runs")
      .update({
        alert_sent: outcome.sent,
        alert_error: outcome.sent ? null : outcome.error.slice(0, 500),
      })
      .eq("id", run.id);
    if (error) {
      console.error(`Could not record alert outcome on run ${run.id}:`, error.message);
    }
  } catch (err) {
    console.error(`Could not record alert outcome on run ${run.id}:`, err);
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
  const tally: Tally = { sent: 0, failures: [], statuses: [], details: [] };
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
      const summary = failureSummary(tally);
      const run = await logRun(admin, trigger, tally.sent, false, summary);
      const alert = await sendFailureAlert(trigger, run, summary, tally.details);
      await recordAlertOutcome(admin, run, alert);
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
    const run = await logRun(admin, trigger, tally.sent, false, message);
    // The alert also lists any individual sends that failed before the crash.
    const details = [
      `The run stopped with an error: ${err instanceof Error && err.stack ? err.stack : message}`,
      ...tally.details,
    ];
    const alert = await sendFailureAlert(
      trigger,
      run,
      `${message} (${tally.sent} reminder(s) had been sent before it stopped.)`,
      details,
    );
    await recordAlertOutcome(admin, run, alert);
    return jsonResponse({ error: message, sent: tally.sent }, 500);
  }
});
