// AI-competitor cost budget display: a hard-cap bar (total_budget_usd, auto-
// pauses the competitor at 100% -- see budgetProgressPct's comment on why
// spend can render briefly over 100%, clamped rather than errored) and an
// advisory weekly pace bar (weekly_budget_usd, nothing enforced -- labeled
// "pace guide" so it doesn't read as a cutoff). Either bar is omitted
// entirely when its budget field is null (not configured), not shown as 0%.
// Renders nothing at all if neither budget is configured.

import { budgetProgressPct } from "../lib/league";
import { formatUsd } from "../lib/format";

export function BudgetBars({
  totalBudgetUsd,
  weeklyBudgetUsd,
  apiCostUsd,
  weekSpentUsd,
  todaySpentUsd,
}: {
  totalBudgetUsd?: string | null;
  weeklyBudgetUsd?: string | null;
  apiCostUsd?: string | null;
  weekSpentUsd?: string | null;
  todaySpentUsd?: string | null;
}) {
  const totalPct = budgetProgressPct(apiCostUsd, totalBudgetUsd);
  const weeklyPct = budgetProgressPct(weekSpentUsd, weeklyBudgetUsd);

  if (totalPct === null && weeklyPct === null && todaySpentUsd == null) return null;

  return (
    <div className="budget-bars">
      {totalPct !== null && (
        <div className="budget-bar">
          <div className="budget-bar-head">
            <span>Budget</span>
            <span className="text-muted">
              {formatUsd(Number(apiCostUsd))} / {formatUsd(Number(totalBudgetUsd))}
            </span>
          </div>
          <div className="budget-bar-track">
            <div
              className={`budget-bar-fill${totalPct >= 100 ? " budget-bar-fill-full" : ""}`}
              style={{ width: `${totalPct}%` }}
            />
          </div>
        </div>
      )}
      {weeklyPct !== null && (
        <div className="budget-bar">
          <div className="budget-bar-head">
            <span>Weekly pace guide</span>
            <span className="text-muted">
              {formatUsd(Number(weekSpentUsd))} / {formatUsd(Number(weeklyBudgetUsd))}
            </span>
          </div>
          <div className="budget-bar-track">
            <div className="budget-bar-fill budget-bar-fill-pace" style={{ width: `${weeklyPct}%` }} />
          </div>
        </div>
      )}
      {todaySpentUsd != null && (
        <div className="budget-bar-today">
          <span className="text-muted">Today</span> {formatUsd(Number(todaySpentUsd))}
        </div>
      )}
    </div>
  );
}
