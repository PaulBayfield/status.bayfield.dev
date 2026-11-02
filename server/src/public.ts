// What needs no account: status pages' data, badges, the embeddable widget, and heartbeat pings.

import { Hono, type Context } from "hono";
import { first } from "./db.ts";
import { config } from "./config.ts";
import { rateLimit } from "./http.ts";
import { ping, type Monitor } from "./checks.ts";
import { domainsOf, pageForHost, publicPage, publicSeries } from "./pages.ts";
import { inMaintenance } from "./maintenance.ts";
import { daysByMonitor, uptime } from "./views.ts";

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

/** After an edit: drop the cached copies of a page so visitors see it straight away (on the
 *  page's custom domain too, and its widget). */
export async function forgetPages(origin: string, slugs: string[]) {
  const cache = (caches as unknown as { default: Cache }).default;
  const hosts = (await domainsOf(slugs)).map((d) => `https://${d}`);
  const urls = [
    `${origin}/api/public/status`,
    ...slugs.flatMap((s) => [`${origin}/api/public/pages/${s}`, `${origin}/api/public/pages/${s}/badge`]),
    ...hosts.flatMap((h) => [`${h}/api/public/status`, ...slugs.map((s) => `${h}/api/public/pages/${s}`)]),
  ];
  await Promise.all(urls.map((u) => cache.delete(new Request(u, { method: "GET" }))));
}

type Page = NonNullable<Awaited<ReturnType<typeof publicPage>>>;
type State = "up" | "degraded" | "down" | "maintenance" | "none";

/** A page's overall state: its monitors, its open posts' impact, and running maintenance. */
export function pageState(p: Page): State {
  const monitors = p.groups.flatMap((g) => g.monitors).filter((m) => m.status !== "paused" && m.status !== "pending");
  const open = p.posts.filter((x) => x.status !== "resolved");
  if (monitors.some((m) => m.status === "down") || open.some((x) => x.impact === "major")) return "down";
  if (monitors.some((m) => m.status === "degraded") || open.some((x) => x.impact === "minor")) return "degraded";
  if (monitors.some((m) => m.status === "maintenance")) return "maintenance";
  return monitors.length ? "up" : "none";
}

/** Where visitors open a page: its custom domain, or /status/<slug>. */
async function pageUrl(slug: string): Promise<string> {
  const [domain] = await domainsOf([slug]);
  return domain ? `https://${domain}` : `${config().publicUrl}/status/${slug}`;
}

/** The default status page: /status, and / for visitors; on a page's custom domain, that page. */
publicRoutes.get("/status", (c) =>
  cached(c, 60, async () => {
    const own = await pageForHost(new URL(c.req.url).hostname);
    const page = await publicPage(own);
    if (!page) return c.json({ error: "No status page yet" }, 404);
    // On a custom domain there's no dashboard here: "Sign in" goes to Status's own address.
    return c.json({ ...page, home: own ? config().publicUrl : null });
  }),
);

/** Any status page by its address: /status/<slug>. */
publicRoutes.get("/pages/:slug", (c) =>
  cached(c, 60, async () => {
    const page = await publicPage((c.req.param("slug") ?? "").toLowerCase());
    return page ? c.json({ ...page, home: null }) : c.json({ error: "No status page at this address" }, 404);
  }),
);

/** A monitor's response times on a page that shows them: /status/<slug>, opening a row. */
publicRoutes.get("/pages/:slug/series/:id", (c) =>
  cached(c, 60, async () => {
    const range = c.req.query("range");
    const series = await publicSeries((c.req.param("slug") ?? "").toLowerCase(), Number(c.req.param("id")), range === "7d" || range === "30d" ? range : "24h");
    return series ? c.json(series) : c.json({ error: "Not found" }, 404);
  }),
);

// --- Badges ---

