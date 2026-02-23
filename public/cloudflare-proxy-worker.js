/**
 * Cloudflare Worker — Lightweight HTTP Proxy for Polymarket CLOB
 *
 * Accepts POST requests with { url, method, headers, body }
 * and forwards them, returning the response. Deploy this in any
 * non-blocked region (Cloudflare has 300+ edge locations worldwide).
 *
 * === SETUP (2 minutes) ===
 *
 * 1. Go to https://dash.cloudflare.com → Workers & Pages → Create
 * 2. Name it "poly-proxy" → Deploy
 * 3. Click "Edit Code", paste this entire file, click "Deploy"
 * 4. (Optional) Add environment variable PROXY_SECRET for auth
 * 5. Copy the worker URL (e.g., https://poly-proxy.your-name.workers.dev)
 * 6. In Lovable, add it as the PROXY_API_URL secret
 *
 * Free tier: 100,000 requests/day — more than enough for trading.
 *
 * === REGION CONTROL ===
 * By default, Cloudflare runs Workers at the nearest edge to the caller.
 * Since Supabase Edge Functions run globally, the Worker may execute
 * in various regions. All Cloudflare regions outside blocked countries work.
 * To force a specific region, use Cloudflare's "Smart Placement" feature
 * or deploy via Cloudflare Pages Functions with a regional hint.
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, x-proxy-secret",
        },
      });
    }

    // Health check
    if (request.method === "GET") {
      return Response.json({
        status: "ok",
        service: "poly-proxy-worker",
        ts: Date.now(),
      });
    }

    // Auth check (optional)
    const PROXY_SECRET = env.PROXY_SECRET || "";
    if (PROXY_SECRET && request.headers.get("x-proxy-secret") !== PROXY_SECRET) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      const { url, method = "POST", headers = {}, body } = await request.json();

      if (!url) {
        return Response.json({ error: "Missing 'url' in request body" }, { status: 400 });
      }

      console.log(`Proxying ${method} ${url}`);

      // Forward the request to the target URL
      const targetRes = await fetch(url, {
        method,
        headers: { ...headers },
        body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
      });

      const text = await targetRes.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      console.log(`Response ${targetRes.status}: ${text.substring(0, 200)}`);

      return Response.json(
        {
          success: targetRes.ok,
          status: targetRes.status,
          data,
        },
        {
          headers: { "Access-Control-Allow-Origin": "*" },
        },
      );
    } catch (err) {
      console.error("Proxy error:", err.message);
      return Response.json({ error: err.message }, { status: 500 });
    }
  },
};
