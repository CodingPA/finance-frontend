// Client for the media-ingestion endpoints: upload an .mp3/.mp4, it's
// transcribed (with diarization) in the background, and once "ready" its
// content is automatically searchable by the assistant (search_media_transcripts
// tool) -- nothing else to wire up for that part. Progress arrives over the
// same realtime socket as everything else, as media.progress / media.complete
// / media.failed, tagged with media_file_id (see lib/ws.ts).

import { apiFetch, parseJsonOrThrow, ApiError } from "./api";

export type MediaStatus = "uploaded" | "downloading" | "extracting_audio" | "transcribing" | "ready" | "failed";

export interface MediaFile {
  id: number;
  original_filename: string;
  media_type: string;
  ticker: string | null;
  duration_seconds: number | null;
  status: MediaStatus;
  error_message: string | null;
}

/** The user's uploads, newest first. */
export async function listMediaFiles(): Promise<MediaFile[]> {
  const res = await apiFetch("/media/");
  return parseJsonOrThrow<MediaFile[]>(res);
}

/** Only .mp3/.mp4 accepted -- anything else 400s. Comes back fast (just the
 *  S3 write); processing happens after, tracked over the socket. */
export async function uploadMedia(file: File, ticker?: string): Promise<MediaFile> {
  const form = new FormData();
  form.append("file", file);
  if (ticker) form.append("ticker", ticker);
  const res = await apiFetch("/media/", { method: "POST", body: form });
  return parseJsonOrThrow<MediaFile>(res);
}

/** Removes the file, its transcript, and its search index entries. */
export async function deleteMediaFile(id: number): Promise<void> {
  const res = await apiFetch(`/media/${id}/`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body);
  }
}
