// Client for the Mode 3 journal endpoint: the sells/wins/kills/checkpoint
// thesis row for a tracked ticker. One row per (user, ticker), auto-created
// blank on first GET. Auth-required.

import { apiFetch, parseJsonOrThrow } from "./api";

export interface CompanyJournal {
  sells: string;
  wins: string;
  kills: string;
  checkpoint: string;
  checkpoint_date: string | null;
  updated_at: string;
}

export type JournalPatch = Partial<
  Pick<CompanyJournal, "sells" | "wins" | "kills" | "checkpoint" | "checkpoint_date">
>;

/** Auto-creates a blank row the first time it's fetched -- not an error. */
export async function getJournal(ticker: string): Promise<CompanyJournal> {
  const res = await apiFetch(`/companies/${encodeURIComponent(ticker)}/journal/`);
  return parseJsonOrThrow<CompanyJournal>(res);
}

/** Partial update -- omitted fields are left as-is. */
export async function updateJournal(ticker: string, patch: JournalPatch): Promise<CompanyJournal> {
  const res = await apiFetch(`/companies/${encodeURIComponent(ticker)}/journal/`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return parseJsonOrThrow<CompanyJournal>(res);
}
