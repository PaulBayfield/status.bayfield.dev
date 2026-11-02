// Status pieces shared by every page: the pill, the dot, and the 90-day uptime bars.
// Status colours always come with a label or a tooltip, never colour alone.

import { useMemo, useRef, useState, type CSSProperties } from "react";
import type { HistoryDay, Status } from "../lib/api";
import type { StringKey } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { AlertTriangle, CircleCheck, CircleDashed, CirclePause, CircleX } from "./icons";

export const statusKey = (s: Status): StringKey => `status_${s}`;

export function StatusIcon({ status, size = 14 }: { status: Status; size?: number }) {
  if (status === "up") return <CircleCheck size={size} />;
  if (status === "down") return <CircleX size={size} />;
  if (status === "degraded") return <AlertTriangle size={size} />;
  if (status === "paused") return <CirclePause size={size} />;
  return <CircleDashed size={size} />;
}

export function StatusPill({ status, large }: { status: Status; large?: boolean }) {
  const { t } = useSettings();
  return (
    <span className={`status-pill s-${status}${large ? " large" : ""}`}>
      <StatusIcon status={status} size={large ? 14 : 12} />
      {t(statusKey(status))}
    </span>
  );
}

/** A dot that pulses while down; its label is the title (and the row next to it). */
export function StatusDot({ status }: { status: Status }) {
  const { t } = useSettings();
  return <span className={`status-dot s-${status}`} title={t(statusKey(status))} role="img" aria-label={t(statusKey(status))} />;
}

/** 99.95%, 100%, 87.3% — enough digits to tell "a few minutes" from "none". */
export function pct(ratio: number | null, f: { locale: string }): string {
  if (ratio === null) return "—";
  const v = ratio * 100;
  const digits = v === 100 || v === 0 ? 0 : v >= 99 ? 2 : 1;
  return `${new Intl.NumberFormat(f.locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.floor(v * 10 ** digits) / 10 ** digits)}%`;
}

export const ms = (n: number | null) => (n === null ? "—" : n >= 10_000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);

type DayState = "none" | "up" | "partial" | "down";

/** A day's colour: red when over 5% of checks failed, amber for any failure or slowness. */
export function dayState(d: HistoryDay | undefined): DayState {
  if (!d || !d[1]) return "none";
  const [, total, down, degraded] = d;
  if (down / total > 0.05) return "down";
  if (down || degraded) return "partial";
  return "up";
}

/** The last `days` UTC days, oldest first, with their history (or undefined). */
function lastDays(history: readonly HistoryDay[], days: number): { day: string; d: HistoryDay | undefined }[] {
  const byDay = new Map(history.map((h) => [h[0], h]));
  const out = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, d: byDay.get(day) });
  }
  return out;
}

/** Where the tooltip goes: centred on the bar, kept inside the scrolling area, and below
 *  the bars when there's no room above (the first row of a page). */
function tipPlace(el: HTMLElement | null, i: number | null, days: number): { left: number | string; below: boolean } {
  if (!el || i === null) return { left: 0, below: false };
  const box = el.getBoundingClientRect();
  const area = (el.closest(".content") ?? document.documentElement).getBoundingClientRect();
  const half = 90; // about half the tooltip's width
  const x = box.left + ((i + 0.5) / days) * box.width;
  const clamped = Math.min(Math.max(x, area.left + half + 8), area.right - half - 8);
  return { left: clamped - box.left, below: box.top - area.top < 90 };
}

/** Uptime bars: one per day, hover for the day's numbers. */
export function UptimeBars({ history, days = 90, compact }: { history: readonly HistoryDay[]; days?: number; compact?: boolean }) {
  const { t, f } = useSettings();
  const list = useMemo(() => lastDays(history, days), [history, days]);
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const tip = hover !== null ? list[hover] : null;
  const place = useMemo(() => tipPlace(ref.current, hover, days), [hover, days]);
  const dateFmt = useMemo(() => new Intl.DateTimeFormat(f.locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }), [f.locale]);

  return (
    <div className={`uptime-bars${compact ? " compact" : ""}`} ref={ref} onPointerLeave={() => setHover(null)}>
      <div className="uptime-bars-row" style={{ "--n": days } as CSSProperties}>
        {list.map(({ day, d }, i) => (
          <span key={day} className={`uptime-bar d-${dayState(d)}${hover === i ? " hover" : ""}`} onPointerEnter={() => setHover(i)} />
        ))}
      </div>
      {tip && (
        <div className={`uptime-tip${place.below ? " below" : ""}`} style={{ left: place.left }} role="tooltip">
          <strong>{dateFmt.format(new Date(`${tip.day}T00:00:00Z`))}</strong>
          {tip.d && tip.d[1] ? (
            <>
              <span className={`tip-state d-${dayState(tip.d)}`}>
                {pct((tip.d[1] - tip.d[2]) / tip.d[1], f)} {t("uptimeWord")}
              </span>
              <span className="muted">
                {tip.d[2] ? t("failedChecks", { n: f.number(tip.d[2]) }) : t("noFailures")}
                {tip.d[3] ? ` · ${t("slowChecks", { n: f.number(tip.d[3]) })}` : ""}
              </span>
            </>
          ) : (
            <span className="muted">{t("noData")}</span>
          )}
        </div>
      )}
      {!compact && (
        <div className="uptime-bars-legend">
          <span>{t("daysAgo", { n: days })}</span>
          <span>{t("today")}</span>
        </div>
      )}
    </div>
  );
}
