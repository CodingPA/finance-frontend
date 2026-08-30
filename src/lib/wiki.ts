// Client for the wiki-monitoring endpoints (Phase 8, finance-backend/docs/roadmap.md): link a
// Wikipedia page to a tracked company, and a daily job rechecks it, keeping a
// `wiki`-sourced ResearchClip in sync when the content actually changes.
// Auth-required, scoped to the logged-in user's own TrackedCompany row.

import { apiFetch, parseJsonOrThrow } from "./api";

export interface WikiPage {
  id: number;
  page_title: string;
  label: string;
  last_checked_at: string | null;
  last_changed_at: string | null;
  created_at: string;
}

export interface NewWikiPage {
  page_title: string;
  label?: string;
}

/** Every page linked to this ticker. 404s if the user isn't tracking it yet. */
export async function listWikiPages(ticker: string): Promise<WikiPage[]> {
  const res = await apiFetch(`/companies/${encodeURIComponent(ticker)}/wiki/`);
  return parseJsonOrThrow<WikiPage[]>(res);
}

/** 201 with the new row, or 200 with the existing one if this page (by its
 *  resolved canonical title) was already linked -- idempotent either way, so
 *  callers that don't care about "was this new" can just use the row. */
export async function linkWikiPage(ticker: string, page: NewWikiPage): Promise<WikiPage> {
  const res = await apiFetch(`/companies/${encodeURIComponent(ticker)}/wiki/`, {
    method: "POST",
    body: JSON.stringify(page),
  });
  return parseJsonOrThrow<WikiPage>(res);
}

/** Stops future daily checks and removes the page's clips from search. */
export async function unlinkWikiPage(ticker: string, id: number): Promise<void> {
  const res = await apiFetch(`/companies/${encodeURIComponent(ticker)}/wiki/${id}/`, {
    method: "DELETE",
  });
  await parseJsonOrThrow<void>(res);
}
