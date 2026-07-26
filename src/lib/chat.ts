// Client for the Phase 6 semantic-search endpoints over ResearchClip text
// (embeddings + Weaviate). Always scoped server-side to the requesting
// user's own clips, regardless of ticker.

import { apiFetch, parseJsonOrThrow } from "./api";
import type { ClipCategory, ClipSourceType } from "./clips";

export interface ClipSearchResult {
  id: number;
  category: ClipCategory;
  source_type: ClipSourceType;
  label: string;
  source: string;
  text: string;
  created_at: string;
  ticker: string;
  /** Cosine distance -- lower is closer. */
  distance: number;
}

/** Nearest-match search across a tracked ticker's clips, or every tracked
 *  company's clips when `ticker` is omitted. 404s if `ticker` is given and
 *  isn't tracked; 503 if the backend has no OPENAI_API_KEY configured. */
export async function searchClips(q: string, ticker?: string, limit?: number): Promise<ClipSearchResult[]> {
  const params = new URLSearchParams({ q });
  if (limit !== undefined) params.set("limit", String(limit));

  const path = ticker
    ? `/companies/${encodeURIComponent(ticker)}/clips/search/?${params.toString()}`
    : `/companies/clips/search/?${params.toString()}`;

  const res = await apiFetch(path);
  return parseJsonOrThrow<ClipSearchResult[]>(res);
}
