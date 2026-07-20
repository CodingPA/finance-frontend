import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { GoogleButton } from "../components/GoogleButton";
import { ApiError } from "../lib/api";

export function LoginPage() {
  const { login, loginWithGoogle } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err) {
      // Login 401s don't distinguish "no such user" from "wrong password" —
      // the API doc says not to try to, so this message stays generic.
      const message = err instanceof ApiError ? "Invalid email or password." : "Something went wrong. Try again.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleToken = async (idToken: string) => {
    setError(null);
    try {
      await loginWithGoogle(idToken);
      navigate("/");
    } catch {
      setError("Google sign-in isn't working right now.");
    }
  };

  return (
    <div className="auth-page">
      <div className="card auth-card elev-sm">
        <div className="card-kicker">The Lab</div>
        <h3 className="card-title">Sign in</h3>

        <form className="stack" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <p className="form-error">{error}</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <GoogleButton onIdToken={handleGoogleToken} onError={setError} />

        <hr className="hr" />
        <p className="form-note">
          Don't have an account? <Link to="/register">Create one</Link>
        </p>
      </div>
    </div>
  );
}
