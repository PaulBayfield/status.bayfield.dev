// Webhook notifications: Discord, Slack, ntfy, or any URL (signed JSON).

import { all, run } from "./db.ts";
import { config } from "./config.ts";
import { hmacSha256 } from "./crypto.ts";
import type { Monitor, Outcome, Result, Status } from "./checks.ts";

export const WEBHOOK_KINDS = ["discord", "slack", "ntfy", "generic"] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];
export const EVENTS = ["down", "up", "degraded"] as const;
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
}

const eventOf = (c: Change): Event => (c.to === "down" ? "down" : c.to === "degraded" ? "degraded" : "up");

/** "3 h 12 min" */
export function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

function text(c: Change) {
  const m = c.monitor;
  const ev = eventOf(c);
  const title =
    ev === "down" ? `${m.name} is down` : ev === "degraded" ? `${m.name} is degraded` : c.from === "degraded" ? `${m.name} is back to normal` : `${m.name} is back up`;
  const detail =
    ev === "up" && c.downSince ? `Down for ${duration(c.at - c.downSince)}. ${c.result.message}` : c.result.message;
  return { title, detail, link: `${config().publicUrl}/m/${m.id}`, target: m.type === "heartbeat" ? "Heartbeat" : m.target };
}

/** The request each kind of webhook expects. */
async function request(w: Pick<Webhook, "kind" | "url" | "secret">, c: Change): Promise<RequestInit> {
  const ev = eventOf(c);
  const { title, detail, link, target } = text(c);
  const json = (body: unknown, extra: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "status.bayfield.dev", ...extra },
    body: JSON.stringify(body),
  });
  switch (w.kind) {
    case "discord":
      return json({
        username: "Status",
        embeds: [
          {
            title: `${ev === "down" ? "🔴" : ev === "degraded" ? "🟡" : "🟢"} ${title}`,
            description: detail,
            url: link,
            color: ev === "down" ? 0xe5484d : ev === "degraded" ? 0xf5a524 : 0x30a46c,
            fields: [
              { name: "Target", value: target, inline: true },
              ...(c.result.latency !== null ? [{ name: "Response", value: `${c.result.latency} ms`, inline: true }] : []),
            ],
            timestamp: new Date(c.at).toISOString(),
          },
        ],
      });
    case "slack":
      return json({ text: `${ev === "down" ? ":red_circle:" : ev === "degraded" ? ":large_yellow_circle:" : ":large_green_circle:"} *${title}*\n${detail}\n<${link}|Open in Status> · ${target}` });
    case "ntfy":
      return {
        method: "POST",
        headers: {
          Title: title,
          Tags: ev === "down" ? "rotating_light" : ev === "degraded" ? "warning" : "white_check_mark",
          Priority: ev === "down" ? "5" : "3",
          Click: link,
          ...(w.secret ? { Authorization: `Bearer ${w.secret}` } : {}),
        },
        body: `${detail}\n${target}`,
      };
    case "generic": {
      const body = JSON.stringify({
        event: ev,
        title,
        message: detail,
        url: link,
        at: new Date(c.at).toISOString(),
        from: c.from,
        to: c.to,
        downSince: c.downSince ? new Date(c.downSince).toISOString() : null,
        monitor: { id: c.monitor.id, name: c.monitor.name, type: c.monitor.type, target: c.monitor.target, projectId: c.monitor.projectId },
        check: c.result,
      });
      const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "status.bayfield.dev", "x-status-event": ev };
      if (w.secret) headers["x-status-signature"] = `sha256=${await hmacSha256(w.secret, body)}`;
      return { method: "POST", headers, body };
    }
  }
}

/** Sends one notification; returns the error, if any. */
export async function send(w: Pick<Webhook, "kind" | "url" | "secret">, c: Change): Promise<string | null> {
  try {
    const res = await fetch(w.url, { ...(await request(w, c)), signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel();
    return res.ok ? null : `Answered ${res.status}`;
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
      (w) => listHas(w.events, ev) && (!w.projects || listHas(w.projects, c.monitor.projectId)) && !(ev === "up" && c.from === "degraded" && !listHas(w.events, "degraded")),
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

/** The "Send a test" button: a made-up outage of a made-up monitor. */
export function testChange(): Change {
  const now = Date.now();
  return {
    monitor: {
      id: 0,
      projectId: null,
      name: "Test monitor",
      type: "http",
      target: "https://example.com",
      status: "down",
    } as Monitor,
    from: "up",
    to: "down",
    result: { status: "down", latency: null, code: 503, message: "This is a test notification from Status." },
    at: now,
    downSince: null,
  };
}
