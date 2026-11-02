// Announcements: incident posts written by a person, shown on the status pages they're published
// to. The list (/posts), one post with its timeline (/posts/<id>), and the forms.

import { useEffect, useState, type CSSProperties } from "react";
import { api, canContribute, IMPACTS, POST_STATUSES, type Impact, type Monitor, type Post, type PostStatus, type StatusPage } from "../lib/api";
import { useApp } from "../lib/app";
import { invalidate, useApi } from "../lib/hooks";
import { Markdown } from "../lib/markdown";
import { useSettings } from "../lib/settings";
import { ConfirmDialog, Spinner, useToast } from "./common";
import { Field, FormShell, PAGES } from "./SidePanel";
import { StatusDot } from "./status";
import { ChevronLeft, Megaphone, Pencil, Plus, Trash } from "./icons";

export const POSTS = "/app/posts";

/** Reloads when a post is created, edited or deleted from the side panel. */
export function useOnChanged(event: string, reload: () => void) {
  useEffect(() => {
    window.addEventListener(event, reload);
    return () => window.removeEventListener(event, reload);
  }, [event, reload]);
}

export function ImpactBadge({ impact }: { impact: Impact }) {
  const { t } = useSettings();
  return <span className={`impact-badge i-${impact}`}>{t(`impact_${impact}`)}</span>;
}

export function PostStatusPill({ status }: { status: PostStatus }) {
  const { t } = useSettings();
  return <span className={`post-status p-${status}`}>{t(`postStatus_${status}`)}</span>;
}

