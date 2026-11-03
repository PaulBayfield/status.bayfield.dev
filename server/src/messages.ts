// What a notification says, and how it looks: each webhook has a message template (titles and
// texts per event with {placeholders}, which details and buttons to include, and Discord's look),
// turned here into each service's request. Empty texts fall back to the defaults of the
// template's language.
//
// Discord gets a components message (a coloured container with a text section, a thumbnail,
// details, link buttons and a footer), like CROUStillantBot's: flag IS_COMPONENTS_V2 and
// ?with_components=true, which lets a plain webhook send non-interactive components.

import { all, first } from "./db.ts";
import { config } from "./config.ts";
import type { Change, Notice } from "./notify.ts";

export const MESSAGE_EVENTS = ["down", "up", "normal", "degraded", "expiring", "post", "maintenance"] as const;
/** down, back up (after down), back to normal (after degraded), degraded, a certificate or domain expiring. */
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
  /** statusPage.page: a status page's address (slug), or empty for the monitor's own page. */
  buttons: { monitor: { enabled: boolean; label: string }; statusPage: { enabled: boolean; label: string; page: string } };
  discord: {
    username: string;
    avatarUrl: string;
    thumbnailUrl: string;
    footer: string;
    emoji: boolean;
    colors: Record<"down" | "up" | "degraded" | "maintenance", string>;
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
      expiring: { title: "The {what} of {monitor} {expiry}", body: "{name} · until {expires} · {issuer}" },
      post: { title: "{title}", body: "**{status}** · {update}" },
      maintenance: { title: "{phase}: {title}", body: "{start} → {end}\n{update}" },
    },
    labels: { target: "Target", cause: "Cause", latency: "Response time", duration: "Downtime", project: "Project", time: "Time" },
    noticeLabels: { affects: "Affects", impact: "Impact" },
    phase: { new: "New announcement", update: "Update", resolved: "Resolved", scheduled: "Maintenance scheduled", started: "Maintenance started", ended: "Maintenance over" },
    postStatus: { investigating: "Investigating", identified: "Identified", monitoring: "Monitoring", resolved: "Resolved" },
    impact: { none: "Notice", minor: "Minor", major: "Major" },
    what: { certificate: "SSL certificate", domain: "domain" },
    expiry: { future: "expires in {n} days", tomorrow: "expires tomorrow", today: "expires today", past: "expired {n} days ago", yesterday: "expired yesterday" },
    buttons: { monitor: "Open in Status", statusPage: "Status page" },
    noticeButton: "Open in Status",
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
      expiring: { title: "Le {what} de {monitor} {expiry}", body: "{name} · jusqu'au {expires} · {issuer}" },
      post: { title: "{title}", body: "**{status}** · {update}" },
      maintenance: { title: "{phase} : {title}", body: "{start} → {end}\n{update}" },
    },
    labels: { target: "Cible", cause: "Cause", latency: "Temps de réponse", duration: "Durée de la panne", project: "Projet", time: "Heure" },
    noticeLabels: { affects: "Concerne", impact: "Impact" },
    phase: { new: "Nouvelle annonce", update: "Mise à jour", resolved: "Résolu", scheduled: "Maintenance planifiée", started: "Maintenance commencée", ended: "Maintenance terminée" },
    postStatus: { investigating: "Analyse en cours", identified: "Cause identifiée", monitoring: "Sous surveillance", resolved: "Résolu" },
    impact: { none: "Information", minor: "Mineur", major: "Majeur" },
    what: { certificate: "certificat SSL", domain: "nom de domaine" },
    expiry: { future: "expire dans {n} jours", tomorrow: "expire demain", today: "expire aujourd'hui", past: "a expiré il y a {n} jours", yesterday: "a expiré hier" },
    buttons: { monitor: "Ouvrir dans Status", statusPage: "Page de statut" },
    noticeButton: "Ouvrir dans Status",
    footer: "Status · {time}",
    status: { up: "En ligne", down: "Hors service", degraded: "Dégradé", pending: "En attente" },
    heartbeat: "Heartbeat",
    days: "jours",
  },
} as const;

