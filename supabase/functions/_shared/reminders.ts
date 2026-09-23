// ============================================================================
// Module 6: the reminder logic, in one place
//
// WHY THIS FILE EXISTS
//   Two things now send renewal reminders: the button a person clicks, and the
//   schedule that runs at eight in the morning. They must do the identical
//   thing, or you get the worst kind of bug, where the feature works when you
//   test it by hand and misbehaves only when nobody is watching.
//
//   So the finding and the sending live here, once, and both callers use them.
//   Only the TRIGGER differs. That is the whole idea of this module sitting in
//   a file: the action was already built, and automation just changes who asks
//   for it.
// ============================================================================

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const FROM = "Subscription Tracker <onboarding@resend.dev>";
export const WINDOW_DAYS = 7;

export interface DueSubscription {
  id: string;
  name: string;
  cost: number;
  billing_period: string;
  next_renewal: string;
  auto_renew: boolean | null;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function money(n: number): string {
  return "$" + Number(n).toFixed(2);
}

// ---------------------------------------------------------------------------
// Which subscriptions are owed a reminder right now?
//
// Four conditions, and each one is a decision worth being able to defend:
//   is_active            the row is still in the list at all
//   status = Active      you are still paying for it; a reminder about a
//                        cancelled subscription would simply be false
//   renewal within 7 days
//   last_reminded_for <> next_renewal
//                        we have not already covered THIS renewal. Without it
//                        a daily job emails you every morning for a week.
// ---------------------------------------------------------------------------
export async function findDue(
  client: SupabaseClient,
  householdId?: string,
): Promise<DueSubscription[]> {
  const today = new Date();
  const horizon = new Date(today.getTime() + WINDOW_DAYS * 86400000);

  let query = client
    .from("subscriptions")
    .select("id, name, cost, billing_period, next_renewal, auto_renew, last_reminded_for, household_id")
    .eq("is_active", true)
    .eq("status", "Active")
    .gte("next_renewal", isoDate(today))
    .lte("next_renewal", isoDate(horizon))
    .order("next_renewal", { ascending: true });

  if (householdId) query = query.eq("household_id", householdId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  // Postgres cannot compare two columns through this query builder, so the
  // already-reminded check happens here. The set is at most a handful of rows.
  return (data ?? []).filter((r) => r.last_reminded_for !== r.next_renewal);
}

// ---------------------------------------------------------------------------
// Send one reminder, and record that we did.
//
// The order matters. Mark it sent only AFTER the email is accepted. Marking
// first would mean a failed send silently consumes the reminder, and you would
// never hear about the renewal at all, which is worse than hearing twice.
// ---------------------------------------------------------------------------
export async function sendReminder(
  client: SupabaseClient,
  apiKey: string,
  to: string,
  sub: DueSubscription,
): Promise<void> {
  const verb = sub.auto_renew === false ? "expires" : "renews";
  const per = sub.billing_period === "yearly" ? "year" : "month";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject: `${sub.name} ${verb} soon`,
      text:
        `${sub.name} ${verb} on ${sub.next_renewal}.\n\n` +
        `Cost: ${money(sub.cost)} per ${per}.\n\n` +
        (sub.auto_renew === false
          ? `This one does not renew on its own. If you want to keep it, you have to act.\n`
          : `This one charges you automatically. If you do not want it, now is the time.\n`),
    }),
  });

  if (!res.ok) {
    throw new Error(`Resend returned ${res.status}: ${await res.text()}`);
  }

  await client
    .from("subscriptions")
    .update({ last_reminded_for: sub.next_renewal })
    .eq("id", sub.id);
}

// ---------------------------------------------------------------------------
// Write one row to the runs log.
//
// Called on every path, success and failure alike, and deliberately swallows
// its own errors. If logging a failure itself fails, the useful thing is still
// the original failure, not a second one stacked on top of it.
// ---------------------------------------------------------------------------
export async function logRun(
  client: SupabaseClient,
  row: {
    household_id?: string | null;
    trigger_source: "manual" | "schedule";
    reminders_sent: number;
    succeeded: boolean;
    error?: string | null;
  },
): Promise<void> {
  try {
    await client.from("workflow_runs").insert({
      household_id: row.household_id ?? null,
      trigger_source: row.trigger_source,
      reminders_sent: row.reminders_sent,
      succeeded: row.succeeded,
      error: row.error ?? null,
    });
  } catch (err) {
    console.error("Could not write the runs log row:", err);
  }
}

// A client that bypasses row level security. Only ever created inside a
// function, never anywhere a browser can reach, and used only where there is
// no signed-in user to act on behalf of: the scheduled job, and writing the
// runs log.
export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}