const COLORS: Record<string, string> = {
  up: "#30a46c",
  degraded: "#f5a524",
  down: "#e5484d",
  maintenance: "#3e63dd",
  paused: "#8b8d98",
  pending: "#8b8d98",
  none: "#8b8d98",
  unknown: "#8b8d98",
};
const WORDS: Record<string, string> = { up: "up", degraded: "degraded", down: "down", maintenance: "maintenance", paused: "paused", pending: "pending", none: "no data", unknown: "unknown" };

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** A shields.io-style badge: grey label, coloured message. */
function badge(label: string, message: string, color: string): Response {
  const w = (s: string) => Math.round([...s].length * 6.6 + 12);
  const lw = w(label);
  const mw = w(message);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + mw}" height="20" role="img" aria-label="${esc(label)}: ${esc(message)}"><title>${esc(label)}: ${esc(message)}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${lw + mw}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${lw + mw}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + mw / 2}" y="14">${esc(message)}</text></g></svg>`;
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml; charset=utf-8" } });
}

/** Only monitors shown on a status page have badges: the rest stays private. */
const publicMonitor = (mid: number) =>
  first<Monitor>("SELECT * FROM monitors WHERE id = ? AND EXISTS (SELECT 1 FROM status_page_monitors WHERE monitor_id = monitors.id)", mid);

const label = (c: Context, fallback: string) => c.req.query("label")?.slice(0, 40) || fallback;

/** <img src="/api/public/badge/3">: the monitor's status. */
publicRoutes.get("/badge/:id", (c) =>
  cached(c, 60, async () => {
    const m = await publicMonitor(Number(c.req.param("id")));
    const status = !m ? "unknown" : m.paused ? "paused" : (await inMaintenance()).has(m.id) ? "maintenance" : m.status;
    return badge(label(c, m?.name ?? "status"), WORDS[status], COLORS[status]);
  }),
);

/** /api/public/badge/3/uptime?days=30 (1, 7, 30 or 90): its uptime. */
publicRoutes.get("/badge/:id/uptime", (c) =>
  cached(c, 300, async () => {
    const days = [1, 7, 30, 90].includes(Number(c.req.query("days"))) ? Number(c.req.query("days")) : 30;
    const m = await publicMonitor(Number(c.req.param("id")));
    const u = m ? uptime((await daysByMonitor([m.id], days)).get(m.id) ?? []) : null;
    const text = u === null ? "no data" : `${u >= 0.9999 ? (u * 100).toFixed(u === 1 ? 0 : 2) : (Math.floor(u * 10_000) / 100).toFixed(2)}%`;
    const color = u === null ? COLORS.none : u >= 0.999 ? COLORS.up : u >= 0.99 ? "#97ca00" : u >= 0.95 ? COLORS.degraded : COLORS.down;
    return badge(label(c, `uptime ${days === 1 ? "24h" : `${days}d`}`), text, color);
  }),
);

/** /api/public/badge/3/response: its average response time over 24 hours. */
publicRoutes.get("/badge/:id/response", (c) =>
  cached(c, 300, async () => {
    const m = await publicMonitor(Number(c.req.param("id")));
    const r = m ? await first<{ avg: number | null }>("SELECT avg(latency) AS avg FROM checks WHERE monitor_id = ? AND at >= ?", m.id, Date.now() - 24 * 60 * 60_000) : null;
    const avg = r?.avg ?? null;
    return badge(label(c, "response"), avg === null ? "no data" : `${Math.round(avg)} ms`, avg === null ? COLORS.none : "#007ec6");
  }),
);

/** /api/public/pages/<slug>/badge: the whole page's state. */
publicRoutes.get("/pages/:slug/badge", (c) =>
  cached(c, 60, async () => {
    const page = await publicPage((c.req.param("slug") ?? "").toLowerCase());
    const state = page ? pageState(page) : "unknown";
    const words: Record<string, string> = { up: "operational", degraded: "degraded", down: "outage", maintenance: "maintenance", none: "no data", unknown: "unknown" };
    return badge(label(c, page?.title ?? "status"), words[state], COLORS[state]);
  }),
);

// --- The widget (an iframe) ---

const EMBED_TEXT = {
  en: { up: "All systems operational", degraded: "Some systems are degraded", down: "Some systems are down", maintenance: "Under maintenance", none: "No monitors yet", open: "View status page", status: WORDS },
  fr: {
    up: "Tous les systèmes fonctionnent",
    degraded: "Certains systèmes sont dégradés",
    down: "Certains systèmes sont hors service",
    maintenance: "Maintenance en cours",
    none: "Aucun moniteur",
    open: "Voir la page de statut",
    status: { up: "en ligne", degraded: "dégradé", down: "hors service", maintenance: "maintenance", paused: "en pause", pending: "en attente", none: "—", unknown: "—" },
  },
};

/**
 * <iframe src="https://status.bayfield.dev/embed/<slug>" width="360" height="72"></iframe>
 * ?theme=light|dark (default: the visitor's), ?lang=fr, ?monitors=1 (list them, taller).
 * Plain HTML and CSS, no script: it can sit on any site.
 */
export const embedRoute = (c: Context) =>
  cached(c, 60, async () => {
    const slug = c.req.param("slug")?.toLowerCase() ?? (await pageForHost(new URL(c.req.url).hostname));
    const page = await publicPage(slug ?? null);
    const lang = c.req.query("lang") === "fr" ? "fr" : "en";
    const T = EMBED_TEXT[lang];
    const theme = c.req.query("theme") === "dark" ? "dark" : c.req.query("theme") === "light" ? "light" : "auto";
    if (!page) return c.html("<!doctype html><title>Status</title>", 404);
    const state = pageState(page);
    const href = await pageUrl(page.slug);
    const list =
      c.req.query("monitors") === "1"
        ? `<ul>${[...new Map(page.groups.flatMap((g) => g.monitors).map((m) => [m.id, m])).values()]
            .map((m) => `<li><span class="dot s-${m.status}"></span><span class="name">${esc(m.name)}</span><span class="st">${esc(T.status[m.status as keyof typeof T.status] ?? m.status)}</span></li>`)
            .join("")}</ul>`
        : "";
    const light = "--bg:#fff;--fg:#1c2024;--muted:#60646c;--border:#e0e1e6;--hover:#f9f9fb";
    const dark = "--bg:#18191b;--fg:#edeef0;--muted:#b0b4ba;--border:#2e3135;--hover:#212225";
    const vars = theme === "dark" ? `:root{${dark}}` : theme === "light" ? `:root{${light}}` : `:root{${light}}@media (prefers-color-scheme:dark){:root{${dark}}}`;
    return c.html(`<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(page.title)}</title>
