// What a notification says, and how it looks: each webhook has a message template (titles and
// texts per event with {placeholders}, which details and buttons to include, and Discord's look),
// turned here into each service's request. Empty texts fall back to the defaults of the
// template's language.
//
// Discord gets a components message (a coloured container with a text section, a thumbnail,
// details, link buttons and a footer), like CROUStillantBot's: flag IS_COMPONENTS_V2 and
// ?with_components=true, which lets a plain webhook send non-interactive components.

import { all } from "./db.ts";
import { config } from "./config.ts";
import type { Change } from "./notify.ts";

export const MESSAGE_EVENTS = ["down", "up", "normal", "degraded"] as const;
/** down, back up (after down), back to normal (after degraded), degraded. */
export type MessageEvent = (typeof MESSAGE_EVENTS)[number];
export const LANGUAGES = ["en", "fr"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DETAILS = ["target", "cause", "latency", "duration", "project", "time"] as const;
export type Detail = (typeof DETAILS)[number];

export interface Template {
  language: Language;
  /** Empty: the language's default. */
  messages: Record<MessageEvent, { title: string; body: string }>;
  details: Record<Detail, boolean>;
  buttons: { monitor: { enabled: boolean; label: string }; statusPage: { enabled: boolean; label: string } };
  discord: {
    username: string;
    avatarUrl: string;
    thumbnailUrl: string;
    footer: string;
    emoji: boolean;
    colors: Record<"down" | "up" | "degraded", string>;
    /** Sent above the message for that event: <@&role id>, <@user id>, @here or @everyone. */
    mentions: Record<MessageEvent, string>;
  };
}

// --- Defaults ---

const TEXTS = {
  en: {
    messages: {
      down: { title: "{monitor} is down", body: "{cause}" },
      up: { title: "{monitor} is back up", body: "Down for {duration}." },
      normal: { title: "{monitor} is back to normal", body: "Response times are back to normal." },
      degraded: { title: "{monitor} is slow", body: "{cause}" },
    },
    labels: { target: "Target", cause: "Cause", latency: "Response time", duration: "Downtime", project: "Project", time: "Time" },
    buttons: { monitor: "Open in Status", statusPage: "Status page" },
    footer: "Status · {time}",
    status: { up: "Up", down: "Down", degraded: "Degraded", pending: "Pending" },
    heartbeat: "Heartbeat",
    days: "days",
  },
  fr: {
    messages: {
      down: { title: "{monitor} est hors service", body: "{cause}" },
      up: { title: "{monitor} est de nouveau en ligne", body: "Hors service pendant {duration}." },
      normal: { title: "{monitor} fonctionne de nouveau normalement", body: "Les temps de réponse sont revenus à la normale." },
      degraded: { title: "{monitor} est lent", body: "{cause}" },
    },
    labels: { target: "Cible", cause: "Cause", latency: "Temps de réponse", duration: "Durée de la panne", project: "Projet", time: "Heure" },
    buttons: { monitor: "Ouvrir dans Status", statusPage: "Page de statut" },
    footer: "Status · {time}",
    status: { up: "En ligne", down: "Hors service", degraded: "Dégradé", pending: "En attente" },
    heartbeat: "Heartbeat",
    days: "jours",
  },
} as const;

export const PLACEHOLDERS = ["monitor", "project", "target", "status", "previous", "cause", "code", "latency", "duration", "time", "year", "link", "page"] as const;

/** The default texts of each language, for the editor's placeholders. */
export function defaultTexts() {
  return Object.fromEntries(
    LANGUAGES.map((l) => [l, { messages: TEXTS[l].messages, buttons: TEXTS[l].buttons, footer: TEXTS[l].footer, labels: TEXTS[l].labels }]),
  );
}

export function emptyTemplate(language: Language = "en"): Template {
  const blank = { title: "", body: "" };
  return {
    language,
    messages: { down: { ...blank }, up: { ...blank }, normal: { ...blank }, degraded: { ...blank } },
    details: { target: true, cause: true, latency: true, duration: true, project: false, time: false },
    buttons: { monitor: { enabled: true, label: "" }, statusPage: { enabled: false, label: "" } },
    discord: {
      username: "Status",
      avatarUrl: "",
      thumbnailUrl: "",
      footer: "",
      emoji: true,
      colors: { down: "#e5484d", up: "#30a46c", degraded: "#f5a524" },
      mentions: { down: "", up: "", normal: "", degraded: "" },
    },
  };
}

// --- Validation (what the editor sends, or what's stored) ---

const COLOR = /^#[0-9a-fA-F]{6}$/;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

export class TemplateError extends Error {}

function httpsUrl(v: unknown, what: string): string {
  const s = text(v, 2000).trim();
  if (!s) return "";
  try {
    if (new URL(s).protocol === "https:") return s;
  } catch {
    // falls through
  }
  throw new TemplateError(`The ${what} must be a URL starting with https://`);
}

/** A complete template from anything: unknown keys dropped, texts clipped, bad URLs refused. */
export function parseTemplate(raw: unknown): Template {
  const t = obj(raw);
  const base = emptyTemplate(LANGUAGES.includes(t.language as Language) ? (t.language as Language) : "en");
  const messages = obj(t.messages);
  for (const ev of MESSAGE_EVENTS) {
    const m = obj(messages[ev]);
    base.messages[ev] = { title: text(m.title, 250).trim(), body: text(m.body, 2000).trim() };
  }
  const details = obj(t.details);
  for (const d of DETAILS) base.details[d] = bool(details[d], base.details[d]);
  const buttons = obj(t.buttons);
  for (const b of ["monitor", "statusPage"] as const) {
    const o = obj(buttons[b]);
    base.buttons[b] = { enabled: bool(o.enabled, base.buttons[b].enabled), label: text(o.label, 80).trim() };
  }
  const d = obj(t.discord);
  const colors = obj(d.colors);
  const mentions = obj(d.mentions);
  base.discord = {
    // Discord refuses webhook names containing "discord", and longer than 80 characters.
    username: text(d.username ?? base.discord.username, 80).trim().replace(/discord/gi, "") || "Status",
    avatarUrl: httpsUrl(d.avatarUrl, "avatar"),
    thumbnailUrl: httpsUrl(d.thumbnailUrl, "thumbnail"),
    footer: text(d.footer, 300).trim(),
    emoji: bool(d.emoji, true),
    colors: {
      down: COLOR.test(String(colors.down)) ? String(colors.down) : base.discord.colors.down,
      up: COLOR.test(String(colors.up)) ? String(colors.up) : base.discord.colors.up,
      degraded: COLOR.test(String(colors.degraded)) ? String(colors.degraded) : base.discord.colors.degraded,
    },
    mentions: Object.fromEntries(MESSAGE_EVENTS.map((ev) => [ev, text(mentions[ev], 200).trim()])) as Template["discord"]["mentions"],
  };
  return base;
}

/** The stored template, or the defaults (old rows, or a template that no longer validates). */
export function storedTemplate(json: string): Template {
  if (!json) return emptyTemplate();
  try {
    return parseTemplate(JSON.parse(json));
  } catch {
    return emptyTemplate();
  }
}

// --- Rendering ---

export const messageEvent = (c: Change): MessageEvent =>
  c.to === "down" ? "down" : c.to === "degraded" ? "degraded" : c.from === "degraded" ? "normal" : "up";

const EMOJI: Record<MessageEvent, string> = { down: "🔴", up: "🟢", normal: "🟢", degraded: "🟡" };

function duration(ms: number, lang: Language): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
  return `${Math.floor(h / 24)} ${TEXTS[lang].days} ${h % 24} h`;
}

