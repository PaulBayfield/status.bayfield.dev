// Webhook notifications: Discord, Slack, ntfy, or any URL (signed JSON). About a monitor changing
// state (a Change), or an announcement or maintenance window (a Notice).

import { all, run } from "./db.ts";
import { hmacSha256 } from "./crypto.ts";
import type { Monitor, Outcome, Result, Status } from "./checks.ts";
import type { Expiry } from "./expiry.ts";
import { compose, composeNotice, discordBody, discordUrl, ntfyRequest, slackText, storedTemplate, type MessageEvent, type Template } from "./messages.ts";

export const WEBHOOK_KINDS = ["discord", "slack", "ntfy", "generic"] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];
export const EVENTS = ["down", "up", "degraded", "expiry", "post", "maintenance"] as const;
export type Event = (typeof EVENTS)[number];

export interface Webhook {
  id: number;
  name: string;
  kind: WebhookKind;
  url: string;
  secret: string;
  events: string;
  projects: string;
  enabled: number;
  lastSentAt: number | null;
  lastError: string;
  /** The message template, as JSON (empty: the defaults). */
  template: string;
  createdAt: number;
}

/** A monitor changing state. */
export interface Change {
  monitor: Monitor;
  from: Status;
  to: Outcome;
  result: Result;
  at: number;
  /** When it went down, for a recovery. */
  downSince: number | null;
  /** A certificate or domain expiry warning (the state didn't change). */
  expiry?: Expiry;
}

/** An announcement published or updated, or a maintenance window scheduled, started or over. */
export interface Notice {
  kind: "post" | "maintenance";
  phase: "new" | "update" | "resolved" | "scheduled" | "started" | "ended";
  id: number;
  title: string;
  /** The update's text, or the window's description. */
  text: string;
  impact?: "none" | "minor" | "major";
  postStatus?: "investigating" | "identified" | "monitoring" | "resolved";
  startsAt?: number;
  endsAt?: number;
  monitors: { id: number; name: string; projectId: number | null }[];
  /** The status page the buttons lead to. */
  pageSlug: string | null;
  at: number;
}

export type Subject = Change | Notice;
export const isNotice = (s: Subject): s is Notice => "phase" in s;

const eventOf = (s: Subject): Event =>
  isNotice(s) ? s.kind : s.expiry ? "expiry" : s.to === "down" ? "down" : s.to === "degraded" ? "degraded" : "up";

type Target = Pick<Webhook, "kind" | "url" | "secret" | "template" | "projects">;

/** The request each kind of webhook expects, from the webhook's message template. */
export async function request(w: Target, c: Subject, template?: Template): Promise<{ url: string; init: RequestInit; preview: unknown }> {
  const t = template ?? storedTemplate(w.template);
  const m = isNotice(c) ? await composeNotice(t, c, w.kind) : await compose(t, c, w.kind, w.projects.split(",").filter(Boolean).map(Number));
  const json = (url: string, body: unknown, extra: Record<string, string> = {}) => ({
    url,
    init: { method: "POST", headers: { "content-type": "application/json", "user-agent": "status.bayfield.dev", ...extra }, body: JSON.stringify(body) },
    preview: body,
  });
  switch (w.kind) {
    case "discord":
      return json(discordUrl(w.url), discordBody(t, m));
    case "slack":
      return json(w.url, { text: slackText(m) });
    case "ntfy": {
      const r = ntfyRequest(w.url, m);
      return json(r.url, r.body, w.secret ? { Authorization: `Bearer ${w.secret}` } : {});
    }
    case "generic": {
      const ev = eventOf(c);
      const payload = isNotice(c)
        ? {
            event: ev,
            phase: c.phase,
            title: m.title,
            message: m.body,
            url: m.vars.link,
            at: new Date(c.at).toISOString(),
            [c.kind]: {
              id: c.id,
              title: c.title,
              text: c.text,
              ...(c.kind === "post" ? { impact: c.impact, status: c.postStatus } : { startsAt: new Date(c.startsAt!).toISOString(), endsAt: new Date(c.endsAt!).toISOString() }),
            },
            monitors: c.monitors,
            details: m.details,
            buttons: m.buttons,
          }
        : {
        event: ev,
        title: m.title,
        message: m.body,
        url: m.vars.link,
        at: new Date(c.at).toISOString(),
        from: c.from,
        to: c.to,
        downSince: c.downSince ? new Date(c.downSince).toISOString() : null,
        monitor: { id: c.monitor.id, name: c.monitor.name, type: c.monitor.type, target: c.monitor.target, projectId: c.monitor.projectId },
        check: c.result,
        details: m.details,
        buttons: m.buttons,
      }
      const body = JSON.stringify(payload);
      const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "status.bayfield.dev", "x-status-event": ev };
      if (w.secret) headers["x-status-signature"] = `sha256=${await hmacSha256(w.secret, body)}`;
      return { url: w.url, init: { method: "POST", headers, body }, preview: payload };
    }
  }
}

