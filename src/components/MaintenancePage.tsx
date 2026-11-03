// Planned maintenance (/maintenance): windows during which some monitors aren't checked or alerted
// on, announced on the status pages that show them. The list, and the form in the side panel.

import { useState } from "react";
import { api, canContribute, windowState, type Maintenance } from "../lib/api";
import { useApp } from "../lib/app";
import { invalidate, useApi } from "../lib/hooks";
import { Markdown } from "../lib/markdown";
import { useSettings } from "../lib/settings";
import { ConfirmDialog, Spinner, useToast } from "./common";
import { Field, FormShell } from "./SidePanel";
import { MonitorChecklist, useOnChanged } from "./PostsPage";
import { StatusDot } from "./status";
import { duration } from "./IncidentsPage";
import { Pencil, Plus, Wrench } from "./icons";

export const MAINTENANCE = "/app/maintenance";

/** "2 Nov, 22:00 – 23:30", or with both dates when it spans days. */
export function useWindowText() {
  const { f } = useSettings();
  return (w: { startsAt: string; endsAt: string }) => {
    const a = new Date(w.startsAt);
    const b = new Date(w.endsAt);
    const time = new Intl.DateTimeFormat(f.locale, { hour: "2-digit", minute: "2-digit" });
    return a.toDateString() === b.toDateString() ? `${f.dateTime(a)} – ${time.format(b)}` : `${f.dateTime(a)} – ${f.dateTime(b)}`;
  };
}

