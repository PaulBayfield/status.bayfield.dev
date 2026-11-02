import { useState } from "react";
import { ROLES, api, type AdminUser } from "../../lib/api";
import { useApp } from "../../lib/app";
import { invalidate, useApi } from "../../lib/hooks";
import { useSettings } from "../../lib/settings";
import type { UpdateCheck } from "../../lib/updates";
import { ConfirmDialog, Dropdown, useToast } from "../common";
import { Check, ExternalLink, MoreHorizontal } from "../icons";
import { PageHeader, Row } from "./common";

/** Accounts are created by signing in; admins pick what each one may do. */
export function UsersPage() {
  const { t, f } = useSettings();
  const { me, server } = useApp();
  const toast = useToast();
  const groupAdmins = !!server?.oidc?.adminGroups;
  const users = useApi<AdminUser[]>("/app/users");
  const [deleting, setDeleting] = useState<AdminUser | null>(null);
  const reload = () => {
    invalidate("/app/users");
    users.reload();
  };
  const setRole = async (id: string, role: string) => {
    try {
      await api(`/app/users/${encodeURIComponent(id)}`, { method: "PATCH", body: { role } });
      reload();
      toast(t("saved"));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <>
      <PageHeader title={t("users")} hint={groupAdmins ? `${t("usersHint")} ${t("adminsFromGroups", { name: server!.oidc!.name })}` : t("usersHint")} />
      <section>
        <div className="settings-list">
          {(users.data ?? []).map((u) => (
            <div key={u.id} className="settings-list-row">
              <div className="settings-list-main">
                <span>
                  {u.name || u.id} <span className="muted small">@{u.id}</span>
                  {u.id === me.id && <span className="badge">{t("you")}</span>}
                  <span className={`badge${u.role === "admin" ? " good" : ""}`} title={t(`roleHint_${u.role}`)}>
                    {t(`role_${u.role}`)}
                  </span>
                </span>
                <span className="small muted">
                  {u.email ?? "—"} · {u.lastSeenAt ? t("lastSeen", { when: f.relative(u.lastSeenAt, t) }) : t("neverSeen")}
                </span>
              </div>
              {u.id !== me.id && (
                <Dropdown
                  button={(_, toggle) => (
                    <button className="icon-button small" aria-label={t("more")} onClick={toggle}>
                      <MoreHorizontal size={14} />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <div className="menu-label">{t("role")}</div>
                      {ROLES.map((role) => (
                        <button
                          key={role}
                          className={u.role === role ? "active" : ""}
                          title={t(`roleHint_${role}`)}
                          disabled={groupAdmins && u.role !== role && (role === "admin" || u.role === "admin")}
                          onClick={() => {
                            close();
                            if (u.role !== role) void setRole(u.id, role);
                          }}
                        >
                          {t(`role_${role}`)}
                          {u.role === role && <Check size={14} />}
                        </button>
                      ))}
                      <div className="menu-separator" />
                      <button
                        className="danger"
                        onClick={() => {
                          close();
                          setDeleting(u);
                        }}
                      >
                        {t("deleteUser")}
                      </button>
                    </>
                  )}
                </Dropdown>
              )}
            </div>
          ))}
        </div>
      </section>
      {deleting && (
        <ConfirmDialog
          title={t("deleteUser")}
          text={t("deleteUserConfirm", { name: deleting.name || deleting.id })}
          word={deleting.id}
          action={t("delete")}
          onConfirm={async () => {
            await api(`/app/users/${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
            reload();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}

/** The version, whether a newer one is out, and where to find the source. */
export function AboutPage({ updates }: { updates: UpdateCheck }) {
  const { t, f } = useSettings();
  const { server } = useApp();
  const { status, checking, error, check } = updates;
  const version = status?.current ?? (server?.version && server.version !== "dev" ? server.version : __APP_VERSION__);
  const latest = status?.available ? status.latest : null;

  const hint = status?.disabled
    ? t("updateCheckOff")
    : checking
      ? t("checkingUpdates")
      : latest
        ? t("updateAvailable", { version: latest.version })
        : error
          ? t("updateCheckFailed")
          : status?.latest
            ? t("upToDate")
            : t("noReleases");

  return (
    <>
      <PageHeader title={t("about")} />
      <section className="settings-rows">
        <Row label={t("appName")} hint={t("aboutText")}>
          <span className="muted small tabular">{t("version", { version })}</span>
        </Row>
        <Row
          label={t("updates")}
          hint={
            <>
              {hint}
              {latest && <> {t("updateHowTo")}</>}
              {!latest && status?.checkedAt && !checking && !status.disabled && <> · {t("lastChecked", { when: f.relative(status.checkedAt, t) })}</>}
            </>
          }
        >
          {latest ? (
            <a className="primary-button" href={latest.url} target="_blank" rel="noreferrer">
              {t("whatsNew")}
            </a>
          ) : (
            !status?.disabled && (
              <button className="text-button" disabled={checking} onClick={() => void check()}>
                {t("checkForUpdates")}
              </button>
            )
          )}
        </Row>
        <Row label={t("allVersions")}>
          <a className="text-button" href={status?.releasesUrl ?? "https://github.com/PaulBayfield/status.bayfield.dev/releases"} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            {t("releaseNotes")}
          </a>
        </Row>
        <Row label={t("checksFrom")} hint={t("checksFromText", { days: server?.retentionDays ?? 30 })} />
        <Row label={t("sourceCode")}>
          <a className="text-button" href="https://github.com/PaulBayfield/status.bayfield.dev" target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            GitHub
          </a>
        </Row>
      </section>
    </>
  );
}
