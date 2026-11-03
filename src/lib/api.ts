// Talking to the Status Worker (same origin; Vite proxies /api in development).

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("status:signed-out"));
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

// --- Types (mirroring the server) ---

/** Viewers only look, collaborators manage monitors and webhooks, admins also users. */
export const ROLES = ["viewer", "collaborator", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const canContribute = (u: { role: Role }) => u.role !== "viewer";

export interface Me {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  ssoLinked: boolean;
  createdAt: string;
}

export interface AuthConfig {
  oidc: { name: string } | null;
  dev: boolean;
}

export interface ServerInfo {
  version: string;
  publicUrl: string;
  retentionDays: number;
  oidc: { name: string; adminGroups: boolean } | null;
}

export interface UpdateStatus {
  current: string;
  latest: { version: string; url: string; publishedAt: string | null } | null;
  available: boolean;
  releasesUrl: string;
  checkedAt: string;
  disabled?: boolean;
  error?: string;
}

export interface Session {
  id: string;
  current: boolean;
  method: string;
  userAgent: string;
  ip: string;
  createdAt: string;
  lastSeenAt: string;
}

export const MONITOR_TYPES = ["http", "tcp", "heartbeat"] as const;
export type MonitorType = (typeof MONITOR_TYPES)[number];
export type Status = "pending" | "up" | "degraded" | "down" | "paused" | "maintenance";
export const STATUSES: Status[] = ["down", "degraded", "up", "maintenance", "pending", "paused"];

/** [day "2026-11-02", checks, down, degraded] */
export type HistoryDay = readonly [string, number, number, number];

export interface Project {
  id: number;
  name: string;
  color: string;
  position: number;
}

export interface Monitor {
  id: number;
  projectId: number | null;
  name: string;
  type: MonitorType;
  target: string;
  method: string;
  expectedStatus: string;
  keyword: string;
  headers: string;
  followRedirects: boolean;
  timeoutMs: number;
  intervalS: number;
  retries: number;
  degradedMs: number;
  pushUrl: string | null;
  lastPingAt: string | null;
  /** The status pages that show it. */
  pages: { id: number; slug: string; title: string }[];
  /** HTTP (and TCP, for domains) monitors: watch the SSL certificate's and the domain's expiry. */
  certCheck: boolean;
  domainCheck: boolean;
  /** Empty: the registered domain of the target's host. */
  domainName: string;
  expiryWarnDays: number;
  expiries: ExpiryInfo[];
  paused: boolean;
  status: Status;
  lastCheckedAt: string | null;
  lastLatency: number | null;
  lastMessage: string;
  statusSince: string | null;
  createdAt: string;
  uptime30: number | null;
  uptime90: number | null;
  history: HistoryDay[];
}

export interface MonitorDetails extends Monitor {
  stats: {
    uptime24h: number | null;
    uptime7d: number | null;
    uptime30d: number | null;
    uptime90d: number | null;
    checks24h: number;
    avgLatency24h: number | null;
    minLatency24h: number | null;
    maxLatency24h: number | null;
    avgLatency30d: number | null;
  };
  openIncident: { id: number; startedAt: string; cause: string } | null;
}

export interface ExpiryInfo {
  kind: "certificate" | "domain";
  name: string;
  expiresAt: string | null;
  issuedAt: string | null;
  /** The certificate's issuer, or the domain's registrar. */
  issuer: string;
  /** tls: read from the server; ct: Certificate Transparency logs; rdap: the registry. */
  source: string;
  error: string;
  checkedAt: string;
}

/** Whole days until it expires (negative once expired), or null when unknown. */
export const daysLeft = (e: ExpiryInfo): number | null => (e.expiresAt ? Math.floor((new Date(e.expiresAt).getTime() - Date.now()) / 86_400_000) : null);

/** down: expired; degraded: within the warning days; up: fine; pending: unknown. */
export function expiryStatus(e: ExpiryInfo, warnDays: number): Status {
  const d = daysLeft(e);
  if (d === null) return "pending";
  return d < 0 ? "down" : d <= warnDays ? "degraded" : "up";
}

/** api.example.co.uk → example.co.uk: the domain the server checks when none is set. */
export function registeredDomain(target: string, type: MonitorType): string {
  let host = "";
  try {
    host = type === "http" ? new URL(target).hostname : target.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
  const labels = host.toLowerCase().split(".");
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":")) return "";
  if (labels.length <= 2) return labels.join(".");
  const sld = labels[labels.length - 2];
  const second = ["co", "com", "net", "org", "gov", "edu", "ac", "ltd", "plc", "me", "gouv", "asso"].includes(sld) && labels[labels.length - 1].length === 2;
  return labels.slice(second ? -3 : -2).join(".");
}

export interface SeriesPoint {
  t: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  n: number;
  down: number;
  degraded: number;
}

export interface Series {
  from: string;
  to: string;
  bucketMs: number;
  points: SeriesPoint[];
}

export interface Check {
  at: string;
  status: "up" | "degraded" | "down";
  latency: number | null;
  code: number | null;
  message: string;
}

