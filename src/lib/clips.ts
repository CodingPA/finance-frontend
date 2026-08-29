// Client for the Mode 3 research-clip endpoints: paste-in filing excerpts,
// wiki snippets, news, etc. against a tracked ticker. Auth-required, and
// scoped to the logged-in user's own TrackedCompany row.

import { apiFetch, parseJsonOrThrow } from "./api";

export type ClipCategory =
  | "revenue_quality"
  | "profitability_path"
  | "catalyst"
  | "concentration"
  | "dilution"
  | "insider_activity"
  | "context";

export type ClipSourceType = "filing" | "news" | "wiki" | "press_release" | "reddit" | "other";

export const CLIP_CATEGORY_LABELS: Record<ClipCategory, string> = {
  revenue_quality: "Revenue quality",
  profitability_path: "Path to profitability",
  catalyst: "Catalyst",
  concentration: "Concentration",
  dilution: "Dilution",
  insider_activity: "Insider activity",
  context: "Context",
};

export const CLIP_SOURCE_TYPE_LABELS: Record<ClipSourceType, string> = {
  filing: "Filing",
  news: "News",
  wiki: "Wiki",
  press_release: "Press release",
  reddit: "Reddit",
  other: "Other",
};

export interface ResearchClip {
  id: number;
  category: ClipCategory;
  source_type: ClipSourceType;
  label: string;
  source: string;
  text: string;
  created_at: string;
}

export interface NewClip {
  label: string;
  text: string;
  category?: ClipCategory;
  source_type?: ClipSourceType;
  source?: string;
}

/** Every clip saved against this ticker, newest first. 404s if the user
 *  isn't tracking it yet. */
export async function listClips(ticker: string): Promise<ResearchClip[]> {
  const res = await apiFetch(`/companies/${encodeURIComponent(ticker)}/clips/`);
  return parseJsonOrThrow<ResearchClip[]>(res);
}

export async function createClip(ticker: string, clip: NewClip): Promise<ResearchClip> {
  const res = await apiFetch(`/companies/${encodeURIComponent(ticker)}/clips/`, {
    method: "POST",
    body: JSON.stringify(clip),
  });
  return parseJsonOrThrow<ResearchClip>(res);
}

/** No edit endpoint by design -- delete and re-`createClip` for corrections. */
export async function deleteClip(ticker: string, id: number): Promise<void> {
  const res = await apiFetch(`/companies/${encodeURIComponent(ticker)}/clips/${id}/`, {
    method: "DELETE",
  });
  await parseJsonOrThrow<void>(res);
}
