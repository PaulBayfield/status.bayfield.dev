// The user record and the shape the app sees.

import { first } from "./db.ts";

/** Viewers only look, collaborators manage monitors and projects, admins also users and webhooks. */
export const ROLES = ["viewer", "collaborator", "admin"] as const;
export type Role = (typeof ROLES)[number];
export const isRole = (v: unknown): v is Role => ROLES.includes(v as Role);

export interface User {
  id: string;
  name: string;
  email: string | null;
  oidcSub: string | null;
  role: Role;
  createdAt: number;
  lastSeenAt: number | null;
}

export const getUser = (id: string) => first<User>("SELECT * FROM users WHERE id = ?", id);

/** What the signed-in user's app gets: no secrets. */
export function meView(u: User) {
  return {
    id: u.id,
    name: u.name || u.id,
    email: u.email,
    role: u.role,
    ssoLinked: !!u.oidcSub,
    createdAt: new Date(u.createdAt).toISOString(),
  };
}

/** A free username based on `wanted` ("paul", "paul2", …). */
export async function freeUsername(wanted: string): Promise<string> {
  const base =
    wanted
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9_.-]+/g, "")
      .replace(/^[^a-zA-Z0-9]+/, "")
      .slice(0, 50) || "user";
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? base : `${base}${i}`;
    if (!(await first("SELECT 1 AS x FROM users WHERE lower(id) = lower(?)", candidate))) return candidate;
  }
}
