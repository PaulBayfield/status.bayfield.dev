// A public status page: /status/<slug>, or the default page at /status (and at / when signed out).
// Only the monitors the page lists, without targets or error details.
// Same look as the overview: header bar, banner, tiles, grouped monitor rows.

import { useEffect, useState } from "react";
import { api, ApiError, type PageDisplay, type PublicMaintenance, type PublicPost, type PublicStatus as Data, type Series } from "../lib/api";
import { ImpactBadge, PostStatusPill } from "./PostsPage";
import { useWindowText } from "./MaintenancePage";
import { overall } from "../lib/app";
import { Markdown } from "../lib/markdown";
import { useSettings } from "../lib/settings";
import { duration } from "./IncidentsPage";
import { StatusDot, StatusIcon, UptimeBars, pct, statusKey } from "./status";
import { Activity, AlertTriangle, ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleX, Clock, Megaphone, Wrench } from "./icons";
import { LatencyChart } from "./LatencyChart";
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
  const openPosts = data?.posts.filter((x) => x.status !== "resolved") ?? [];
  const pastPosts = data?.posts.filter((x) => x.status === "resolved") ?? [];
  // Open posts count like the monitors: a major one is an outage, a minor one a degradation.
  const fromMonitors = data ? overall(monitors) : "none";
  const state =
    fromMonitors === "down" || openPosts.some((x) => x.impact === "major")
      ? "down"
      : fromMonitors === "degraded" || openPosts.some((x) => x.impact === "minor")
        ? "degraded"
        : fromMonitors;
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
        {/* On a custom domain, the dashboard is at Status's own address. */}
        {data?.home ? (
          <a className="text-button" href={data.home}>
            {t("signIn")}
          </a>
        ) : (
          action && (
            <button className="text-button" onClick={action.run}>
              {action.label}
            </button>
          )
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
              {openPosts.map((x) => (
                <PostCard key={x.id} post={x} names={monitors} />
              ))}
              {data.maintenances.map((w) => (
                <MaintenanceCard key={w.id} w={w} names={monitors} />
              ))}
              <div className={`overall-banner o-${state}`}>
                {state === "down" ? <CircleX size={22} /> : state === "degraded" ? <AlertTriangle size={22} /> : state === "maintenance" ? <Wrench size={22} /> : <CircleCheck size={22} />}
                <div>
                  <strong>
                    {state === "down"
                      ? t("publicDown")
                      : state === "degraded"
                        ? t("publicDegraded")
                        : state === "maintenance"
                          ? t("publicMaintenance")
                          : state === "none"
                            ? t("noPublicMonitors")
                            : t("allOperational")}
                  </strong>
                  <span>
                    {state === "down" && down.length
                      ? f.list(down.map((m) => m.name))
                      : state === "degraded" && degraded.length
                        ? f.list(degraded.map((m) => m.name))
                        : state === "down" || state === "degraded"
                          ? f.list(openPosts.map((x) => x.title))
                          : active.length === 1
                            ? t("oneMonitorWatched")
                            : t("monitorsWatched", { n: f.number(active.length) })}
                  </span>
                </div>
              </div>

              {active.length > 0 && data.display.tiles && (
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
                      <PublicRow key={m.id} m={m} slug={data.slug} display={data.display} />
                    ))}
                  </div>
                </section>
              ))}

              {data.display.incidents && pastPosts.length > 0 && (
                <section className="monitor-group">
                  <h2 className="group-title">{t("pastPosts")}</h2>
                  {pastPosts.map((x) => (
                    <PostCard key={x.id} post={x} names={monitors} collapsed />
                  ))}
                </section>
              )}

              {data.display.incidents && (ongoing.length > 0 || past.length > 0) && (
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

function PublicRow({ m, slug, display }: { m: PublicMonitor; slug: string; display: PageDisplay }) {
  const { t, f } = useSettings();
  const [open, setOpen] = useState(display.charts === "expanded");
  const charts = display.charts !== "off";
  return (
    <div className="public-item">
      <div className="monitor-row public-row">
        <div className="monitor-main">
          <StatusDot status={m.status} />
          <div className="monitor-name">
            <span className="name">{m.name}</span>
            <span className={`target s-${m.status}`}>
              <StatusIcon status={m.status} size={12} />
              {t(statusKey(m.status))}
              {m.statusSince && m.status !== "up" && m.status !== "maintenance" && <span className="muted"> · {f.relative(m.statusSince, t)}</span>}
              {charts && (
                <button type="button" className="chart-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Activity size={12} />
                  {t("responseTime")}
                </button>
              )}
            </span>
          </div>
        </div>
        <div className="monitor-bars">{display.bars && <UptimeBars history={m.history} days={90} compact />}</div>
        <div className="monitor-stat">
          <span className="stat-value">{pct(m.uptime90, f)}</span>
          <span className="stat-label">{t("uptime90d")}</span>
        </div>
      </div>
      {charts && open && <PublicChart slug={slug} id={m.id} />}
    </div>
  );
}

/** A monitor's response times, as on its page in the app: min, mean and max. */
function PublicChart({ slug, id }: { slug: string; id: number }) {
  const { t } = useSettings();
  const [range, setRange] = useState<"24h" | "7d" | "30d">("24h");
  const [series, setSeries] = useState<Series | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    api<Series>(`/public/pages/${encodeURIComponent(slug)}/series/${id}?range=${range}`).then(
      (s) => live && setSeries(s),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [slug, id, range]);
  return (
    <div className="public-chart">
      <div className="segmented">
        {(["24h", "7d", "30d"] as const).map((r) => (
          <button key={r} className={range === r ? "active" : ""} onClick={() => setRange(r)}>
            {t(`range_${r}`)}
          </button>
        ))}
      </div>
      {error ? <p className="error-text small">{error}</p> : series ? <LatencyChart series={series} range={range} height={180} /> : <div className="chart-empty"><Spinner /></div>}
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

/** A post as visitors see it: impact, status, the latest update, and the earlier ones on demand. */
function PostCard({ post, names, collapsed }: { post: PublicPost; names: { id: number; name: string }[]; collapsed?: boolean }) {
  const { t, f } = useSettings();
  const [all, setAll] = useState(false);
  const [latest, ...older] = post.updates;
  const affected = post.monitors.map((id) => names.find((m) => m.id === id)?.name).filter(Boolean) as string[];
  return (
    <article className={`post-card i-${post.impact}${post.status === "resolved" ? " resolved" : ""}`}>
      <header>
        <Megaphone size={16} />
        <strong>{post.title}</strong>
        {post.status !== "resolved" && <ImpactBadge impact={post.impact} />}
        <div className="toolbar-spacer" />
        <PostStatusPill status={post.status} />
      </header>
      {affected.length > 0 && <span className="small muted">{t("affects", { list: f.list(affected) })}</span>}
      {latest && !collapsed && (
        <div className="post-update">
          <Markdown text={latest.body} />
          <span className="small muted">{f.dateTime(latest.createdAt)}</span>
        </div>
      )}
      {(collapsed ? post.updates.length > 0 : older.length > 0) && (
        <button className="chart-toggle" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {collapsed
            ? post.updates.length === 1
              ? t("showUpdate")
              : t("showUpdates", { n: f.number(post.updates.length) })
            : older.length === 1
              ? t("earlierUpdate")
              : t("earlierUpdates", { n: f.number(older.length) })}
        </button>
      )}
      {all && (
        <ol className="timeline compact">
          {(collapsed ? post.updates : older).map((u) => (
            <li key={u.id} className={`p-${u.status}`}>
              <div className="timeline-head">
                <PostStatusPill status={u.status} />
                <span className="small muted">{f.dateTime(u.createdAt)}</span>
              </div>
              <Markdown text={u.body} />
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

/** Planned maintenance: running now, or coming. */
function MaintenanceCard({ w, names }: { w: PublicMaintenance; names: { id: number; name: string }[] }) {
  const { t, f } = useSettings();
  const span = useWindowText();
  const affected = w.monitors.map((id) => names.find((m) => m.id === id)?.name).filter(Boolean) as string[];
  return (
    <article className={`post-card maintenance${w.active ? " active" : ""}`}>
      <header>
        <Wrench size={16} />
        <strong>{w.title}</strong>
        <div className="toolbar-spacer" />
        <span className="status-pill s-maintenance">{w.active ? t("window_active_short") : t("window_upcoming_short")}</span>
      </header>
      <span className="small">{span(w)}</span>
      {affected.length > 0 && <span className="small muted">{t("affects", { list: f.list(affected) })}</span>}
      {w.description && <Markdown className="small" text={w.description} />}
    </article>
  );
}
