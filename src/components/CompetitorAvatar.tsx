// Small circular identity chip for a competitor -- their seeded/chosen
// color as the background, avatar emoji on top. Both fields are freeform
// and optional (league.ts's competitorColor()/competitorAvatar() supply the
// neutral fallback for a competitor that never set one), so this is the one
// place that fallback is applied for display.

import { competitorAvatar, competitorColor } from "../lib/league";

export function CompetitorAvatar({
  color,
  avatar,
  size = 22,
}: {
  color?: string;
  avatar?: string;
  size?: number;
}) {
  return (
    <span
      className="competitor-avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.6),
        background: competitorColor(color),
        verticalAlign: "middle",
      }}
    >
      {competitorAvatar(avatar)}
    </span>
  );
}
