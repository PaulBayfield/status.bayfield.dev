// Sessions, and sign-in with Authentik (OIDC authorization code + PKCE): the only way in.
// Multi-factor authentication is the identity provider's job.
//
// The session cookie holds a random token; the database only stores its SHA-256.

import { Hono, type Context, type MiddlewareHandler, type Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { first, run } from "./db.ts";
import { config } from "./config.ts";
import { challenge, decodeBase64url, randomToken, sha256 } from "./crypto.ts";
import { HttpError, clientIp, str } from "./http.ts";
import { freeUsername, getUser, meView, type User } from "./users.ts";

export interface Session {
  id: string;
  userId: string;
  method: string;
}

export type AppEnv = { Variables: { user: User; session: Session } };

const cookieName = () => (config().secureCookies ? "__Host-status" : "status");
const DAY = 24 * 60 * 60_000;

// --- Sessions ---

async function startSession(c: Context, user: User, method: string) {
  const token = randomToken();
  const now = Date.now();
  await run(
    "INSERT INTO sessions (id, user_id, method, user_agent, ip, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    await sha256(token),
    user.id,
    method,
    str(c.req.header("User-Agent"), 300),
    clientIp(c),
    now,
    now,
    now + config().sessionIdleDays * DAY,
  );
  setCookie(c, cookieName(), token, {
    httpOnly: true,
    secure: config().secureCookies,
    sameSite: "Lax",
    path: "/",
    // The cookie outlives idle expiry; the database decides when it's dead.
    maxAge: 400 * 24 * 60 * 60,
  });
  await run("UPDATE users SET last_seen_at = ? WHERE id = ?", now, user.id);
}

async function currentSession(c: Context): Promise<(Session & { user: User }) | null> {
  const token = getCookie(c, cookieName());
  if (!token) return null;
  const s = await first<Session & { expiresAt: number; lastSeenAt: number }>("SELECT id, user_id, method, expires_at, last_seen_at FROM sessions WHERE id = ?", await sha256(token));
  if (!s || s.expiresAt < Date.now()) return null;
  const user = await getUser(s.userId);
  if (!user) return null;
  // Slide the idle expiry, at most once a minute per session.
  if (Date.now() - s.lastSeenAt > 60_000) {
    const now = Date.now();
    await run("UPDATE sessions SET last_seen_at = ?, expires_at = ?, ip = ? WHERE id = ?", now, now + config().sessionIdleDays * DAY, clientIp(c), s.id);
    await run("UPDATE users SET last_seen_at = ? WHERE id = ?", now, user.id);
  }
  return { ...s, user };
}

export async function requireUser(c: Context<AppEnv>, next: Next) {
  const s = await currentSession(c);
  if (!s) throw new HttpError(401, "Not signed in");
  c.set("user", s.user);
  c.set("session", s);
  await next();
}

export async function requireAdmin(c: Context<AppEnv>, next: Next) {
  if (c.get("user").role !== "admin") throw new HttpError(403, "Admins only");
  await next();
}

/** Adding and editing monitors: everyone but viewers. */
export const requireCollaborator: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("user").role === "viewer") throw new HttpError(403, "Your account can only view monitors. Ask an admin to make you a collaborator.");
  await next();
};

/**
 * Cookie-authenticated writes must come from the app itself. Browsers send Origin on every
 * cross-site POST, so a mismatch means another site is trying to act as the user.
 */
export async function sameOrigin(c: Context, next: Next) {
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && getCookie(c, cookieName())) {
    const origin = c.req.header("Origin");
    const site = c.req.header("Sec-Fetch-Site");
    const allowed = new URL(config().publicUrl).origin;
    if ((origin && origin !== allowed && !isDevOrigin(origin) && !isRewrittenDevOrigin(c, origin)) || (!origin && site && site !== "same-origin" && site !== "none")) {
      throw new HttpError(403, "Cross-site request blocked");
    }
  }
  await next();
}

