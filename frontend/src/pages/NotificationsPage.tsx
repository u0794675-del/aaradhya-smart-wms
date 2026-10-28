import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDateTime, formatNumber, queryString, titleCase } from '../api';
import { useAuth } from '../auth';
import { useApi, useAction } from '../hooks';
import { useToast } from '../toast';
import { ReasonDialog } from '../components/forms';
import {
  Card,
  DataTable,
  ErrorNote,
  Icon,
  PageHeader,
  Stat,
  StatusPill,
  Tabs,
  type Column,
} from '../ui';
import { entityLabel, entityLink } from '../links';

interface NotificationRow {
  id: string;
  rule_code: string;
  severity: string;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: string | null;
  assigned_role: string | null;
  status: string;
  created_at: string;
  acknowledged_by: string | null;
  acknowledged_by_name: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

interface NotificationList {
  rows: NotificationRow[];
  counts: Record<string, number>;
}

const TABS = [
  { key: 'OPEN', label: 'Open' },
  { key: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { key: 'RESOLVED', label: 'Resolved' },
  { key: 'ALL', label: 'All' },
];

export function NotificationsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('OPEN');
  const [version, setVersion] = useState(0);
  const [resolveTarget, setResolveTarget] = useState<NotificationRow | null>(null);
  const action = useAction();

  const state = useApi<NotificationList>(
    `/notifications${queryString({ status: tab === 'ALL' ? undefined : tab, limit: 300 })}`,
    version,
  );
  const rows = state.data?.rows ?? [];
  const counts = state.data?.counts ?? {};
  const openCount = Number(counts.OPEN ?? 0);
  const acknowledgedCount = Number(counts.ACKNOWLEDGED ?? 0);
  const resolvedCount = Number(counts.RESOLVED ?? 0);
  const criticalOpen = rows.filter((row) => row.status === 'OPEN' && row.severity === 'CRITICAL').length;

  const acknowledge = async (row: NotificationRow) => {
    const result = await action.run(() => api.post(`/notifications/${row.id}/acknowledge`));
    if (result !== undefined) {
      toast.notify(`Notification ${titleCase(row.rule_code)} acknowledged.`, 'success');
      setVersion((value) => value + 1);
    }
  };

  const columns: Array<Column<NotificationRow>> = [
    {
      key: 'title',
      header: 'Notification',
      render: (row) => (
        <div className="cell-title">
          <strong>{row.title}</strong>
          <span className="muted tiny">{titleCase(row.rule_code)}</span>
        </div>
      ),
    },
    { key: 'severity', header: 'Severity', render: (row) => <StatusPill value={row.severity} dot={false} /> },
    { key: 'body', header: 'Detail', render: (row) => <span className="small clamp-2">{row.body}</span> },
    {
      key: 'entity',
      header: 'Linked record',
      render: (row) => {
        const link = entityLink(row.entity_type, row.entity_id);
        if (!link) return <span className="muted">—</span>;
        return (
          <Link className="inline-link" to={link} onClick={(event) => event.stopPropagation()}>
            {entityLabel(row.entity_type)}
          </Link>
        );
      },
    },
    { key: 'assigned_role', header: 'Owner role', render: (row) => (row.assigned_role ? titleCase(row.assigned_role) : '—') },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
    {
      key: 'created_at',
      header: 'Raised',
      render: (row) => <span className="muted small">{formatDateTime(row.created_at)}</span>,
    },
    {
      key: 'acknowledged',
      header: 'Acknowledged',
      render: (row) =>
        row.acknowledged_by_name ? (
          <div className="cell-title">
            <span className="small">{row.acknowledged_by_name}</span>
            <span className="muted tiny">{formatDateTime(row.acknowledged_at)}</span>
          </div>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      render: (row) =>
        can('exception.manage') ? (
          <div className="row-actions">
            {row.status === 'OPEN' ? (
              <button
                type="button"
                className="btn btn-subtle btn-xs"
                disabled={action.running}
                onClick={(event) => {
                  event.stopPropagation();
                  void acknowledge(row);
                }}
              >
                Acknowledge
              </button>
            ) : null}
            {['OPEN', 'ACKNOWLEDGED'].includes(row.status) ? (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={(event) => {
                  event.stopPropagation();
                  setResolveTarget(row);
                }}
              >
                Resolve
              </button>
            ) : null}
          </div>
        ) : (
          <span className="muted small">Read only</span>
        ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        eyebrow="Operations"
        title="Notifications"
        subtitle="Rules-driven alerts for low stock, batch expiry and critical exceptions. Alerts are raised and auto-resolved by the backend; acknowledge or resolve with a documented reason."
        actions={
          <button
            type="button"
            className="btn btn-subtle"
            onClick={() => {
              setVersion((value) => value + 1);
            }}
          >
            <Icon name="refresh" size={16} /> Re-evaluate rules
          </button>
        }
      />

      <div className="stat-grid four">
        <Stat label="Open" value={formatNumber(openCount)} icon="notifications" tone={openCount ? 'warning' : 'success'} />
        <Stat label="Critical open" value={formatNumber(criticalOpen)} icon="alert" tone={criticalOpen ? 'danger' : 'neutral'} hint="In current view" />
        <Stat label="Acknowledged" value={formatNumber(acknowledgedCount)} icon="check" />
        <Stat label="Resolved" value={formatNumber(resolvedCount)} icon="audit" tone="success" />
      </div>

      <Card
        title="Notification register"
        subtitle={`${formatNumber(rows.length)} notifications in this view`}
        actions={
          <Tabs
            tabs={TABS.map((entry) => ({
              ...entry,
              count: entry.key === 'ALL' ? openCount + acknowledgedCount + resolvedCount : Number(counts[entry.key] ?? 0),
            }))}
            active={tab}
            onChange={setTab}
          />
        }
        flush
      >
        <ErrorNote error={state.error ?? action.error} />
        <DataTable
          columns={columns}
          rows={rows}
          loading={state.loading && !state.data}
          rowKey={(row) => row.id}
          emptyTitle={tab === 'OPEN' ? 'No open notifications' : 'No notifications in this view'}
          emptyMessage="Rules run on each refresh: low stock, batch expiry within the warning window, and critical exceptions."
        />
      </Card>

      <ReasonDialog
        open={Boolean(resolveTarget)}
        title={resolveTarget ? `Resolve: ${resolveTarget.title}` : 'Resolve notification'}
        label="Resolution reason"
        hint="Explain why this alert is being closed. The reason is stored in the audit trail."
        confirmLabel="Resolve notification"
        minLength={3}
        onClose={() => setResolveTarget(null)}
        onConfirm={async (reason) => {
          if (!resolveTarget) return undefined;
          const result = await action.run(() =>
            api.post(`/notifications/${resolveTarget.id}/resolve`, { reason }),
          );
          if (result !== undefined) {
            toast.notify('Notification resolved and audited.', 'success');
            setVersion((value) => value + 1);
          }
          return result;
        }}
      />
    </div>
  );
}
