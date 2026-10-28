import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDateTime, type SettingRow } from '../api';
import { useAuth } from '../auth';
import { useApi, useAction } from '../hooks';
import { useToast } from '../toast';
import { Card, ErrorNote, Icon, PageHeader, Spinner, Stat } from '../ui';

interface SettingsResponse {
  rows: SettingRow[];
}

export function SettingsPage() {
  const state = useApi<SettingsResponse>('/settings');
  const rows = state.data?.rows ?? [];
  const booleanCount = rows.filter((row) => typeof row.value === 'boolean').length;
  const numericCount = rows.filter((row) => typeof row.value === 'number').length;
  const textCount = rows.filter((row) => typeof row.value === 'string').length;
  const lastUpdated = rows
    .map((row) => row.updated_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  return (
    <div className="page">
      <PageHeader
        eyebrow="Administration"
        title="System settings"
        subtitle="Operational rules are enforced by the backend. Each change is validated, stored with the acting user and written to the immutable audit trail with its before and after values."
        actions={
          <div className="toolbar">
            <Link className="btn btn-subtle" to="/audit?entityType=SETTING">
              <Icon name="audit" size={16} /> Setting audit history
            </Link>
            <button type="button" className="btn btn-subtle" onClick={() => state.reload()}>
              <Icon name="refresh" size={16} /> Refresh
            </button>
          </div>
        }
      />

      <div className="stat-grid four">
        <Stat label="Settings" value={rows.length} icon="settings" />
        <Stat label="Boolean rules" value={booleanCount} icon="check" />
        <Stat label="Numeric thresholds" value={numericCount} icon="adjust" />
        <Stat
          label="Last changed"
          value={lastUpdated ? formatDateTime(lastUpdated) : 'Never'}
          icon="clock"
          hint={`${textCount} text settings`}
        />
      </div>

      <Card
        title="Report OTP and security"
        subtitle="One-time codes for report downloads are managed separately from the setting row below."
      >
        <p className="muted small">
          Enroll an authenticator app or confirm email delivery in My Security, then switch
          <code className="code"> report_otp_required</code> on in Report Studio. The backend refuses to enable it
          until at least one channel is ready.
        </p>
        <div className="toolbar">
          <Link className="btn btn-subtle" to="/security">
            <Icon name="lock" size={16} /> My Security
          </Link>
          <Link className="btn btn-subtle" to="/report-studio">
            <Icon name="reports" size={16} /> Report Studio
          </Link>
        </div>
      </Card>

      <ErrorNote error={state.error} />
      {state.loading && !state.data ? <Spinner label="Loading settings…" /> : null}

      <div className="stack">
        {rows.map((row) => (
          <SettingEditor
            key={`${row.key}-${row.updated_at ?? ''}`}
            setting={row}
            onSaved={() => {
              state.reload();
            }}
          />
        ))}
      </div>

      {state.data && rows.length === 0 ? (
        <Card>
          <p className="muted">No settings are configured.</p>
        </Card>
      ) : null}
    </div>
  );
}

function SettingEditor({ setting, onSaved }: { setting: SettingRow; onSaved: () => void }) {
  const { refreshMeta } = useAuth();
  const toast = useToast();
  const action = useAction();
  const kind = typeof setting.value;
  const [draft, setDraft] = useState(() => (kind === 'boolean' ? String(setting.value) : String(setting.value ?? '')));

  useEffect(() => {
    setDraft(kind === 'boolean' ? String(setting.value) : String(setting.value ?? ''));
  }, [setting.value, kind]);

  const nextValue =
    kind === 'boolean' ? draft === 'true' : kind === 'number' ? Number(draft) : draft;
  const invalid =
    kind === 'number' ? !Number.isFinite(Number(draft)) || Number(draft) < 0 || draft.trim() === '' : draft.trim() === '';
  const dirty = kind === 'boolean' ? String(setting.value) !== draft : String(setting.value ?? '') !== draft;

  const save = async () => {
    if (invalid) return;
    const result = await action.run(() => api.patch(`/settings/${encodeURIComponent(setting.key)}`, { value: nextValue }));
    if (result !== undefined) {
      toast.notify(`Setting ${setting.key} updated and audited.`, 'success');
      await refreshMeta();
      onSaved();
    }
  };

  return (
    <section className="setting-row">
      <div className="setting-copy">
        <code className="code">{setting.key}</code>
        <p className="muted small">{setting.description ?? 'No description provided.'}</p>
        <span className="muted tiny">
          Type: {kind} · {setting.updated_at ? `Last changed ${formatDateTime(setting.updated_at)}` : 'Never changed'}
        </span>
      </div>
      <div className="setting-control">
        {kind === 'boolean' ? (
          <select className="input" value={draft} onChange={(event) => setDraft(event.target.value)}>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        ) : kind === 'number' ? (
          <input
            className="input"
            type="number"
            min={0}
            step="any"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : (
          <input className="input" maxLength={200} value={draft} onChange={(event) => setDraft(event.target.value)} />
        )}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={action.running || invalid || !dirty}
          onClick={() => void save()}
        >
          {action.running ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
      </div>
      {action.error ? (
        <div className="setting-error">
          <ErrorNote error={action.error} />
        </div>
      ) : null}
    </section>
  );
}