/** `wrangler dev` rewrites Origin to the route's host (status.bayfield.dev) and the request URL with
 *  it; on localhost only, that rewritten origin is the app itself. */
const isRewrittenDevOrigin = (c: Context, o: string) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(config().publicUrl) && o === new URL(c.req.url).origin;

/** Vite's dev server, when the app itself runs on localhost. */
const isDevOrigin = (o: string) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(config().publicUrl) && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(o);

export async function signOutEverywhere(userId: string, except?: string) {
  await run("DELETE FROM sessions WHERE user_id = ? AND id <> ?", userId, except ?? "");
}

// --- OIDC ---

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  issuer: string;
}
let discovery: Promise<Discovery> | null = null;
function discover(): Promise<Discovery> {
  const oidc = config().oidc;
  if (!oidc) throw new HttpError(404, "Single sign-on isn't configured");
  const url = `${oidc.issuer}/.well-known/openid-configuration`;
  discovery ??= fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`OIDC discovery failed (${r.status} from ${JSON.stringify(url)}): check OIDC_ISSUER`);
      return r.json() as Promise<Discovery>;
    })
    .catch((e) => {
      discovery = null;
      throw e;
    });
  return discovery;
}

function decodeJwt(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new HttpError(400, "Malformed ID token");
  return JSON.parse(decodeBase64url(payload));
}

interface Claims {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  groups?: string[];
}

const userCount = async () => (await first<{ n: number }>("SELECT count(*) AS n FROM users"))?.n ?? 0;

/**
 * Finds (or creates) the account for a provider identity. An account that was never signed into
 * (created by an admin) is claimed by email, then by username.
 */
async function oidcUser(claims: Claims): Promise<User> {
  const cfg = config().oidc;
  if (!cfg) throw new HttpError(404, "Single sign-on isn't configured");
  const groups = Array.isArray(claims.groups) ? claims.groups : [];
  if (cfg.allowedGroups.length && !groups.some((g) => cfg.allowedGroups.includes(g))) {
    throw new HttpError(403, "Your account isn't allowed to use Status.");
  }
  // With OIDC_ADMIN_GROUPS set, the provider decides who is an admin, at every sign-in.
  const managed = cfg.adminGroups.length > 0;
  const admin = managed && groups.some((g) => cfg.adminGroups.includes(g));
  const signedIn = async (id: string) => {
    if (managed) await run("UPDATE users SET role = CASE WHEN ? THEN 'admin' WHEN role = 'admin' THEN 'collaborator' ELSE role END WHERE id = ?", admin, id);
    return (await getUser(id))!;
  };
  const claim = async (u: User) => {
    await run("UPDATE users SET oidc_sub = ? WHERE id = ?", claims.sub, u.id);
    return signedIn(u.id);
  };

  const bySub = await first<User>("SELECT * FROM users WHERE oidc_sub = ?", claims.sub);
  if (bySub) return signedIn(bySub.id);

  const email = claims.email?.toLowerCase();
  if (email) {
    const byEmail = await first<User>("SELECT * FROM users WHERE lower(email) = ? AND oidc_sub IS NULL", email);
    if (byEmail) return claim(byEmail);
  }
  if (claims.preferred_username) {
    const byName = await first<User>("SELECT * FROM users WHERE lower(id) = lower(?) AND oidc_sub IS NULL", claims.preferred_username);
    if (byName) return claim(byName);
  }

  const count = await userCount();
  if (count > 0 && !cfg.autoCreate) throw new HttpError(403, "No Status account matches yours. Ask an admin to create one.");
  const id = await freeUsername(claims.preferred_username || email?.split("@")[0] || "user");
  const emailTaken = email ? await first("SELECT 1 AS x FROM users WHERE lower(email) = ?", email) : undefined;
  await run(
    "INSERT INTO users (id, name, email, oidc_sub, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    claims.name ?? "",
    email && !emailTaken ? email : null,
    claims.sub,
    // The very first account runs the place.
    admin || (count === 0 && !managed) ? "admin" : cfg.defaultRole,
    Date.now(),
  );
  return (await getUser(id))!;
}