export function MaintenancePage() {
  const { t } = useSettings();
  const { me, edit, monitors } = useApp();
  const toast = useToast();
  const list = useApi<Maintenance[]>(MAINTENANCE, true);
  const [ending, setEnding] = useState<Maintenance | null>(null);
  const editor = canContribute(me);
  const span = useWindowText();
  useOnChanged("status:maintenance", list.reload);
  const groups = (["active", "upcoming", "done"] as const)
    .map((state) => ({ state, items: (list.data ?? []).filter((w) => windowState(w) === state) }))
    .map((g) => ({ ...g, items: g.state === "done" ? g.items : [...g.items].reverse() }))
    .filter((g) => g.items.length);

  return (
    <div className="page">
      <div className="page-head">
        <p className="muted page-intro">{t("maintenanceIntro")}</p>
        {editor && list.data && list.data.length > 0 && (
          <button className="text-button" onClick={() => edit({ kind: "maintenance" })}>
            <Plus size={14} />
            {t("newMaintenance")}
          </button>
        )}
      </div>
      {!list.data ? (
        <Spinner />
      ) : list.data.length === 0 ? (
        <div className="empty-state">
          <Wrench size={28} />
          <h2>{t("noMaintenance")}</h2>
          {editor && (
            <button className="primary-button" onClick={() => edit({ kind: "maintenance" })}>
              <Plus size={14} />
              {t("newMaintenance")}
            </button>
          )}
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.state} className="monitor-group">
            <h2 className="group-title">{t(`window_${g.state}`)}</h2>
            <div className="webhook-list">
              {g.items.map((w) => (
                <div key={w.id} className={`card webhook-card maintenance-card w-${g.state}`}>
                  <div className="webhook-main">
                    <div className="webhook-title">
                      <strong>{w.title}</strong>
                      {g.state === "active" && <span className="status-pill s-maintenance">{t("window_active_short")}</span>}
                    </div>
                    <span className="small">
                      {span(w)}
                      {g.state === "upcoming" && <span className="muted"> · {t("startsIn", { when: duration(new Date(w.startsAt).getTime() - Date.now(), t) })}</span>}
                    </span>
                    {w.description && <Markdown className="small muted" text={w.description} />}
                    <span className="affected">
                      {w.monitors.map((mid) => {
                        const m = monitors?.find((x) => x.id === mid);
                        return m ? (
                          <span key={mid} className="affected-chip">
                            <StatusDot status={m.status} />
                            {m.name}
                          </span>
                        ) : null;
                      })}
                    </span>
                  </div>
                  {editor && g.state !== "done" && (
                    <div className="webhook-actions">
                      {g.state === "active" && (
                        <button className="text-button" onClick={() => setEnding(w)}>
                          {t("endNow")}
                        </button>
                      )}
                      <button className="icon-button" title={t("edit")} aria-label={t("edit")} onClick={() => edit({ kind: "maintenance", maintenance: w })}>
                        <Pencil />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))
      )}
      {ending && (
        <ConfirmDialog
          title={t("endMaintenance")}
          text={t("endMaintenanceConfirm", { title: ending.title })}
          action={t("endNow")}
          onConfirm={async () => {
            await api(`${MAINTENANCE}/${ending.id}/end`, { method: "POST" });
            invalidate(MAINTENANCE);
            invalidate("/app/monitors");
            list.reload();
            toast(t("maintenanceEnded"));
          }}
          onClose={() => setEnding(null)}
        />
      )}
    </div>
  );
}

/** <input type="datetime-local"> works in local time without a zone: convert both ways. */
const toLocal = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocal = (s: string) => (s ? new Date(s).toISOString() : "");

export function MaintenanceForm({ maintenance }: { maintenance?: Maintenance }) {
  const { t } = useSettings();
  const { edit, reload } = useApp();
  const toast = useToast();
  // A new window: the next round hour, for an hour.
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const [title, setTitle] = useState(maintenance?.title ?? "");
  const [description, setDescription] = useState(maintenance?.description ?? "");
  const [startsAt, setStartsAt] = useState(toLocal(maintenance ? new Date(maintenance.startsAt) : start));
  const [endsAt, setEndsAt] = useState(toLocal(maintenance ? new Date(maintenance.endsAt) : new Date(start.getTime() + 3_600_000)));
  const [monitorIds, setMonitorIds] = useState<number[]>(maintenance?.monitors ?? []);
  const [notifyOn, setNotifyOn] = useState(maintenance?.notify ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(maintenance ? `${MAINTENANCE}/${maintenance.id}` : MAINTENANCE, {
        method: maintenance ? "PATCH" : "POST",
        body: { title, description, startsAt: fromLocal(startsAt), endsAt: fromLocal(endsAt), monitors: monitorIds, notify: notifyOn },
      });
      invalidate(MAINTENANCE);
      window.dispatchEvent(new Event("status:maintenance"));
      reload();
      toast(maintenance ? t("saved") : t("maintenanceScheduled"));
      edit(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Quick lengths from the start. */
  const length = (minutes: number) => {
    const s = new Date(startsAt);
    if (!Number.isNaN(s.getTime())) setEndsAt(toLocal(new Date(s.getTime() + minutes * 60_000)));
  };

  return (
    <>
      <FormShell onSubmit={submit} busy={busy} error={error} submitLabel={maintenance ? t("save") : t("scheduleMaintenance")} onDelete={maintenance ? () => setDeleting(true) : undefined}>
        <Field label={t("postTitle")}>
          <input className="text-field" value={title} maxLength={150} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder={t("maintenanceTitlePlaceholder")} />
        </Field>
        <div className="date-grid">
          <Field label={t("startsAt")}>
            <input className="text-field" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </Field>
          <Field label={t("endsAt")}>
            <input className="text-field" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </Field>
        </div>
        <div className="quick-lengths">
          {[30, 60, 120, 240].map((m) => (
            <button type="button" key={m} className="placeholder-chip" onClick={() => length(m)}>
              {m < 60 ? `${m} min` : `${m / 60} h`}
            </button>
          ))}
          <span className="form-hint">{t("timeZoneHint", { zone })}</span>
        </div>
        <Field label={t("pageDescription")} hint={t("markdownHint")}>
          <textarea className="text-field prose-field" rows={3} value={description} maxLength={4000} placeholder={t("optional")} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="form-field">
          <span className="form-label">{t("postMonitors")}</span>
          <MonitorChecklist value={monitorIds} onChange={setMonitorIds} />
          <span className="form-hint">{t("maintenanceMonitorsHint")}</span>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={notifyOn} onChange={(e) => setNotifyOn(e.target.checked)} />
          {t("notifyWebhooks")}
        </label>
        <span className="form-hint">{t("maintenanceNotifyHint")}</span>
      </FormShell>
      {deleting && maintenance && (
        <ConfirmDialog
          title={t("deleteMaintenance")}
          text={t("deleteMaintenanceConfirm", { title: maintenance.title })}
          action={t("delete")}
          onConfirm={async () => {
            await api(`${MAINTENANCE}/${maintenance.id}`, { method: "DELETE" });
            invalidate(MAINTENANCE);
            window.dispatchEvent(new Event("status:maintenance"));
            reload();
            edit(null);
          }}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );
}
