import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useRealtimeStatus } from "../hooks/useRealtimeStatus";
import { useIsMobile } from "../hooks/useIsMobile";
import { NotificationBell } from "./NotificationBell";
import { ThemeToggle } from "./ThemeToggle";

const REALTIME_LABEL = {
  idle: "Offline",
  connecting: "Connecting…",
  open: "Live",
  closed: "Reconnecting…",
} as const;

export function NavBar() {
  const { user, status, logout } = useAuth();
  const wsStatus = useRealtimeStatus();
  const isMobile = useIsMobile();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  return (
    <nav className="nav">
      <Link to="/" className="nav-brand">
        The Lab
      </Link>
      {status === "authenticated" && user ? (
        <>
          {!isMobile && (
            <>
              <Link to="/screen">Screener</Link>
              <Link to="/league">League</Link>
              <span className={`tag ${wsStatus === "open" ? "tag-accent" : "tag-neutral"}`} title="Realtime connection">
                {REALTIME_LABEL[wsStatus]}
              </span>
              <span className="text-muted">{user.name || user.email}</span>
            </>
          )}
          <NotificationBell />
          <ThemeToggle />
          <button type="button" className="btn btn-secondary" onClick={handleLogout}>
            Log out
          </button>
        </>
      ) : (
        <>
          <ThemeToggle />
          <Link to="/login">Sign in</Link>
        </>
      )}
    </nav>
  );
}
