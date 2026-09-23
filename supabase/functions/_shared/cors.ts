// Browsers refuse to let a page at one address call a server at another unless
// that server says it is allowed. These headers are that permission slip.
//
// The app runs at localhost:8000 during development and on Vercel in
// production, and the function lives on supabase.co, so every call from the
// app is a cross-origin call. Without these headers the browser blocks the
// response and you get a confusing "failed to fetch" with nothing in the
// server logs, because the request never arrived.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
