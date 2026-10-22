import { useRef, useState } from "react";

/** 单调三次插值（Fritsch–Carlson）：曲线平滑且不会冲到 0 以下或越过相邻点的高度。 */
function smoothPath(points: [number, number][]) {
  if (points.length < 2) return points.length ? `M${points[0][0]},${points[0][1]}` : "";
  const n = points.length, slopes: number[] = [], tangents: number[] = [];
  for (let i = 0; i < n - 1; i++) slopes.push((points[i + 1][1] - points[i][1]) / (points[i + 1][0] - points[i][0]));
  tangents.push(slopes[0]);
  for (let i = 1; i < n - 1; i++) tangents.push(slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2);
  tangents.push(slopes[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) { tangents[i] = tangents[i + 1] = 0; continue; }
    const a = tangents[i] / slopes[i], b = tangents[i + 1] / slopes[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); tangents[i] = t * a * slopes[i]; tangents[i + 1] = t * b * slopes[i]; }
  }
  let path = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i], [x1, y1] = points[i + 1], dx = (x1 - x0) / 3;
    path += ` C${x0 + dx},${y0 + tangents[i] * dx} ${x1 - dx},${y1 - tangents[i + 1] * dx} ${x1},${y1}`;
  }
  return path;
}

/** 坐标轴上限取 1／2／5×10ⁿ 的整齐值，刻度数字好读。 */
function niceMax(value: number) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value)), unit = value / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

const CHART_W = 1000, CHART_H = 200;

type CurvePoint = { id: string | number; tick: string; values: number[]; description: string };

/** 共用的用量曲线：鼠标、触屏与键盘使用相同的时段选择逻辑。 */
export function CurveChart({ points, label, selectionLabel, formatValue, colors = ["var(--accent)"] }: {
  points: CurvePoint[]; label: string; selectionLabel: string; formatValue: (value: number) => string; colors?: string[];
}) {
  const [selected, setSelected] = useState<string | number | null>(null);
  const plot = useRef<HTMLDivElement>(null);
  if (!points.length) return null;
  const max = niceMax(Math.max(...points.flatMap(point => point.values)));
  const x = (index: number) => points.length === 1 ? CHART_W / 2 : index / (points.length - 1) * CHART_W;
  const y = (value: number) => CHART_H - value / max * CHART_H;
  const found = points.findIndex(point => point.id === selected);
  const index = found < 0 ? points.length - 1 : found, current = points[index];
  // 固定间隔最多约 7 个刻度，保留最后一个并避免末尾标签挤在一起。
  const last = points.length - 1, step = Math.max(1, Math.ceil(last / 6));
  const ticks = Array.from({ length: Math.floor(last / step) + 1 }, (_, i) => i * step);
  if (ticks.at(-1) !== last) { if (last - ticks.at(-1)! < step * 0.6 && ticks.length > 1) ticks.pop(); ticks.push(last); }
  const pick = (clientX: number) => {
    const box = plot.current?.getBoundingClientRect();
    if (!box || !box.width) return;
    const target = Math.max(0, Math.min(last, Math.round((clientX - box.left) / box.width * last)));
    setSelected(points[target].id);
  };
  return <div className="usage-curve" aria-label={label}>
    <div className="usage-curve-body">
      <div className="usage-curve-axis" aria-hidden="true"><span>{formatValue(max)}</span><span>{formatValue(max / 2)}</span><span>{formatValue(0)}</span></div>
      <div className="usage-curve-plot" ref={plot} tabIndex={0} role="slider" aria-label={selectionLabel} aria-valuemin={0} aria-valuemax={last} aria-valuenow={index}
        aria-valuetext={current.description}
        onPointerMove={event => pick(event.clientX)} onPointerDown={event => pick(event.clientX)} onPointerLeave={() => setSelected(null)}
        onKeyDown={event => {
          const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
          if (event.key === "Home" || event.key === "End") { event.preventDefault(); setSelected(points[event.key === "Home" ? 0 : last].id); }
          else if (step) { event.preventDefault(); setSelected(points[Math.max(0, Math.min(last, index + step))].id); }
        }}>
        <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" aria-hidden="true">
          {[0, 0.5, 1].map(ratio => <line key={ratio} className="usage-curve-grid" x1={0} x2={CHART_W} y1={CHART_H * ratio} y2={CHART_H * ratio} vectorEffect="non-scaling-stroke" />)}
          {colors.map((color, series) => {
            const line = smoothPath(points.map((point, i) => [x(i), y(point.values[series] ?? 0)]));
            const area = `${line} L${x(last)},${CHART_H} L${x(0)},${CHART_H} Z`;
            return <g key={series} style={{ color }}>
              <path className="usage-curve-area" d={area} />
              <path className="usage-curve-line" d={line} vectorEffect="non-scaling-stroke" />
            </g>;
          })}
          <line className="usage-curve-guide" x1={x(index)} x2={x(index)} y1={0} y2={CHART_H} vectorEffect="non-scaling-stroke" />
        </svg>
        {colors.map((color, series) => <span className="usage-curve-dot" key={series} style={{ color, left: `${x(index) / CHART_W * 100}%`, top: `${y(current.values[series] ?? 0) / CHART_H * 100}%` }} aria-hidden="true" />)}
      </div>
    </div>
    <div className="usage-curve-ticks" aria-hidden="true">
      {ticks.map(tick => <span key={points[tick].id} style={{ left: `${x(tick) / CHART_W * 100}%` }}>{points[tick].tick}</span>)}
    </div>
    <p className="traffic-readout">{current.description}</p>
  </div>;
}