/** The status pages that show the monitor: the button links to the first (the default one first). */
async function pageUrl(monitorId: number): Promise<string> {
  if (!monitorId) return `${config().publicUrl}/status`;
  const [p] = await all<{ slug: string }>(
    `SELECT p.slug FROM status_page_monitors l JOIN status_page_groups g ON g.id = l.group_id JOIN status_pages p ON p.id = g.page_id
     WHERE l.monitor_id = ? ORDER BY p.is_default DESC, p.id LIMIT 1`,
    monitorId,
  );
  return p ? `${config().publicUrl}/status/${p.slug}` : "";
}

async function projectName(projectId: number | null): Promise<string> {
  if (projectId === null) return "";
  const [p] = await all<{ name: string }>("SELECT name FROM projects WHERE id = ?", projectId);
  return p?.name ?? "";
}

type Vars = Record<(typeof PLACEHOLDERS)[number], string>;

async function variables(c: Change, lang: Language, kind: string): Promise<Vars> {
  const m = c.monitor;
  const L = TEXTS[lang];
  const date = new Date(c.at);
  return {
    monitor: m.name,
    project: await projectName(m.projectId),
    target: m.type === "heartbeat" ? L.heartbeat : m.target,
    status: L.status[c.to],
    previous: L.status[c.from],
    cause: c.result.message,
    code: c.result.code !== null ? String(c.result.code) : "",
    latency: c.result.latency !== null ? `${c.result.latency} ms` : "",
    duration: c.downSince ? duration(c.at - c.downSince, lang) : "",
    // Discord shows its timestamps in each reader's time zone.
    time:
      kind === "discord"
        ? `<t:${Math.floor(c.at / 1000)}:f>`
        : `${new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date)} UTC`,
    link: `${config().publicUrl}/m/${m.id}`,
    page: await pageUrl(m.id),
    // For a footer like "© {year} bayfield.dev".
    year: String(date.getUTCFullYear()),
  };
}

/** {name} → its value; unknown placeholders stay as typed. A line that only held empty
 *  placeholders (no duration for a first outage…) is dropped; blank lines typed on purpose stay. */
const fill = (s: string, v: Vars) =>
  s
    .split("\n")
    .flatMap((line) => {
      const out = line.replace(/\{(\w+)\}/g, (all, k: string) => (k in v ? v[k as keyof Vars] : all));
      return /\{\w+\}/.test(line) && !out.trim() ? [] : [out];
    })
    .join("\n")
    .trim();

