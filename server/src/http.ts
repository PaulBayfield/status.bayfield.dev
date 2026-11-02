// Small request helpers shared by the routes.

import type { Context } from "hono";

export class HttpError extends Error {
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503;
  constructor(status: HttpError["status"], message: string) {
    super(message);
    this.status = status;
  }
}

export const bad = (message = "Invalid request") => new HttpError(400, message);

/** On Cloudflare the visitor's address is always in cf-connecting-ip. */
export const clientIp = (c: Context): string => c.req.header("cf-connecting-ip") ?? "unknown";

const hits = new Map<string, number[]>();

/**
 * Sliding-window limit per key (bucket + client IP). Throws 429 when exceeded.
 * Per isolate: a brake on hammering, not a hard quota.
 */
export function rateLimit(c: Context, bucket: string, limit: number, windowMs: number) {
  const key = `${bucket}:${clientIp(c)}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) {
    for (const [k, times] of hits) if (times[times.length - 1] < now - 60 * 60_000) hits.delete(k);
  }
  if (recent.length > limit) throw new HttpError(429, "Too many attempts, try again later");
}

export async function body(c: Context): Promise<Record<string, unknown>> {
  const data = await c.req.json().catch(() => null);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw bad();
  return data as Record<string, unknown>;
}

export const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** An integer within [min, max], or the fallback. */
export function int(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

export const id = (c: Context, name = "id"): number => {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, "Not found");
  return n;
};
