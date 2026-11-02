// Status as a Cloudflare Worker: the web app, its API, and the checks (a cron trigger every minute).

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { env } from "cloudflare:workers";
import { config, type Env } from "./config.ts";
import { first, migrate } from "./db.ts";
import { api } from "./api.ts";
import { authRoutes, sameOrigin } from "./auth.ts";
import { publicRoutes, pushRoute } from "./public.ts";
import { runDue } from "./checks.ts";
import { sha256Base64 } from "./crypto.ts";
import { HttpError } from "./http.ts";

const assets = () => (env as unknown as Env).ASSETS;

// index.html applies the theme in a tiny inline script before the bundle loads (no flash of the
// wrong theme). The policy allows exactly that script, by hash, computed once per isolate.
let inlineScripts: Promise<string[]> | null = null;
function scriptHashes(origin: string): Promise<string[]> {
  inlineScripts ??= assets()
    .fetch(new Request(`${origin}/index.html`))
    .then((r) => (r.ok ? r.text() : ""))
    .then((html) => Promise.all([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(async (m) => `'sha256-${await sha256Base64(m[1])}'`)))
    .catch(() => {
      inlineScripts = null;
      return [];
    });
  return inlineScripts;
}

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

app.use("*", async (c, next) => {
  await migrate();
  await next();
});

app.use("*", async (c, next) => {
  const hashes = await scriptHashes(new URL(c.req.url).origin);
  return secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", ...hashes],
      styleSrc: ["'self'", "'unsafe-inline'"],
      // Status page logos are links to images hosted elsewhere.
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
    },
    referrerPolicy: "strict-origin-when-cross-origin",
  })(c, next);
});
app.use("/api/*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }));

// Heartbeats come from scripts (no cookie, any origin), so before the same-origin guard.
app.all("/api/push/:token", pushRoute);
app.use("/api/*", sameOrigin);

app.get("/api/health", async (c) => {
  await first("SELECT 1 AS ok");
  return c.json({ ok: true });
});

app.route("/api/auth", authRoutes);
app.route("/api/public", publicRoutes);
app.route("/api/app", api);
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// The web build: hashed assets cached forever, pages (the SPA fallback) always revalidated.
app.get("*", async (c) => {
  const res = await assets().fetch(c.req.raw);
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", new URL(c.req.url).pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
  return out;
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, _env: Env, ctx: ExecutionContext) {
    config();
    await migrate();
    ctx.waitUntil(
      runDue(controller.scheduledTime).then(
        (r) => r.checked && console.log(`Checked ${r.checked} monitors, ${r.changes} changed`),
        (e) => console.error("Cron run failed:", e),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
