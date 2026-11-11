import { formatDayMonth, formatRate } from "../lib/format";
import { chartGeometry } from "../lib/fx";

const PLOT = { width: 600, height: 160 } as const;

/**
 * One ECB rate over time: a single line, no legend needed. Axis labels are real text next to the
 * drawing (so they scale with the page), the picture itself is `aria-hidden` and the same
 * information is in the text alternative and, below the chart, in a table. Positions are integer
 * BigInt maths (lib/fx.ts), colours are tokens (both themes), and nothing animates.
 */
export function FxChart({
  currency,
  points,
}: {
  currency: string;
  points: readonly { rateDate: string; rate: string }[];
}) {
  const g = chartGeometry(points, PLOT);
  if (g.points.length === 0) return null;
  const show = (r: string) => formatRate(r, 4, 4);
  const dayOf = (p: { rateDate: string } | null) => (p ? formatDayMonth(p.rateDate) : "");
  const summary =
    `${currency} per 1 EUR over ${g.points.length} ECB publication days: ` +
    `from ${show(g.first?.rate ?? "")} on ${dayOf(g.first)} to ${show(g.last?.rate ?? "")} on ${dayOf(g.last)}. ` +
    `Lowest ${show(g.min)} on ${dayOf(g.lowest)}, highest ${show(g.max)} on ${dayOf(g.highest)}.`;
  return (
    <figure className="fx-chart">
      <div className="fx-chart-grid" role="img" aria-label={summary}>
        <span className="fx-ylab fx-ymax cap" aria-hidden="true">
          {show(g.max)}
        </span>
        <span className="fx-ylab fx-ymin cap" aria-hidden="true">
          {show(g.min)}
        </span>
        <svg
          className="fx-plot"
          viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <line className="fx-grid" x1="0" y1="0" x2={PLOT.width} y2="0" />
          <line className="fx-grid" x1="0" y1={PLOT.height} x2={PLOT.width} y2={PLOT.height} />
          <path className="fx-series" d={g.path} />
        </svg>
        <span className="fx-xlab fx-xfirst cap" aria-hidden="true">
          {dayOf(g.first)}
        </span>
        <span className="fx-xlab fx-xlast cap" aria-hidden="true">
          {dayOf(g.last)}
        </span>
      </div>
      <figcaption className="cap">
        {currency} per 1 EUR, one point per ECB publication day. Lowest {show(g.min)} on{" "}
        {dayOf(g.lowest)}, highest {show(g.max)} on {dayOf(g.highest)}, latest{" "}
        {show(g.last?.rate ?? "")} on {dayOf(g.last)}.
      </figcaption>
    </figure>
  );
}
