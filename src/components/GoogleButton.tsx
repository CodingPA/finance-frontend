import { useEffect, useRef, useState } from "react";

// Minimal typing for the slice of Google Identity Services we use.
interface GoogleIdCredentialResponse {
  credential: string;
}
interface GoogleAccountsId {
  initialize: (config: { client_id: string; callback: (response: GoogleIdCredentialResponse) => void }) => void;
  renderButton: (parent: HTMLElement, options: { theme: string; size: string; width?: number }) => void;
}
declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const SCRIPT_SRC = "https://accounts.google.com/gsi/client";

function loadGsiScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
  if (existing) {
    return new Promise((resolve) => existing.addEventListener("load", () => resolve()));
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(script);
  });
}

/**
 * Renders Google's own sign-in button. Hidden entirely when
 * VITE_GOOGLE_CLIENT_ID isn't set (unconfigured in dev by default — see
 * README) rather than rendering a button that would only fail.
 */
export function GoogleButton({ onIdToken, onError }: { onIdToken: (idToken: string) => void; onError: (message: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!CLIENT_ID || !containerRef.current) return;
    let cancelled = false;

    loadGsiScript()
      .then(() => {
        if (cancelled || !window.google || !containerRef.current) return;
        window.google.accounts.id.initialize({
          client_id: CLIENT_ID,
          callback: (response) => onIdToken(response.credential),
        });
        window.google.accounts.id.renderButton(containerRef.current, {
          theme: "outline",
          size: "large",
          width: 352,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          onError("Google sign-in isn't working right now.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [onIdToken, onError]);

  if (!CLIENT_ID || failed) return null;
  return <div ref={containerRef} />;
}