/** Sends one notification; returns the error, if any. */
export async function send(w: Target, c: Subject, template?: Template): Promise<string | null> {
  try {
    const r = await request(w, c, template);
    const res = await fetch(r.url, { ...r.init, signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      await res.body?.cancel();
      return null;
    }
    // Discord and Slack say what they didn't like: worth showing next to the webhook.
    const why = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    return `Answered ${res.status}${why ? `: ${why}` : ""}`;
  } catch (e) {
    return (e as Error).message || "Request failed";
  }
}

const listHas = (csv: string, v: string | number | null) => v !== null && csv.split(",").map((s) => s.trim()).includes(String(v));

/** A webhook for some projects gets what touches them; a notice about no monitor goes to all. */
const forProjects = (w: Webhook, s: Subject) =>
  !w.projects || (isNotice(s) ? !s.monitors.length || s.monitors.some((m) => listHas(w.projects, m.projectId)) : listHas(w.projects, s.monitor.projectId));

/** Every enabled webhook that wants these changes and notices. */
export async function notify(changes: Subject[]) {
  if (!changes.length) return;
  const hooks = await all<Webhook>("SELECT * FROM webhooks WHERE enabled = 1");
  for (const c of changes) {
    const ev = eventOf(c);
    // "Back to normal" after degraded counts as an "up" event only for webhooks that get degraded ones.
    const normal = !isNotice(c) && ev === "up" && c.from === "degraded" && !c.expiry;
    const targets = hooks.filter((w) => listHas(w.events, ev) && forProjects(w, c) && !(normal && !listHas(w.events, "degraded")));
    await Promise.all(
      targets.map(async (w) => {
        const error = await send(w, c);
        await run("UPDATE webhooks SET last_sent_at = ?, last_error = ? WHERE id = ?", Date.now(), error ?? "", w.id);
        if (error) console.warn(`Webhook ${w.id} (${w.name}) failed: ${error}`);
      }),
    );
  }
}

/** The "Send a test" button and the editor's preview: a made-up change, or a made-up notice. */
export function testSubject(event: MessageEvent = "down"): Subject {
  const now = Date.now();
  const monitors = [{ id: 0, name: "Example API", projectId: null }];
  if (event === "post") {
    return { kind: "post", phase: "new", id: 0, title: "Slow API responses", text: "We're looking into slow responses on the API.", impact: "minor", postStatus: "investigating", monitors, pageSlug: null, at: now };
  }
  if (event === "maintenance") {
    const start = Math.ceil(now / 3_600_000) * 3_600_000 + 24 * 3_600_000;
    return { kind: "maintenance", phase: "scheduled", id: 0, title: "Database upgrade", text: "The API will be read-only for a few minutes.", startsAt: start, endsAt: start + 3_600_000, monitors, pageSlug: null, at: now };
  }
  return testChange(event);
}

function testChange(event: MessageEvent, monitor?: Partial<Monitor>): Change {
  const now = Date.now();
  const to = event === "down" ? "down" : event === "degraded" ? "degraded" : "up";
  const from = event === "normal" ? "degraded" : event === "up" ? "down" : "up";
  const message = ({ down: "Answered 503 Service Unavailable, expected 200-299", degraded: "Slow: 2340 ms (over 1500 ms)", up: "200 OK", normal: "200 OK" } as Record<string, string>)[event] ?? "";
  return {
    monitor: { id: 0, projectId: null, name: "Example API", type: "http", target: "https://api.example.com/health", status: to, ...monitor } as Monitor,
    from,
    to,
    result: { status: to, latency: event === "expiring" ? null : event === "down" ? 112 : event === "degraded" ? 2340 : 84, code: event === "down" ? 503 : 200, message },
    at: now,
    downSince: event === "up" ? now - 47 * 60_000 : null,
    ...(event === "expiring"
      ? {
          expiry: {
            monitorId: 0,
            kind: "certificate" as const,
            name: "api.example.com",
            expiresAt: now + 9 * 24 * 60 * 60_000 + 60_000,
            issuedAt: now - 80 * 24 * 60 * 60_000,
            issuer: "Let's Encrypt (R11)",
            source: "tls",
            error: "",
            checkedAt: now,
            stage: "warn",
          },
        }
      : {}),
  };
}
