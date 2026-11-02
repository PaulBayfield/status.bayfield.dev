// The overview: how everything is doing (banner and tiles), then every monitor with its 90 days.

import type { CSSProperties } from "react";
import { canContribute, type Monitor, type Project } from "../lib/api";
import { overall, useApp } from "../lib/app";
import { useSettings } from "../lib/settings";
import { MonitorTypeIcon } from "./MonitorPage";
import { StatusDot, UptimeBars, ms, pct } from "./status";
import { Activity, AlertTriangle, CircleCheck, CircleX, Plus } from "./icons";

export function Overview() {
  const { t, f, settings } = useSettings();
  const { me, monitors, projects, visible, project, status, edit } = useApp();

  if (!monitors) return <div className="page" />;

  if (!monitors.length) {
    return (
      <div className="page">
        <div className="empty-state">
          <Activity size={28} />
          <h2>{t("noMonitors")}</h2>
          <p className="muted">{t("noMonitorsHint")}</p>
          {canContribute(me) && (
            <button className="primary-button" onClick={() => edit({ kind: "monitor" })}>
              <Plus size={14} />
              {t("addMonitor")}
            </button>
          )}
        </div>
      </div>
    );
  }

  const state = overall(monitors);
  const down = monitors.filter((m) => m.status === "down");
  const degraded = monitors.filter((m) => m.status === "degraded");
  const active = monitors.filter((m) => !m.paused);
  const withUptime = active.filter((m) => m.uptime30 !== null);
  const avgUptime = withUptime.length ? withUptime.reduce((s, m) => s + m.uptime30!, 0) / withUptime.length : null;
  const latencies = active.map((m) => m.lastLatency).filter((v): v is number => v !== null);
  const avgLatency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;

  const groups: { project: Project | null; monitors: Monitor[] }[] = [];
  if (settings.groupByProject && project === null) {
    for (const p of projects ?? []) {
      const list = visible.filter((m) => m.projectId === p.id);
      if (list.length) groups.push({ project: p, monitors: list });
    }
    const loose = visible.filter((m) => m.projectId === null || !projects?.some((p) => p.id === m.projectId));
    if (loose.length) groups.push({ project: null, monitors: loose });
  } else groups.push({ project: null, monitors: visible });

  return (
    <div className="page">
      {project === null && !status && (
        <>
          <div className={`overall-banner o-${state}`}>
            {state === "down" ? <CircleX size={22} /> : state === "degraded" ? <AlertTriangle size={22} /> : <CircleCheck size={22} />}
            <div>
              <strong>{state === "down" ? t("someDown", { n: down.length }) : state === "degraded" ? t("someDegraded", { n: degraded.length }) : state === "none" ? t("waitingFirstChecks") : t("allOperational")}</strong>
              <span>
                {state === "down"
                  ? f.list(down.map((m) => m.name))
                  : state === "degraded"
                    ? f.list(degraded.map((m) => m.name))
                    : active.length === 1 ? t("oneMonitorWatched") : t("monitorsWatched", { n: f.number(active.length) })}
              </span>
            </div>
          </div>
          <div className="tiles">
            <Tile label={t("monitorsUp")} value={`${f.number(active.filter((m) => m.status === "up" || m.status === "degraded").length)} / ${f.number(active.length)}`} />
            <Tile label={t("down")} value={f.number(down.length)} tone={down.length ? "down" : undefined} />
            <Tile label={t("uptime30d")} value={pct(avgUptime, f)} />
            <Tile label={t("avgResponse")} value={ms(avgLatency)} />
          </div>
        </>
      )}

      {visible.length === 0 && <p className="muted empty-filter">{t("noMonitorsMatch")}</p>}
      {groups.map((g) => (
        <section key={g.project?.id ?? "none"} className="monitor-group">
          {groups.length > 1 || g.project ? (
            <h2 className="group-title">
              {g.project && <span className="project-dot" style={{ "--c": g.project.color } as CSSProperties} />}
              {g.project?.name ?? t("noProject")}
              <span className="muted small">{f.number(g.monitors.length)}</span>
            </h2>
          ) : null}
          <div className="monitor-list">
            {g.monitors.map((m) => (
              <MonitorRow key={m.id} m={m} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "down" }) {
  return (
    <div className={`tile${tone ? ` t-${tone}` : ""}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
    </div>
  );
}

function MonitorRow({ m }: { m: Monitor }) {
  const { t, f } = useSettings();
  const { navigate, query } = useApp();
  return (
    <div
      className="monitor-row"
      role="link"
      tabIndex={0}
      onClick={() => navigate({ name: "monitor", id: m.id }, query)}
      onKeyDown={(e) => e.key === "Enter" && navigate({ name: "monitor", id: m.id }, query)}
    >
      <div className="monitor-main">
        <StatusDot status={m.status} />
        <div className="monitor-name">
          <span className="name">{m.name}</span>
          <span className="target">
            <MonitorTypeIcon type={m.type} size={12} />
            {m.type === "heartbeat" ? t("type_heartbeat") : m.target.replace(/^https?:\/\//, "")}
          </span>
        </div>
      </div>
      <div className="monitor-bars hide-narrow">
        <UptimeBars history={m.history} days={45} compact />
      </div>
      <div className="monitor-stat">
        <span className="stat-value">{pct(m.uptime30, f)}</span>
        <span className="stat-label">{t("uptime30d")}</span>
      </div>
      <div className="monitor-stat hide-mobile">
        <span className="stat-value">{m.type === "heartbeat" && m.lastLatency === null ? "—" : ms(m.lastLatency)}</span>
        <span className="stat-label">{t("response")}</span>
      </div>
    </div>
  );
}
