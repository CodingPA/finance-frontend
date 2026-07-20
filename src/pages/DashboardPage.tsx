import { useAuth } from "../context/AuthContext";

export function DashboardPage() {
  const { user } = useAuth();

  return (
    <div className="page">
      <h2>Welcome{user?.name ? `, ${user.name}` : ""}.</h2>
      <p className="text-muted">Signed in as {user?.email}. This is where The Lab gets built.</p>
    </div>
  );
}