export function PostsPage() {
  const { t, f } = useSettings();
  const { me, edit, navigate } = useApp();
  const posts = useApi<Post[]>(POSTS, true);
  const editor = canContribute(me);
  useOnChanged("status:posts", posts.reload);
  const open = (posts.data ?? []).filter((p) => p.status !== "resolved");
  const done = (posts.data ?? []).filter((p) => p.status === "resolved");

  const list = (items: Post[]) => (
    <div className="webhook-list">
      {items.map((p) => (
        <div key={p.id} className="card webhook-card page-card" role="link" tabIndex={0} onClick={() => navigate({ name: "post", id: p.id }, {})} onKeyDown={(e) => e.key === "Enter" && navigate({ name: "post", id: p.id }, {})}>
          <div className="webhook-main">
            <div className="webhook-title">
              <strong>{p.title}</strong>
              <ImpactBadge impact={p.impact} />
              <PostStatusPill status={p.status} />
            </div>
            <span className="small muted">
              {p.resolvedAt ? t("postResolvedOn", { when: f.dateTime(p.resolvedAt) }) : t("postUpdated", { when: f.relative(p.updates[0]?.createdAt ?? p.createdAt, t) })}
              {" · "}
              {p.updates.length === 1 ? t("postUpdateOne") : t("postUpdatesCount", { n: f.number(p.updates.length) })}
              {p.pages.length === 0 && <span className="error-text"> · {t("postOnNoPage")}</span>}
            </span>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="page">
      <div className="page-head">
        <p className="muted page-intro">{t("postsIntro")}</p>
        {editor && posts.data && posts.data.length > 0 && (
          <button className="text-button" onClick={() => edit({ kind: "post" })}>
            <Plus size={14} />
            {t("newPost")}
          </button>
        )}
      </div>
      {!posts.data ? (
        <Spinner />
      ) : posts.data.length === 0 ? (
        <div className="empty-state">
          <Megaphone size={28} />
          <h2>{t("noPosts")}</h2>
          {editor && (
            <button className="primary-button" onClick={() => edit({ kind: "post" })}>
              <Plus size={14} />
              {t("newPost")}
            </button>
          )}
        </div>
      ) : (
        <>
          {open.length > 0 && (
            <section className="monitor-group">
              <h2 className="group-title">{t("postsOpen")}</h2>
              {list(open)}
            </section>
          )}
          {done.length > 0 && (
            <section className="monitor-group">
              <h2 className="group-title">{t("postsResolved")}</h2>
              {list(done)}
            </section>
          )}
        </>
      )}
    </div>
  );
}

export function PostPage({ id }: { id: number }) {
  const { t, f } = useSettings();
  const { me, edit, navigate, monitors } = useApp();
  const toast = useToast();
  const posts = useApi<Post[]>(POSTS, true);
  const pages = useApi<StatusPage[]>(PAGES).data;
  const post = posts.data?.find((p) => p.id === id);
  const [status, setStatus] = useState<PostStatus | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const editor = canContribute(me);
  useOnChanged("status:posts", posts.reload);

  if (posts.data && !post) return <div className="page"><p className="muted">{t("postNotFound")}</p></div>;
  if (!post) return <div className="page"><Spinner /></div>;
  const next = status ?? post.status;

  const reload = () => {
    invalidate(POSTS);
    posts.reload();
  };
  const postUpdate = async () => {
    setBusy(true);
    try {
      await api(`${POSTS}/${post.id}/updates`, { method: "POST", body: { status: next, body: text } });
      setText("");
      setStatus(null);
      reload();
      toast(t("updatePosted"));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page post-page">
      <div className="message-head">
        <button className="text-button" onClick={() => navigate({ name: "posts" }, {})}>
          <ChevronLeft size={14} />
          {t("posts")}
        </button>
      </div>
      <div className="card page-summary">
        <div className="webhook-main">
          <div className="webhook-title">
            <h2>{post.title}</h2>
            <ImpactBadge impact={post.impact} />
            <PostStatusPill status={post.status} />
          </div>
          <span className="small muted">{t("postBy", { name: post.author || "—", when: f.dateTime(post.createdAt) })}</span>
          <span className="small">
            {post.pages.length ? (
              <>
                {t("postShownOn")}{" "}
                {post.pages.map((pid, i) => {
                  const p = pages?.find((x) => x.id === pid);
                  return p ? (
                    <span key={pid}>
                      {i > 0 && ", "}
                      <a href={`/status/${p.slug}`} target="_blank" rel="noreferrer">
                        {p.title}
                      </a>
                    </span>
                  ) : null;
                })}
              </>
            ) : (
              <span className="error-text">{t("postOnNoPage")}</span>
            )}
          </span>
          {post.monitors.length > 0 && (
            <span className="affected">
              {post.monitors.map((mid) => {
                const m = monitors?.find((x) => x.id === mid);
                return m ? (
                  <span key={mid} className="affected-chip">
                    <StatusDot status={m.status} />
                    {m.name}
                  </span>
                ) : null;
              })}
            </span>
          )}
        </div>
        {editor && (
          <div className="webhook-actions">
            <button className="text-button" onClick={() => edit({ kind: "post", post })}>
              <Pencil size={14} />
              <span className="hide-mobile">{t("edit")}</span>
            </button>
          </div>
        )}
      </div>

      {editor && (
        <section className="card">
          <h3>{t("postAnUpdate")}</h3>
          <div className="segmented status-tabs" role="radiogroup" aria-label={t("postStatus")}>
            {POST_STATUSES.map((s) => (
              <button key={s} role="radio" aria-checked={next === s} className={next === s ? "active" : ""} onClick={() => setStatus(s)}>
                <span className={`post-dot p-${s}`} />
                {t(`postStatus_${s}`)}
              </button>
            ))}
          </div>
          <textarea className="text-field prose-field" rows={4} value={text} maxLength={5000} placeholder={t(`postPlaceholder_${next}`)} onChange={(e) => setText(e.target.value)} />
          <div className="form-actions">
            <span className="form-hint">{t("markdownHint")}</span>
            <div className="toolbar-spacer" />
            <button className="primary-button" disabled={busy || !text.trim()} onClick={() => void postUpdate()}>
              {busy && <Spinner />}
              {t("postUpdateButton")}
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <h3>{t("postTimeline")}</h3>
        <ol className="timeline">
          {post.updates.map((u) => (
            <li key={u.id} className={`p-${u.status}`}>
              <div className="timeline-head">
                <PostStatusPill status={u.status} />
                <span className="small muted">
                  {f.dateTime(u.createdAt)}
                  {u.author && ` · ${u.author}`}
                </span>
                <div className="toolbar-spacer" />
                {editor && post.updates.length > 1 && (
                  <button className="icon-button small danger" title={t("delete")} aria-label={t("delete")} onClick={() => setRemoving(u.id)}>
                    <Trash />
                  </button>
                )}
              </div>
              <Markdown text={u.body} />
            </li>
          ))}
        </ol>
      </section>

      {removing !== null && (
        <ConfirmDialog
          title={t("deleteUpdate")}
          text={t("deleteUpdateConfirm")}
          action={t("delete")}
          onConfirm={async () => {
            await api(`${POSTS}/${post.id}/updates/${removing}`, { method: "DELETE" });
            reload();
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

/** Checkboxes for monitors, grouped by project: posts' and maintenance windows' monitors. */
export function MonitorChecklist({ value, onChange }: { value: number[]; onChange: (ids: number[]) => void }) {
  const { t } = useSettings();
  const { monitors, projects } = useApp();
  const groups = [
    ...(projects ?? []).map((p) => ({ key: p.id, name: p.name, color: p.color, items: (monitors ?? []).filter((m) => m.projectId === p.id) })),
    { key: 0, name: t("noProject"), color: "", items: (monitors ?? []).filter((m) => m.projectId === null) },
  ].filter((g) => g.items.length);
  const toggle = (m: Monitor, on: boolean) => onChange(on ? [...value, m.id] : value.filter((x) => x !== m.id));
  return (
    <div className="monitor-checklist">
      {groups.map((g) => (
        <div key={g.key} className="checklist-group">
          <span className="checklist-title">
            {g.color && <span className="project-dot" style={{ "--c": g.color } as CSSProperties} />}
            {g.name}
          </span>
          {g.items.map((m) => (
            <label key={m.id} className="checkbox">
              <input type="checkbox" checked={value.includes(m.id)} onChange={(e) => toggle(m, e.target.checked)} />
              {m.name}
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A new post (with its first update), or a post's title, impact, pages and monitors. */
export function PostForm({ post }: { post?: Post }) {
  const { t } = useSettings();
  const { edit, navigate } = useApp();
  const toast = useToast();
  const pages = useApi<StatusPage[]>(PAGES).data;
  const [title, setTitle] = useState(post?.title ?? "");
  const [impact, setImpact] = useState<Impact>(post?.impact ?? "minor");
  const [status, setStatus] = useState<PostStatus>("investigating");
  const [body, setBody] = useState("");
  const [pageIds, setPageIds] = useState<number[] | null>(post?.pages ?? null);
  const [monitorIds, setMonitorIds] = useState<number[]>(post?.monitors ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // A new post goes on the default page unless other pages are picked.
  const chosen = pageIds ?? (pages ?? []).filter((p) => p.isDefault).map((p) => p.id);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api<Post>(post ? `${POSTS}/${post.id}` : POSTS, {
        method: post ? "PATCH" : "POST",
        body: post ? { title, impact, pages: chosen, monitors: monitorIds } : { title, impact, status, body, pages: chosen, monitors: monitorIds },
      });
      invalidate(POSTS);
      window.dispatchEvent(new Event("status:posts"));
      toast(post ? t("saved") : t("postPublished"));
      edit(null);
      if (!post) navigate({ name: "post", id: saved.id }, {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <FormShell onSubmit={submit} busy={busy} error={error} submitLabel={post ? t("save") : t("publishPost")} onDelete={post ? () => setDeleting(true) : undefined}>
        <Field label={t("postTitle")}>
          <input className="text-field" value={title} maxLength={150} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder={t("postTitlePlaceholder")} />
        </Field>
        <Field label={t("postImpact")} hint={t(`impactHint_${impact}`)}>
          <div className="segmented">
            {IMPACTS.map((i) => (
              <button type="button" key={i} className={impact === i ? "active" : ""} onClick={() => setImpact(i)}>
                {t(`impact_${i}`)}
              </button>
            ))}
          </div>
        </Field>
        {!post && (
          <>
            <Field label={t("postStatus")}>
              <select value={status} onChange={(e) => setStatus(e.target.value as PostStatus)}>
                {POST_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`postStatus_${s}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("postFirstUpdate")} hint={t("markdownHint")}>
              <textarea className="text-field prose-field" rows={4} value={body} maxLength={5000} placeholder={t(`postPlaceholder_${status}`)} onChange={(e) => setBody(e.target.value)} />
            </Field>
          </>
        )}
        <div className="form-field">
          <span className="form-label">{t("postPages")}</span>
          {(pages ?? []).map((p) => (
            <label key={p.id} className="checkbox">
              <input type="checkbox" checked={chosen.includes(p.id)} onChange={(e) => setPageIds(e.target.checked ? [...chosen, p.id] : chosen.filter((x) => x !== p.id))} />
              {p.title}
            </label>
          ))}
          {pages?.length === 0 && <span className="form-hint">{t("noStatusPages")}</span>}
        </div>
        <div className="form-field">
          <span className="form-label">{t("postMonitors")}</span>
          <MonitorChecklist value={monitorIds} onChange={setMonitorIds} />
          <span className="form-hint">{t("postMonitorsHint")}</span>
        </div>
      </FormShell>
      {deleting && post && (
        <ConfirmDialog
          title={t("deletePost")}
          text={t("deletePostConfirm", { title: post.title })}
          action={t("delete")}
          onConfirm={async () => {
            await api(`${POSTS}/${post.id}`, { method: "DELETE" });
            invalidate(POSTS);
            window.dispatchEvent(new Event("status:posts"));
            edit(null);
            navigate({ name: "posts" }, {});
          }}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );
}