/** Everything a message says, filled in for this change. */
export async function compose(t: Template, c: Change, kind: string) {
  const ev = messageEvent(c);
  const L = TEXTS[t.language];
  const v = await variables(c, t.language, kind);
  const msg = t.messages[ev];
  const title = fill(msg.title || L.messages[ev].title, v);
  const body = fill(msg.body || L.messages[ev].body, v);
  const details: { label: string; value: string }[] = [];
  // A detail the title or text already says (the cause, the downtime…) isn't repeated.
  const add = (d: Detail, value: string) => t.details[d] && value && !`${title}
${body}`.includes(value) && details.push({ label: L.labels[d], value });
  add("target", v.target);
  add("cause", ev === "down" || ev === "degraded" ? v.cause : "");
  add("latency", v.latency);
  add("duration", ev === "up" ? v.duration : "");
  add("project", v.project);
  add("time", v.time);
  const buttons: { label: string; url: string }[] = [];
  if (t.buttons.monitor.enabled) buttons.push({ label: fill(t.buttons.monitor.label || L.buttons.monitor, v), url: v.link });
  if (t.buttons.statusPage.enabled && v.page) buttons.push({ label: fill(t.buttons.statusPage.label || L.buttons.statusPage, v), url: v.page });
  return {
    event: ev,
    emoji: EMOJI[ev],
    title,
    body,
    details,
    buttons,
    footer: fill(t.discord.footer || L.footer, v),
    mention: fill(t.discord.mentions[ev], v),
    vars: v,
  };
}

export type Composed = Awaited<ReturnType<typeof compose>>;

const C = { container: 17, section: 9, text: 10, thumbnail: 11, separator: 14, row: 1, button: 2 } as const;
const LINK_BUTTON = 5;
const IS_COMPONENTS_V2 = 1 << 15;

/** Discord: one container in the event's colour, like a bot's components message. */
export function discordBody(t: Template, m: Composed) {
  const color = parseInt((m.event === "down" ? t.discord.colors.down : m.event === "degraded" ? t.discord.colors.degraded : t.discord.colors.up).slice(1), 16);
  const headline = `## ${t.discord.emoji ? `${m.emoji} ` : ""}${m.title}${m.body ? `\n${m.body}` : ""}`.slice(0, 3000);
  const inside: unknown[] = [
    t.discord.thumbnailUrl
      ? { type: C.section, components: [{ type: C.text, content: headline }], accessory: { type: C.thumbnail, media: { url: t.discord.thumbnailUrl } } }
      : { type: C.text, content: headline },
  ];
  if (m.details.length) {
    inside.push({ type: C.separator, divider: true, spacing: 1 });
    inside.push({ type: C.text, content: m.details.map((d) => `**${d.label}**\n${d.value}`).join("\n").slice(0, 1500) });
  }
  // Discord only takes link buttons to public https addresses.
  const buttons = m.buttons.filter((b) => /^https:\/\//.test(b.url) && !/^https:\/\/(localhost|127\.)/.test(b.url));
  if (buttons.length) inside.push({ type: C.row, components: buttons.slice(0, 5).map((b) => ({ type: C.button, style: LINK_BUTTON, label: b.label.slice(0, 80), url: b.url })) });
  if (m.footer) inside.push({ type: C.text, content: `-# ${m.footer}`.slice(0, 500) });
  return {
    username: t.discord.username,
    ...(t.discord.avatarUrl ? { avatar_url: t.discord.avatarUrl } : {}),
    flags: IS_COMPONENTS_V2,
    // Only the mention line may ping; a monitor named "@everyone" never does.
    allowed_mentions: m.mention ? { parse: ["users", "roles", "everyone"] } : { parse: [] },
    components: [...(m.mention ? [{ type: C.text, content: m.mention }] : []), { type: C.container, accent_color: color, components: inside }],
  };
}

/** The webhook URL with ?with_components=true (keeping a ?thread_id=…). */
export function discordUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("with_components", "true");
  return u.toString();
}

export function slackText(m: Composed): string {
  const lines = [`${m.emoji} *${m.title}*`];
  if (m.body) lines.push(m.body);
  for (const d of m.details) lines.push(`*${d.label}:* ${d.value}`);
  if (m.buttons.length) lines.push(m.buttons.map((b) => `<${b.url}|${b.label}>`).join(" · "));
  return lines.join("\n");
}

/** ntfy's JSON publishing (UTF-8 titles, unlike its headers): POST the topic's server root. */
export function ntfyRequest(url: string, m: Composed) {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  const topic = parts.pop() ?? "";
  u.pathname = `/${parts.join("/")}`;
  u.search = "";
  const tags = { down: "rotating_light", up: "white_check_mark", normal: "white_check_mark", degraded: "warning" }[m.event];
  return {
    url: u.toString(),
    body: {
      topic,
      title: m.title,
      message: [m.body, ...m.details.map((d) => `${d.label}: ${d.value}`)].filter(Boolean).join("\n") || m.title,
      tags: [tags],
      priority: m.event === "down" ? 5 : 3,
      ...(m.buttons[0] ? { click: m.buttons[0].url } : {}),
      actions: m.buttons.slice(0, 3).map((b) => ({ action: "view", label: b.label, url: b.url })),
    },
  };
}
