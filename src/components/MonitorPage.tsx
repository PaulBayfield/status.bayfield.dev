// One monitor: its state, uptime over several spans, response times, incidents and recent checks.

import { useState } from "react";
import { api, canContribute, daysLeft, expiryStatus, type Check, type Incident, type MonitorDetails, type MonitorType, type Series } from "../lib/api";
import { useApp } from "../lib/app";
import { invalidate, useApi } from "../lib/hooks";
import { useSettings } from "../lib/settings";
import { ConfirmDialog, CopyButton, Spinner, useToast } from "./common";
import { LatencyChart } from "./LatencyChart";
import { IncidentList } from "./IncidentsPage";
import { StatusPill, UptimeBars, ms, pct } from "./status";
import { ExternalLink, Globe, HeartPulse, Pause, Pencil, Play, RefreshCw, Server, Shield, Trash } from "./icons";

export function MonitorTypeIcon({ type, size = 14 }: { type: MonitorType; size?: number }) {
  if (type === "tcp") return <Server size={size} />;
  if (type === "heartbeat") return <HeartPulse size={size} />;
  return <Globe size={size} />;
}

export function MonitorPage({ id }: { id: number }) {
  const { t, f, settings, update } = useSettings();
  const { me, edit, navigate, reload, projects } = useApp();
  const toast = useToast();
  const details = useApi<MonitorDetails>(`/app/monitors/${id}`, true);
  const range = settings.chartRange;
  const series = useApi<Series>(`/app/monitors/${id}/series?range=${range}`, true);
  const incidents = useApi<Incident[]>(`/app/incidents?monitor=${id}&limit=10`, true);
  const [failuresOnly, setFailuresOnly] = useState(false);
  const checks = useApi<Check[]>(`/app/monitors/${id}/checks?limit=30${failuresOnly ? "&failures=1" : ""}`, true);
  const [busy, setBusy] = useState<"check" | "pause" | null>(null);
  const [deleting, setDeleting] = useState(false);

  const m = details.data;
  if (details.error && !m) return <div className="page"><p className="error-text">{details.error}</p></div>;
  if (!m) return <div className="page"><Spinner /></div>;
  const editor = canContribute(me);
  const project = projects?.find((p) => p.id === m.projectId);

  const refresh = () => {
    invalidate(`/app/monitors/${id}`);
    invalidate("/app/incidents");
    details.reload();
    series.reload();
    checks.reload();
    incidents.reload();
    reload();
  };

  const checkNow = async () => {
    setBusy("check");
    try {
      const r = await api<{ status: string; latency: number | null; message: string }>(`/app/monitors/${id}/check`, { method: "POST" });
      toast(`${r.message}${r.latency !== null ? ` · ${ms(r.latency)}` : ""}`);
      refresh();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const togglePause = async () => {
    setBusy("pause");
    try {
      await api(`/app/monitors/${id}/pause`, { body: { paused: !m.paused } });
      toast(m.paused ? t("monitorResumed") : t("monitorPaused"));
      refresh();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page monitor-page">
      <header className="monitor-header">
        <div className="monitor-header-main">
          <div className="monitor-title-row">
            <h2>{m.name}</h2>
            <StatusPill status={m.status} large />
          </div>
          <div className="monitor-meta muted">
            <MonitorTypeIcon type={m.type} />
            {m.type === "http" ? (
              <a href={m.target} target="_blank" rel="noreferrer" className="monitor-target">
                {m.method !== "GET" && <b>{m.method} </b>}
                {m.target}
                <ExternalLink size={12} />
              </a>
            ) : (
              <span>{m.type === "tcp" ? m.target : t("type_heartbeat")}</span>
            )}
            <span>·</span>
            <span>{t("everyInterval", { interval: interval(m.intervalS, t) })}</span>
            {m.type === "http" && m.jsonPath && (
              <>
                <span>·</span>
                <span title={t("jsonCheck")}>
                  <code className="json-inline">{m.jsonPath}</code> {t(`jsonOp_${m.jsonOp}`)}
                  {["equals", "not_equals", "contains", "gt", "lt"].includes(m.jsonOp) && <code className="json-inline">{m.jsonValue}</code>}
                </span>
              </>
            )}
            {project && (
              <>
                <span>·</span>
                <span>{project.name}</span>
              </>
            )}
            {m.pages.length > 0 && (
              <>
                <span>·</span>
                <span>
                  {t("shownOn", { pages: "" })}
                  {m.pages.map((p, i) => (
                    <span key={p.id}>
                      {i > 0 && ", "}
                      <a href={`/status/${p.slug}`} target="_blank" rel="noreferrer">
                        {p.title}
                      </a>
                    </span>
                  ))}
                </span>
              </>
            )}
          </div>
        </div>
        {editor && (
          <div className="monitor-actions">
            {m.type !== "heartbeat" && (
              <button className="text-button" disabled={!!busy || m.paused} onClick={checkNow} title={`${t("checkNow")} (R)`}>
                {busy === "check" ? <Spinner /> : <RefreshCw size={14} />}
                <span className="hide-mobile">{t("checkNow")}</span>
              </button>
            )}
            <button className="text-button" disabled={!!busy} onClick={togglePause}>
              {m.paused ? <Play size={14} /> : <Pause size={14} />}
              <span className="hide-mobile">{m.paused ? t("resume") : t("pause")}</span>
            </button>
            <button className="text-button" onClick={() => edit({ kind: "monitor", monitor: m })} title={`${t("edit")} (E)`}>
              <Pencil size={14} />
              <span className="hide-mobile">{t("edit")}</span>
            </button>
            <button className="icon-button danger" onClick={() => setDeleting(true)} title={t("deleteMonitor")} aria-label={t("deleteMonitor")}>
              <Trash />
            </button>
          </div>
        )}
      </header>

      {m.openIncident && (
        <div className="incident-banner">
          <strong>{t("downSince", { when: f.relative(m.openIncident.startedAt, t) })}</strong>
          <span>{m.openIncident.cause}</span>
        </div>
      )}
      {!m.openIncident && m.status !== "up" && m.lastMessage && <div className={`message-banner s-${m.status}`}>{m.lastMessage}</div>}

      <div className="tiles">
        <Tile label={t("uptime24h")} value={pct(m.stats.uptime24h, f)} />
        <Tile label={t("uptime7d")} value={pct(m.stats.uptime7d, f)} />
        <Tile label={t("uptime30d")} value={pct(m.stats.uptime30d, f)} />
        <Tile label={t("avgResponse24h")} value={ms(m.stats.avgLatency24h)} />
        <Tile
          label={m.type === "heartbeat" ? t("lastHeartbeat") : t("lastCheck")}
          value={(m.type === "heartbeat" ? m.lastPingAt : m.lastCheckedAt) ? f.relative((m.type === "heartbeat" ? m.lastPingAt : m.lastCheckedAt)!, t) : "—"}
        />
      </div>

      {(m.certCheck || m.domainCheck) && <ExpiryCard m={m} editor={editor} onChecked={refresh} />}

      {m.type === "heartbeat" && editor && m.pushUrl && <PushCard url={m.pushUrl} interval={m.intervalS} onRegenerated={refresh} id={m.id} />}

      <section className="card">
        <div className="card-header">
          <h3>{t("responseTime")}</h3>
          <div className="segmented">
            {(["24h", "7d", "30d"] as const).map((r) => (
              <button key={r} className={range === r ? "active" : ""} onClick={() => update({ chartRange: r })}>
                {t(`range_${r}`)}
              </button>
            ))}
          </div>
        </div>
        {series.data ? <LatencyChart series={series.data} range={range} /> : <div className="chart-empty"><Spinner /></div>}
        {m.stats.checks24h > 0 && (
          <div className="card-foot muted small">
            {t("latencySummary", { min: ms(m.stats.minLatency24h), avg: ms(m.stats.avgLatency24h), max: ms(m.stats.maxLatency24h), n: f.number(m.stats.checks24h) })}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-header">
          <h3>{t("uptime90d")}</h3>
          <span className="card-number">{pct(m.stats.uptime90d, f)}</span>
        </div>
        <UptimeBars history={m.history} />
      </section>

      <div className="two-columns">
        <section className="card">
          <div className="card-header">
            <h3>{t("incidents")}</h3>
          </div>
          {incidents.data && <IncidentList incidents={incidents.data} showMonitor={false} />}
        </section>
        <section className="card">
          <div className="card-header">
            <h3>{t("recentChecks")}</h3>
            <label className="checkbox small">
              <input type="checkbox" checked={failuresOnly} onChange={(e) => setFailuresOnly(e.target.checked)} />
              {t("failuresOnly")}
            </label>
          </div>
          <div className="check-list">
            {(checks.data ?? []).map((c) => (
              <div key={c.at} className="check-row">
                <span className={`check-state s-${c.status}`} title={t(`status_${c.status}`)} />
                <span className="check-time tabular">{f.time(c.at)}</span>
                <span className="check-message" title={c.message}>
                  {c.message}
                </span>
                <span className="check-latency tabular">{ms(c.latency)}</span>
              </div>
            ))}
            {checks.data?.length === 0 && <p className="settings-empty">{failuresOnly ? t("noFailuresRecently") : t("noChecksYet")}</p>}
          </div>
        </section>
      </div>

      {deleting && (
        <ConfirmDialog
          title={t("deleteMonitor")}
          text={t("deleteMonitorConfirm", { name: m.name })}
          action={t("delete")}
          onConfirm={async () => {
            await api(`/app/monitors/${id}`, { method: "DELETE" });
            invalidate("/app/monitors");
            reload();
            toast(t("monitorDeleted"));
            navigate({ name: "overview" });
          }}
          onClose={() => setDeleting(false)}
        />
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
    </div>
  );
}

/** "1 min", "5 min", "1 h", "1 day". */
export function interval(s: number, t: ReturnType<typeof useSettings>["t"]): string {
  if (s % 86400 === 0) return t("nDays", { n: s / 86400 });
  if (s % 3600 === 0) return t("nHours", { n: s / 3600 });
  if (s % 60 === 0) return t("nMinutes", { n: s / 60 });
  return t("nSeconds", { n: s });
}

/** How a heartbeat reports in: its URL, and a cron line to copy. */
function PushCard({ url, interval: every, id, onRegenerated }: { url: string; interval: number; id: number; onRegenerated: () => void }) {
  const { t } = useSettings();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const cron = every >= 86400 ? "0 3 * * *" : every >= 3600 ? `0 */${Math.max(1, Math.floor(every / 3600))} * * *` : `*/${Math.max(1, Math.floor(every / 60))} * * * *`;
  const curl = `curl -fsS -m 10 --retry 3 ${url} > /dev/null`;
  return (
    <section className="card">
      <div className="card-header">
        <h3>{t("pushUrl")}</h3>
        <button className="text-button" onClick={() => setConfirm(true)}>
          <RefreshCw size={14} />
          {t("newUrl")}
        </button>
      </div>
      <p className="small muted">{t("pushHint")}</p>
      <pre className="code-block">
        {url}
        <CopyButton text={url} className="icon-button small copy-button" />
      </pre>
      <p className="small muted">{t("pushCronHint")}</p>
      <pre className="code-block">
        {`${cron}  your-job && ${curl}`}
        <CopyButton text={`${cron}  your-job && ${curl}`} className="icon-button small copy-button" />
      </pre>
      <p className="small muted">{t("pushDownHint")}</p>
      {confirm && (
        <ConfirmDialog
          title={t("newUrl")}
          text={t("newUrlConfirm")}
          action={t("newUrl")}
          onConfirm={async () => {
            await api(`/app/monitors/${id}/push-token`, { method: "POST" });
            toast(t("saved"));
            onRegenerated();
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </section>
  );
}

/** The SSL certificate and the domain's registration: until when, from whom, and how soon. */
function ExpiryCard({ m, editor, onChecked }: { m: MonitorDetails; editor: boolean; onChecked: () => void }) {
  const { t, f } = useSettings();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const kinds = [...(m.certCheck ? (["certificate"] as const) : []), ...(m.domainCheck ? (["domain"] as const) : [])];
  const check = async () => {
    setBusy(true);
    try {
      await api(`/app/monitors/${m.id}/expiry-check`, { method: "POST" });
      onChecked();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <div className="card-header">
        <h3>{t("expiriesTitle")}</h3>
        {editor && (
          <button className="text-button" disabled={busy} onClick={() => void check()}>
            {busy ? <Spinner /> : <RefreshCw size={14} />}
            {t("checkAgain")}
          </button>
        )}
      </div>
      <div className="expiry-list">
        {kinds.map((kind) => {
          const e = m.expiries.find((x) => x.kind === kind);
          const status = e ? expiryStatus(e, m.expiryWarnDays) : "pending";
          const d = e ? daysLeft(e) : null;
          return (
            <div key={kind} className={`expiry-row s-${status}`}>
              <span className="expiry-icon">{kind === "certificate" ? <Shield size={16} /> : <Globe size={16} />}</span>
              <div className="expiry-main">
                <strong>
                  {t(kind === "certificate" ? "expCertificate" : "expDomain")}
                  {e?.name && <span className="muted"> · {e.name}</span>}
                </strong>
                {!e ? (
                  <span className="small muted">{t("expNotChecked")}</span>
                ) : (
                  <>
                    {e.expiresAt && (
                      <span className="small">
                        {t(kind === "certificate" ? "expValidUntil" : "expRegisteredUntil", { date: f.mediumDate(e.expiresAt) })}
                        {e.issuer && <span className="muted"> · {t(kind === "certificate" ? "expIssuedBy" : "expRegistrar", { name: e.issuer })}</span>}
                      </span>
                    )}
                    {e.error && <span className={`small ${e.expiresAt ? "muted" : "error-text"}`}>{e.error}</span>}
                    {e.source === "ct" && <span className="small muted">{t("expFromCt")}</span>}
                    <span className="small muted">{t("expChecked", { when: f.relative(e.checkedAt, t) })}</span>
                  </>
                )}
              </div>
              <span className="expiry-days">
                {d === null ? "—" : d < 0 ? t("expExpiredAgo", { n: f.number(-d) }) : d === 0 ? t("expToday") : t("expDaysLeft", { n: f.number(d) })}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
