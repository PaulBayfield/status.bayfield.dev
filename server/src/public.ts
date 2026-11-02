// What needs no account: the public status page's data, status badges, and heartbeat pings.

import { Hono, type Context } from "hono";
import { all } from "./db.ts";
import { rateLimit } from "./http.ts";
import { ping, type Monitor } from "./checks.ts";
import { publicPage } from "./pages.ts";

export const publicRoutes = new Hono();

/** Serves from Cloudflare's cache for a minute: the page is public, so anyone can reload it. */
async function cached(c: Context, ttl: number, make: () => Promise<Response>): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(new URL(c.req.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  // Cached responses have read-only headers; the security headers still need adding.
  if (hit) return new Response(hit.body, hit);
  const res = await make();
  // Only answers worth keeping: a page created a moment ago must not stay "not found".
  if (!res.ok) return res;
  res.headers.set("Cache-Control", `public, max-age=${ttl}`);
  c.executionCtx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/** After an edit: drop the cached copies of a page so visitors see it straight away. */
export async function forgetPages(origin: string, slugs: string[]) {
  const cache = (caches as unknown as { default: Cache }).default;
  await Promise.all([`${origin}/api/public/status`, ...slugs.map((s) => `${origin}/api/public/pages/${s}`)].map((u) => cache.delete(new Request(u, { method: "GET" }))));
}

/** The default status page: /status, and / for visitors. */
publicRoutes.get("/status", (c) =>
  cached(c, 60, async () => {
    const page = await publicPage(null);
    return page ? c.json(page) : c.json({ error: "No status page yet" }, 404);
  }),
);

/** Any status page by its address: /status/<slug>. */
publicRoutes.get("/pages/:slug", (c) =>
  cached(c, 60, async () => {
    const page = await publicPage((c.req.param("slug") ?? "").toLowerCase());
    return page ? c.json(page) : c.json({ error: "No status page at this address" }, 404);
  }),
);

const BADGE_COLORS: Record<string, string> = { up: "#30a46c", degraded: "#f5a524", down: "#e5484d", paused: "#8b8d98", pending: "#8b8d98" };

/** A shields.io-style badge for a monitor shown on a status page: <img src="/api/public/badge/3">. */
publicRoutes.get("/badge/:id", (c) =>
  cached(c, 60, async () => {
    const [m] = await all<Monitor>("SELECT * FROM monitors WHERE id = ? AND EXISTS (SELECT 1 FROM status_page_monitors WHERE monitor_id = monitors.id)", Number(c.req.param("id")));
    const status = !m ? "unknown" : m.paused ? "paused" : m.status;
    const label = c.req.query("label")?.slice(0, 40) || m?.name || "status";
    const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
    const w = (s: string) => Math.round(s.length * 6.6 + 12);
    const lw = w(label);
    const sw = w(status);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + sw}" height="20" role="img" aria-label="${esc(label)}: ${status}"><title>${esc(label)}: ${status}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${lw + sw}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${sw}" height="20" fill="${BADGE_COLORS[status] ?? "#8b8d98"}"/><rect width="${lw + sw}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + sw / 2}" y="14">${status}</text></g></svg>`;
    return new Response(svg, { headers: { "Content-Type": "image/svg+xml; charset=utf-8" } });
  }),
);

/**
 * A heartbeat: curl https://status.bayfield.dev/api/push/<token>
 * Optional: ?status=down&msg=Backup%20failed&ms=1234 (a duration to chart).
 */
export const pushRoute = async (c: Context) => {
  rateLimit(c, "push", 120, 60_000);
  const m = await ping(c.req.param("token") ?? "", c.req.query());
  if (!m) return c.json({ error: "Unknown push token" }, 404);
  return c.json({ ok: true });
};
