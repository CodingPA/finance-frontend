import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useRealtimeStatus } from "../hooks/useRealtimeStatus";
import { NotificationBell } from "./NotificationBell";

const REALTIME_LABEL = {
  idle: "Offline",
  connecting: "Connecting…",
  open: "Live",
  closed: "Reconnecting…",
} as const;

export function NavBar() {
  const { user, status, logout } = useAuth();
  const wsStatus = useRealtimeStatus();
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
          <Link to="/screen">Screener</Link>
          <span className={`tag ${wsStatus === "open" ? "tag-accent" : "tag-neutral"}`} title="Realtime connection">
            {REALTIME_LABEL[wsStatus]}
          </span>
          <NotificationBell />
          <span className="text-muted">{user.name || user.email}</span>
          <button type="button" className="btn btn-secondary" onClick={handleLogout}>
            Log out
          </button>
        </>
      ) : (
        <Link to="/login">Sign in</Link>
      )}
    </nav>
  );
}
