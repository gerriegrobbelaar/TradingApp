import { useDivision } from "../division";

/**
 * Administration switcher for the top nav. A native select: keyboard operable and announced
 * correctly everywhere, and the phone browser's own picker is used at small widths. With a single
 * administration it is a plain label; with none (not connected yet) it renders nothing.
 */
export function DivisionSwitcher() {
  const { status, divisions, selected, select } = useDivision();
  if (status !== "ready" || divisions.length === 0 || selected === null) return null;
  if (divisions.length === 1) {
    return (
      <div className="division-switch">
        <span className="division-label">
          <span className="sr-only">Administration: </span>
          {selected.name}
        </span>
      </div>
    );
  }
  return (
    <div className="division-switch">
      <label className="sr-only" htmlFor="division-select">
        Administration
      </label>
      <select
        id="division-select"
        className="input"
        value={selected.id}
        onChange={(e) => void select(Number(e.target.value))}
      >
        {divisions.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    </div>
  );
}
