import { useRef, type CSSProperties } from "react";
import { canContribute, type Status } from "../lib/api";
import { useApp } from "../lib/app";
import { useSettings } from "../lib/settings";
import { StatusDot, statusKey } from "./status";
import { Activity, AlertTriangle, Bell, Globe, Home, Megaphone, PanelLeft, Pencil, Plus, Search, Wrench } from "./icons";

const MIN_W = 200;
const MAX_W = 480;
const DEFAULT_W = 248;

/** Same layout as Calendar's, Notes' and Llip's sidebars: toggle and search on top, then the lists. */
export function Sidebar() {
  const { t, f, settings } = useSettings();
  const { me, monitors, projects, project, status, route, query, navigate, toggleSidebar, openSearch, edit } = useApp();
  const all = monitors ?? [];
  const onOverview = route.name === "overview";
  /** Filters apply to the overview: they bring you back to it from other pages. */
  const filter = (patch: Record<string, string | undefined>) => {
    const next = Object.entries({ ...query, ...patch }).filter((e): e is [string, string] => e[1] !== undefined);
    navigate({ name: "overview" }, Object.fromEntries(next));
  };
  const down = all.filter((m) => m.status === "down").length;
  const statuses: Status[] = ["down", "degraded", "up", "maintenance", "paused"];
  const loose = all.filter((m) => m.projectId === null).length;
  const pinned = all.filter((m) => m.status === "down" || m.status === "degraded");

  return (
    <aside className="sidebar" style={{ "--sidebar-w": `${settings.sidebarWidth}px` } as CSSProperties}>
      <ResizeHandle />
      <div className="sidebar-top">
        <button className="icon-button" title={`${t("toggleSidebar")} (Ctrl+B)`} aria-label={t("toggleSidebar")} onClick={toggleSidebar}>
          <PanelLeft />
        </button>
        <div className="toolbar-spacer" />
        <button className="icon-button" title={`${t("search")} (Ctrl+K)`} aria-label={t("search")} onClick={openSearch}>
          <Search />
        </button>
      </div>

      <nav className="sidebar-nav">
        <button className={`sidebar-row${onOverview && project === null && !status ? " active" : ""}`} onClick={() => navigate({ name: "overview" }, {})}>
          <Home />
          <span className="row-label">{t("overview")}</span>
          <span className="row-meta">{monitors ? f.number(all.length) : ""}</span>
        </button>
        <button className={`sidebar-row${route.name === "incidents" ? " active" : ""}`} onClick={() => navigate({ name: "incidents" }, project !== null ? { project: String(project) } : {})}>
          <AlertTriangle />
          <span className="row-label">{t("incidents")}</span>
          <span className="row-meta">{down ? <span className="count-badge">{f.number(down)}</span> : ""}</span>
        </button>
        <button className={`sidebar-row${route.name === "posts" || route.name === "post" ? " active" : ""}`} onClick={() => navigate({ name: "posts" }, {})}>
          <Megaphone />
          <span className="row-label">{t("posts")}</span>
        </button>
        <button className={`sidebar-row${route.name === "maintenance" ? " active" : ""}`} onClick={() => navigate({ name: "maintenance" }, {})}>
          <Wrench />
          <span className="row-label">{t("maintenanceTitle")}</span>
        </button>
        <button className={`sidebar-row${route.name === "notifications" || route.name === "webhook" ? " active" : ""}`} onClick={() => navigate({ name: "notifications" }, {})}>
          <Bell />
          <span className="row-label">{t("notifications")}</span>
        </button>
        <button className={`sidebar-row${route.name === "pages" || route.name === "page" ? " active" : ""}`} onClick={() => navigate({ name: "pages" }, {})}>
          <Globe />
          <span className="row-label">{t("statusPages")}</span>
        </button>
      </nav>

      {/* Only the lists scroll; the header and pages stay put. */}
      <div className="sidebar-scroll">
        <div className="sidebar-group">
          <div className="sidebar-group-title">{t("statusLabel")}</div>
          {statuses.map((s) => {
            const n = all.filter((m) => m.status === s).length;
            return (
              <button
                key={s}
                className={`sidebar-row${onOverview && status === s ? " active" : ""}${n === 0 ? " empty" : ""}`}
                onClick={() => filter({ status: onOverview && status === s ? undefined : s })}
              >
                <StatusDot status={s} />
                <span className="row-label">{t(statusKey(s))}</span>
                <span className="row-meta">{n ? f.number(n) : ""}</span>
              </button>
            );
          })}
        </div>

        <div className="sidebar-group">
          <div className="sidebar-group-title with-action">
            <span>{t("projects")}</span>
            {canContribute(me) && (
              <button className="icon-button tiny" title={t("addProject")} aria-label={t("addProject")} onClick={() => edit({ kind: "project" })}>
                <Plus size={12} />
              </button>
            )}
          </div>
          {(projects ?? []).map((p) => {
            const n = all.filter((m) => m.projectId === p.id).length;
            const bad = all.some((m) => m.projectId === p.id && m.status === "down");
            return (
              <div key={p.id} className="sidebar-row-wrap">
                <button
                  className={`sidebar-row${onOverview && project === p.id ? " active" : ""}`}
                  onClick={() => filter({ project: onOverview && project === p.id ? undefined : String(p.id) })}
                >
                  <span className="project-dot" style={{ "--c": p.color } as CSSProperties} />
                  <span className="row-label">{p.name}</span>
                  <span className="row-meta">{bad ? <span className="count-badge">!</span> : n ? f.number(n) : ""}</span>
                </button>
                {canContribute(me) && (
                  <button className="icon-button tiny row-action" title={t("editProject")} aria-label={t("editProject")} onClick={() => edit({ kind: "project", project: p })}>
                    <Pencil size={12} />
                  </button>
                )}
              </div>
            );
          })}
          {loose > 0 && (projects?.length ?? 0) > 0 && (
            <button className={`sidebar-row${onOverview && project === 0 ? " active" : ""}`} onClick={() => filter({ project: onOverview && project === 0 ? undefined : "0" })}>
              <span className="project-dot" />
              <span className="row-label">{t("noProject")}</span>
              <span className="row-meta">{f.number(loose)}</span>
            </button>
          )}
          {projects?.length === 0 && <div className="sidebar-hint">{t("noProjectsHint")}</div>}
        </div>

        {pinned.length > 0 && (
          <div className="sidebar-group">
            <div className="sidebar-group-title">{t("needsAttention")}</div>
            {pinned.map((m) => (
              <button key={m.id} className={`sidebar-row${route.name === "monitor" && route.id === m.id ? " active" : ""}`} onClick={() => navigate({ name: "monitor", id: m.id })}>
                <StatusDot status={m.status} />
                <span className="row-label">{m.name}</span>
                <Activity size={12} />
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

/** Drag the right edge to resize; double-click to reset. */
function ResizeHandle() {
  const { update } = useSettings();
  const drag = useRef<{ x: number; w: number; aside: HTMLElement } | null>(null);
  const clamp = (w: number) => Math.round(Math.min(MAX_W, Math.max(MIN_W, w)));
  return (
    <div
      className="sidebar-resize"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const aside = e.currentTarget.parentElement!;
        drag.current = { x: e.clientX, w: aside.getBoundingClientRect().width, aside };
        e.currentTarget.setPointerCapture(e.pointerId);
        document.documentElement.classList.add("resizing-sidebar");
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) d.aside.style.setProperty("--sidebar-w", `${clamp(d.w + e.clientX - d.x)}px`);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        document.documentElement.classList.remove("resizing-sidebar");
        update({ sidebarWidth: clamp(d.w + e.clientX - d.x) });
      }}
      onDoubleClick={() => update({ sidebarWidth: DEFAULT_W })}
    />
  );
}
