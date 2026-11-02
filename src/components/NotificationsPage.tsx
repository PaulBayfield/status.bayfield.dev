// Webhooks: where alerts go when a monitor goes down, comes back, or slows down.

import { useEffect, useState } from "react";
import { api, canContribute, type Webhook, type WebhookKind } from "../lib/api";
import { useApp } from "../lib/app";
import { invalidate, useApi } from "../lib/hooks";
import { useSettings } from "../lib/settings";
import { ConfirmDialog, Spinner, useToast } from "./common";
import { Bell, Pencil, Plus, Send, Trash } from "./icons";
import { Switch } from "./settings/common";

export const kindLabel: Record<WebhookKind, string> = { discord: "Discord", slack: "Slack", ntfy: "ntfy", generic: "Webhook (JSON)" };

export const WEBHOOKS = "/app/webhooks";

export function NotificationsPage() {
  const { t, f } = useSettings();
  const { me, edit, projects } = useApp();
  const toast = useToast();
  const hooks = useApi<Webhook[]>(WEBHOOKS, true);
  const [deleting, setDeleting] = useState<Webhook | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const editor = canContribute(me);
  const reload = () => {
    invalidate(WEBHOOKS);
    hooks.reload();
  };
  // The form in the side panel saved one.
  useEffect(() => {
    const onSaved = () => hooks.reload();
    window.addEventListener("status:webhooks", onSaved);
    return () => window.removeEventListener("status:webhooks", onSaved);
  }, [hooks.reload]);

  const test = async (w: Webhook) => {
    setTesting(w.id);
    try {
      await api(`${WEBHOOKS}/${w.id}/test`, { method: "POST" });
      toast(t("testSent"));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setTesting(null);
      reload();
    }
  };

  const toggle = async (w: Webhook, enabled: boolean) => {
    try {
      await api(`${WEBHOOKS}/${w.id}`, { method: "PATCH", body: { enabled } });
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="page">
      <p className="muted page-intro">{t("notificationsHint")}</p>
      {!hooks.data ? (
        <Spinner />
      ) : hooks.data.length === 0 ? (
        <div className="empty-state">
          <Bell size={28} />
          <h2>{t("noWebhooks")}</h2>
          <p className="muted">{t("noWebhooksHint")}</p>
          {editor && (
            <button className="primary-button" onClick={() => edit({ kind: "webhook" })}>
              <Plus size={14} />
              {t("addWebhook")}
            </button>
          )}
        </div>
      ) : (
        <div className="webhook-list">
          {hooks.data.map((w) => (
            <div key={w.id} className={`card webhook-card${w.enabled ? "" : " disabled"}`}>
              <div className="webhook-main">
                <div className="webhook-title">
                  <strong>{w.name}</strong>
                  <span className="badge">{kindLabel[w.kind]}</span>
                </div>
                <span className="small muted webhook-url">{maskUrl(w.url)}</span>
                <span className="small">
                  {w.events.map((e) => t(`event_${e}`)).join(" · ") || t("noEvents")}
                  <span className="muted">
                    {" — "}
                    {w.projects.length ? f.list(w.projects.map((id) => projects?.find((p) => p.id === id)?.name ?? `#${id}`)) : t("allMonitors")}
                  </span>
                </span>
                {w.lastSentAt && (
                  <span className={`small ${w.lastError ? "error-text" : "muted"}`}>
                    {w.lastError ? t("lastFailed", { when: f.relative(w.lastSentAt, t), error: w.lastError }) : t("lastSent", { when: f.relative(w.lastSentAt, t) })}
                  </span>
                )}
              </div>
              {editor && (
                <div className="webhook-actions">
                  <Switch checked={w.enabled} onChange={(on) => void toggle(w, on)} label={t("enabled")} />
                  <button className="text-button" disabled={testing === w.id} onClick={() => void test(w)}>
                    {testing === w.id ? <Spinner /> : <Send size={14} />}
                    <span className="hide-mobile">{t("sendTest")}</span>
                  </button>
                  <button className="icon-button" title={t("edit")} aria-label={t("edit")} onClick={() => edit({ kind: "webhook", webhook: w })}>
                    <Pencil />
                  </button>
                  <button className="icon-button danger" title={t("delete")} aria-label={t("delete")} onClick={() => setDeleting(w)}>
                    <Trash />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {deleting && (
        <ConfirmDialog
          title={t("deleteWebhook")}
          text={t("deleteWebhookConfirm", { name: deleting.name })}
          action={t("delete")}
          onConfirm={async () => {
            await api(`${WEBHOOKS}/${deleting.id}`, { method: "DELETE" });
            reload();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

/** Webhook URLs are credentials: show where they go, not the token. */
function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 18 ? `${u.pathname.slice(0, 14)}…` : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}
