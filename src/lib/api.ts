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
export type Status = "pending" | "up" | "degraded" | "down" | "paused";
export const STATUSES: Status[] = ["down", "degraded", "up", "pending", "paused"];

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

export interface SeriesPoint {
  t: string;
  avg: number | null;
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
export const EVENTS = ["down", "up", "degraded"] as const;
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
  isDefault: boolean;
  groups: StatusPageGroup[];
  updatedAt: string;
}

/** What visitors get: /api/public/status (the default page) or /api/public/pages/<slug>. */
export interface PublicStatus {
  slug: string;
  title: string;
  description: string;
  logoUrl: string;
  updatedAt: string;
  groups: { name: string; monitors: { id: number; name: string; status: Status; statusSince: string | null; uptime90: number | null; history: HistoryDay[] }[] }[];
  incidents: { monitorId: number; monitorName: string; startedAt: string; resolvedAt: string | null }[];
}
