// Worker configuration, read once per isolate from the bindings (wrangler.jsonc "vars", secrets,
// and .dev.vars locally). See server/.dev.vars.example for every option.

import { env } from "cloudflare:workers";
import pkg from "../../package.json" with { type: "json" };

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PUBLIC_URL?: string;
  APP_VERSION?: string;
  DEV_LOGIN_USER?: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_NAME?: string;
  OIDC_AUTO_CREATE?: string;
  OIDC_ALLOWED_GROUPS?: string;
  OIDC_ADMIN_GROUPS?: string;
  OIDC_DEFAULT_ROLE?: string;
  SESSION_IDLE_DAYS?: string;
  UPDATE_CHECK?: string;
  RETENTION_DAYS?: string;
}

const vars = env as unknown as Env;

function required(name: keyof Env): string {
  const value = (vars[name] as string | undefined)?.trim();
  if (!value) throw new Error(`Missing variable ${name} (see server/.dev.vars.example)`);
  return value;
}

const flag = (name: keyof Env, fallback: boolean) => {
  const v = (vars[name] as string | undefined)?.trim().toLowerCase();
  return v ? v === "true" || v === "1" || v === "yes" : fallback;
};

const list = (name: keyof Env) =>
  ((vars[name] as string | undefined) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export interface Config {
  publicUrl: string;
  secureCookies: boolean;
  appVersion: string;
  updateCheck: boolean;
  devLoginUser: string | null;
  sessionIdleDays: number;
  /** Raw checks are kept this long; daily summaries (the 90-day bars) are kept for a year. */
  retentionDays: number;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    name: string;
    redirectUri: string;
    autoCreate: boolean;
    allowedGroups: string[];
    adminGroups: string[];
    defaultRole: "viewer" | "collaborator";
  } | null;
}

let cached: Config | null = null;

/** Read on first use: bindings aren't all there while the module loads. */
export function config(): Config {
  if (cached) return cached;
  const publicUrl = required("PUBLIC_URL").replace(/\/+$/, "");
  // Local development only: signs straight in as this user. Ignored unless PUBLIC_URL is localhost.
  const devLoginUser = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(publicUrl) ? vars.DEV_LOGIN_USER?.trim() || null : null;
  if (!vars.OIDC_ISSUER && !devLoginUser) {
    throw new Error("Set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET: Status signs in through your identity provider (see server/.dev.vars.example)");
  }
  const env = vars.APP_VERSION?.trim();
  cached = {
    publicUrl,
    secureCookies: publicUrl.startsWith("https://"),
    appVersion: env && env !== "dev" ? env : ((pkg as { version?: string }).version ?? "dev"),
    updateCheck: flag("UPDATE_CHECK", true),
    devLoginUser,
    sessionIdleDays: Number(vars.SESSION_IDLE_DAYS ?? 30),
    retentionDays: Math.max(2, Number(vars.RETENTION_DAYS ?? 30)),
    oidc: vars.OIDC_ISSUER
      ? {
          issuer: vars.OIDC_ISSUER.trim()
            .replace(/^["']|["']$/g, "")
            .replace(/\/+$/, ""),
          clientId: required("OIDC_CLIENT_ID"),
          clientSecret: required("OIDC_CLIENT_SECRET"),
          name: vars.OIDC_NAME ?? "Authentik",
          redirectUri: `${publicUrl}/api/auth/oidc/callback`,
          autoCreate: flag("OIDC_AUTO_CREATE", true),
          allowedGroups: list("OIDC_ALLOWED_GROUPS"),
          adminGroups: list("OIDC_ADMIN_GROUPS"),
          defaultRole: (() => {
            const role = (vars.OIDC_DEFAULT_ROLE?.trim().toLowerCase() || "viewer") as "viewer" | "collaborator";
            if (role !== "viewer" && role !== "collaborator") throw new Error("OIDC_DEFAULT_ROLE is collaborator or viewer");
            return role;
          })(),
        }
      : null,
  };
  return cached;
}
