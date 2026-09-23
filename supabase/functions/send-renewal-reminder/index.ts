// ============================================================================
// send-renewal-reminder  (Module 5, extended in Module 6)
//
//   The action behind the "Email reminders" button.
//
//   Module 5 wrote this. Module 6 changed two things about it and neither one
//   is the work itself: the finding and sending moved into _shared/reminders
//   so the schedule can use the identical code, and every run now writes a row
//   to the runs log.
//
//   The button is still just a trigger. So is the clock.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { findDue, logRun, sendReminder, serviceClient } from "../_shared/reminders.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Logging uses the service client because the runs table takes no writes
  // from the browser at all, by design: a page cannot forge a clean history.
  const log = serviceClient();
  let householdId: string | null = null;
  let sent = 0;

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user?.email) {
      return jsonResponse({ error: "Not signed in." }, 401);
    }

    const { data: membership } = await supabase
      .from("household_members")
      .select("household_id")
      .limit(1);
    householdId = membership?.[0]?.household_id ?? null;

    const due = await findDue(supabase);

    if (due.length === 0) {
      await logRun(log, {
        household_id: householdId,
        trigger_source: "manual",
        reminders_sent: 0,
        succeeded: true,
      });
      return jsonResponse({ ok: true, sent: 0 });
    }

    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) throw new Error("RESEND_API_KEY is not set on this project.");

    // One at a time, counted honestly. If the third of five fails, three were
    // sent and the run failed. Both of those facts go in the log.
    const failures: string[] = [];
    for (const sub of due) {
      try {
        await sendReminder(supabase, apiKey, user.email, sub);
        sent++;
      } catch (err) {
        console.error(`Reminder failed for ${sub.name}:`, err);
        failures.push(`${sub.name}: ${err}`);
      }
    }

    if (failures.length > 0) throw new Error(failures.join("; "));

    await logRun(log, {
      household_id: householdId,
      trigger_source: "manual",
      reminders_sent: sent,
      succeeded: true,
    });
    return jsonResponse({ ok: true, sent });
  } catch (err) {
    console.error("send-renewal-reminder failed:", err);
    await logRun(log, {
      household_id: householdId,
      trigger_source: "manual",
      reminders_sent: sent,
      succeeded: false,
      error: String(err),
    });
    return jsonResponse({ error: String(err), sent }, 502);
  }
});
