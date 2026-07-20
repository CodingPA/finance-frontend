import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { GoogleButton } from "../components/GoogleButton";
import { extractFieldErrors, extractGenericMessage, type FieldErrors } from "../lib/formErrors";

export function RegisterPage() {
  const { register, loginWithGoogle } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      await register(email, password, name || undefined);
      navigate("/");
    } catch (err) {
      const fields = extractFieldErrors(err);
      if (Object.keys(fields).length > 0) {
        setFieldErrors(fields);
      } else {
        setError(extractGenericMessage(err, "Something went wrong. Try again."));
      }
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
        <h3 className="card-title">Create an account</h3>

        <form className="stack" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" className="input" type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
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
            {fieldErrors.email?.map((msg) => (
              <p className="form-error" key={msg}>
                {msg}
              </p>
            ))}
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {fieldErrors.password?.map((msg) => (
              <p className="form-error" key={msg}>
                {msg}
              </p>
            ))}
          </div>
          {error && <p className="form-error">{error}</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? "Creating account…" : "Create account"}
          </button>
        </form>

        <GoogleButton onIdToken={handleGoogleToken} onError={setError} />

        <hr className="hr" />
        <p className="form-note">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
