// Status pages, like Uptime Kuma's: the list (/pages), and one page's editor (/pages/<id>) where
// its groups of monitors are arranged. Title, address and description are in the side panel.

import { useEffect, useMemo, useState } from "react";
import { api, canContribute, type Monitor, type StatusPage, type StatusPageGroup } from "../lib/api";
import { useApp } from "../lib/app";
import { invalidate, useApi } from "../lib/hooks";
import { useSettings } from "../lib/settings";
import { Spinner, useToast } from "./common";
import { MonitorTypeIcon } from "./MonitorPage";
import { PAGES } from "./SidePanel";
import { PageLogo } from "./PublicStatus";
import { StatusDot, UptimeBars } from "./status";
import { ChevronDown, ChevronUp, ExternalLink, Globe, Gear, Layers, Plus, Trash, X } from "./icons";

const pageUrl = (p: Pick<StatusPage, "slug">) => `/status/${p.slug}`;

/** Reloads when a page is created, edited or deleted from the side panel. */
function useOnPagesChanged(reload: () => void) {
  useEffect(() => {
    window.addEventListener("status:pages", reload);
    return () => window.removeEventListener("status:pages", reload);
  }, [reload]);
}

export function StatusPagesPage() {
  const { t, f } = useSettings();
  const { me, edit, navigate } = useApp();
  const pages = useApi<StatusPage[]>(PAGES, true);
  const editor = canContribute(me);
  useOnPagesChanged(pages.reload);

  return (
    <div className="page">
      <div className="page-head">
        <p className="muted page-intro">{t("noStatusPagesHint")}</p>
        {editor && pages.data && pages.data.length > 0 && (
          <button className="text-button" onClick={() => edit({ kind: "page" })}>
            <Plus size={14} />
            {t("newStatusPage")}
          </button>
        )}
      </div>
      {!pages.data ? (
        <Spinner />
      ) : pages.data.length === 0 ? (
        <div className="empty-state">
          <Globe size={28} />
          <h2>{t("noStatusPages")}</h2>
          {editor && (
            <button className="primary-button" onClick={() => edit({ kind: "page" })}>
              <Plus size={14} />
              {t("newStatusPage")}
            </button>
          )}
        </div>
      ) : (
        <div className="webhook-list">
          {pages.data.map((p) => {
            const monitors = new Set(p.groups.flatMap((g) => g.monitors)).size;
            return (
              <div key={p.id} className="card webhook-card page-card" role="link" tabIndex={0} onClick={() => navigate({ name: "page", id: p.id }, {})} onKeyDown={(e) => e.key === "Enter" && navigate({ name: "page", id: p.id }, {})}>
                <div className="webhook-main">
                  <div className="webhook-title">
                    <strong>{p.title}</strong>
                    {p.isDefault && <span className="badge">{t("defaultPage")}</span>}
                  </div>
                  <span className="small muted webhook-url">{pageUrl(p)}</span>
                  <span className="small muted">{t("pageGroupsSummary", { monitors: f.number(monitors), groups: f.number(p.groups.length) })}</span>
                </div>
                <div className="webhook-actions" onClick={(e) => e.stopPropagation()}>
                  <a className="text-button" href={pageUrl(p)} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} />
                    <span className="hide-mobile">{t("viewPage")}</span>
                  </a>
                  {editor && (
                    <button className="icon-button" title={t("pageSettings")} aria-label={t("pageSettings")} onClick={() => edit({ kind: "page", page: p })}>
                      <Gear />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- One page's editor ---

type Draft = { key: number; name: string; monitors: number[] }[];

let nextKey = 1;
const toDraft = (groups: StatusPageGroup[]): Draft => groups.map((g) => ({ key: nextKey++, name: g.name, monitors: [...g.monitors] }));
const strip = (d: Draft): StatusPageGroup[] => d.map((g) => ({ name: g.name.trim(), monitors: g.monitors }));
const move = <T,>(list: T[], i: number, by: number): T[] => {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
};

export function PageEditor({ id }: { id: number }) {
  const { t } = useSettings();
  const { me, edit, monitors, projects, reload: reloadMonitors } = useApp();
  const toast = useToast();
  const page = useApi<StatusPage>(`${PAGES}/${id}`, true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const editor = canContribute(me);
  useOnPagesChanged(page.reload);

  const dirty = !!draft && !!page.data && JSON.stringify(strip(draft)) !== JSON.stringify(page.data.groups);
  // Follow the server while nothing is being edited here.
  useEffect(() => {
    if (page.data && !dirty) setDraft(toDraft(page.data.groups));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.data]);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  const byId = useMemo(() => new Map((monitors ?? []).map((m) => [m.id, m])), [monitors]);

  if (page.error) return <div className="page"><p className="error-text">{page.error}</p></div>;
  if (!page.data || !draft) return <div className="page"><Spinner /></div>;
  const p = page.data;

  const set = (d: Draft) => setDraft(d);
  const setGroup = (i: number, patch: Partial<Draft[number]>) => set(draft.map((g, j) => (j === i ? { ...g, ...patch } : g)));

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api<StatusPage>(`${PAGES}/${p.id}`, { method: "PATCH", body: { groups: strip(draft) } });
      invalidate(PAGES);
      page.reload();
      setDraft(toDraft(saved.groups));
      reloadMonitors();
      toast(t("saved"));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  /** Starts from the projects: one group each, with its monitors. */
  const fromProjects = () => {
    const list = monitors ?? [];
    const groups: Draft = (projects ?? [])
      .map((pr) => ({ key: nextKey++, name: pr.name, monitors: list.filter((m) => m.projectId === pr.id).map((m) => m.id) }))
      .filter((g) => g.monitors.length);
    const loose = list.filter((m) => m.projectId === null).map((m) => m.id);
    if (loose.length) groups.push({ key: nextKey++, name: t("other"), monitors: loose });
    set([...draft, ...groups]);
  };

  return (
    <div className="page page-editor">
      <div className="card page-summary">
        {p.logoUrl && <PageLogo url={p.logoUrl} size={40} />}
        <div className="webhook-main">
          <div className="webhook-title">
            <h2>{p.title}</h2>
            {p.isDefault && <span className="badge">{t("defaultPage")}</span>}
          </div>
          <a className="small webhook-url" href={pageUrl(p)} target="_blank" rel="noreferrer">
            {location.origin}
            {pageUrl(p)}
          </a>
          {p.description && <span className="small muted public-description">{p.description}</span>}
        </div>
        <div className="webhook-actions">
          <a className="text-button" href={pageUrl(p)} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            <span className="hide-mobile">{t("viewPage")}</span>
          </a>
          {editor && (
            <button className="text-button" onClick={() => edit({ kind: "page", page: p })}>
              <Gear size={14} />
              <span className="hide-mobile">{t("settings")}</span>
            </button>
          )}
        </div>
      </div>

      {draft.length === 0 && <p className="muted empty-filter">{t("noGroups")}</p>}

      {draft.map((g, i) => (
        <section key={g.key} className="monitor-group">
          <div className="group-editor-head">
            {editor ? (
              <input className="text-field group-name" value={g.name} maxLength={80} placeholder={t("groupName")} aria-label={t("groupName")} onChange={(e) => setGroup(i, { name: e.target.value })} />
            ) : (
              <h2 className="group-title">{g.name}</h2>
            )}
            <div className="toolbar-spacer" />
            {editor && (
              <>
                <button className="icon-button small" title={t("moveUp")} aria-label={t("moveUp")} disabled={i === 0} onClick={() => set(move(draft, i, -1))}>
                  <ChevronUp />
                </button>
                <button className="icon-button small" title={t("moveDown")} aria-label={t("moveDown")} disabled={i === draft.length - 1} onClick={() => set(move(draft, i, 1))}>
                  <ChevronDown />
                </button>
                <button className="icon-button small danger" title={t("deleteGroup")} aria-label={t("deleteGroup")} onClick={() => set(draft.filter((_, j) => j !== i))}>
                  <Trash />
                </button>
              </>
            )}
          </div>
          <div className="monitor-list">
            {g.monitors.length === 0 && <div className="group-empty muted small">{t("emptyGroup")}</div>}
            {g.monitors.map((mid, j) => {
              const m = byId.get(mid);
              if (!m) return null;
              return <EditorRow key={mid} m={m} editor={editor} first={j === 0} last={j === g.monitors.length - 1} onMove={(by) => setGroup(i, { monitors: move(g.monitors, j, by) })} onRemove={() => setGroup(i, { monitors: g.monitors.filter((x) => x !== mid) })} />;
            })}
            {editor && (
              <div className="group-add">
                <Plus size={14} />
                <select
                  className="text-field"
                  value=""
                  aria-label={t("addMonitorToGroup")}
                  onChange={(e) => e.target.value && setGroup(i, { monitors: [...g.monitors, Number(e.target.value)] })}
                >
                  <option value="">{t("addMonitorToGroup")}</option>
                  {(monitors ?? [])
                    .filter((m) => !g.monitors.includes(m.id))
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.projectId !== null ? ` — ${projects?.find((pr) => pr.id === m.projectId)?.name ?? ""}` : ""}
                      </option>
                    ))}
                </select>
              </div>
            )}
          </div>
        </section>
      ))}

      {editor && (
        <div className="group-buttons">
          <button className="text-button" onClick={() => set([...draft, { key: nextKey++, name: "", monitors: [] }])}>
            <Plus size={14} />
            {t("addGroup")}
          </button>
          {(projects?.length ?? 0) > 0 && (
            <button className="text-button" onClick={fromProjects}>
              <Layers size={14} />
              {t("groupPerProject")}
            </button>
          )}
        </div>
      )}

      {dirty && (
        <div className="save-bar" role="status">
          <span>{t("unsavedChanges")}</span>
          <div className="toolbar-spacer" />
          <button className="text-button" disabled={saving} onClick={() => setDraft(toDraft(p.groups))}>
            {t("discard")}
          </button>
          <button className="primary-button" disabled={saving} onClick={() => void save()}>
            {saving && <Spinner />}
            {t("saveChanges")}
          </button>
        </div>
      )}
    </div>
  );
}

function EditorRow({ m, editor, first, last, onMove, onRemove }: { m: Monitor; editor: boolean; first: boolean; last: boolean; onMove: (by: number) => void; onRemove: () => void }) {
  const { t } = useSettings();
  return (
    <div className="monitor-row editor-row">
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
      {editor && (
        <div className="row-actions">
          <button className="icon-button small" title={t("moveUp")} aria-label={t("moveUp")} disabled={first} onClick={() => onMove(-1)}>
            <ChevronUp />
          </button>
          <button className="icon-button small" title={t("moveDown")} aria-label={t("moveDown")} disabled={last} onClick={() => onMove(1)}>
            <ChevronDown />
          </button>
          <button className="icon-button small" title={t("remove")} aria-label={t("remove")} onClick={onRemove}>
            <X />
          </button>
        </div>
      )}
    </div>
  );
}
