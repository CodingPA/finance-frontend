import { ApiError } from "./api";

/** Field-name -> message-list shape the backend returns for 400s. */
export type FieldErrors = Record<string, string[]>;

export function extractFieldErrors(err: unknown): FieldErrors {
  if (err instanceof ApiError && err.status === 400 && err.body && typeof err.body === "object") {
    return err.body as FieldErrors;
  }
  return {};
}

export function extractGenericMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 400) return fallback;
    return err.message || fallback;
  }
  return fallback;
}
