import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDateTime } from '../api';
import { useAuth } from '../auth';
import { useApi, useAction } from '../hooks';
import { useToast } from '../toast';
import {
  Card,
  CopyButton,
  ErrorNote,
  Field,
  Icon,
  PageHeader,
  Spinner,
  Stat,
  StatusPill,
} from '../ui';
import type { SecurityStatus } from '../reports';

interface Enrollment {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
  issuer: string;
  account: string;
}

export function SecurityPage() {
  const { can, user } = useAuth();
  const toast = useToast();
  const security = useApi<SecurityStatus>('/security/status');
  const startAction = useAction();
  const confirmAction = useAction();
  const disableAction = useAction();
  const testAction = useAction();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [showDisable, setShowDisable] = useState(false);

  const status = security.data;
  const enrolled = status?.totp.enrolled ?? false;
  const required = status?.policy.reportOtpRequired ?? false;
  const emailReady = status?.email.configured ?? false;

  const start = async () => {
    const result = await startAction.run(() =>
      api.post<Enrollment>('/security/totp/start'),
    );
    if (result) {
      setEnrollment(result);
      setCode('');
    }
  };

  const confirm = async () => {
    const token = code.replace(/\s+/g, '');
    if (token.length < 6) return;
    const result = await confirmAction.run(() =>
      api.post<{ enrolled: boolean; confirmedAt: string }>('/security/totp/confirm', { code: token }),
    );
    if (result) {
      toast.notify('Authenticator connected. You can now use app codes for report downloads.', 'success');
      setEnrollment(null);
      setCode('');
      security.reload();
    }
  };

  const disable = async () => {
    if (!password) return;
    const result = await disableAction.run(() =>
      api.post('/security/totp/disable', { password }),
    );
    if (result !== undefined) {
      toast.notify('Authenticator disconnected.', 'success');
      setPassword('');
      setShowDisable(false);
      security.reload();
    }
  };

  const sendTest = async () => {
    const result = await testAction.run(() => api.post<{ sentTo: string }>('/security/test-email'));
    if (result) toast.notify(`Test email sent to ${result.sentTo}.`, 'success');
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Account"
        title="My security"
        subtitle="Connect an authenticator app and check how one-time codes protect report downloads. Codes are verified on the backend and never stored in plain text."
        actions={
          <button type="button" className="btn btn-subtle" onClick={() => security.reload()}>
            <Icon name="refresh" size={16} /> Refresh status
          </button>
        }
      />

      <ErrorNote error={security.error} />
      {!status && security.loading ? <Spinner label="Checking your security settings…" /> : null}

      {status ? (
        <>
          <div className="stat-grid three">
            <Stat
              label="Report OTP policy"
              value={required ? 'Mandatory' : 'Optional'}
              hint={required ? 'Every export needs a fresh code' : 'Exports can be generated directly'}
              icon="lock"
              tone={required ? 'success' : 'neutral'}
            />
            <Stat
              label="Authenticator"
              value={enrolled ? 'Connected' : status.totp.started ? 'Setup incomplete' : 'Not connected'}
              hint={enrolled ? formatDateTime(status.totp.confirmedAt) : 'Recommended for report security'}
              icon="check"
              tone={enrolled ? 'success' : 'warning'}
            />
            <Stat
              label="Email codes"
              value={emailReady ? 'Ready' : 'Not configured'}
              hint={emailReady ? status.email.from ?? 'Sender configured' : 'Needs SMTP on the server'}
              icon="notifications"
              tone={emailReady ? 'success' : 'warning'}
            />
          </div>

          <div className="detail-grid">
            <Card
              title="Authenticator app"
              subtitle="Time-based codes from Google Authenticator, Authy, 1Password or any TOTP app."
            >
              {enrolled ? (
                <div className="stack">
                  <div className="toolbar">
                    <StatusPill value="Connected" tone="success" />
                    <span className="muted small">
                      Confirmed {formatDateTime(status.totp.confirmedAt)}
                    </span>
                  </div>
                  <p className="muted small">
                    Each code is valid for 30 seconds and can be used only once. Reusing a code is rejected and
                    recorded as a failed attempt.
                  </p>
                  {required ? (
                    <div className="alert alert-info">
                      <Icon name="info" size={17} />
                      <div>
                        Report OTP is mandatory. Disconnecting is blocked unless a working email sender can still
                        deliver codes, so the workspace cannot lock itself out.
                      </div>
                    </div>
                  ) : null}
                  <div className="toolbar">
                    <button
                      type="button"
                      className="btn btn-subtle btn-sm"
                      onClick={() => setShowDisable((value) => !value)}
                    >
                      <Icon name="lock" size={14} /> {showDisable ? 'Cancel' : 'Disconnect authenticator'}
                    </button>
                  </div>
                  {showDisable ? (
                    <div className="inline-form-panel">
                      <div className="inline-form-row">
                        <Field label="Confirm your password" hint="Required to disconnect. This action is audited.">
                          <input
                            className="input"
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                          />
                        </Field>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={disableAction.running || !password}
                          onClick={() => void disable()}
                        >
                          {disableAction.running ? 'Disconnecting…' : 'Confirm disconnect'}
                        </button>
                      </div>
                      <ErrorNote error={disableAction.error} />
                    </div>
                  ) : null}
                </div>
              ) : enrollment ? (
                <div className="stack">
                  <div className="qr-panel">
                    <span className="qr-image">
                      <img src={enrollment.qrDataUrl} alt="Authenticator QR code" />
                    </span>
                    <div className="stack" style={{ flex: 1, minWidth: 220 }}>
                      <div>
                        <strong>Scan this QR code</strong>
                        <p className="muted small">
                          Open your authenticator app, add an account and scan the code. If you cannot scan it,
                          enter the setup key manually.
                        </p>
                      </div>
                      <div className="secret-box">{enrollment.secret}</div>
                      <div className="toolbar">
                        <CopyButton value={enrollment.secret} label="Copy setup key" />
                        <CopyButton value={enrollment.otpauthUri} label="Copy setup link" />
                      </div>
                      <Field label="Enter the 6-digit code from the app" hint={`Issuer: ${enrollment.issuer} · Account: ${enrollment.account}`}>
                        <input
                          className="input code-input"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          maxLength={6}
                          placeholder="000000"
                          value={code}
                          onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))}
                        />
                      </Field>
                      <div className="toolbar">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={confirmAction.running || code.length < 6}
                          onClick={() => void confirm()}
                        >
                          {confirmAction.running ? 'Verifying…' : 'Verify and connect'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-subtle btn-sm"
                          onClick={() => {
                            setEnrollment(null);
                            setCode('');
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                      <ErrorNote error={confirmAction.error} />
                    </div>
                  </div>
                  <p className="muted tiny">
                    The secret is encrypted at rest before it is saved. It is never written to logs or audit entries.
                  </p>
                </div>
              ) : (
                <div className="stack">
                  <p className="muted small">
                    Connect an authenticator to protect report downloads with rotating codes. Setup takes less than a
                    minute: scan a QR code, then confirm one code.
                  </p>
                  {status.totp.started ? (
                    <div className="alert alert-info">
                      <Icon name="info" size={17} />
                      <div>
                        A previous setup was started but not confirmed. Start again to get a fresh QR code and key.
                      </div>
                    </div>
                  ) : null}
                  <div className="toolbar">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={startAction.running}
                      onClick={() => void start()}
                    >
                      <Icon name="lock" size={14} />
                      {startAction.running ? 'Preparing…' : status.totp.started ? 'Restart setup' : 'Set up authenticator'}
                    </button>
                    <Link className="btn btn-subtle btn-sm" to="/reports">
                      <Icon name="reports" size={14} /> Report exports
                    </Link>
                  </div>
                  <ErrorNote error={startAction.error} />
                </div>
              )}
            </Card>

            <Card
              title="Email one-time codes"
              subtitle="Delivered to the email address on your account when you request a code in the export dialog."
            >
              <div className="stack">
                <div className="toolbar">
                  <StatusPill
                    value={emailReady ? 'Sender ready' : 'Not configured'}
                    tone={emailReady ? 'success' : 'warning'}
                  />
                  {status.email.from ? <span className="muted small">{status.email.from}</span> : null}
                </div>
                <p className="muted small">
                  Codes expire after 5 minutes, allow 5 attempts and are limited to 3 requests per 10 minutes.
                  Successful and failed attempts are audited without recording the code itself.
                </p>
                <div className="meta-list">
                  <div className="meta-row">
                    <dt>Delivery address</dt>
                    <dd>{user?.email ?? '—'}</dd>
                  </div>
                  <div className="meta-row">
                    <dt>Policy</dt>
                    <dd>{required ? 'Mandatory for every export' : 'Optional — can be enabled in Report Studio'}</dd>
                  </div>
                </div>
                {!emailReady ? (
                  <div className="alert alert-info">
                    <Icon name="info" size={17} />
                    <div>
                      Email codes need an SMTP sender configured on the server (SMTP_HOST, SMTP_USER, SMTP_PASS).
                      The system never pretends an email was sent when SMTP is missing.
                    </div>
                  </div>
                ) : null}
                <div className="toolbar">
                  {can('settings.manage') ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-subtle btn-sm"
                        disabled={!emailReady || testAction.running}
                        onClick={() => void sendTest()}
                      >
                        <Icon name="notifications" size={14} />
                        {testAction.running ? 'Sending…' : 'Send test email'}
                      </button>
                      <Link className="btn btn-subtle btn-sm" to="/report-studio">
                        <Icon name="settings" size={14} /> Report Studio
                      </Link>
                    </>
                  ) : (
                    <span className="muted tiny">
                      Report OTP policy is managed by an administrator in Report Studio.
                    </span>
                  )}
                </div>
                <ErrorNote error={testAction.error} />
              </div>
            </Card>
          </div>

          <Card title="How report codes work">
            <div className="security-steps">
              <div>
                <span className="security-step-no">1</span>
                <strong>Open the export dialog</strong>
                <p className="muted small">
                  Choose the report, filters, format and template on the Reports page.
                </p>
              </div>
              <div>
                <span className="security-step-no">2</span>
                <strong>Prove it is you</strong>
                <p className="muted small">
                  If the policy is on, enter an authenticator code or request a code by email.
                </p>
              </div>
              <div>
                <span className="security-step-no">3</span>
                <strong>Download once</strong>
                <p className="muted small">
                  The backend verifies and consumes the code before building the file. Replays are rejected.
                </p>
              </div>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
