// Gate for hrefs built from backend or AI-agent data (EDGAR filing URLs,
// web-search results in turn transcripts). React 18 renders a `javascript:`
// href as-is, and with the refresh token in localStorage one injected script
// is a full account takeover -- so anything that isn't plain http(s) comes
// back undefined and renders as an inert, unlinked <a>.

/** `url` if it's an absolute http(s) URL, otherwise undefined. */
export function safeHref(url: string): string | undefined {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
