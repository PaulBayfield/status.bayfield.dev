// The right-hand panel: the add/edit forms (monitor, webhook, project), otherwise the activity feed.

import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { api, EVENTS, MONITOR_TYPES, WEBHOOK_KINDS, type Incident, type Monitor, type MonitorType, type PageDisplay, type Project, type StatusPage, type Webhook, type WebhookKind, registeredDomain } from "../lib/api";
import { useApp } from "../lib/app";
import { invalidate, useApi } from "../lib/hooks";
import { useSettings } from "../lib/settings";
import { ConfirmDialog, useToast } from "./common";
import { duration } from "./IncidentsPage";
import { PageLogo } from "./PublicStatus";
import { PostForm } from "./PostsPage";
import { MaintenanceForm } from "./MaintenancePage";
import { MonitorTypeIcon, interval } from "./MonitorPage";
import { WEBHOOKS, kindLabel } from "./NotificationsPage";
import { Switch } from "./settings/common";
import { ChevronDown, ChevronRight, CircleCheck, CircleX, Trash, X } from "./icons";

export function SidePanel() {
  const { t } = useSettings();
  const { editing, edit, togglePanel } = useApp();
  const label = !editing
    ? t("activity")
    : editing.kind === "monitor"
      ? editing.monitor
        ? t("editMonitor")
        : t("addMonitor")
      : editing.kind === "webhook"
        ? editing.webhook
          ? t("editWebhook")
          : t("addWebhook")
        : editing.kind === "page"
          ? editing.page
            ? t("pageSettings")
            : t("newStatusPage")
          : editing.kind === "post"
            ? editing.post
              ? t("editPost")
              : t("newPost")
            : editing.kind === "maintenance"
              ? editing.maintenance
                ? t("editMaintenance")
                : t("newMaintenance")
          : editing.project
            ? t("editProject")
            : t("addProject");
  return (
    <aside className="panel side-panel">
      <div className="panel-header">
        <span className="panel-label">{label}</span>
        <div className="toolbar-spacer" />
        <button className="icon-button small" aria-label={t("close")} onClick={() => (editing ? edit(null) : togglePanel())}>
          <X />
        </button>
      </div>
      {!editing ? (
        <Activity />
      ) : editing.kind === "monitor" ? (
        <MonitorForm key={editing.monitor?.id ?? "new"} monitor={editing.monitor} projectId={editing.projectId} />
      ) : editing.kind === "webhook" ? (
        <WebhookForm key={editing.webhook?.id ?? "new"} webhook={editing.webhook} />
      ) : editing.kind === "page" ? (
        <PageForm key={editing.page?.id ?? "new"} page={editing.page} />
      ) : editing.kind === "post" ? (
        <PostForm key={editing.post?.id ?? "new"} post={editing.post} />
      ) : editing.kind === "maintenance" ? (
        <MaintenanceForm key={editing.maintenance?.id ?? "new"} maintenance={editing.maintenance} />
      ) : (
        <ProjectForm key={editing.project?.id ?? "new"} project={editing.project} />
      )}
    </aside>
  );
}

// --- Activity ---