<style>${vars}
*{box-sizing:border-box;margin:0}html,body{background:transparent}body{font:14px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg)}
.card{display:block;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:inherit;text-decoration:none;overflow:hidden}
.head{display:flex;align-items:center;gap:12px;padding:12px 14px}.card:hover .head{background:var(--hover)}
.big{width:12px;height:12px;border-radius:50%;flex:none;background:var(--s);box-shadow:0 0 0 4px color-mix(in srgb,var(--s) 22%,transparent)}
.t{display:flex;flex-direction:column;min-width:0;flex:1}.t strong{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.t span{color:var(--muted);font-size:12.5px}
.go{color:var(--muted);font-size:12px;white-space:nowrap}
ul{list-style:none;padding:4px 14px 10px;border-top:1px solid var(--border)}li{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:13px}
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--s)}.name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.st{color:var(--muted);font-size:12px}
.s-up{--s:${COLORS.up}}.s-degraded{--s:${COLORS.degraded}}.s-down{--s:${COLORS.down}}.s-maintenance{--s:${COLORS.maintenance}}.s-paused,.s-pending,.s-none{--s:${COLORS.none}}
</style></head><body>
<a class="card" href="${esc(href)}" target="_blank" rel="noopener"><div class="head"><span class="big s-${state}"></span><span class="t"><strong>${esc(page.title)}</strong><span>${esc(T[state])}</span></span><span class="go">${esc(T.open)} ↗</span></div>${list}</a>
</body></html>`);
  });

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

