// Ctrl+K / "/": the same command palette as Calendar's, Notes' and Llip's. Jumps to a monitor, a
// project, a page, an action or a settings page.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { canContribute } from "../lib/api";
import { useApp, type SettingsPage } from "../lib/app";
import { useSettings } from "../lib/settings";
import type { StringKey } from "../lib/i18n";
import { StatusDot } from "./status";
import { AlertTriangle, Bell, Gear, Globe, Home, Plus, Search } from "./icons";

interface Result {
  key: string;
  section: StringKey;
  title: string;
  extra?: string;
  icon: ReactNode;
  run: () => void;
}

const SETTINGS: { id: SettingsPage; label: StringKey }[] = [
  { id: "profile", label: "profile" },
  { id: "preferences", label: "preferences" },
  { id: "security", label: "security" },
  { id: "data", label: "data" },
  { id: "shortcuts", label: "shortcuts" },
  { id: "about", label: "about" },
];

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function SearchDialog({ onClose }: { onClose: () => void }) {
  const { t } = useSettings();
  const { me, monitors, projects, navigate, openSettings, edit } = useApp();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const q = norm(query.trim());

  const results = useMemo(() => {
    const keep = (...texts: string[]) => !q || texts.some((s) => norm(s).includes(q));
    const done = (fn: () => void) => () => {
      onClose();
      fn();
    };
    const out: Result[] = [];
    for (const m of (monitors ?? []).filter((m) => keep(m.name, m.target)).slice(0, q ? 20 : 8)) {
      out.push({
        key: `m:${m.id}`,
        section: "monitors",
        title: m.name,
        extra: m.type === "heartbeat" ? t("type_heartbeat") : m.target.replace(/^https?:\/\//, ""),
        icon: <StatusDot status={m.status} />,
        run: done(() => navigate({ name: "monitor", id: m.id })),
      });
    }
    if (q) {
      for (const p of (projects ?? []).filter((p) => keep(p.name))) {
        out.push({
          key: `p:${p.id}`,
          section: "projects",
          title: p.name,
          icon: <span className="project-dot" style={{ "--c": p.color } as CSSProperties} />,
          run: done(() => navigate({ name: "overview" }, { project: String(p.id) })),
        });
      }
    }
    const pages: [StringKey, ReactNode, () => void][] = [
      ["overview", <Home size={16} />, () => navigate({ name: "overview" }, {})],
      ["incidents", <AlertTriangle size={16} />, () => navigate({ name: "incidents" }, {})],
      ["notifications", <Bell size={16} />, () => navigate({ name: "notifications" }, {})],
      ["statusPages", <Globe size={16} />, () => navigate({ name: "pages" }, {})],
    ];
    if (q) for (const [label, icon, run] of pages) if (keep(t(label))) out.push({ key: `page:${label}`, section: "pages", title: t(label), icon, run: done(run) });
    if (canContribute(me)) {
      const actions: [StringKey, () => void][] = [
        ["addMonitor", () => edit({ kind: "monitor" })],
        ["addProject", () => edit({ kind: "project" })],
        ["addWebhook", () => edit({ kind: "webhook" })],
        ["newStatusPage", () => edit({ kind: "page" })],
      ];
      for (const [label, run] of actions) if (keep(t(label))) out.push({ key: `a:${label}`, section: "actions", title: t(label), icon: <Plus size={16} />, run: done(run) });
    }
    if (q) {
      for (const s of SETTINGS.filter((s) => keep(t(s.label)))) {
        out.push({ key: `settings:${s.id}`, section: "settings", title: t(s.label), icon: <Gear size={16} />, run: done(() => openSettings(s.id)) });
      }
    }
    return out;
  }, [q, me, monitors, projects, t, navigate, openSettings, edit, onClose]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".search-result.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let lastSection: StringKey | null = null;
  return (
    <div className="dialog-backdrop search-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search-dialog" role="dialog" aria-label={t("search")}>
        <div className="search-input-row">
          <Search size={18} />
          <input
            autoFocus
            value={query}
            placeholder={t("searchPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") setActive((i) => Math.min(results.length - 1, i + 1));
              else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
              else if (e.key === "Enter" && results[active]) results[active].run();
              else return;
              e.preventDefault();
              e.stopPropagation();
            }}
          />
        </div>
        <div className="search-results" ref={listRef}>
          {results.length === 0 && <p className="search-empty">{t("noResults")}</p>}
          {results.map((r, i) => {
            const header = r.section !== lastSection ? <div className="search-section">{t(r.section)}</div> : null;
            lastSection = r.section;
            return (
              <div key={r.key}>
                {header}
                <button className={`search-result${i === active ? " active" : ""}`} onMouseEnter={() => setActive(i)} onClick={r.run}>
                  <span className="search-result-icon">{r.icon}</span>
                  <span className="search-result-text">
                    <span className="search-result-title">{r.title}</span>
                  </span>
                  {r.extra && <span className="search-result-when">{r.extra}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
