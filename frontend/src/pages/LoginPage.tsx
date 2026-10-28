import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { postLoginPath } from '../landing';
import { ErrorNote, Icon } from '../ui';

export function LoginPage() {
  const { user, loading, login, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [endedPrevious, setEndedPrevious] = useState(false);
  const [endingSession, setEndingSession] = useState(false);
  const checkedExisting = useRef(false);

  // Opening the login page always ends any existing session so credentials are
  // required; an active session must never be continued with one click.
  useEffect(() => {
    if (loading || checkedExisting.current) return;
    checkedExisting.current = true;
    if (!user) return;
    setEndedPrevious(true);
    setEndingSession(true);
    void logout().finally(() => setEndingSession(false));
  }, [loading, user, logout]);

  return (
    <div className="login-shell">
      <section className="login-hero">
        <div className="login-brand">
          <span className="brand-mark large">A</span>
          <div>
            <strong>AARADHYA</strong>
            <span>SMART WMS</span>
          </div>
        </div>
        <div className="login-hero-copy">
          <div className="eyebrow light">Aaradhya Homeopathic Pvt. Ltd.</div>
          <h1>Every unit accounted for, from receipt to return.</h1>
          <p>
            One authoritative inventory ledger for single and mixed boxes, batch and expiry control,
            and a complete audit trail behind every movement.
          </p>
          <ul className="login-points">
            <li>
              <Icon name="check" size={16} /> Backend-validated stock movements with reversal lineage
            </li>
            <li>
              <Icon name="check" size={16} /> Mixed-box isolation, scanning and concurrent-safe deductions
            </li>
            <li>
              <Icon name="check" size={16} /> Immutable audit events tied to user, device and reference
            </li>
          </ul>
        </div>
        <div className="login-footnote">Warehouse WH1 · Asia/Kolkata · Session lifetime 12 hours</div>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <div className="eyebrow">Sign in</div>
          <h2>Warehouse operations</h2>
          <p className="login-sub">
            {endedPrevious
              ? 'The previous session was signed out. Enter your credentials to continue.'
              : 'Use the credentials issued by your system administrator.'}
          </p>

          {error ? <ErrorNote error={error.message} /> : null}

          <form
            className="login-form"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const signedIn = await login(email.trim(), password);
                navigate(postLoginPath(signedIn, from), { replace: true });
              } catch (reason) {
                setError(reason instanceof ApiError ? reason : new ApiError(0, 'LOGIN_FAILED', 'Sign in failed'));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field">
              <span className="field-label">Work email</span>
              <div className="input-with-icon">
                <Icon name="user" size={17} />
                <input
                  className="input"
                  type="email"
                  autoComplete="username"
                  required
                  autoFocus
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@aaradhya.local"
                />
              </div>
            </label>
            <label className="field">
              <span className="field-label">Password</span>
              <div className="input-with-icon">
                <Icon name="lock" size={17} />
                <input
                  className="input"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••••"
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </label>
            <button
              type="submit"
              className="btn btn-primary btn-block"
              disabled={busy || endingSession || loading || !email || !password}
            >
              {busy ? 'Signing in…' : endingSession ? 'Signing out previous session…' : 'Sign in to the warehouse'}
            </button>
          </form>

          <div className="login-security">
            <Icon name="audit" size={15} />
            <span>Failed attempts are rate limited. Sign-in, permission denials and configuration changes are audited.</span>
          </div>
        </div>
      </section>
    </div>
  );
}
