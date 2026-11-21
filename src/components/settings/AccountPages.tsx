import { useState } from "react";
import { api, type Session } from "../../lib/api";
import { useApp } from "../../lib/app";
import { invalidate, useApi } from "../../lib/hooks";
import { useSettings, type Settings, type Theme } from "../../lib/settings";
import type { StringKey } from "../../lib/i18n";
import { Download, ExternalLink } from "../icons";
import { PageHeader, Row, Switch, useSaveProfile } from "./common";
import { connectPrefs, disconnectPrefs, usePrefsStatus, activeCustomTheme, BASE_COLORS, PREFS_URL } from "../../lib/prefs";

// --- Profile ---

export function ProfilePage() {
  const { t } = useSettings();
  const { me, server } = useApp();
  const { save, busy } = useSaveProfile();
  const [name, setName] = useState(me.name);

  return (
    <>
      <PageHeader title={t("profile")} hint={t("profileHint", { name: server?.oidc?.name ?? "SSO" })} />
      <section className="settings-rows">
        <Row label={t("username")}>
          <span className="muted">{me.id}</span>
        </Row>
        <Row label={t("nameLabel")}>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save({ name });
            }}
          >
            <input className="text-field" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            <button className="primary-button" disabled={busy || name.trim() === me.name}>
              {t("save")}
            </button>
          </form>
        </Row>
        <Row label={t("emailLabel")}>
          <span className="muted">{me.email ?? "—"}</span>
        </Row>
        <Row label={t("role")} hint={t(`roleHint_${me.role}`)}>
          <span className="badge">{t(`role_${me.role}`)}</span>
        </Row>
      </section>
    </>
  );
}

// --- Preferences ---

const THEMES: { id: Theme; label: StringKey }[] = [
  { id: "system", label: "themeSystem" },
  { id: "light", label: "themeLight" },
  { id: "dark", label: "themeDark" },
  { id: "rosepine", label: "themeRosepine" },
  { id: "rosepine-dawn", label: "themeRosepineDawn" },
];