// --- Routes ---

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/config", (c) => c.json({ oidc: config().oidc ? { name: config().oidc!.name } : null, dev: !!config().devLoginUser }));

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, cookieName());
  if (token) await run("DELETE FROM sessions WHERE id = ?", await sha256(token));
  deleteCookie(c, cookieName(), { path: "/", secure: config().secureCookies });
  return c.json({ ok: true });
});

authRoutes.get("/oidc/start", async (c) => {
  const oidc = config().oidc!;
  const d = await discover();
  const state = randomToken(24);
  const verifier = randomToken(48);
  const nonce = randomToken(16);
  await run("DELETE FROM oidc_states WHERE expires_at < ?", Date.now());
  await run("INSERT INTO oidc_states (state, verifier, nonce, expires_at) VALUES (?, ?, ?, ?)", state, verifier, nonce, Date.now() + 10 * 60_000);
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: oidc.clientId,
    redirect_uri: oidc.redirectUri,
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: await challenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return c.redirect(url.toString());
});

authRoutes.get("/oidc/callback", async (c) => {
  const fail = (message: string) => c.redirect(`/?signin_error=${encodeURIComponent(message)}`);
  const { code, state, error, error_description } = c.req.query();
  if (error) return fail(error_description || error);
  if (!code || !state) return fail("The sign-in response was incomplete.");
  const saved = await first<{ verifier: string; nonce: string }>("DELETE FROM oidc_states WHERE state = ? AND expires_at > ? RETURNING verifier, nonce", state, Date.now());
  if (!saved) return fail("This sign-in link has expired. Try again.");

  try {
    const oidc = config().oidc!;
    const d = await discover();
    const tokenRes = await fetch(d.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: oidc.redirectUri,
        client_id: oidc.clientId,
        client_secret: oidc.clientSecret,
        code_verifier: saved.verifier,
      }),
    });
    const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; id_token?: string; error_description?: string };
    if (!tokenRes.ok || !token.access_token || !token.id_token) throw new Error(token.error_description ?? `Token exchange failed (${tokenRes.status})`);

    // The ID token came straight from the token endpoint over TLS, so checking its claims is enough (OIDC Core 3.1.3.7).
    const id = decodeJwt(token.id_token);
    const aud = Array.isArray(id.aud) ? id.aud : [id.aud];
    if (id.iss !== d.issuer || !aud.includes(oidc.clientId) || id.nonce !== saved.nonce) throw new Error("The ID token doesn't match this app");
    if (typeof id.exp === "number" && id.exp * 1000 < Date.now() - 60_000) throw new Error("The ID token has expired");

    const infoRes = await fetch(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${token.access_token}` } });
    const info = (await infoRes.json().catch(() => ({}))) as Claims;
    if (!infoRes.ok || info.sub !== id.sub) throw new Error("Couldn't read your profile from the provider");

    const user = await oidcUser({ ...info, groups: info.groups ?? (id.groups as string[] | undefined) });
    await startSession(c, user, "oidc");
    return c.redirect("/");
  } catch (e) {
    console.warn("OIDC sign-in failed:", e);
    return fail(e instanceof Error ? e.message : "Sign-in failed");
  }
});

/** Local development only (see DEV_LOGIN_USER): signs in without the identity provider. */
authRoutes.post("/dev-login", async (c) => {
  const dev = config().devLoginUser;
  if (!dev) throw new HttpError(404, "Not found");
  let user = await getUser(dev);
  if (!user) {
    await run("INSERT INTO users (id, name, role, created_at) VALUES (?, ?, ?, ?)", dev, dev, (await userCount()) === 0 ? "admin" : "collaborator", Date.now());
    user = (await getUser(dev))!;
  }
  await startSession(c, user, "dev");
  return c.json({ ok: true });
});

authRoutes.get("/me", requireUser, (c) => c.json(meView(c.get("user"))));
