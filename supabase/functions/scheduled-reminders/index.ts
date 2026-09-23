// ============================================================================
// scheduled-reminders  (Module 6)
//
// WHAT CHANGED, AND WHAT DID NOT
//   Nothing about the work. This finds due renewals and sends emails using the
//   same code the button uses. What is new is that nobody asked it to. A
//   schedule in the database calls this every morning.
//
//   That is the whole module in one sentence: we replaced the finger.
//
// WHO IS ALLOWED TO CALL IT
//   A scheduled job has no signed-in user, so this function cannot check a
//   session the way the others do. verify_jwt is off for it, which means the
//   URL is reachable by anyone who knows it. So it checks a shared secret
//   instead: the schedule sends x-cron-secret, and this compares it against
//   CRON_SECRET. No match, no work, and the caller learns nothing about why.
//
// SETUP
//   openssl rand -hex 32
//   supabase secrets set CRON_SECRET=<that string>
//   supabase functions deploy scheduled-reminders
//   then run section 3 of schema-module6-automation.sql with the same string
// ============================================================================

import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { findDue, logRun, sendReminder, serviceClient } from "../_shared/reminders.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const expected = Deno.env.get("CRON_SECRET");
  const presented = req.headers.get("x-cron-secret");
  if (!expected || presented !== expected) {
    // Deliberately vague to the caller, specific in the logs. A stranger
    // learns nothing; you can still see that it happened.
    console.error("scheduled-reminders called without a valid cron secret.");
    return jsonResponse({ error: "Not authorized." }, 401);
  }

  const db = serviceClient();
  let totalSent = 0;

  try {
    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) throw new Error("RESEND_API_KEY is not set on this project.");

    // Every household, because there is no "current user" here.
    const { data: households, error } = await db.from("households").select("id");
    if (error) throw new Error(error.message);

    const problems: string[] = [];

    for (const household of households ?? []) {
      let sentHere = 0;
      try {
        const due = await findDue(db, household.id);
        if (due.length === 0) {
          await logRun(db, {
            household_id: household.id,
            trigger_source: "schedule",
            reminders_sent: 0,
            succeeded: true,
          });
          continue;
        }

        // Who gets the mail. auth.users is not readable over the normal API,
        // so this goes through the admin interface, which is available only
        // because this function holds the service role.
        const { data: members } = await db
          .from("household_members")
          .select("user_id")
          .eq("household_id", household.id);

        const recipients: string[] = [];
        for (const m of members ?? []) {
          const { data: u } = await db.auth.admin.getUserById(m.user_id);
          if (u?.user?.email) recipients.push(u.user.email);
        }

        for (const sub of due) {
          for (const to of recipients) {
            await sendReminder(db, apiKey, to, sub);
            sentHere++;
            totalSent++;
          }
        }

        await logRun(db, {
          household_id: household.id,
          trigger_source: "schedule",
          reminders_sent: sentHere,
          succeeded: true,
        });
      } catch (err) {
        // One household's failure must not stop the others. It gets its own
        // failed row, which is what makes "it broke for one person" visible
        // rather than looking like a total outage, or like nothing at all.
        console.error(`Household ${household.id} failed:`, err);
        problems.push(`${household.id}: ${err}`);
        await logRun(db, {
          household_id: household.id,
          trigger_source: "schedule",
          reminders_sent: sentHere,
          succeeded: false,
          error: String(err),
        });
      }
    }

    if (problems.length > 0) {
      return jsonResponse(
        { error: `${problems.length} household(s) failed.`, sent: totalSent, problems },
        502,
      );
    }
    return jsonResponse({ ok: true, sent: totalSent });
  } catch (err) {
    console.error("scheduled-reminders failed outright:", err);
    await logRun(db, {
      household_id: null,
      trigger_source: "schedule",
      reminders_sent: totalSent,
      succeeded: false,
      error: String(err),
    });
    return jsonResponse({ error: String(err), sent: totalSent }, 500);
  }
});