function Activity() {
  const { t, f } = useSettings();
  const { navigate, monitors } = useApp();
  const incidents = useApi<Incident[]>("/app/incidents?limit=25", true);
  const ongoing = (incidents.data ?? []).filter((i) => !i.resolvedAt);
  const recent = (incidents.data ?? []).filter((i) => i.resolvedAt);
  const paused = (monitors ?? []).filter((m) => m.paused);
  const row = (i: Incident) => {
    const lasted = (i.resolvedAt ? new Date(i.resolvedAt).getTime() : Date.now()) - new Date(i.startedAt).getTime();
    return (
      <button key={i.id} className="activity-row" onClick={() => navigate({ name: "monitor", id: i.monitorId })}>
        <span className={`incident-icon ${i.resolvedAt ? "s-up" : "s-down"}`}>{i.resolvedAt ? <CircleCheck size={14} /> : <CircleX size={14} />}</span>
        <span className="activity-text">
          <span className="activity-title">{i.monitorName}</span>
          <span className="small muted">
            {i.resolvedAt ? t("recoveredAfter", { duration: duration(lasted, t) }) : t("downFor", { duration: duration(lasted, t) })} · {f.relative(i.resolvedAt ?? i.startedAt, t)}
          </span>
        </span>
      </button>
    );
  };
  return (
    <div className="panel-body">
      <div className="panel-section">
        <span className="panel-subtitle">{t("ongoing")}</span>
        {ongoing.length ? ongoing.map(row) : <span className="small muted">{t("nothingDown")}</span>}
      </div>
      <div className="panel-section">
        <span className="panel-subtitle">{t("recentIncidents")}</span>
        {recent.length ? recent.slice(0, 15).map(row) : <span className="small muted">{t("noIncidents")}</span>}
      </div>
      {paused.length > 0 && (
        <div className="panel-section">
          <span className="panel-subtitle">{t("status_paused")}</span>
          {paused.map((m) => (
            <button key={m.id} className="activity-row" onClick={() => navigate({ name: "monitor", id: m.id })}>
              <MonitorTypeIcon type={m.type} />
              <span className="activity-title">{m.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Forms ---

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="form-field">
      <span className="form-label">{label}</span>
      {children}
      {hint && <span className="form-hint">{hint}</span>}
    </label>
  );
}

export function FormShell({ onSubmit, busy, error, children, onDelete, submitLabel }: { onSubmit: () => Promise<void>; busy: boolean; error: string | null; children: ReactNode; onDelete?: () => void; submitLabel: string }) {
  const { t } = useSettings();
  const { edit } = useApp();
  return (
    <form
      className="panel-body panel-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void onSubmit();
      }}
    >
      {children}
      {error && <p className="error-text">{error}</p>}
      <div className="form-actions">
        {onDelete && (
          <button type="button" className="icon-button danger" title={t("delete")} aria-label={t("delete")} onClick={onDelete}>
            <Trash />
          </button>
        )}
        <div className="toolbar-spacer" />
        <button type="button" className="text-button" onClick={() => edit(null)}>
          {t("cancel")}
        </button>
        <button className="primary-button" disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

const INTERVALS = [60, 120, 300, 600, 900, 1800, 3600, 6 * 3600, 12 * 3600, 86400];
const HEARTBEAT_INTERVALS = [300, 900, 1800, 3600, 6 * 3600, 12 * 3600, 86400, 7 * 86400];

function MonitorForm({ monitor, projectId }: { monitor?: Monitor; projectId?: number | null }) {
  const { t } = useSettings();
  const { projects, edit, reload, navigate } = useApp();
  const toast = useToast();
  const [form, setForm] = useState({
    name: monitor?.name ?? "",
    type: (monitor?.type ?? "http") as MonitorType,
    target: monitor?.target ?? "",
    projectId: monitor ? monitor.projectId : (projectId ?? null),
    intervalS: monitor?.intervalS ?? 60,
    method: monitor?.method ?? "GET",
    expectedStatus: monitor?.expectedStatus ?? "200-299",
    keyword: monitor?.keyword ?? "",
    headers: monitor?.headers ?? "",
    followRedirects: monitor?.followRedirects ?? true,
    timeoutMs: monitor?.timeoutMs ?? 10_000,
    retries: monitor?.retries ?? 2,
    degradedMs: monitor?.degradedMs ?? 0,
    certCheck: monitor?.certCheck ?? false,
    domainCheck: monitor?.domainCheck ?? false,
    domainName: monitor?.domainName ?? "",
    expiryWarnDays: monitor?.expiryWarnDays ?? 14,
  });
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const intervals = form.type === "heartbeat" ? HEARTBEAT_INTERVALS : INTERVALS;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api<Monitor>(monitor ? `/app/monitors/${monitor.id}` : "/app/monitors", { method: monitor ? "PATCH" : "POST", body: form });
      invalidate("/app/monitors");
      reload();
      toast(monitor ? t("saved") : t("monitorAdded"));
      edit(null);
      if (!monitor) navigate({ name: "monitor", id: saved.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormShell onSubmit={submit} busy={busy} error={error} submitLabel={monitor ? t("save") : t("addMonitor")}>
      <Field label={t("monitorType")}>
        <div className="type-picker">
          {MONITOR_TYPES.map((type) => (
            <button
              type="button"
              key={type}
              className={`type-option${form.type === type ? " active" : ""}`}
              onClick={() => set({ type, intervalS: type === "heartbeat" ? Math.max(form.intervalS, 3600) : Math.min(form.intervalS, 86400) })}
            >
              <MonitorTypeIcon type={type} size={16} />
              <span>{t(`type_${type}`)}</span>
            </button>
          ))}
        </div>
        <span className="form-hint">{t(`typeHint_${form.type}`)}</span>
      </Field>
      <Field label={t("name")}>
        <input className="text-field" value={form.name} maxLength={100} autoFocus={!monitor} onChange={(e) => set({ name: e.target.value })} placeholder={t("namePlaceholder")} />
      </Field>
      {form.type === "http" && (
        <Field label={t("url")}>
          <input className="text-field" value={form.target} inputMode="url" onChange={(e) => set({ target: e.target.value })} placeholder="https://example.com/health" />
        </Field>
      )}
      {form.type === "tcp" && (
        <Field label={t("hostPort")} hint={t("tcpHint")}>
          <input className="text-field" value={form.target} onChange={(e) => set({ target: e.target.value })} placeholder="server.example.com:22" />
        </Field>
      )}
      <Field label={t("project")}>
        <select value={form.projectId ?? ""} onChange={(e) => set({ projectId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">{t("noProject")}</option>
          {(projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={form.type === "heartbeat" ? t("expectEvery") : t("checkEvery")} hint={form.type === "heartbeat" ? t("expectEveryHint") : undefined}>
        <select value={form.intervalS} onChange={(e) => set({ intervalS: Number(e.target.value) })}>
          {[...new Set([...intervals, form.intervalS])]
            .sort((a, b) => a - b)
            .map((s) => (
              <option key={s} value={s}>
                {interval(s, t)}
              </option>
            ))}
        </select>
      </Field>
      {form.type === "http" && (
        <Field label={t("keyword")} hint={t("keywordHint")}>
          <input className="text-field" value={form.keyword} onChange={(e) => set({ keyword: e.target.value })} placeholder={t("optional")} />
        </Field>
      )}

      {form.type !== "heartbeat" && (
        <div className="form-field">
          <span className="form-label">{t("expiriesTitle")}</span>
          {form.type === "http" && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.certCheck && /^https:/i.test(form.target)}
                disabled={!/^https:/i.test(form.target)}
                onChange={(e) => set({ certCheck: e.target.checked })}
              />
              {t("watchCert")}
            </label>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={form.domainCheck} onChange={(e) => set({ domainCheck: e.target.checked })} />
            {t("watchDomain")}
          </label>
          {form.domainCheck && (
            <input
              className="text-field"
              value={form.domainName}
              spellCheck={false}
              aria-label={t("domainNameLabel")}
              onChange={(e) => set({ domainName: e.target.value.trim().toLowerCase() })}
              placeholder={registeredDomain(form.target, form.type) || "example.com"}
            />
          )}
          {(form.certCheck || form.domainCheck) && (
            <label className="inline-number">
              {t("expiryWarnBefore")}
              <input className="text-field" type="number" min={1} max={90} value={form.expiryWarnDays} onChange={(e) => set({ expiryWarnDays: Number(e.target.value) })} />
              {t("expiryWarnDays")}
            </label>
          )}
          <span className="form-hint">{t("expiriesHint")}</span>
        </div>
      )}

      {form.type !== "heartbeat" && (
        <>
          <button type="button" className="disclosure" onClick={() => setAdvanced((a) => !a)}>
            {advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {t("advanced")}
          </button>
          {advanced && (
            <div className="advanced">
              {form.type === "http" && (
                <>
                  <div className="form-grid">
                    <Field label={t("method")}>
                      <select value={form.method} onChange={(e) => set({ method: e.target.value })}>
                        {["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].map((m) => (
                          <option key={m}>{m}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t("expectedStatus")}>
                      <input className="text-field" value={form.expectedStatus} onChange={(e) => set({ expectedStatus: e.target.value })} />
                    </Field>
                  </div>
                  <Field label={t("requestHeaders")} hint={t("requestHeadersHint")}>
                    <textarea className="text-field" rows={3} value={form.headers} onChange={(e) => set({ headers: e.target.value })} placeholder="Authorization: Bearer …" />
                  </Field>
                  <div className="form-row">
                    <span className="form-label">{t("followRedirects")}</span>
                    <Switch checked={form.followRedirects} onChange={(on) => set({ followRedirects: on })} label={t("followRedirects")} />
                  </div>
                </>
              )}
              <div className="form-grid">
                <Field label={t("timeoutS")}>
                  <input className="text-field" type="number" min={1} max={30} value={form.timeoutMs / 1000} onChange={(e) => set({ timeoutMs: Math.round(Number(e.target.value) * 1000) })} />
                </Field>
                <Field label={t("retries")}>
                  <input className="text-field" type="number" min={1} max={10} value={form.retries} onChange={(e) => set({ retries: Number(e.target.value) })} />
                </Field>
              </div>
              <span className="form-hint">{t("retriesHint")}</span>
              <Field label={t("degradedMs")} hint={t("degradedMsHint")}>
                <input className="text-field" type="number" min={0} max={60000} step={100} value={form.degradedMs} onChange={(e) => set({ degradedMs: Number(e.target.value) })} />
              </Field>
            </div>
          )}
        </>
      )}
      {form.type === "heartbeat" && !monitor && <p className="form-hint">{t("pushAfterSave")}</p>}
    </FormShell>
  );
}

function WebhookForm({ webhook }: { webhook?: Webhook }) {
  const { t } = useSettings();
  const { projects, edit } = useApp();
  const toast = useToast();
  const [form, setForm] = useState({
    name: webhook?.name ?? "",
    kind: (webhook?.kind ?? "discord") as WebhookKind,
    url: webhook?.url ?? "",
    secret: "",
    clearSecret: false,
    events: webhook?.events ?? ["down", "up", "expiry", "post", "maintenance"],
    projects: webhook?.projects ?? [],
    enabled: webhook?.enabled ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(webhook ? `${WEBHOOKS}/${webhook.id}` : WEBHOOKS, { method: webhook ? "PATCH" : "POST", body: form });
      invalidate(WEBHOOKS);
      toast(webhook ? t("saved") : t("webhookAdded"));
      edit(null);
      window.dispatchEvent(new Event("status:webhooks"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormShell onSubmit={submit} busy={busy} error={error} submitLabel={webhook ? t("save") : t("addWebhook")}>
      <Field label={t("service")}>
        <select value={form.kind} onChange={(e) => set({ kind: e.target.value as WebhookKind })}>
          {WEBHOOK_KINDS.map((k) => (
            <option key={k} value={k}>
              {kindLabel[k]}
            </option>
          ))}
        </select>
        <span className="form-hint">{t(`kindHint_${form.kind}`)}</span>
      </Field>
      <Field label={t("name")}>
        <input className="text-field" value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder={t("webhookNamePlaceholder")} />
      </Field>
      <Field label={t("url")}>
        <input className="text-field" value={form.url} inputMode="url" onChange={(e) => set({ url: e.target.value })} placeholder={form.kind === "ntfy" ? "https://ntfy.sh/my-topic" : "https://…"} />
      </Field>
      {(form.kind === "generic" || form.kind === "ntfy") && (
        <Field label={form.kind === "ntfy" ? t("ntfyToken") : t("signingSecret")} hint={form.kind === "ntfy" ? t("ntfyTokenHint") : t("signingSecretHint")}>
          <input
            className="text-field"
            type="password"
            autoComplete="off"
            value={form.secret}
            onChange={(e) => set({ secret: e.target.value, clearSecret: false })}
            placeholder={webhook?.hasSecret ? t("secretKept") : t("optional")}
          />
          {webhook?.hasSecret && (
            <label className="checkbox small">
              <input type="checkbox" checked={form.clearSecret} onChange={(e) => set({ clearSecret: e.target.checked, secret: "" })} />
              {t("removeSecret")}
            </label>
          )}
        </Field>
      )}
      <div className="form-field">
        <span className="form-label">{t("notifyWhen")}</span>
        {EVENTS.map((ev) => (
          <label key={ev} className="checkbox">
            <input
              type="checkbox"
              checked={form.events.includes(ev)}
              onChange={(e) => set({ events: e.target.checked ? [...form.events, ev] : form.events.filter((x) => x !== ev) })}
            />
            {t(`eventLong_${ev}`)}
          </label>
        ))}
      </div>
      <div className="form-field">
        <span className="form-label">{t("forMonitors")}</span>
        <label className="checkbox">
          <input type="checkbox" checked={form.projects.length === 0} onChange={() => set({ projects: [] })} />
          {t("allMonitors")}
        </label>
        {(projects ?? []).map((p) => (
          <label key={p.id} className="checkbox">
            <input
              type="checkbox"
              checked={form.projects.includes(p.id)}
              onChange={(e) => set({ projects: e.target.checked ? [...form.projects, p.id] : form.projects.filter((x) => x !== p.id) })}
            />
            <span className="project-dot" style={{ "--c": p.color } as CSSProperties} />
            {p.name}
          </label>
        ))}
      </div>
    </FormShell>
  );
}

const COLORS = ["#2383e2", "#30a46c", "#9065b0", "#e5484d", "#f5a524", "#0d9488", "#d6409f", "#787774"];

function ProjectForm({ project }: { project?: Project }) {
  const { t } = useSettings();
  const { edit, reload, setQuery } = useApp();
  const toast = useToast();
  const [name, setName] = useState(project?.name ?? "");
  const [color, setColor] = useState(project?.color ?? COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(project ? `/app/projects/${project.id}` : "/app/projects", { method: project ? "PATCH" : "POST", body: { name, color } });
      invalidate("/app/projects");
      reload();
      toast(project ? t("saved") : t("projectAdded"));
      edit(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <FormShell onSubmit={submit} busy={busy} error={error} submitLabel={project ? t("save") : t("addProject")} onDelete={project ? () => setDeleting(true) : undefined}>
        <Field label={t("name")} hint={t("projectHint")}>
          <input className="text-field" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="form-field">
          <span className="form-label">{t("color")}</span>
          <div className="color-picker">
            {COLORS.map((c) => (
              <button type="button" key={c} className={`color-swatch${color === c ? " active" : ""}`} style={{ "--c": c } as CSSProperties} aria-label={c} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
      </FormShell>
      {deleting && project && (
        <ConfirmDialog
          title={t("deleteProject")}
          text={t("deleteProjectConfirm", { name: project.name })}
          action={t("delete")}
          onConfirm={async () => {
            await api(`/app/projects/${project.id}`, { method: "DELETE" });
            invalidate("/app");
            reload();
            setQuery({ project: undefined });
            edit(null);
          }}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );
}

// --- Status page settings (the groups are edited on the page itself) ---

/** "Croustillant API" → "croustillant-api". */
export const slugify = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

export const PAGES = "/app/pages";

function PageForm({ page }: { page?: StatusPage }) {
  const { t } = useSettings();
  const { edit, navigate } = useApp();
  const toast = useToast();
  const [title, setTitle] = useState(page?.title ?? "");
  const [slug, setSlug] = useState(page?.slug ?? "");
  // A new page's address follows its title until it's edited by hand.
  const [slugEdited, setSlugEdited] = useState(!!page);
  const [description, setDescription] = useState(page?.description ?? "");
  const [logoUrl, setLogoUrl] = useState(page?.logoUrl ?? "");
  const [isDefault, setIsDefault] = useState(page?.isDefault ?? false);
  const [domain, setDomain] = useState(page?.domain ?? "");
  const [display, setDisplay] = useState<PageDisplay>(page?.display ?? { tiles: true, bars: true, incidents: true, charts: "off" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api<StatusPage>(page ? `${PAGES}/${page.id}` : PAGES, { method: page ? "PATCH" : "POST", body: { title, slug, description, logoUrl, display, domain, ...(isDefault ? { isDefault: true } : {}) } });
      invalidate(PAGES);
      window.dispatchEvent(new Event("status:pages"));
      toast(page ? t("saved") : t("pageCreated"));
      edit(null);
      if (!page) navigate({ name: "page", id: saved.id }, {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <FormShell onSubmit={submit} busy={busy} error={error} submitLabel={page ? t("save") : t("newStatusPage")} onDelete={page ? () => setDeleting(true) : undefined}>
        <Field label={t("pageTitle")}>
          <input
            className="text-field"
            value={title}
            maxLength={100}
            autoFocus
            onChange={(e) => {
              setTitle(e.target.value);
              if (!slugEdited) setSlug(slugify(e.target.value));
            }}
          />
        </Field>
        <Field label={t("pageSlug")} hint={t("pageSlugHint", { url: `${location.origin}/status/${slug || "…"}` })}>
          <input
            className="text-field"
            value={slug}
            maxLength={64}
            spellCheck={false}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
            }}
          />
        </Field>
        <Field label={t("pageLogo")} hint={t("pageLogoHint")}>
          <div className="logo-field">
            <input className="text-field" type="url" value={logoUrl} maxLength={2000} spellCheck={false} placeholder="https://…/logo.svg" onChange={(e) => setLogoUrl(e.target.value.trim())} />
            {/^https:\/\/.+/.test(logoUrl) && <PageLogo url={logoUrl} size={28} />}
          </div>
        </Field>
        <Field label={t("pageDescription")} hint={t("pageDescriptionHint")}>
          <textarea className="text-field prose-field" rows={3} value={description} maxLength={1000} placeholder={t("optional")} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="form-row">
          <span className="form-label">{t("defaultPage")}</span>
          {/* There's always a default page: choose another one to move it. */}
          <Switch checked={isDefault} onChange={(on) => setIsDefault(on || !!page?.isDefault)} label={t("defaultPage")} />
        </div>
        <span className="form-hint">{t("defaultPageHint")}</span>
        <Field label={t("customDomain")} hint={t("customDomainHint")}>
          <input className="text-field" value={domain} spellCheck={false} placeholder="status.example.com" onChange={(e) => setDomain(e.target.value.trim().toLowerCase())} />
        </Field>
        {domain && (
          <div className="domain-steps">
            <span className="form-label">{t("customDomainSteps")}</span>
            <ol>
              <li>{t("customDomainStep1")}</li>
              <li>
                {t("customDomainStep2")}
                <pre className="message-code">{`{ "pattern": "${domain}", "custom_domain": true }`}</pre>
              </li>
              <li>{t("customDomainStep3")}</li>
            </ol>
          </div>
        )}
        <div className="form-field">
          <span className="form-label">{t("displayTitle")}</span>
          {(["tiles", "bars", "incidents"] as const).map((k) => (
            <label key={k} className="checkbox">
              <input type="checkbox" checked={display[k]} onChange={(e) => setDisplay({ ...display, [k]: e.target.checked })} />
              {t(`display_${k}`)}
            </label>
          ))}
        </div>
        <Field label={t("displayCharts")} hint={t("displayChartsHint")}>
          <select value={display.charts} onChange={(e) => setDisplay({ ...display, charts: e.target.value as PageDisplay["charts"] })}>
            <option value="off">{t("charts_off")}</option>
            <option value="collapsed">{t("charts_collapsed")}</option>
            <option value="expanded">{t("charts_expanded")}</option>
          </select>
        </Field>
      </FormShell>
      {deleting && page && (
        <ConfirmDialog
          title={t("deletePage")}
          text={t("deletePageConfirm", { title: page.title })}
          action={t("delete")}
          onConfirm={async () => {
            await api(`${PAGES}/${page.id}`, { method: "DELETE" });
            invalidate(PAGES);
            window.dispatchEvent(new Event("status:pages"));
            edit(null);
            navigate({ name: "pages" }, {});
          }}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );
}