export const PLACEHOLDERS = [
  "monitor",
  "project",
  "target",
  "status",
  "previous",
  "cause",
  "code",
  "latency",
  "duration",
  "time",
  "year",
  "link",
  "page",
  // Certificate and domain warnings:
  "what",
  "name",
  "expires",
  "days",
  "expiry",
  "issuer",
  // Announcements and maintenance:
  "title",
  "update",
  "impact",
  "phase",
  "start",
  "end",
  "affects",
] as const;

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
    messages: { down: { ...blank }, up: { ...blank }, normal: { ...blank }, degraded: { ...blank }, expiring: { ...blank }, post: { ...blank }, maintenance: { ...blank } },
    details: { target: true, cause: true, latency: true, duration: true, project: false, time: false },
    buttons: { monitor: { enabled: true, label: "" }, statusPage: { enabled: false, label: "", page: "" } },
    discord: {
      username: "Status",
      avatarUrl: "",
      thumbnailUrl: "",
      footer: "",
      emoji: true,
      colors: { down: "#e5484d", up: "#30a46c", degraded: "#f5a524", maintenance: "#3e63dd" },
      mentions: { down: "", up: "", normal: "", degraded: "", expiring: "", post: "", maintenance: "" },
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
  const button = (o: Record<string, unknown>, fallback: boolean) => ({ enabled: bool(o.enabled, fallback), label: text(o.label, 80).trim() });
  base.buttons.monitor = button(obj(buttons.monitor), base.buttons.monitor.enabled);
  const sp = obj(buttons.statusPage);
  const page = text(sp.page, 64).trim().toLowerCase();
  base.buttons.statusPage = { ...button(sp, base.buttons.statusPage.enabled), page: /^[a-z0-9-]*$/.test(page) ? page : "" };
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
      maintenance: COLOR.test(String(colors.maintenance)) ? String(colors.maintenance) : base.discord.colors.maintenance,
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
  c.expiry ? "expiring" : c.to === "down" ? "down" : c.to === "degraded" ? "degraded" : c.from === "degraded" ? "normal" : "up";

const EMOJI: Record<MessageEvent, string> = { down: "🔴", up: "🟢", normal: "🟢", degraded: "🟡", expiring: "⏳", post: "📢", maintenance: "🔧" };

/** Whole days until the expiry (negative once expired). */
const daysLeft = (at: number, expiresAt: number) => Math.floor((expiresAt - at) / (24 * 60 * 60_000));

function duration(ms: number, lang: Language): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
  return `${Math.floor(h / 24)} ${TEXTS[lang].days} ${h % 24} h`;
}

/** Where the "status page" button and {page} lead: the chosen page; otherwise a page showing the
 *  monitor (the default one first). A made-up test monitor is on no page: then a page showing
 *  one of the webhook's monitors, or the default page. */
async function pageUrl(monitorId: number, chosen: string, projects: number[]): Promise<string> {
  const url = (slug: string) => `${config().publicUrl}/status/${slug}`;
  if (chosen && (await all("SELECT 1 AS x FROM status_pages WHERE slug = ?", chosen)).length) return url(chosen);
  const pages = "FROM status_page_monitors l JOIN status_page_groups g ON g.id = l.group_id JOIN status_pages p ON p.id = g.page_id JOIN monitors m ON m.id = l.monitor_id";
  const [p] = monitorId
    ? await all<{ slug: string }>(`SELECT p.slug ${pages} WHERE l.monitor_id = ? ORDER BY p.is_default DESC, p.id LIMIT 1`, monitorId)
    : projects.length
      ? await all<{ slug: string }>(`SELECT p.slug ${pages} WHERE m.project_id IN (${projects.map(() => "?").join(",")}) ORDER BY p.is_default DESC, p.id LIMIT 1`, ...projects)
      : await all<{ slug: string }>("SELECT slug FROM status_pages ORDER BY is_default DESC, id LIMIT 1");
  return p ? url(p.slug) : "";
}

async function projectName(projectId: number | null): Promise<string> {
  if (projectId === null) return "";
  const [p] = await all<{ name: string }>("SELECT name FROM projects WHERE id = ?", projectId);
  return p?.name ?? "";
}

type Vars = Record<(typeof PLACEHOLDERS)[number], string>;

