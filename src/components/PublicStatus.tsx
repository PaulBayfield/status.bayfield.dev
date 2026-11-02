// A public status page: /status/<slug>, or the default page at /status (and at / when signed out).
// Only the monitors the page lists, without targets or error details.
// Same look as the overview: header bar, banner, tiles, grouped monitor rows.

import { useEffect, useState } from "react";
import { api, ApiError, type PublicStatus as Data } from "../lib/api";
import { overall } from "../lib/app";
import { Markdown } from "../lib/markdown";
import { useSettings } from "../lib/settings";
import { duration } from "./IncidentsPage";
import { StatusDot, StatusIcon, UptimeBars, pct, statusKey } from "./status";
import { AlertTriangle, CircleCheck, CircleDashed, CircleX, Clock } from "./icons";
import { Spinner } from "./common";

type PublicMonitor = Data["groups"][number]["monitors"][number];
type PublicIncident = Data["incidents"][number];

export function PublicStatus({ slug, action }: { slug?: string; action?: { label: string; run: () => void } }) {
  const { t, f } = useSettings();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    const load = () =>
      api<Data>(slug ? `/public/pages/${encodeURIComponent(slug)}` : "/public/status").then(
        (d) => {
          setData(d);
          setError(null);
        },
        (e: Error) => setError(e instanceof ApiError && e.status === 404 ? t("pageNotFound") : e.message),
      );
    void load();
    const timer = window.setInterval(() => document.visibilityState === "visible" && void load(), 60_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    if (data) document.title = data.title;
  }, [data]);

  const groups = data?.groups.filter((g) => g.monitors.length) ?? [];
  // A monitor can sit in several groups: count it once.
  const monitors = [...new Map(groups.flatMap((g) => g.monitors).map((m) => [m.id, m])).values()];
  const state = data ? overall(monitors) : "none";
  const down = monitors.filter((m) => m.status === "down");
  const degraded = monitors.filter((m) => m.status === "degraded");
  const active = monitors.filter((m) => m.status !== "paused");
  const withUptime = active.filter((m) => m.uptime90 !== null);
  const avgUptime = withUptime.length ? withUptime.reduce((s, m) => s + m.uptime90!, 0) / withUptime.length : null;
  const ongoing = data?.incidents.filter((i) => !i.resolvedAt) ?? [];
  const past = data?.incidents.filter((i) => i.resolvedAt) ?? [];

  return (
    <div className="public-page">
      <header className="toolbar">
        {/* The app's name; the page's own logo and title head the content. */}
        <img className="public-logo" src="/favicon.svg" alt="" width={24} height={24} />
        <span className="toolbar-title">{t("appName")}</span>
        <div className="toolbar-spacer" />
        {data && (
          // When the data was read: the page refreshes it every minute.
          <span className="public-updated" title={f.dateTime(data.updatedAt)}>
            <Clock size={13} />
            <span className="hide-mobile">{t("updatedAtTime", { time: "" }).trim()}</span>
            <time dateTime={data.updatedAt}>{f.time(data.updatedAt)}</time>
          </span>
        )}
        {action && (
          <button className="text-button" onClick={action.run}>
            {action.label}
          </button>
        )}
      </header>
      <div className="content">
        <main className="page public-main">
          {error && (
            <div className="empty-state">
              <CircleDashed size={28} />
              <h2>{error}</h2>
            </div>
          )}
          {!data && !error && <Spinner />}
          {data && (
            <>
              <div className="public-hero">
                {data.logoUrl && <PageLogo url={data.logoUrl} size={56} />}
                <div className="public-hero-text">
                  <h1>{data.title}</h1>
                  {data.description && <Markdown className="public-description" text={data.description} />}
                </div>
              </div>
              <div className={`overall-banner o-${state}`}>
                {state === "down" ? <CircleX size={22} /> : state === "degraded" ? <AlertTriangle size={22} /> : <CircleCheck size={22} />}
                <div>
                  <strong>{state === "down" ? t("publicDown") : state === "degraded" ? t("publicDegraded") : state === "none" ? t("noPublicMonitors") : t("allOperational")}</strong>
                  <span>{state === "down" ? f.list(down.map((m) => m.name)) : state === "degraded" ? f.list(degraded.map((m) => m.name)) : active.length === 1 ? t("oneMonitorWatched") : t("monitorsWatched", { n: f.number(active.length) })}</span>
                </div>
              </div>

              {active.length > 0 && (
                <div className="tiles public-tiles">
                  <Tile label={t("monitorsUp")} value={`${f.number(active.filter((m) => m.status === "up" || m.status === "degraded").length)} / ${f.number(active.length)}`} />
                  <Tile label={t("down")} value={f.number(down.length)} tone={down.length ? "down" : undefined} />
                  <Tile label={t("uptime90d")} value={pct(avgUptime, f)} />
                </div>
              )}

              {groups.map((g, i) => (
                <section key={i} className="monitor-group">
                  {g.name && (
                    <h2 className="group-title">
                      {g.name}
                      <span className="muted small">{f.number(g.monitors.length)}</span>
                    </h2>
                  )}
                  <div className="monitor-list">
                    {g.monitors.map((m) => (
                      <PublicRow key={m.id} m={m} />
                    ))}
                  </div>
                </section>
              ))}

              {(ongoing.length > 0 || past.length > 0) && (
                <section className="monitor-group">
                  <h2 className="group-title">{t("incidents")}</h2>
                  <div className="monitor-list">
                    {[...ongoing, ...past].map((i) => (
                      <IncidentRow key={`${i.monitorId}-${i.startedAt}`} i={i} />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
          <footer className="public-footer muted small">
            {withLink(t("poweredBy", { site: SLOT }), "https://github.com/PaulBayfield/status.bayfield.dev", "status.bayfield.dev")}
            <span aria-hidden="true"> · </span>
            {withLink(t("createdBy", { name: SLOT }), "https://bayfield.dev", "Paul Bayfield")}
          </footer>
        </main>
      </div>
    </div>
  );
}

const SLOT = "\u0000";

/** A translated sentence with a link where its placeholder was. */
function withLink(text: string, href: string, label: string) {
  const [before, after = ""] = text.split(SLOT);
  return (
    <span>
      {before}
      <a href={href} target="_blank" rel="noreferrer">
        {label}
      </a>
      {after}
    </span>
  );
}

/** The page's own logo (a link to an image hosted elsewhere), or the app's icon. */
export function PageLogo({ url, size = 28 }: { url: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  if (!url || broken) return null;
  return <img className="public-logo custom" src={url} alt="" height={size} style={{ maxHeight: size }} referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "down" }) {
  return (
    <div className={`tile${tone ? ` t-${tone}` : ""}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
    </div>
  );
}

function PublicRow({ m }: { m: PublicMonitor }) {
  const { t, f } = useSettings();
  return (
    <div className="monitor-row public-row">
      <div className="monitor-main">
        <StatusDot status={m.status} />
        <div className="monitor-name">
          <span className="name">{m.name}</span>
          <span className={`target s-${m.status}`}>
            <StatusIcon status={m.status} size={12} />
            {t(statusKey(m.status))}
            {m.statusSince && m.status !== "up" && <span className="muted"> · {f.relative(m.statusSince, t)}</span>}
          </span>
        </div>
      </div>
      <div className="monitor-bars">
        <UptimeBars history={m.history} days={90} compact />
      </div>
      <div className="monitor-stat">
        <span className="stat-value">{pct(m.uptime90, f)}</span>
        <span className="stat-label">{t("uptime90d")}</span>
      </div>
    </div>
  );
}

function IncidentRow({ i }: { i: PublicIncident }) {
  const { t, f } = useSettings();
  const lasted = (i.resolvedAt ? new Date(i.resolvedAt).getTime() : Date.now()) - new Date(i.startedAt).getTime();
  return (
    <div className="public-incident">
      <span className={`incident-icon ${i.resolvedAt ? "s-up" : "s-down"}`}>{i.resolvedAt ? <CircleCheck size={14} /> : <CircleX size={14} />}</span>
      <span className="activity-text">
        <span className="activity-title">{i.monitorName}</span>
        <span className="small muted">
          {i.resolvedAt ? t("recoveredAfter", { duration: duration(lasted, t) }) : t("downFor", { duration: duration(lasted, t) })} · {f.dateTime(i.startedAt)}
        </span>
      </span>
      {!i.resolvedAt && <span className="status-pill s-down">{t("ongoing")}</span>}
    </div>
  );
}
