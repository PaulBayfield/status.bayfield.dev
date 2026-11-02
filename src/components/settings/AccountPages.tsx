import { useState } from "react";
import { api, type Session } from "../../lib/api";
import { useApp } from "../../lib/app";
import { invalidate, useApi } from "../../lib/hooks";
import { useSettings, type Settings, type Theme } from "../../lib/settings";
import type { StringKey } from "../../lib/i18n";
import { Download } from "../icons";
import { PageHeader, Row, Switch, useSaveProfile } from "./common";

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
            <button key={id} className={`theme-card${settings.theme === id ? " active" : ""}`} onClick={() => update({ theme: id })}>
              <span className={`theme-preview ${id}`}>
                <span />
                <span />
                <span />
              </span>
              {t(label)}
            </button>
          ))}
        </div>
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