async function variables(c: Change, t: Template, kind: string, projects: number[]): Promise<Vars> {
  const lang = t.language;
  const m = c.monitor;
  const L = TEXTS[lang];
  const date = new Date(c.at);
  const x = c.expiry;
  const days = x?.expiresAt ? daysLeft(c.at, x.expiresAt) : null;
  const dateFmt = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", { dateStyle: "long", timeZone: "UTC" });
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
    page: await pageUrl(m.id, t.buttons.statusPage.page, projects),
    // For a footer like "© {year} bayfield.dev".
    year: String(date.getUTCFullYear()),
    what: x ? L.what[x.kind] : "",
    name: x?.name ?? "",
    expires: x?.expiresAt ? dateFmt.format(new Date(x.expiresAt)) : "",
    days: days !== null ? String(days) : "",
    expiry:
      days === null
        ? ""
        : days > 1
          ? L.expiry.future.replace("{n}", String(days))
          : days === 1
            ? L.expiry.tomorrow
            : days === 0
              ? L.expiry.today
              : days === -1
                ? L.expiry.yesterday
                : L.expiry.past.replace("{n}", String(-days)),
    issuer: x?.issuer ?? "",
    title: "",
    update: "",
    impact: "",
    phase: "",
    start: "",
    end: "",
    affects: "",
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
/** `projects`: the webhook's projects, for a test's status page. */
export async function compose(t: Template, c: Change, kind: string, projects: number[] = []) {
  const ev = messageEvent(c);
  const L = TEXTS[t.language];
  const v = await variables(c, t, kind, projects);
  const msg = t.messages[ev];
  const title = fill(msg.title || L.messages[ev].title, v);
  const body = fill(msg.body || L.messages[ev].body, v);
  const details: { label: string; value: string }[] = [];
  // A detail the title or text already says (the cause, the downtime…) isn't repeated.
  const add = (d: Detail, value: string) => t.details[d] && value && !`${title}
${body}`.includes(value) && details.push({ label: L.labels[d], value });
  add("target", v.target);
  add("cause", ev === "down" || ev === "degraded" || ev === "expiring" ? v.cause : "");
  add("latency", v.latency);
  add("duration", ev === "up" ? v.duration : "");
  add("project", v.project);
  add("time", v.time);
  const buttons: { label: string; url: string }[] = [];
  if (t.buttons.monitor.enabled) buttons.push({ label: fill(t.buttons.monitor.label || L.buttons.monitor, v), url: v.link });
  if (t.buttons.statusPage.enabled && v.page) buttons.push({ label: fill(t.buttons.statusPage.label || L.buttons.statusPage, v), url: v.page });
  const expired = !!c.expiry?.expiresAt && c.expiry.expiresAt <= c.at;
  return {
    event: ev,
    /** An expiry warning for something already expired: shown in the "down" colour. */
    expired,
    /** The colour: down, degraded, up or maintenance. */
    tone: (ev === "down" || expired ? "down" : ev === "degraded" || ev === "expiring" ? "degraded" : "up") as Tone,
    emoji: ev === "expiring" && c.expiry?.expiresAt && c.expiry.expiresAt <= c.at ? "🔴" : EMOJI[ev],
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
type Tone = "down" | "degraded" | "up" | "maintenance";

/** Where a notice's button and {page} lead: the chosen page, or the notice's own (custom domain first). */
async function noticePage(chosen: string, slug: string | null): Promise<string> {
  const pick = chosen && (await first<{ slug: string }>("SELECT slug FROM status_pages WHERE slug = ?", chosen)) ? chosen : slug;
  if (!pick) return "";
  const row = await first<{ domain: string }>("SELECT domain FROM status_pages WHERE slug = ?", pick);
  return row?.domain ? `https://${row.domain}` : `${config().publicUrl}/status/${pick}`;
}

/** An announcement or a maintenance window, as a message (same shape as a monitor's change). */
export async function composeNotice(t: Template, n: Notice, kind: string) {
  const ev: MessageEvent = n.kind;
  const L = TEXTS[t.language];
  const date = new Date(n.at);
  const when = (ms: number | undefined) =>
    ms === undefined
      ? ""
      : kind === "discord"
        ? `<t:${Math.floor(ms / 1000)}:f>`
        : `${new Intl.DateTimeFormat(t.language === "fr" ? "fr-FR" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(ms))} UTC`;
  const affects = n.monitors.map((m) => m.name).join(", ");
  const projects = [...new Set(n.monitors.map((m) => m.projectId).filter((p): p is number => p !== null))];
  const v: Vars = {
    monitor: "",
    project: projects.length === 1 ? await projectName(projects[0]) : "",
    target: "",
    status: n.kind === "post" ? L.postStatus[n.postStatus ?? "investigating"] : L.phase[n.phase],
    previous: "",
    cause: "",
    code: "",
    latency: "",
    duration: "",
    time: when(n.at),
    link: `${config().publicUrl}${n.kind === "post" ? `/posts/${n.id}` : "/maintenance"}`,
    page: await noticePage(t.buttons.statusPage.page, n.pageSlug),
    year: String(date.getUTCFullYear()),
    what: "",
    name: "",
    expires: "",
    days: "",
    expiry: "",
    issuer: "",
    title: n.title,
    update: n.text,
    impact: n.impact ? L.impact[n.impact] : "",
    phase: L.phase[n.phase],
    start: when(n.startsAt),
    end: when(n.endsAt),
    affects,
  };
  const msg = t.messages[ev];
  const title = fill(msg.title || L.messages[ev].title, v);
  const body = fill(msg.body || L.messages[ev].body, v);
  const details: { label: string; value: string }[] = [];
  const add = (on: boolean, label: string, value: string) => on && value && !`${title}\n${body}`.includes(value) && details.push({ label, value });
  // "Target" stands for what a notice touches; project and time as for monitors.
  add(t.details.target, L.noticeLabels.affects, affects);
  add(n.kind === "post", L.noticeLabels.impact, v.impact);
  add(t.details.project, L.labels.project, v.project);
  add(t.details.time, L.labels.time, v.time);
  const buttons: { label: string; url: string }[] = [];
  if (t.buttons.monitor.enabled) buttons.push({ label: fill(t.buttons.monitor.label || L.noticeButton, v), url: v.link });
  if (t.buttons.statusPage.enabled && v.page) buttons.push({ label: fill(t.buttons.statusPage.label || L.buttons.statusPage, v), url: v.page });
  const done = n.phase === "resolved" || n.phase === "ended";
  const tone: Tone = done ? "up" : n.kind === "maintenance" ? "maintenance" : n.impact === "major" ? "down" : n.impact === "minor" ? "degraded" : "maintenance";
  return {
    event: ev,
    expired: false,
    tone,
    emoji: done ? "✅" : n.kind === "post" ? (n.impact === "major" ? "🔴" : n.impact === "minor" ? "🟠" : "📢") : EMOJI[ev],
    title,
    body,
    details,
    buttons,
    footer: fill(t.discord.footer || L.footer, v),
    mention: fill(t.discord.mentions[ev], v),
    vars: v,
  };
}

const C = { container: 17, section: 9, text: 10, thumbnail: 11, separator: 14, row: 1, button: 2 } as const;
const LINK_BUTTON = 5;
const IS_COMPONENTS_V2 = 1 << 15;

/** Discord: one container in the event's colour, like a bot's components message. */
export function discordBody(t: Template, m: Composed) {
  const hex = t.discord.colors[m.tone];
  const color = parseInt(hex.slice(1), 16);
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

/** Slack's mrkdwn: *bold*, _italic_, <url|text> (the texts are written in Discord's markdown). */
const toSlack = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<$2|$1>");

export function slackText(m: Composed): string {
  const lines = [`${m.emoji} *${toSlack(m.title).replace(/\*/g, "")}*`];
  if (m.body) lines.push(toSlack(m.body));
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
  const tags = { down: "rotating_light", up: "white_check_mark", normal: "white_check_mark", degraded: "warning", expiring: "hourglass", post: "loudspeaker", maintenance: "wrench" }[m.event];
  return {
    url: u.toString(),
    body: {
      topic,
      // The texts may use markdown (**bold**, links): ntfy renders it in its apps.
      markdown: true,
      title: m.title,
      message: [m.body, ...m.details.map((d) => `${d.label}: ${d.value}`)].filter(Boolean).join("\n") || m.title,
      tags: [tags],
      priority: m.tone === "down" ? 5 : m.event === "expiring" ? 4 : 3,
      ...(m.buttons[0] ? { click: m.buttons[0].url } : {}),
      actions: m.buttons.slice(0, 3).map((b) => ({ action: "view", label: b.label, url: b.url })),
    },
  };
}
