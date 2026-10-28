import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, formatDateTime, formatNumber, queryString, titleCase } from '../api';
import { useAuth } from '../auth';
import { useApi, useAction, useDebouncedValue } from '../hooks';
import { useToast } from '../toast';
import {
  Card,
  DataTable,
  Dialog,
  ErrorNote,
  Field,
  Icon,
  JsonView,
  MetaList,
  PageHeader,
  Spinner,
  Stat,
  StatusPill,
  type Column,
} from '../ui';
import { entityLabel, entityLink } from '../links';

interface ExceptionRow {
  id: string;
  exception_no: string;
  type: string;
  severity: string;
  status: string;
  owner_user_id: string | null;
  owner_name: string | null;
  entity_type: string | null;
  entity_id: string | null;
  description: string;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  resolved_at: string | null;
  resolution: string | null;
}

interface ExceptionList {
  rows: ExceptionRow[];
  total: number;
  limit: number;
  offset: number;
}

interface ExceptionAudit {
  id: string;
  event_type: string;
  reason: string | null;
  outcome: string | null;
  created_at: string;
  actor_name: string | null;
}

interface ExceptionDetail extends ExceptionRow {
  audit: ExceptionAudit[];
}

const STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'];
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const TRANSITIONS: Record<string, string[]> = {
  OPEN: ['INVESTIGATING', 'RESOLVED', 'CLOSED'],
  INVESTIGATING: ['RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
};

export function ExceptionsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [severity, setSeverity] = useState(params.get('severity') ?? '');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [version, setVersion] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const selectedId = params.get('id');

  const list = useApi<ExceptionList>(
    `/exceptions${queryString({
      status: status || undefined,
      severity: severity || undefined,
      search: debouncedSearch || undefined,
      limit: 200,
    })}`,
    version,
  );
  const rows = list.data?.rows ?? [];

  const openException = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('id', id);
    setParams(next, { replace: true });
  };
  const closeException = () => {
    const next = new URLSearchParams(params);
    next.delete('id');
    setParams(next, { replace: true });
  };

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => ({
          open: acc.open + (['OPEN', 'INVESTIGATING'].includes(row.status) ? 1 : 0),
          critical: acc.critical + (row.severity === 'CRITICAL' && ['OPEN', 'INVESTIGATING'].includes(row.status) ? 1 : 0),
          resolved: acc.resolved + (row.status === 'RESOLVED' ? 1 : 0),
          closed: acc.closed + (row.status === 'CLOSED' ? 1 : 0),
        }),
        { open: 0, critical: 0, resolved: 0, closed: 0 },
      ),
    [rows],
  );

  const columns: Array<Column<ExceptionRow>> = [
    {
      key: 'exception_no',
      header: 'Exception',
      render: (row) => (
        <div className="cell-title">
          <strong>{row.exception_no}</strong>
          <span className="muted tiny">{titleCase(row.type)}</span>
        </div>
      ),
    },
    { key: 'severity', header: 'Severity', render: (row) => <StatusPill value={row.severity} dot={false} /> },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
    {
      key: 'description',
      header: 'Description',
      render: (row) => <span className="small clamp-2">{row.description}</span>,
    },
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
    { key: 'owner_name', header: 'Owner', render: (row) => row.owner_name ?? '—' },
    {
      key: 'created_at',
      header: 'Raised',
      render: (row) => <span className="muted small">{formatDateTime(row.created_at)}</span>,
    },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <button type="button" className="btn btn-subtle btn-xs" onClick={() => openException(row.id)}>
          Open
        </button>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        eyebrow="Operational control"
        title="Exceptions"
        subtitle="Discrepancies, exceptions and quality issues with severity, ownership, resolution and a complete audit history."
        actions={
          can('exception.manage') ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={16} /> Raise exception
            </button>
          ) : null
        }
      />

      <div className="stat-grid four">
        <Stat label="In view" value={formatNumber(rows.length)} icon="exceptions" />
        <Stat label="Open" value={formatNumber(totals.open)} icon="alert" tone={totals.open ? 'warning' : 'success'} />
        <Stat label="Critical" value={formatNumber(totals.critical)} icon="alert" tone={totals.critical ? 'danger' : 'success'} />
        <Stat label="Resolved / closed" value={formatNumber(totals.resolved + totals.closed)} icon="check" tone="success" />
      </div>

      <Card
        title="Exception register"
        subtitle={
          list.data
            ? `${formatNumber(list.data.total)} exceptions${list.data.total > rows.length ? ` · showing ${rows.length}` : ''}`
            : 'Loading exception register'
        }
        actions={
          <div className="toolbar wrap">
            <div className="search-inline">
              <Icon name="search" size={15} />
              <input
                className="input compact-input"
                placeholder="Number, description or entity id"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <select className="input compact-input" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </select>
            <select className="input compact-input" value={severity} onChange={(event) => setSeverity(event.target.value)}>
              <option value="">All severities</option>
              {SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-subtle btn-sm" onClick={() => list.reload()}>
              <Icon name="refresh" size={14} /> Refresh
            </button>
          </div>
        }
        flush
      >
        <ErrorNote error={list.error} />
        <DataTable
          columns={columns}
          rows={rows}
          loading={list.loading && !list.data}
          rowKey={(row) => row.id}
          onRowClick={(row) => openException(row.id)}
          emptyTitle="No exceptions match this filter"
          emptyMessage="Raise an exception when an operational issue needs an owner and a resolution path."
        />
      </Card>

      {selectedId ? (
        <ExceptionDetailDialog
          id={selectedId}
          onClose={closeException}
          onChanged={() => {
            setVersion((value) => value + 1);
          }}
        />
      ) : null}

      <CreateExceptionDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id, exceptionNo) => {
          setCreateOpen(false);
          setVersion((value) => value + 1);
          toast.notify(`Exception ${exceptionNo} raised.`, 'warning');
          openException(id);
        }}
      />
    </div>
  );
}

function CreateExceptionDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string, exceptionNo: string) => void;
}) {
  const [type, setType] = useState('STOCK_DISCREPANCY');
  const [severity, setSeverity] = useState('MEDIUM');
  const [description, setDescription] = useState('');
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const action = useAction();

  useEffect(() => {
    if (open) {
      setType('STOCK_DISCREPANCY');
      setSeverity('MEDIUM');
      setDescription('');
      setEntityType('');
      setEntityId('');
      action.setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    const result = await action.run(() =>
      api.post<{ id: string; exceptionNo: string }>('/exceptions', {
        type: type.trim(),
        severity,
        description: description.trim(),
        entityType: entityType.trim() || null,
        entityId: entityId.trim() || null,
      }),
    );
    if (result) onCreated(result.id, result.exceptionNo);
  };

  return (
    <Dialog
      open={open}
      title="Raise exception"
      subtitle="Exceptions are never deleted; they are investigated, resolved and closed with a documented resolution."
      onClose={onClose}
      wide
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={action.running || type.trim().length < 2 || description.trim().length < 5}
          >
            {action.running ? 'Raising…' : 'Raise exception'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={action.error} />
        <div className="form-grid two">
          <Field label="Exception type" required hint="Upper-cased, e.g. CYCLE_COUNT_DISCREPANCY.">
            <input className="input" value={type} maxLength={100} onChange={(event) => setType(event.target.value)} />
          </Field>
          <Field label="Severity" required>
            <select className="input" value={severity} onChange={(event) => setSeverity(event.target.value)}>
              {SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Linked entity type" hint="Optional, e.g. ORDER, RECEIPT, BOX, BATCH.">
            <input className="input" value={entityType} maxLength={100} onChange={(event) => setEntityType(event.target.value.toUpperCase())} />
          </Field>
          <Field label="Linked entity id" hint="Optional record identifier or document number.">
            <input className="input" value={entityId} maxLength={200} onChange={(event) => setEntityId(event.target.value)} />
          </Field>
          <Field label="Description" required className="span-2">
            <textarea
              className="input textarea"
              rows={4}
              maxLength={2000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What happened, where, and what was observed?"
            />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function ExceptionDetailDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const detail = useApi<ExceptionDetail>(`/exceptions/${id}`, version);
  const [nextStatus, setNextStatus] = useState('');
  const [nextSeverity, setNextSeverity] = useState('');
  const [resolution, setResolution] = useState('');
  const action = useAction();
  const data = detail.data;
  const transitions = data ? TRANSITIONS[data.status] ?? [] : [];
  const requireResolution = ['RESOLVED', 'CLOSED'].includes(nextStatus || data?.status || '');

  useEffect(() => {
    if (!detail.data) return;
    setNextStatus(detail.data.status);
    setNextSeverity(detail.data.severity);
    setResolution(detail.data.resolution ?? '');
  }, [detail.data]);

  const link = data ? entityLink(data.entity_type, data.entity_id) : null;

  const save = async () => {
    if (!data) return;
    const result = await action.run(() =>
      api.patch(`/exceptions/${data.id}`, {
        status: nextStatus || data.status,
        severity: nextSeverity || data.severity,
        resolution: resolution.trim() || null,
      }),
    );
    if (result !== undefined) {
      toast.notify('Exception updated and audited.', 'success');
      setVersion((value) => value + 1);
      onChanged();
    }
  };

  return (
    <Dialog
      open
      title={data ? `Exception ${data.exception_no}` : 'Exception'}
      subtitle={data ? `${titleCase(data.type)} · ${titleCase(data.status)}` : 'Loading exception'}
      onClose={onClose}
      wide
      footer={
        <div className="form-actions spread">
          <span className="muted small">Resolution is stored with the audit event who/when.</span>
          <button type="button" className="btn btn-subtle" onClick={onClose}>
            Close
          </button>
        </div>
      }
    >
      {detail.loading && !data ? <Spinner label="Loading exception…" /> : null}
      <ErrorNote error={detail.error ?? action.error} />
      {data ? (
        <div className="stack">
          <div className="stat-grid four">
            <Stat label="Severity" value={<StatusPill value={data.severity} dot={false} />} icon="alert" />
            <Stat label="Status" value={<StatusPill value={data.status} />} icon="clock" />
            <Stat label="Owner" value={data.owner_name ?? 'Unassigned'} icon="user" />
            <Stat label="Raised" value={formatDateTime(data.created_at)} icon="exceptions" />
          </div>

          <div className="detail-grid">
            <MetaList
              items={[
                { label: 'Exception no', value: <strong>{data.exception_no}</strong> },
                { label: 'Type', value: titleCase(data.type) },
                { label: 'Linked record', value: link ? <Link className="inline-link" to={link}>{entityLabel(data.entity_type)}</Link> : '—' },
                { label: 'Raised by', value: data.created_by_name ?? '—' },
                { label: 'Resolved at', value: data.resolved_at ? formatDateTime(data.resolved_at) : '—' },
                { label: 'Resolution', value: data.resolution ?? '—' },
              ]}
            />
            <div className="detail-actions">
              <div className="callout">
                <strong>Description</strong>
                <p>{data.description}</p>
              </div>
            </div>
          </div>

          {can('exception.manage') ? (
            <div className="inline-form-panel">
              <div className="inline-form-head">
                <strong>Investigate & resolve</strong>
                <span className="muted tiny">Resolution text is required to resolve or close.</span>
              </div>
              <div className="form-grid three">
                <Field label="Status">
                  <select className="input" value={nextStatus} onChange={(event) => setNextStatus(event.target.value)}>
                    <option value={data.status}>{titleCase(data.status)} (current)</option>
                    {transitions.map((value) => (
                      <option key={value} value={value}>
                        {titleCase(value)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Severity">
                  <select className="input" value={nextSeverity} onChange={(event) => setNextSeverity(event.target.value)}>
                    {SEVERITIES.map((value) => (
                      <option key={value} value={value}>
                        {titleCase(value)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Resolution" required={requireResolution}>
                  <textarea
                    className="input textarea"
                    rows={3}
                    maxLength={2000}
                    value={resolution}
                    onChange={(event) => setResolution(event.target.value)}
                  />
                </Field>
              </div>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={action.running || (requireResolution && !resolution.trim())}
                  onClick={() => void save()}
                >
                  {action.running ? 'Saving…' : 'Save exception'}
                </button>
              </div>
            </div>
          ) : null}

          <div>
            <h3 className="section-title">Audit history</h3>
            {data.audit.length === 0 ? (
              <p className="muted small">No audit events recorded.</p>
            ) : (
              <div className="timeline">
                {data.audit.map((event) => (
                  <div className="timeline-row" key={event.id}>
                    <div className="timeline-main">
                      <strong>{titleCase(event.event_type)}</strong>
                      {event.reason ? <span className="muted small">{event.reason}</span> : null}
                    </div>
                    <div className="timeline-meta">
                      <span>{event.actor_name ?? 'System'}</span>
                      <span>{formatDateTime(event.created_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <details className="json-details">
            <summary>Raw record</summary>
            <JsonView value={data} />
          </details>
        </div>
      ) : null}
    </Dialog>
  );
}