export interface Incident {
  id: number;
  monitorId: number;
  monitorName: string;
  projectId: number | null;
  startedAt: string;
  resolvedAt: string | null;
  cause: string;
}

export const WEBHOOK_KINDS = ["discord", "slack", "ntfy", "generic"] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];
export const EVENTS = ["down", "up", "degraded", "expiry", "post", "maintenance"] as const;
export type WebhookEvent = (typeof EVENTS)[number];

export interface Webhook {
  id: number;
  name: string;
  kind: WebhookKind;
  url: string;
  hasSecret: boolean;
  events: WebhookEvent[];
  projects: number[];
  enabled: boolean;
  lastSentAt: string | null;
  lastError: string;
  template: MessageTemplate;
}

export const MESSAGE_EVENTS = ["down", "up", "normal", "degraded", "expiring", "post", "maintenance"] as const;
/** down, back up (after down), back to normal (after degraded), degraded, a certificate or domain expiring. */
export type MessageEvent = (typeof MESSAGE_EVENTS)[number];
export const MESSAGE_DETAILS = ["target", "cause", "latency", "duration", "project", "time"] as const;
export type MessageDetail = (typeof MESSAGE_DETAILS)[number];
export const PLACEHOLDERS = ["monitor", "project", "target", "status", "previous", "cause", "code", "latency", "duration", "time", "year", "link", "page", "what", "name", "expires", "days", "expiry", "issuer", "title", "update", "impact", "phase", "start", "end", "affects"] as const;

/** What a webhook's notifications say and look like. Empty texts: the language's defaults. */
export interface MessageTemplate {
  language: "en" | "fr";
  messages: Record<MessageEvent, { title: string; body: string }>;
  details: Record<MessageDetail, boolean>;
  /** statusPage.page: a status page's slug, or empty for the monitor's own page. */
  buttons: { monitor: { enabled: boolean; label: string }; statusPage: { enabled: boolean; label: string; page: string } };
  discord: {
    username: string;
    avatarUrl: string;
    thumbnailUrl: string;
    footer: string;
    emoji: boolean;
    colors: Record<"down" | "up" | "degraded" | "maintenance", string>;
    mentions: Record<MessageEvent, string>;
  };
}

export interface MessageDefaults {
  texts: Record<"en" | "fr", { messages: Record<MessageEvent, { title: string; body: string }>; buttons: { monitor: string; statusPage: string }; footer: string; labels: Record<MessageDetail, string> }>;
}

export interface AdminUser extends Me {
  lastSeenAt: string | null;
}

export interface StatusPageGroup {
  name: string;
  monitors: number[];
}

export interface StatusPage {
  id: number;
  slug: string;
  title: string;
  description: string;
  /** A link to an image hosted elsewhere; empty for the app's icon. */
  logoUrl: string;
  display: PageDisplay;
  /** A host name that serves this page at / (status.example.com), or empty. */
  domain: string;
  isDefault: boolean;
  groups: StatusPageGroup[];
  updatedAt: string;
}

/** What a status page shows. Response times: hidden, a chart visitors open, or open already. */
export interface PageDisplay {
  tiles: boolean;
  bars: boolean;
  incidents: boolean;
  charts: "off" | "collapsed" | "expanded";
}

/** What visitors get: /api/public/status (the default page) or /api/public/pages/<slug>. */
export interface PublicStatus {
  slug: string;
  title: string;
  description: string;
  logoUrl: string;
  display: PageDisplay;
  updatedAt: string;
  /** On a custom domain: Status's own address, for "Sign in". */
  home: string | null;
  posts: PublicPost[];
  maintenances: PublicMaintenance[];
  groups: { name: string; monitors: { id: number; name: string; status: Status; statusSince: string | null; uptime90: number | null; history: HistoryDay[] }[] }[];
  incidents: { monitorId: number; monitorName: string; startedAt: string; resolvedAt: string | null }[];
}

// --- Incident posts and maintenance ---

export const POST_STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];
export const IMPACTS = ["none", "minor", "major"] as const;
export type Impact = (typeof IMPACTS)[number];

export interface PostUpdate {
  id: number;
  status: PostStatus;
  body: string;
  createdAt: string;
  author?: string;
}

export interface Post {
  id: number;
  title: string;
  impact: Impact;
  status: PostStatus;
  author: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  pages: number[];
  monitors: number[];
  /** Newest first. */
  updates: PostUpdate[];
}

export type PublicPost = Omit<Post, "author" | "updatedAt" | "pages">;

export interface Maintenance {
  id: number;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  author: string;
  monitors: number[];
  /** Send webhook notifications: scheduled, started, over. */
  notify: boolean;
}

export interface PublicMaintenance {
  id: number;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  active: boolean;
  monitors: number[];
}

export type WindowState = "upcoming" | "active" | "done";
export const windowState = (w: { startsAt: string; endsAt: string }, now = Date.now()): WindowState =>
  new Date(w.startsAt).getTime() > now ? "upcoming" : new Date(w.endsAt).getTime() > now ? "active" : "done";
