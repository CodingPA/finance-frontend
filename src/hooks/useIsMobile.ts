import { useEffect, useState } from "react";

// Single source of truth for the mobile breakpoint -- keep in sync with the
// max-width used for .bottom-nav / .page mobile rules in app.css.
const MOBILE_QUERY = "(max-width: 768px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
