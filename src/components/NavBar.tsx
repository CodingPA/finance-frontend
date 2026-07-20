import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function NavBar() {
  const { user, status, logout } = useAuth();
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
