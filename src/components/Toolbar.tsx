// The top bar, laid out like Calendar's, Notes' and Llip's: title on the left; account and actions on
// the right; then the side panel toggle.

import { useRef, useState, type ReactNode } from "react";
import { canContribute } from "../lib/api";
import { useApp } from "../lib/app";
import { useSettings } from "../lib/settings";
import { Dropdown as Floating } from "./pickers";
import { PanelLeft, PanelRight, Plus } from "./icons";

export function Toolbar({ title, loading }: { title: ReactNode; loading?: boolean }) {
  const { t } = useSettings();
  const { me, sidebarVisible, toggleSidebar, panelVisible, togglePanel, edit, editing, route, project } = useApp();
  const webhooks = route.name === "notifications";
  return (
    <header className="toolbar">
      {!sidebarVisible && (
        <button className="icon-button" title={`${t("toggleSidebar")} (Ctrl+B)`} aria-label={t("toggleSidebar")} onClick={toggleSidebar}>
          <PanelLeft />
        </button>
      )}
      <h1 className="toolbar-title">{title}</h1>
      {loading && <span className="spinner" aria-label={t("loading")} />}
      <div className="toolbar-spacer" />
      <AccountMenu />
      {canContribute(me) && (
        <button
          className="text-button"
          title={webhooks ? t("addWebhook") : `${t("addMonitor")} (N)`}
          disabled={!!editing}
          onClick={() => edit(webhooks ? { kind: "webhook" } : { kind: "monitor", projectId: project })}
        >
          <Plus size={14} />
          <span className="hide-mobile">{webhooks ? t("addWebhook") : t("addMonitor")}</span>
        </button>
      )}
      <button
        className={`icon-button panel-toggle${panelVisible ? " active" : ""}`}
        title={`${t("togglePanel")} (.)`}
        aria-label={t("togglePanel")}
        aria-pressed={panelVisible}
        onClick={togglePanel}
      >
        <PanelRight />
      </button>
    </header>
  );
}

function AccountMenu() {
  const { t } = useSettings();
  const { me, openSettings, signOut } = useApp();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div className="menu-anchor">
      <button ref={anchor} className="avatar" title={me.email ?? me.id} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        {(me.name.trim()[0] ?? "?").toUpperCase()}
      </button>
      {open && (
        <Floating anchor={anchor} onClose={() => setOpen(false)} className="menu-floating">
          <div className="menu" role="menu">
            <div className="menu-label">{me.email ?? me.id}</div>
            <button
              onClick={() => {
                setOpen(false);
                openSettings("profile");
              }}
            >
              <span>{t("settings")}</span>
              <span className="keys">
                <kbd>Ctrl</kbd> <kbd>,</kbd>
              </span>
            </button>
            <button onClick={signOut}>{t("signOut")}</button>
          </div>
        </Floating>
      )}
    </div>
  );
}
