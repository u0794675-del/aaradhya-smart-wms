import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatDateTime, formatNumber, queryString, titleCase } from '../api';
import { useApi, useDebouncedValue } from '../hooks';
import {
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Icon,
  JsonView,
  MetaList,
  PageHeader,
  Stat,
  StatusPill,
  type Column,
} from '../ui';
import { entityLabel, entityLink } from '../links';

interface AuditRow {
  id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  transaction_id: string | null;
  outcome: string;
  reason: string | null;
  before: unknown;
  after: unknown;
  refs: unknown;
  created_at: string;
}

interface AuditList {
  rows: AuditRow[];
  total: number;
  limit: number;
  offset: number;
}

const OUTCOMES = ['SUCCESS', 'FAILURE'];

export function AuditPage() {
  const [params] = useSearchParams();
  const [eventType, setEventType] = useState('');
  const [entityType, setEntityType] = useState(params.get('entityType') ?? '');
  const [entityId, setEntityId] = useState(params.get('entityId') ?? '');
  const [outcome, setOutcome] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState<AuditRow | null>(null);
  const debouncedSearch = useDebouncedValue(search, 300);

  const path = `/audit${queryString({
    eventType: eventType.trim() || undefined,
    entityType: entityType.trim() || undefined,
    entityId: entityId.trim() || undefined,
    outcome: outcome || undefined,
    search: debouncedSearch.trim() || undefined,
    from: from ? `${from}T00:00:00.000Z` : undefined,
    to: to ? `${to}T23:59:59.999Z` : undefined,
    limit: 200,
  })}`;
  const list = useApi<AuditList>(path);
  const rows = list.data?.rows ?? [];

  const stats = useMemo(() => {
    const actorSet = new Set<string>();
    let success = 0;
    let failure = 0;
    for (const row of rows) {
      if (row.outcome === 'SUCCESS') success += 1;
      if (row.outcome === 'FAILURE') failure += 1;
      actorSet.add(row.actor_user_id ?? 'system');
    }
    return { success, failure, actors: actorSet.size };
  }, [rows]);

  const clearFilters = () => {
    setEventType('');
    setEntityType('');
    setEntityId('');
    setOutcome('');
    setSearch('');
    setFrom('');
    setTo('');
  };

  const columns: Array<Column<AuditRow>> = [
    {
      key: 'created_at',
      header: 'When',
      width: '170px',
      render: (row) => (
        <div className="cell-title">
          <strong className="small">{formatDateTime(row.created_at)}</strong>
          <span className="muted tiny">{row.id.slice(0, 8)}</span>
        </div>
      ),
    },
    {
      key: 'event_type',
      header: 'Event',
      render: (row) => (
        <div className="cell-title">
          <strong>{titleCase(row.event_type)}</strong>
          <span className="muted tiny">{row.event_type}</span>
        </div>
      ),
    },
    {
      key: 'entity',
      header: 'Entity',
      render: (row) => {
        const link = entityLink(row.entity_type, row.entity_id);
        const label = entityLabel(row.entity_type);
        return (
          <div className="cell-title">
            {link ? (
              <Link className="inline-link" to={link} onClick={(event) => event.stopPropagation()}>
                {label}
              </Link>
            ) : (
              <span>{label}</span>
            )}
            <span className="muted tiny nowrap">{row.entity_id ?? '—'}</span>
          </div>
        );
      },
    },
    {
      key: 'actor',
      header: 'Actor',
      render: (row) => (
        <div className="cell-title">
          <span>{row.actor_name ?? 'System'}</span>
          {row.actor_email ? <span className="muted tiny">{row.actor_email}</span> : null}
        </div>
      ),
    },
    { key: 'outcome', header: 'Outcome', render: (row) => <StatusPill value={row.outcome} dot={false} /> },
    {
      key: 'reason',
      header: 'Reason',
      render: (row) => (row.reason ? <span className="small clamp-2">{row.reason}</span> : <span className="muted">—</span>),
    },
    {
      key: 'transaction',
      header: 'Transaction',
      render: (row) =>
        row.transaction_id ? <code className="code tiny">{row.transaction_id.slice(0, 8)}</code> : <span className="muted">—</span>,
    },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <button
          type="button"
          className="btn btn-subtle btn-xs"
          onClick={(event) => {
            event.stopPropagation();
            setSelected(row);
          }}
        >
          Details
        </button>
      ),
    },
  ];

  const hasFilters = Boolean(eventType || entityType || entityId || outcome || search || from || to);

  return (
    <div className="page">
      <PageHeader
        eyebrow="Control"
        title="Audit trail"
        subtitle="Append-only record of every validated action: actor, role, timestamp, reason, before/after values and references. Entries cannot be edited or deleted."
      />

      <div className="stat-grid four">
        <Stat label="Events in view" value={formatNumber(rows.length)} icon="audit" />
        <Stat label="Successful" value={formatNumber(stats.success)} icon="check" tone="success" />
        <Stat label="Failures" value={formatNumber(stats.failure)} icon="alert" tone={stats.failure ? 'danger' : 'neutral'} />
        <Stat label="Distinct actors" value={formatNumber(stats.actors)} icon="user" />
      </div>

      <Card title="Search the trail" subtitle="Filters map directly to indexed audit columns.">
        <div className="form-grid four">
          <Field label="Event type" hint="Exact match, e.g. INVENTORY.MOVE">
            <input
              className="input"
              value={eventType}
              maxLength={100}
              placeholder="INVENTORY.MOVE"
              onChange={(event) => setEventType(event.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Entity type" hint="Exact match, e.g. BOX, ORDER">
            <input
              className="input"
              value={entityType}
              maxLength={100}
              placeholder="ORDER"
              onChange={(event) => setEntityType(event.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Entity id">
            <input className="input" value={entityId} maxLength={200} placeholder="UUID or document id" onChange={(event) => setEntityId(event.target.value)} />
          </Field>
          <Field label="Outcome">
            <select className="input" value={outcome} onChange={(event) => setOutcome(event.target.value)}>
              <option value="">All outcomes</option>
              {OUTCOMES.map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Search" hint="Event, reason, actor name or entity id.">
            <input className="input" value={search} maxLength={200} placeholder="Reason or actor" onChange={(event) => setSearch(event.target.value)} />
          </Field>
          <Field label="From">
            <input type="date" className="input" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" className="input" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          <div className="field">
            <span className="field-label">Actions</span>
            <div className="toolbar">
              <button type="button" className="btn btn-subtle btn-sm" onClick={() => list.reload()}>
                <Icon name="refresh" size={14} /> Refresh
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters} disabled={!hasFilters}>
                Clear filters
              </button>
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="Audit events"
        subtitle={
          list.data
            ? `${formatNumber(list.data.total)} events${list.data.total > rows.length ? ` · showing latest ${rows.length}` : ''}`
            : 'Loading events'
        }
        flush
      >
        <ErrorNote error={list.error} />
        <DataTable
          columns={columns}
          rows={rows}
          loading={list.loading && !list.data}
          rowKey={(row) => row.id}
          onRowClick={(row) => setSelected(row)}
          emptyTitle="No audit events match this filter"
          emptyMessage="Every stock movement, approval, permission denial and configuration change is written here."
        />
      </Card>

      <Dialog
        open={Boolean(selected)}
        title={selected ? titleCase(selected.event_type) : 'Audit event'}
        subtitle={selected ? `${formatDateTime(selected.created_at)} · ${selected.outcome}` : undefined}
        onClose={() => setSelected(null)}
        wide
        footer={
          <div className="form-actions">
            <button type="button" className="btn btn-subtle" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
        }
      >
        {selected ? <AuditDetail event={selected} /> : null}
      </Dialog>
    </div>
  );
}

function AuditDetail({ event }: { event: AuditRow }) {
  const link = entityLink(event.entity_type, event.entity_id);
  return (
    <div className="stack">
      <MetaList
        items={[
          { label: 'Event', value: <code className="code">{event.event_type}</code> },
          { label: 'Outcome', value: <StatusPill value={event.outcome} dot={false} /> },
          { label: 'Actor', value: event.actor_name ? `${event.actor_name}${event.actor_email ? ` · ${event.actor_email}` : ''}` : 'System' },
          { label: 'Actor user id', value: event.actor_user_id ? <code className="code tiny">{event.actor_user_id}</code> : '—' },
          { label: 'Entity', value: `${entityLabel(event.entity_type)} · ${event.entity_id ?? '—'}` },
          { label: 'Linked record', value: link ? <Link className="inline-link" to={link}>{entityLabel(event.entity_type)}</Link> : '—' },
          { label: 'Transaction', value: event.transaction_id ? <code className="code tiny">{event.transaction_id}</code> : '—' },
          { label: 'Recorded', value: formatDateTime(event.created_at) },
          { label: 'Reason', value: event.reason ?? '—' },
        ]}
      />

      <div className="detail-grid">
        <div>
          <h3 className="section-title">Before</h3>
          {event.before ? <JsonView value={event.before} /> : <EmptyState title="No before state" message="This event was not a state mutation." icon="audit" />}
        </div>
        <div>
          <h3 className="section-title">After</h3>
          {event.after ? <JsonView value={event.after} /> : <EmptyState title="No after state" message="This event recorded a read or denial." icon="audit" />}
        </div>
      </div>

      <div>
        <h3 className="section-title">References</h3>
        {event.refs ? <JsonView value={event.refs} /> : <p className="muted small">No reference metadata stored.</p>}
      </div>
    </div>
  );
}