export function PreferencesPage() {
  const { t, settings, update } = useSettings();
  const select = <K extends keyof Settings>(key: K, options: [Settings[K], string][]) => (
    <select
      value={String(settings[key])}
      onChange={(e) => update({ [key]: options.find(([v]) => String(v) === e.target.value)![0] } as Partial<Settings>)}
    >
      {options.map(([value, label]) => (
        <option key={String(value)} value={String(value)}>
          {label}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <PageHeader title={t("preferences")} hint={t("preferencesHint")} />
      <section>
        <h3>{t("appearance")}</h3>
        <div className="theme-picker">
          {THEMES.map(({ id, label }) => (
            <button key={id} className={`theme-card${!activeCustomTheme(settings) && settings.theme === id ? " active" : ""}`} onClick={() => update({ theme: id, customTheme: "" })}>
              <span className={`theme-preview ${id}`}>
                <span />
                <span />
                <span />
              </span>
              {t(label)}
            </button>
          ))}
          {settings.customThemes.map((theme) => {
            const c = { ...BASE_COLORS[theme.base], ...theme.colors };
            return (
              <button
                key={theme.id}
                className={`theme-card${activeCustomTheme(settings)?.id === theme.id ? " active" : ""}`}
                title={theme.name}
                onClick={() => update({ theme: theme.base, customTheme: theme.id })}
              >
                <span className="theme-preview" style={{ background: c.bg, borderColor: c["border-strong"] }}>
                  <span style={{ background: c["bg-sidebar"] }} />
                  <span style={{ background: c.primary }} />
                  <span style={{ background: c.accent }} />
                </span>
                <span className="theme-card-name">{theme.name}</span>
              </button>
            );
          })}
        </div>
        <p className="theme-manage">
          {t("manageThemesHint")}{" "}
          <a className="theme-manage-link" href={PREFS_URL} target="_blank" rel="noopener">
            {t("manageThemes")}
            <ExternalLink size={13} />
          </a>
        </p>
      </section>
      <section className="settings-rows">
        <Row label={t("languageLabel")}>
          {select("language", [
            ["auto", t("automatic")],
            ["fr", "Français"],
            ["en", "English"],
          ])}
        </Row>
        <Row label={t("groupByProject")} hint={t("groupByProjectHint")}>
          <Switch checked={settings.groupByProject} onChange={(groupByProject) => update({ groupByProject })} label={t("groupByProject")} />
        </Row>
      </section>
      <PrefsSyncRow />
    </>
  );
}

// --- Security ---

export function SecurityPage() {
  const { t, f } = useSettings();
  const { server } = useApp();
  const sessions = useApi<Session[]>("/app/sessions");
  const sso = server?.oidc?.name ?? "SSO";
  const reload = () => {
    invalidate("/app/sessions");
    sessions.reload();
  };

  return (
    <>
      <PageHeader title={t("security")} hint={t("securityHint", { name: sso })} />
      <section>
        <h3>{t("sessions")}</h3>
        <div className="settings-list">
          {(sessions.data ?? []).map((s) => (
            <div key={s.id} className="settings-list-row">
              <div className="settings-list-main">
                <span>
                  {describeAgent(s.userAgent)}
                  {s.current && <span className="badge good">{t("thisDevice")}</span>}
                </span>
                <span className="small muted">
                  {t("lastActiveAt", { when: f.relative(s.lastSeenAt, t) })} · {s.ip}
                </span>
              </div>
              {!s.current && (
                <button
                  className="text-button"
                  onClick={async () => {
                    await api(`/app/sessions/${s.id}`, { method: "DELETE" });
                    reload();
                  }}
                >
                  {t("signOutDevice")}
                </button>
              )}
            </div>
          ))}
        </div>
        {(sessions.data?.length ?? 0) > 1 && (
          <button
            className="text-button"
            style={{ marginTop: 10 }}
            onClick={async () => {
              await api("/app/sessions/revoke-others", { method: "POST" });
              reload();
            }}
          >
            {t("signOutOthers")}
          </button>
        )}
      </section>
    </>
  );
}

/** "Chrome · Windows" from a user agent, roughly. */
function describeAgent(ua: string): string {
  const browser = /edg\//i.test(ua) ? "Edge" : /firefox\//i.test(ua) ? "Firefox" : /chrome\//i.test(ua) ? "Chrome" : /safari\//i.test(ua) ? "Safari" : ua.split(" ")[0] || "?";
  const os = /windows/i.test(ua) ? "Windows" : /android/i.test(ua) ? "Android" : /iphone|ipad/i.test(ua) ? "iOS" : /mac os/i.test(ua) ? "macOS" : /linux/i.test(ua) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
}

// --- Data ---

export function DataPage() {
  const { t } = useSettings();
  return (
    <>
      <PageHeader title={t("data")} hint={t("dataHint")} />
      <section className="settings-rows">
        <Row label={t("export")} hint={t("exportHint")}>
          <a className="text-button" href="/api/app/export" download>
            <Download size={14} />
            {t("download")}
          </a>
        </Row>
      </section>
    </>
  );
}

/** Theme and language shared with the other bayfield.dev apps, through prefs.bayfield.dev. */
function PrefsSyncRow() {
  const { t } = useSettings();
  const { status, email } = usePrefsStatus();
  const hint =
    status === "connected"
      ? t("prefsConnected", { email: email ?? "" })
      : status === "connecting"
        ? t("prefsApprove")
        : status === "offline"
          ? t("prefsOffline")
          : t("prefsHint");
  return (
    <section className="settings-rows">
      <h3>{t("prefsTitle")}</h3>
      <Row label={t("prefsLabel")} hint={hint}>
        {status === "connected" ? (
          <button className="text-button" onClick={() => void disconnectPrefs()}>
            {t("prefsDisconnect")}
          </button>
        ) : status === "disconnected" || status === "connecting" ? (
          <button className="primary-button" onClick={() => void connectPrefs("Status")}>
            {t("prefsConnect")}
          </button>
        ) : null}
      </Row>
    </section>
  );
}
