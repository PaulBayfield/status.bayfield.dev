// Response time over a range: the mean as a 2px line, the min–max spread of each time bucket as a
// light band behind it, failures as a strip along the baseline, and a crosshair with a tooltip
// (min, mean, max) on hover. The legend toggles the line and the band. One axis, recessive grid.

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { Series } from "../lib/api";
import { useSettings } from "../lib/settings";
import { ms } from "./status";

const PAD = { top: 12, right: 12, bottom: 26, left: 48 };
const STRIP = 6;

/** Round tick steps: 1, 2, 5 × 10ⁿ. */
function niceStep(max: number, count: number) {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
}

type Pt = { x: number; mean: number; min: number; max: number };

export function LatencyChart({ series, range, height = 220 }: { series: Series; range: "24h" | "7d" | "30d"; height?: number }) {
  const { t, f } = useSettings();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const [show, setShow] = useState({ mean: true, band: true });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const H = height;
  const from = new Date(series.from).getTime();
  const to = new Date(series.to).getTime();
  const points = series.points.map((p) => ({ ...p, time: new Date(p.t).getTime() }));
  // The scale follows what's shown: the slowest check with the band, the slowest mean without.
  const values = points.flatMap((p) => (show.band ? [p.max, p.avg] : [p.avg])).filter((v): v is number => v !== null);
  const top = Math.max(...values, 10);
  const step = niceStep(top, 3);
  const yMax = Math.ceil(top / step) * step;
  const iw = Math.max(10, width - PAD.left - PAD.right);
  const ih = H - PAD.top - PAD.bottom - STRIP - 4;
  const x = (time: number) => PAD.left + ((time - from) / (to - from)) * iw;
  const y = (v: number) => PAD.top + ih - (Math.min(v, yMax) / yMax) * ih;

  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(f.locale, range === "24h" ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" }),
    [f.locale, range],
  );
  const tipFmt = useMemo(() => new Intl.DateTimeFormat(f.locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }), [f.locale]);

  // Runs of consecutive buckets with checks: the line and the band break over gaps.
  const runs: Pt[][] = [];
  let run: Pt[] = [];
  points.forEach((p, i) => {
    const prev = points[i - 1];
    if (prev && p.time - prev.time > series.bucketMs * 1.5 && run.length) {
      runs.push(run);
      run = [];
    }
    if (p.avg !== null) run.push({ x: x(p.time + series.bucketMs / 2), mean: y(p.avg), min: y(p.min ?? p.avg), max: y(p.max ?? p.avg) });
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  });
  if (run.length) runs.push(run);

  const line = (r: Pt[], k: "mean" | "min" | "max") => r.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p[k].toFixed(1)}`).join("");
  // A single bucket gets a little width so its band still shows.
  const band = (r: Pt[]) => {
    const pts = r.length === 1 ? [{ ...r[0], x: r[0].x - 3 }, { ...r[0], x: r[0].x + 3 }] : r;
    return `${line(pts, "max")}${[...pts].reverse().map((p) => `L${p.x.toFixed(1)},${p.min.toFixed(1)}`).join("")}Z`;
  };

  const ticks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step);
  const xTicks = Array.from({ length: 5 }, (_, i) => from + ((to - from) * i) / 4);
  const hp = hover !== null ? points[hover] : null;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const time = from + ((e.clientX - rect.left - PAD.left) / iw) * (to - from);
    let best: number | null = null;
    let dist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(p.time + series.bucketMs / 2 - time);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    setHover(dist < series.bucketMs * 3 ? best : null);
  };

  if (!points.length) return <div className="chart-empty muted">{t("noChecksYet")}</div>;

  return (
    <div className="latency-chart" ref={box}>
      <div className="chart-legend" role="group" aria-label={t("chartLayers")}>
        <button type="button" className={`legend-item${show.mean ? "" : " off"}`} aria-pressed={show.mean} onClick={() => setShow((s) => ({ ...s, mean: !s.mean || !s.band }))}>
          <span className="legend-line" />
          {t("chartMean")}
        </button>
        <button type="button" className={`legend-item${show.band ? "" : " off"}`} aria-pressed={show.band} onClick={() => setShow((s) => ({ ...s, band: !s.band || !s.mean }))}>
          <span className="legend-band" />
          {t("chartRange")}
        </button>
      </div>
      <svg width={width} height={H} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={t("responseTime")}>
        {ticks.map((v) => (
          <g key={v}>
            <line className="grid" x1={PAD.left} x2={PAD.left + iw} y1={y(v)} y2={y(v)} />
            <text className="axis" x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
              {ms(v)}
            </text>
          </g>
        ))}
        {xTicks.map((time, i) => (
          <text key={time} className="axis" x={x(time)} y={H - 6} textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}>
            {timeFmt.format(time)}
          </text>
        ))}
        {show.band && runs.map((r, i) => <path key={`b${i}`} className="band" d={band(r)} />)}
        {show.mean &&
          runs.map((r, i) =>
            r.length === 1 ? <circle key={`d${i}`} className="dot" cx={r[0].x} cy={r[0].mean} r={3} /> : <path key={`l${i}`} className="line" d={line(r, "mean")} />,
          )}
        {/* Failures and slow checks, along the baseline. */}
        {points
          .filter((p) => p.down || p.degraded)
          .map((p) => (
            <rect
              key={p.t}
              className={p.down ? "strip down" : "strip degraded"}
              x={x(p.time)}
              y={PAD.top + ih + 4}
              width={Math.max(2, x(p.time + series.bucketMs) - x(p.time) - 1)}
              height={STRIP}
              rx={1}
            />
          ))}
        {hp && (
          <g>
            <line className="crosshair" x1={x(hp.time + series.bucketMs / 2)} x2={x(hp.time + series.bucketMs / 2)} y1={PAD.top} y2={PAD.top + ih} />
            {hp.avg !== null && show.mean && <circle className="marker" cx={x(hp.time + series.bucketMs / 2)} cy={y(hp.avg)} r={4} />}
          </g>
        )}
      </svg>
      {hp && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(x(hp.time + series.bucketMs / 2), 90), width - 90) }}>
          <strong>{tipFmt.format(hp.time)}</strong>
          <span className="tip-row">
            {t("chartMin")} <b>{ms(hp.min)}</b>
          </span>
          <span className="tip-row">
            {t("chartMean")} <b>{ms(hp.avg)}</b>
          </span>
          <span className="tip-row">
            {t("chartMax")} <b>{ms(hp.max)}</b>
          </span>
          {hp.down > 0 && <span className="tip-state d-down">{t("failedChecks", { n: hp.down })}</span>}
          {hp.degraded > 0 && <span className="tip-state d-partial">{t("slowChecks", { n: hp.degraded })}</span>}
          <span className="muted">{t("checksCount", { n: hp.n })}</span>
        </div>
      )}
    </div>
  );
}
