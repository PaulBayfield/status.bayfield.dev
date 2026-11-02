// Response time over a range: one series (a 2px line over a light area), failures as a strip
// along the baseline, a crosshair and tooltip on hover. One axis, recessive grid.

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { Series } from "../lib/api";
import { useSettings } from "../lib/settings";
import { ms } from "./status";

const H = 220;
const PAD = { top: 12, right: 12, bottom: 26, left: 48 };
const STRIP = 6;

/** Round tick steps: 1, 2, 5 × 10ⁿ. */
function niceStep(max: number, count: number) {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
}

export function LatencyChart({ series, range }: { series: Series; range: "24h" | "7d" | "30d" }) {
  const { t, f } = useSettings();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const from = new Date(series.from).getTime();
  const to = new Date(series.to).getTime();
  const points = series.points.map((p) => ({ ...p, time: new Date(p.t).getTime() }));
  const values = points.map((p) => p.avg).filter((v): v is number => v !== null);
  const step = niceStep(Math.max(...values, 10), 3);
  const yMax = Math.ceil(Math.max(...values, 10) / step) * step;
  const iw = Math.max(10, width - PAD.left - PAD.right);
  const ih = H - PAD.top - PAD.bottom - STRIP - 4;
  const x = (time: number) => PAD.left + ((time - from) / (to - from)) * iw;
  const y = (v: number) => PAD.top + ih - (v / yMax) * ih;

  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(f.locale, range === "24h" ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" }),
    [f.locale, range],
  );
  const tipFmt = useMemo(() => new Intl.DateTimeFormat(f.locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }), [f.locale]);

  // The line breaks over gaps (no checks), rather than drawing across them.
  const segments: string[] = [];
  const dots: { x: number; y: number }[] = [];
  const areas: string[] = [];
  let run: { x: number; y: number }[] = [];
  const flush = () => {
    if (run.length === 1) dots.push(run[0]);
    else if (run.length) {
      segments.push(run.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(""));
      const base = (PAD.top + ih).toFixed(1);
      areas.push(`M${run[0].x.toFixed(1)},${base}${run.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("")}L${run[run.length - 1].x.toFixed(1)},${base}Z`);
    }
    run = [];
  };
  points.forEach((p, i) => {
    const prev = points[i - 1];
    if (prev && p.time - prev.time > series.bucketMs * 1.5) flush();
    if (p.avg !== null) run.push({ x: x(p.time + series.bucketMs / 2), y: y(p.avg) });
    else flush();
  });
  flush();

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
        {areas.map((d, i) => (
          <path key={i} className="area" d={d} />
        ))}
        {segments.map((d, i) => (
          <path key={i} className="line" d={d} />
        ))}
        {dots.map((p) => (
          <circle key={`${p.x}`} className="dot" cx={p.x} cy={p.y} r={3} />
        ))}
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
            {hp.avg !== null && <circle className="marker" cx={x(hp.time + series.bucketMs / 2)} cy={y(hp.avg)} r={4} />}
          </g>
        )}
      </svg>
      {hp && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(x(hp.time + series.bucketMs / 2), 90), width - 90) }}>
          <strong>{tipFmt.format(hp.time)}</strong>
          <span>
            {t("average")} <b>{ms(hp.avg)}</b>
          </span>
          <span>
            {t("slowest")} <b>{ms(hp.max)}</b>
          </span>
          {hp.down > 0 && <span className="tip-state d-down">{t("failedChecks", { n: hp.down })}</span>}
          {hp.degraded > 0 && <span className="tip-state d-partial">{t("slowChecks", { n: hp.degraded })}</span>}
          <span className="muted">{t("checksCount", { n: hp.n })}</span>
        </div>
      )}
    </div>
  );
}
