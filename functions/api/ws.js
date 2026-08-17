/* ------------------------------------------------------------------
   Cloudflare Pages Function: /api/ws?code=NNNNNN&role=host|guest

   The SignalRoom Durable Object is DEFINED in the separate signaling
   Worker (../signaling-worker). Pages binds to it via `script_name` in
   wrangler.toml, so this function just routes the WebSocket upgrade to
   the correct room (one DO instance per 6-digit code) and returns the
   101 response back to the browser.
   ------------------------------------------------------------------ */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code || !/^\d{6}$/.test(code)) {
    return new Response("Bad or missing 6-digit code", { status: 400 });
  }

  const id = env.SIGNAL_ROOMS.idFromName(code);
  const stub = env.SIGNAL_ROOMS.get(id);
  return stub.fetch(request);
}
