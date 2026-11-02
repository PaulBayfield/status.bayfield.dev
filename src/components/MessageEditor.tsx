// A webhook's message editor (/notifications/<id>): what each event's notification says, the
// details and buttons it carries and, for Discord, how it looks. A live preview on the right is
// rendered by the server from the draft, so it's exactly what would be sent.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  api,
  canContribute,
  MESSAGE_DETAILS,
  MESSAGE_EVENTS,
  PLACEHOLDERS,
  type MessageDefaults,
  type MessageEvent,
  type MessageTemplate,
  type StatusPage,
  type Webhook,
} from "../lib/api";
import { useApp } from "../lib/app";
import { invalidate, useApi } from "../lib/hooks";
import type { StringKey } from "../lib/i18n";
import { inline } from "../lib/markdown";
import { useSettings } from "../lib/settings";
import { Spinner, useToast } from "./common";
import { kindLabel, WEBHOOKS } from "./NotificationsPage";
import { PAGES } from "./SidePanel";
import { Switch } from "./settings/common";
import { ChevronLeft, RefreshCw, Send } from "./icons";

type Field = HTMLInputElement | HTMLTextAreaElement;

export function MessageEditor({ id }: { id: number }) {
  const { t } = useSettings();
  const { me, navigate } = useApp();
  const toast = useToast();
  const hooks = useApi<Webhook[]>(WEBHOOKS, true);
  const defaults = useApi<MessageDefaults>(`${WEBHOOKS}/defaults`).data;
  const pages = useApi<StatusPage[]>(PAGES).data;
  const hook = hooks.data?.find((w) => w.id === id);
  const [draft, setDraft] = useState<MessageTemplate | null>(null);
  const [event, setEvent] = useState<MessageEvent>("down");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const editor = canContribute(me);
  // The last text field used: placeholders are inserted there.
  const lastField = useRef<Field | null>(null);

  const saved = hook ? JSON.stringify(hook.template) : "";
  const dirty = !!draft && !!hook && JSON.stringify(draft) !== saved;
  useEffect(() => {
    if (hook && !dirty) setDraft(structuredClone(hook.template));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  const preview = usePreview(hook?.kind, hook?.id, draft, event);

  if (hooks.data && !hook) return <div className="page"><p className="muted">{t("webhookNotFound")}</p></div>;
  if (!hook || !draft || !defaults) return <div className="page"><Spinner /></div>;

  const d = draft;
  const texts = defaults.texts[d.language];
  const discord = hook.kind === "discord";
  const update = (fn: (t: MessageTemplate) => void) => {
    const next = structuredClone(d);
    fn(next);
    setDraft(next);
  };
  const focus = (e: { currentTarget: Field }) => (lastField.current = e.currentTarget);

  /** Puts {name} at the cursor of the last field used, through React's state. */
  const insert = (name: string) => {
    const el = lastField.current;
    if (!el || !editor) return;
    const token = `{${name}}`;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const value = el.value.slice(0, start) + token + el.value.slice(end);
    const path = el.dataset.path!;
    update((t) => setPath(t, path, value));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await api(`${WEBHOOKS}/${hook.id}`, { method: "PATCH", body: { template: d } });
      invalidate(WEBHOOKS);
      hooks.reload();
      toast(t("saved"));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      await api(`${WEBHOOKS}/${hook.id}/test`, { method: "POST", body: { event, template: d } });
      toast(t("testSent"));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setTesting(false);
      invalidate(WEBHOOKS);
    }
  };

  const textField = (path: string, value: string, placeholder: string, opts: { area?: boolean; max?: number } = {}) => {
    const common = {
      className: `text-field${opts.area ? " prose-field" : ""}`,
      value,
      placeholder,
      maxLength: opts.max ?? 250,
      disabled: !editor,
      "data-path": path,
      onFocus: focus,
      onChange: (e: { target: Field }) => update((t) => setPath(t, path, e.target.value)),
    };
    return opts.area ? <textarea rows={3} {...common} /> : <input {...common} />;
  };

  return (
    <div className="page message-page">
      <div className="message-head">
        <button className="text-button" onClick={() => navigate({ name: "notifications" }, {})}>
          <ChevronLeft size={14} />
          {t("notifications")}
        </button>
        <h2>
          {hook.name} <span className="badge">{kindLabel[hook.kind]}</span>
        </h2>
        <p className="muted page-intro">{t("messageIntro")}</p>
      </div>

      <div className="message-editor">
        <div className="message-form">
          <section className="card">
            <div className="card-header">
              <h3>{t("messageLanguage")}</h3>
              <select value={d.language} disabled={!editor} onChange={(e) => update((t) => (t.language = e.target.value as "en" | "fr"))}>
                <option value="en">English</option>
                <option value="fr">Français</option>
              </select>
            </div>
            <span className="form-hint">{t("messageLanguageHint")}</span>
          </section>

          <section className="card">
            <div className="card-header">
              <h3>{t("msgBody")}</h3>
              <EventTabs event={event} setEvent={setEvent} />
            </div>
            <label className="form-field">
              <span className="form-label">{t("msgTitle")}</span>
              {textField(`messages.${event}.title`, d.messages[event].title, texts.messages[event].title)}
            </label>
            <label className="form-field">
              <span className="form-label">{t("msgBody")}</span>
              {textField(`messages.${event}.body`, d.messages[event].body, texts.messages[event].body, { area: true, max: 2000 })}
            </label>
            {discord && (
              <label className="form-field">
                <span className="form-label">{t("msgMention")}</span>
                {textField(`discord.mentions.${event}`, d.discord.mentions[event], "<@&123456789012345678>", { max: 200 })}
                <span className="form-hint">{t("msgMentionHint")}</span>
              </label>
            )}
            <div className="form-field">
              <span className="form-label">{t("placeholders")}</span>
              <div className="placeholder-chips">
                {PLACEHOLDERS.map((p) => (
                  <button key={p} type="button" className="placeholder-chip" title={t(`ph_${p}` as StringKey)} disabled={!editor} onClick={() => insert(p)}>
                    <code>{`{${p}}`}</code>
                    <span>{t(`ph_${p}` as StringKey)}</span>
                  </button>
                ))}
              </div>
              <span className="form-hint">{t("placeholdersHint")}</span>
            </div>
          </section>

          <section className="card">
            <h3>{t("msgDetails")}</h3>
            <div className="check-grid">
              {MESSAGE_DETAILS.map((k) => (
                <label key={k} className="checkbox">
                  <input type="checkbox" checked={d.details[k]} disabled={!editor} onChange={(e) => update((t) => (t.details[k] = e.target.checked))} />
                  {texts.labels[k]}
                </label>
              ))}
            </div>
            <span className="form-hint">{t("msgDetailsHint")}</span>
          </section>

          <section className="card">
            <h3>{t("msgButtons")}</h3>
            {(["monitor", "statusPage"] as const).map((b) => (
              <div key={b} className="button-option">
                <label className="checkbox">
                  <input type="checkbox" checked={d.buttons[b].enabled} disabled={!editor} onChange={(e) => update((t) => (t.buttons[b].enabled = e.target.checked))} />
                  {t(b === "monitor" ? "btnMonitor" : "btnStatusPage")}
                </label>
                {d.buttons[b].enabled && textField(`buttons.${b}.label`, d.buttons[b].label, texts.buttons[b], { max: 80 })}
                {b === "statusPage" && d.buttons.statusPage.enabled && (
                  <select
                    className="button-page"
                    aria-label={t("buttonPage")}
                    value={d.buttons.statusPage.page}
                    disabled={!editor}
                    onChange={(e) => update((t) => (t.buttons.statusPage.page = e.target.value))}
                  >
                    <option value="">{t("buttonPageAuto")}</option>
                    {(pages ?? []).map((p) => (
                      <option key={p.id} value={p.slug}>
                        {p.title} (/status/{p.slug})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </section>

          {discord && (
            <section className="card">
              <h3>{t("discordLook")}</h3>
              <div className="form-grid">
                <label className="form-field">
                  <span className="form-label">{t("dcUsername")}</span>
                  {textField("discord.username", d.discord.username, "Status", { max: 80 })}
                </label>
                <label className="form-field">
                  <span className="form-label">{t("dcAvatar")}</span>
                  {textField("discord.avatarUrl", d.discord.avatarUrl, "https://…/avatar.png", { max: 2000 })}
                </label>
              </div>
              <label className="form-field">
                <span className="form-label">{t("dcThumbnail")}</span>
                {textField("discord.thumbnailUrl", d.discord.thumbnailUrl, "https://…/logo.png", { max: 2000 })}
                <span className="form-hint">{t("dcThumbnailHint")}</span>
              </label>
              <label className="form-field">
                <span className="form-label">{t("dcFooter")}</span>
                {textField("discord.footer", d.discord.footer, texts.footer, { max: 300 })}
              </label>
              <div className="form-row">
                <span className="form-label">{t("dcEmoji")}</span>
                <Switch checked={d.discord.emoji} onChange={(on) => editor && update((t) => (t.discord.emoji = on))} label={t("dcEmoji")} />
              </div>
              <div className="form-field">
                <span className="form-label">{t("dcColors")}</span>
                <div className="color-inputs">
                  {(["down", "degraded", "up"] as const).map((k) => (
                    <label key={k} className="color-input">
                      <input type="color" value={d.discord.colors[k]} disabled={!editor} onChange={(e) => update((t) => (t.discord.colors[k] = e.target.value))} />
                      {t(`msgEvent_${k}`)}
                    </label>
                  ))}
                </div>
              </div>
            </section>
          )}

          {editor && (
            <button className="text-button reset-defaults" onClick={() => setDraft(blankTemplate(d.language))}>
              <RefreshCw size={14} />
              {t("resetDefaults")}
            </button>
          )}
        </div>

        <aside className="message-preview">
          <div className="card">
            <div className="card-header">
              <h3>{t("messagePreview")}</h3>
              <EventTabs event={event} setEvent={setEvent} />
            </div>
            <span className="form-hint">{t("messagePreviewHint", { service: kindLabel[hook.kind] })}</span>
            {!preview ? <Spinner /> : <PreviewBody kind={hook.kind} data={preview} template={d} />}
            {editor && (
              <button className="text-button" disabled={testing} onClick={() => void test()}>
                {testing ? <Spinner /> : <Send size={14} />}
                {t("sendTest")} · {t(`msgEvent_${event}`)}
              </button>
            )}
          </div>
        </aside>
      </div>

      {dirty && (
        <div className="save-bar" role="status">
          <span>{t("unsavedChanges")}</span>
          <div className="toolbar-spacer" />
          <button className="text-button" disabled={saving} onClick={() => setDraft(structuredClone(hook.template))}>
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

function EventTabs({ event, setEvent }: { event: MessageEvent; setEvent: (e: MessageEvent) => void }) {
  const { t } = useSettings();
  return (
    <div className="segmented event-tabs" role="tablist">
      {MESSAGE_EVENTS.map((ev) => (
        <button key={ev} role="tab" aria-selected={event === ev} className={event === ev ? "active" : ""} onClick={() => setEvent(ev)}>
          <span className={`event-dot e-${ev}`} />
          {t(`msgEvent_${ev}`)}
        </button>
      ))}
    </div>
  );
}

/** "messages.down.title" → sets that key. */
function setPath(t: MessageTemplate, path: string, value: string) {
  const keys = path.split(".");
  let o = t as unknown as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>;
  o[keys[keys.length - 1]] = value;
}

function blankTemplate(language: "en" | "fr"): MessageTemplate {
  const blank = { title: "", body: "" };
  return {
    language,
    messages: { down: { ...blank }, up: { ...blank }, normal: { ...blank }, degraded: { ...blank }, expiring: { ...blank } },
    details: { target: true, cause: true, latency: true, duration: true, project: false, time: false },
    buttons: { monitor: { enabled: true, label: "" }, statusPage: { enabled: false, label: "", page: "" } },
    discord: {
      username: "Status",
      avatarUrl: "",
      thumbnailUrl: "",
      footer: "",
      emoji: true,
      colors: { down: "#e5484d", up: "#30a46c", degraded: "#f5a524" },
      mentions: { down: "", up: "", normal: "", degraded: "", expiring: "" },
    },
  };
}

// --- Preview ---

interface Preview {
  kind: Webhook["kind"];
  body: unknown;
  buttonsNeedHttps?: boolean;
  error?: string;
}

/** The server renders the draft (debounced), so the preview is exactly what would be sent. */
function usePreview(kind: Webhook["kind"] | undefined, webhookId: number | undefined, draft: MessageTemplate | null, event: MessageEvent): Preview | null {
  const [out, setOut] = useState<Preview | null>(null);
  const key = JSON.stringify([kind, draft, event]);
  useEffect(() => {
    if (!kind || !draft) return;
    let live = true;
    const timer = window.setTimeout(() => {
      api<Preview>(`${WEBHOOKS}/preview`, { method: "POST", body: { kind, webhookId, template: draft, event } }).then(
        (p) => live && setOut(p),
        (e: Error) => live && setOut((o) => ({ ...(o ?? { kind, body: null }), error: e.message })),
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return out;
}

function PreviewBody({ kind, data, template }: { kind: Webhook["kind"]; data: Preview; template: MessageTemplate }) {
  const { t } = useSettings();
  return (
    <>
      {data.error && <p className="error-text small">{data.error}</p>}
      {kind === "discord" ? (
        <>
          <DiscordMessage body={data.body as DiscordBody} avatar={template.discord.avatarUrl} />
          {data.buttonsNeedHttps && (template.buttons.monitor.enabled || template.buttons.statusPage.enabled) && <span className="form-hint">{t("buttonsNeedHttps")}</span>}
        </>
      ) : kind === "slack" ? (
        <pre className="message-code">{(data.body as { text: string }).text}</pre>
      ) : (
        <pre className="message-code">{JSON.stringify(data.body, null, 2)}</pre>
      )}
    </>
  );
}

interface Component {
  type: number;
  content?: string;
  components?: Component[];
  accessory?: Component;
  media?: { url: string };
  accent_color?: number;
  label?: string;
  url?: string;
  divider?: boolean;
}
interface DiscordBody {
  username: string;
  components: Component[];
}

/** Discord's look, roughly: the webhook's name and avatar, then its components. */
function DiscordMessage({ body, avatar }: { body: DiscordBody | null; avatar: string }) {
  const { t, f } = useSettings();
  const time = useMemo(() => new Intl.DateTimeFormat(f.locale, { hour: "2-digit", minute: "2-digit" }).format(new Date()), [f.locale]);
  if (!body) return null;
  return (
    <div className="dc-message">
      <img className="dc-avatar" src={avatar || "/favicon.svg"} alt="" referrerPolicy="no-referrer" />
      <div className="dc-main">
        <div className="dc-author">
          <strong>{body.username}</strong>
          <span className="dc-app">{t("appBadge")}</span>
          <span className="dc-time">{t("todayAt", { time })}</span>
        </div>
        {body.components.map((c, i) => (
          <DiscordComponent key={i} c={c} />
        ))}
      </div>
    </div>
  );
}

function DiscordComponent({ c }: { c: Component }): ReactNode {
  switch (c.type) {
    case 17:
      return (
        <div className="dc-container" style={{ borderLeftColor: c.accent_color !== undefined ? `#${c.accent_color.toString(16).padStart(6, "0")}` : undefined }}>
          {c.components?.map((x, i) => <DiscordComponent key={i} c={x} />)}
        </div>
      );
    case 9:
      return (
        <div className="dc-section">
          <div>{c.components?.map((x, i) => <DiscordComponent key={i} c={x} />)}</div>
          {c.accessory?.media && <img className="dc-thumb" src={c.accessory.media.url} alt="" referrerPolicy="no-referrer" />}
        </div>
      );
    case 10:
      return <DiscordText text={c.content ?? ""} />;
    case 14:
      return <hr className="dc-separator" />;
    case 1:
      return (
        <div className="dc-buttons">
          {c.components?.map((b, i) => (
            <a key={i} className="dc-button" href={b.url} target="_blank" rel="noreferrer">
              {b.label} ↗
            </a>
          ))}
        </div>
      );
    default:
      return null;
  }
}

/** Discord's markdown, enough for a preview: headings, -# subtext, timestamps and mentions. */
function DiscordText({ text }: { text: string }) {
  const { f } = useSettings();
  const shown = text
    .replace(/<t:(\d+):\w>/g, (_, s: string) => new Intl.DateTimeFormat(f.locale, { dateStyle: "long", timeStyle: "short" }).format(new Date(Number(s) * 1000)))
    .replace(/<@&(\d+)>/g, "@role")
    .replace(/<@!?(\d+)>/g, "@user");
  return (
    <div className="dc-text">
      {shown.split("\n").map((line, i) => {
        const h = /^(#{1,3})\s+(.*)$/.exec(line);
        if (h) return <div key={i} className={`dc-h${h[1].length}`}>{inline(h[2])}</div>;
        if (line.startsWith("-# ")) return <div key={i} className="dc-sub">{inline(line.slice(3))}</div>;
        return <div key={i}>{line ? inline(line).map((n, j) => (typeof n === "string" ? <Mentions key={j} text={n} /> : n)) : " "}</div>;
      })}
    </div>
  );
}

function Mentions({ text }: { text: string }) {
  const parts = text.split(/(@everyone|@here|@role|@user)/g);
  return (
    <>
      {parts.map((p, i) => (/^@(everyone|here|role|user)$/.test(p) ? <span key={i} className="dc-mention">{p}</span> : p))}
    </>
  );
}
