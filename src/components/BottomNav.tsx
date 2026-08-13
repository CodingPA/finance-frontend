// App-like bottom tab bar, shown instead of the top NavBar's links on
// mobile (see useIsMobile). Only renders for authenticated users -- signed
// out visitors only ever see the login/register pages, which have nothing
// to navigate between.

import { NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const TABS = [
  {
    to: "/",
    label: "Home",
    icon: (
      <path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1v-7.5Z" />
    ),
  },
  {
    to: "/screen",
    label: "Screener",
    icon: <path d="m20 20-3.5-3.5M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z" />,
  },
  {
    to: "/league",
    label: "League",
    icon: <path d="M7 21h10M12 17v4M6 4h12v3a6 6 0 0 1-12 0V4ZM6 5H3v2a3 3 0 0 0 3 3M18 5h3v2a3 3 0 0 1-3 3" />,
  },
];

export function BottomNav() {
  const { user, status } = useAuth();
  if (status !== "authenticated" || !user) return null;

  return (
    <nav className="bottom-nav">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.to === "/"}
          className={({ isActive }) => `bottom-nav-tab${isActive ? " is-active" : ""}`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            {tab.icon}
          </svg>
          <span>{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
