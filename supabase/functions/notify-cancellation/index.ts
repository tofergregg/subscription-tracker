// ============================================================================
// Module 3: notify-cancellation
//
// WHAT THIS IS
//   A Supabase edge function. A small piece of code that runs on Supabase's
//   servers, not in anybody's browser. Its whole job is to send one email.
//
// WHY IT EXISTS AT ALL
//   The app could not send this email itself. To send email we use Resend, and
//   Resend gives us an API key, which is a password: whoever holds it can send
//   mail on our account. Anything in the frontend can be read by anyone who
//   right-clicks and views source. So putting the key there would be posting
//   the password in public.
//
//   That is the entire reason a backend exists, and this file is the smallest
//   honest example of it. The key lives as a Supabase secret, server-side, and
//   only this function ever touches it.
//
// SETUP BEFORE THIS WILL RUN
//   supabase secrets set RESEND_API_KEY=re_your_key_here
//   supabase functions deploy notify-cancellation
//
//   On the Resend free tier you do not need a domain. The default sender
//   address below works, and it can only deliver to the email address you
//   signed up with, which is exactly what we want for a course app.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

// Resend's shared sender for accounts without a verified domain.
const FROM = "Subscription Tracker <onboarding@resend.dev>";

Deno.serve(async (req: Request) => {
  // The browser sends an OPTIONS request first to ask whether it is allowed to
  // make the real one. Answer it and stop.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ------------------------------------------------------------------
    // 1. Who is asking?
    //
    // We never take the recipient address from the request body. If we did,
    // anyone with a session could use our Resend account to mail anyone they
    // liked. Instead we read the signed-in user from their token and send to
    // whatever address that account is registered with. The caller does not
    // get to choose.
    // ------------------------------------------------------------------
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
    // 2. What are we telling them?
    // ------------------------------------------------------------------
    const body = await req.json().catch(() => ({}));
    const name = String(body.name ?? "").trim().slice(0, 60);
    const cost = Number(body.cost);
    const period = body.billing_period === "yearly" ? "year" : "month";

    if (!name) {
      return jsonResponse({ error: "Which subscription?" }, 400);
    }

    const saved = Number.isFinite(cost)
      ? ` That is $${cost.toFixed(2)} a ${period} you are no longer paying.`
      : "";

    // ------------------------------------------------------------------
    // 3. Send it.
    //
    // No library, just an HTTP call. An API is an agreed way for one piece of
    // software to talk to another, and most of the time it looks exactly like
    // this: a URL, a credential in a header, and some JSON.
    // ------------------------------------------------------------------
    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) {
      // This is a configuration mistake, not a user mistake, so say so plainly
      // rather than making somebody guess.
      return jsonResponse(
        { error: "RESEND_API_KEY is not set on this project." },
        500,
      );
    }

    const resend = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [user.email],
        subject: `Cancelled: ${name}`,
        text:
          `You marked ${name} as cancelled in your Subscription Tracker.${saved}\n\n` +
          `It stays in your list, greyed out, so your spending history stays intact.\n\n` +
          `If you sign up again later, add it as a new subscription. Resubscribing ` +
          `usually means a different price and a different renewal date, and an old ` +
          `record would quietly make your totals wrong.\n`,
      }),
    });

    if (!resend.ok) {
      const detail = await resend.text();
      console.error("Resend rejected the send:", resend.status, detail);
      return jsonResponse(
        { error: `Email service returned ${resend.status}.`, detail },
        502,
      );
    }

    const sent = await resend.json();
    return jsonResponse({ ok: true, id: sent.id });
  } catch (err) {
    console.error("notify-cancellation failed:", err);
    return jsonResponse({ error: String(err) }, 500);
  }
});
