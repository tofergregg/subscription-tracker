// ============================================================================
// Module 5: send-renewal-reminder
//
// WHAT THIS IS
//   The action behind the "Email reminders" button. It looks for
//   subscriptions renewing in the next seven days and emails one reminder for
//   each one.
//
// WHY IT MATTERS LATER
//   Nothing about this function knows or cares who asked it to run. Right now
//   a person clicks a button. In Module 6 a schedule will call this exact same
//   function on a timer, and not one line of what follows has to change.
//
//   That is the whole idea behind automation, sitting here in plain sight
//   before we get to it: the ACTION is already built. The only new part will
//   be the TRIGGER.
//
// SETUP
//   Uses the same RESEND_API_KEY secret as notify-cancellation. Nothing new.
//   supabase functions deploy send-renewal-reminder
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const FROM = "Subscription Tracker <onboarding@resend.dev>";
const WINDOW_DAYS = 7;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function money(n: number): string {
  return "$" + Number(n).toFixed(2);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

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

    // ------------------------------------------------------------------
    // Which subscriptions are coming up?
    //
    // Two filters worth naming. `status = Active` because a cancelled
    // subscription is not renewing and a reminder about it would be a lie.
    // `is_active` because that row might have been archived out of the list
    // entirely, which is a different thing again.
    // ------------------------------------------------------------------
    const today = new Date();
    const horizon = new Date(today.getTime() + WINDOW_DAYS * 86400000);

    const { data: rows, error: readError } = await supabase
      .from("subscriptions")
      .select("id, name, cost, billing_period, next_renewal, auto_renew")
      .eq("is_active", true)
      .eq("status", "Active")
      .gte("next_renewal", isoDate(today))
      .lte("next_renewal", isoDate(horizon))
      .order("next_renewal", { ascending: true });

    if (readError) {
      return jsonResponse({ error: readError.message }, 500);
    }

    const due = rows ?? [];
    if (due.length === 0) {
      return jsonResponse({ ok: true, sent: 0 });
    }

    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) {
      return jsonResponse(
        { error: "RESEND_API_KEY is not set on this project." },
        500,
      );
    }

    // ------------------------------------------------------------------
    // One email per upcoming renewal.
    //
    // Sent one at a time and counted honestly. If the third of five fails, we
    // report three sent and two failed rather than calling the whole run a
    // success or a disaster. Module 6 builds a log on top of exactly this
    // distinction.
    // ------------------------------------------------------------------
    let sent = 0;
    const failures: string[] = [];

    for (const sub of due) {
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
          to: [user.email],
          subject,
          text:
            `${sub.name} ${verb} on ${sub.next_renewal}.\n\n` +
            `Cost: ${money(sub.cost)} per ${sub.billing_period === "yearly" ? "year" : "month"}.\n\n` +
            (sub.auto_renew === false
              ? `This one does not renew on its own. If you want to keep it, you have to act.\n`
              : `This one charges you automatically. If you do not want it, now is the time.\n`),
        }),
      });

      if (res.ok) {
        sent++;
      } else {
        const detail = await res.text();
        console.error(`Reminder failed for ${sub.name}:`, res.status, detail);
        failures.push(`${sub.name}: ${res.status}`);
      }
    }

    // A partial failure is a failure. Saying "ok" here because four of five
    // went out is how a broken thing keeps looking healthy.
    if (failures.length > 0) {
      return jsonResponse(
        { error: `${failures.length} reminder(s) failed to send.`, sent, failures },
        502,
      );
    }

    return jsonResponse({ ok: true, sent });
  } catch (err) {
    console.error("send-renewal-reminder failed:", err);
    return jsonResponse({ error: String(err) }, 500);
  }
});
