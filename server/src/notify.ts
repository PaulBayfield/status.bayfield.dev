// Webhook notifications: Discord, Slack, ntfy, or any URL (signed JSON).

import { all, run } from "./db.ts";
import { hmacSha256 } from "./crypto.ts";
import type { Monitor, Outcome, Result, Status } from "./checks.ts";
import type { Expiry } from "./expiry.ts";
import { compose, discordBody, discordUrl, ntfyRequest, slackText, storedTemplate, type MessageEvent, type Template } from "./messages.ts";

export const WEBHOOK_KINDS = ["discord", "slack", "ntfy", "generic"] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];
export const EVENTS = ["down", "up", "degraded", "expiry"] as const;
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

const eventOf = (c: Change): Event => (c.expiry ? "expiry" : c.to === "down" ? "down" : c.to === "degraded" ? "degraded" : "up");

type Target = Pick<Webhook, "kind" | "url" | "secret" | "template" | "projects">;

/** The request each kind of webhook expects, from the webhook's message template. */
export async function request(w: Target, c: Change, template?: Template): Promise<{ url: string; init: RequestInit; preview: unknown }> {
  const t = template ?? storedTemplate(w.template);
  const m = await compose(t, c, w.kind, w.projects.split(",").filter(Boolean).map(Number));
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
      const payload = {
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
      };
      const body = JSON.stringify(payload);
      const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "status.bayfield.dev", "x-status-event": ev };
      if (w.secret) headers["x-status-signature"] = `sha256=${await hmacSha256(w.secret, body)}`;
      return { url: w.url, init: { method: "POST", headers, body }, preview: payload };
    }
  }
}

/** Sends one notification; returns the error, if any. */
export async function send(w: Target, c: Change, template?: Template): Promise<string | null> {
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

/** Every enabled webhook that wants these changes. */
export async function notify(changes: Change[]) {
  const hooks = await all<Webhook>("SELECT * FROM webhooks WHERE enabled = 1");
  for (const c of changes) {
    const ev = eventOf(c);
    // "Back to normal" after degraded counts as an "up" event only for webhooks that get degraded ones.
    const targets = hooks.filter(
      (w) =>
        listHas(w.events, ev) &&
        (!w.projects || listHas(w.projects, c.monitor.projectId)) &&
        !(ev === "up" && c.from === "degraded" && !c.expiry && !listHas(w.events, "degraded")),
    );
    await Promise.all(
      targets.map(async (w) => {
        const error = await send(w, c);
        await run("UPDATE webhooks SET last_sent_at = ?, last_error = ? WHERE id = ?", Date.now(), error ?? "", w.id);
        if (error) console.warn(`Webhook ${w.id} (${w.name}) failed: ${error}`);
      }),
    );
  }
}

/** The "Send a test" button and the editor's preview: a made-up change of a made-up monitor. */
export function testChange(event: MessageEvent = "down", monitor?: Partial<Monitor>): Change {
  const now = Date.now();
  const to = event === "down" ? "down" : event === "degraded" ? "degraded" : "up";
  const from = event === "normal" ? "degraded" : event === "up" ? "down" : "up";
  const message = { down: "Answered 503 Service Unavailable, expected 200-299", degraded: "Slow: 2340 ms (over 1500 ms)", up: "200 OK", normal: "200 OK", expiring: "" }[event];
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
