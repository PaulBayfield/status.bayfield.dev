// Every outage: ongoing ones first, then the history, with how long each lasted.

import type { Incident } from "../lib/api";
import { useApp } from "../lib/app";
import { useApi } from "../lib/hooks";
import { useSettings } from "../lib/settings";
import { CircleCheck, CircleX } from "./icons";
import { Spinner } from "./common";

export function IncidentsPage() {
  const { t } = useSettings();
  const { project } = useApp();
  const incidents = useApi<Incident[]>("/app/incidents?limit=300", true);
  const list = (incidents.data ?? []).filter((i) => project === null || (i.projectId ?? 0) === project);
  return (
    <div className="page">
      <section className="card">
        {!incidents.data ? <Spinner /> : list.length ? <IncidentList incidents={list} showMonitor /> : <p className="settings-empty">{t("noIncidents")}</p>}
      </section>
    </div>
  );
}

/** "2 h 5 min" */
export function duration(msTotal: number, t: ReturnType<typeof useSettings>["t"]): string {
  const min = Math.max(1, Math.round(msTotal / 60_000));
  if (min < 60) return t("nMinutes", { n: min });
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${t("nHours", { n: h })} ${t("nMinutes", { n: min % 60 })}` : t("nHours", { n: h });
  return t("nDays", { n: Math.round(h / 24) });
}

export function IncidentList({ incidents, showMonitor }: { incidents: Incident[]; showMonitor: boolean }) {
  const { t, f } = useSettings();
  const { navigate } = useApp();
  if (!incidents.length) return <p className="settings-empty">{t("noIncidents")}</p>;
  return (
    <div className="incident-list">
      {incidents.map((i) => {
        const ongoing = !i.resolvedAt;
        const lasted = (i.resolvedAt ? new Date(i.resolvedAt).getTime() : Date.now()) - new Date(i.startedAt).getTime();
        return (
          <div key={i.id} className={`incident-row${ongoing ? " ongoing" : ""}`}>
            <span className={`incident-icon ${ongoing ? "s-down" : "s-up"}`}>{ongoing ? <CircleX size={16} /> : <CircleCheck size={16} />}</span>
            <div className="incident-main">
              <span className="incident-title">
                {showMonitor ? (
                  <button className="link-button" onClick={() => navigate({ name: "monitor", id: i.monitorId })}>
                    {i.monitorName}
                  </button>
                ) : null}
                <span className={ongoing ? "incident-state s-down" : "incident-state"}>{ongoing ? t("ongoingFor", { duration: duration(lasted, t) }) : t("downFor", { duration: duration(lasted, t) })}</span>
              </span>
              {i.cause && <span className="small muted incident-cause">{i.cause}</span>}
            </div>
            <span className="small muted tabular incident-when" title={new Date(i.startedAt).toLocaleString(f.locale)}>
              {f.dateTime(i.startedAt)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
