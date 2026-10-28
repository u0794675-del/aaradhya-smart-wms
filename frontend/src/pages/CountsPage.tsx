import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, formatDateTime, formatNumber, idempotencyKey, queryString, titleCase } from '../api';
import { useAuth } from '../auth';
import { useApi, useAction } from '../hooks';
import { useToast } from '../toast';
import {
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Icon,
  MetaList,
  PageHeader,
  Spinner,
  Stat,
  StatusPill,
  type Column,
} from '../ui';
import { LocationSelect, ProductSelect, ReasonDialog } from '../components/forms';
import { LedgerDialog } from '../components/LedgerDialog';

interface CountRow {
  id: string;
  count_no: string;
  count_type: string;
  status: string;
  warehouse_id: string;
  location_id: string | null;
  box_id: string | null;
  location_code: string | null;
  box_code: string | null;
  created_by_name: string | null;
  line_count: number;
  difference_count: number;
  created_at: string;
  submitted_at: string | null;
  posted_at: string | null;
  notes: string | null;
}

interface CountList {
  rows: CountRow[];
  total: number;
  limit: number;
  offset: number;
}

interface CountLine {
  id: string;
  count_id: string;
  product_id: string;
  batch_id: string | null;
  box_id: string | null;
  location_id: string;
  pool_id: string | null;
  system_qty: number;
  counted_qty: number | null;
  difference: number | null;
  reason: string | null;
  investigation_status: string | null;
  adjustment_txn_id: string | null;
  sku: string;
  product_name: string;
  location_code: string;
  pool_code: string | null;
  batch_no: string | null;
  box_code: string | null;
  adjustment_txn_no: string | null;
}

interface CountException {
  id: string;
  exception_no: string;
  type: string;
  severity: string;
  status: string;
  description: string;
}

interface CountDetail extends CountRow {
  location: { id: string; code: string; type: string } | null;
  box: { id: string; box_code: string; status: string } | null;
  lines: CountLine[];
  exceptions: CountException[];
}

interface BoxOption {
  id: string;
  box_code: string;
  status: string;
  location_id: string | null;
  location_code: string | null;
}

const STATUSES = ['DRAFT', 'IN_PROGRESS', 'PENDING_APPROVAL', 'POSTED', 'REJECTED', 'CANCELLED'];
const COUNT_TYPES = ['AD_HOC', 'SCHEDULED', 'BLIND', 'LOCATION', 'SKU', 'BOX', 'BATCH', 'FULL'];

export function CountsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [version, setVersion] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const selectedId = params.get('count');

  const list = useApi<CountList>(`/cycle-counts${queryString({ status: status || undefined, limit: 200 })}`, version);
  const rows = list.data?.rows ?? [];

  const openCount = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('count', id);
    setParams(next, { replace: true });
  };
  const closeCount = () => {
    const next = new URLSearchParams(params);
    next.delete('count');
    setParams(next, { replace: true });
  };

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => ({
          pending: acc.pending + (row.status === 'PENDING_APPROVAL' ? 1 : 0),
          posted: acc.posted + (row.status === 'POSTED' ? 1 : 0),
          differences: acc.differences + Number(row.difference_count),
          open: acc.open + (['DRAFT', 'IN_PROGRESS'].includes(row.status) ? 1 : 0),
        }),
        { pending: 0, posted: 0, differences: 0, open: 0 },
      ),
    [rows],
  );

  const columns: Array<Column<CountRow>> = [
    {
      key: 'count_no',
      header: 'Count',
      render: (row) => (
        <div className="cell-title">
          <strong>{row.count_no}</strong>
          <span className="muted tiny">{titleCase(row.count_type)} count</span>
        </div>
      ),
    },
    {
      key: 'scope',
      header: 'Scope',
      render: (row) => (
        <div>
          <strong>{row.box_code ?? row.location_code ?? '—'}</strong>
          <span className="muted tiny">{row.box_code ? 'Box' : 'Location'}</span>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
    {
      key: 'line_count',
      header: 'Lines',
      className: 'num',
      render: (row) => (
        <div className="cell-title right">
          <strong>{formatNumber(row.line_count)}</strong>
          <span className={Number(row.difference_count) ? 'text-warning tiny' : 'muted tiny'}>
            {formatNumber(row.difference_count)} difference{Number(row.difference_count) === 1 ? '' : 's'}
          </span>
        </div>
      ),
    },
    { key: 'created_by_name', header: 'Created by', render: (row) => row.created_by_name ?? '—' },
    {
      key: 'created_at',
      header: 'Created',
      render: (row) => <span className="muted small">{formatDateTime(row.created_at)}</span>,
    },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <button type="button" className="btn btn-subtle btn-xs" onClick={() => openCount(row.id)}>
          Open
        </button>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        eyebrow="Stock accuracy"
        title="Cycle counts"
        subtitle="Count physical stock by location or box, record variances and post authorised, fully audited adjustments."
        actions={
          can('cycle_count.manage') ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={16} /> New cycle count
            </button>
          ) : null
        }
      />

      <div className="stat-grid four">
        <Stat label="Counts in view" value={formatNumber(rows.length)} icon="counts" />
        <Stat label="In progress" value={formatNumber(totals.open)} icon="clock" tone="warning" />
        <Stat label="Awaiting approval" value={formatNumber(totals.pending)} icon="lock" tone="info" />
        <Stat label="Posted" value={formatNumber(totals.posted)} icon="check" tone="success" />
      </div>

      <Card
        title="Count register"
        subtitle={
          list.data
            ? `${formatNumber(list.data.total)} counts${list.data.total > rows.length ? ` · showing ${rows.length}` : ''}`
            : 'Loading count register'
        }
        actions={
          <div className="toolbar">
            <select className="input compact-input" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              {STATUSES.map((value) => (
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
          onRowClick={(row) => openCount(row.id)}
          emptyTitle="No cycle counts match this filter"
          emptyMessage="Create a count for a location or box to verify physical stock against the ledger."
        />
      </Card>

      {selectedId ? (
        <CountDetailDialog
          id={selectedId}
          onClose={closeCount}
          onChanged={() => {
            setVersion((value) => value + 1);
            toast.notify('Cycle count updated.', 'success');
          }}
        />
      ) : null}

      <CreateCountDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id, countNo) => {
          setCreateOpen(false);
          setVersion((value) => value + 1);
          toast.notify(`Cycle count ${countNo} created.`, 'success');
          openCount(id);
        }}
      />
    </div>
  );
}

function CreateCountDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string, countNo: string) => void;
}) {
  const [scope, setScope] = useState<'LOCATION' | 'BOX'>('LOCATION');
  const [countType, setCountType] = useState('LOCATION');
  const [locationId, setLocationId] = useState('');
  const [boxId, setBoxId] = useState('');
  const [productId, setProductId] = useState('');
  const [notes, setNotes] = useState('');
  const action = useAction();
  const boxes = useApi<{ rows: BoxOption[] }>(open ? '/boxes?limit=200' : null);

  useEffect(() => {
    if (open) {
      setScope('LOCATION');
      setCountType('LOCATION');
      setLocationId('');
      setBoxId('');
      setProductId('');
      setNotes('');
      action.setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const positionedBoxes = (boxes.data?.rows ?? []).filter((box) => box.location_id);

  const submit = async () => {
    const result = await action.run(() =>
      api.post<{ id: string; countNo: string }>(
        '/cycle-counts',
        {
          countType,
          locationId: scope === 'LOCATION' ? locationId : null,
          boxId: scope === 'BOX' ? boxId : null,
          productId: productId || null,
          notes: notes.trim() || null,
        },
        idempotencyKey(),
      ),
    );
    if (result) onCreated(result.id, result.countNo);
  };

  const ready = scope === 'LOCATION' ? Boolean(locationId) : Boolean(boxId);

  return (
    <Dialog
      open={open}
      title="Create cycle count"
      subtitle="Lines are generated from the canonical ledger for the selected scope."
      onClose={onClose}
      wide
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={action.running || !ready}>
            {action.running ? 'Creating…' : 'Create count'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={action.error} />
        <div className="form-grid">
          <Field label="Count scope" required>
            <select
              className="input"
              value={scope}
              onChange={(event) => {
                const value = event.target.value as 'LOCATION' | 'BOX';
                setScope(value);
                setCountType(value === 'BOX' ? 'BOX' : 'LOCATION');
              }}
            >
              <option value="LOCATION">Location</option>
              <option value="BOX">Box (mixed box contents)</option>
            </select>
          </Field>
          <Field label="Count type" required>
            <select className="input" value={countType} onChange={(event) => setCountType(event.target.value)}>
              {COUNT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </select>
          </Field>
          {scope === 'LOCATION' ? (
            <Field label="Location" required hint="All available stock at this location is included.">
              <LocationSelect value={locationId} onChange={setLocationId} />
            </Field>
          ) : (
            <Field label="Box" required hint="Only boxes positioned at a location can be counted.">
              <select className="input" value={boxId} onChange={(event) => setBoxId(event.target.value)}>
                <option value="">Select a box</option>
                {positionedBoxes.map((box) => (
                  <option key={box.id} value={box.id}>
                    {box.box_code} · {box.location_code} · {titleCase(box.status)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Limit to product" hint="Optional — otherwise every stock line in scope is counted.">
            <ProductSelect value={productId} onChange={setProductId} placeholder="All products" />
          </Field>
          <Field label="Notes" className="span-2">
            <input className="input" value={notes} maxLength={1000} onChange={(event) => setNotes(event.target.value)} />
          </Field>
        </div>
        <p className="muted small">
          Creating a count never changes stock. Differences only post after counts are recorded and, when configured, approved
          by a second user.
        </p>
      </div>
    </Dialog>
  );
}

function CountDetailDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can, user } = useAuth();
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const detail = useApi<CountDetail>(`/cycle-counts/${id}`, version);
  const [entries, setEntries] = useState<Record<string, { counted: string; reason: string }>>({});
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const saveAction = useAction();
  const transitionAction = useAction();

  const data = detail.data;
  const editable = Boolean(data && ['DRAFT', 'IN_PROGRESS'].includes(data.status));
  const canManage = can('cycle_count.manage');
  const canApprove = can('cycle_count.approve');

  useEffect(() => {
    if (!detail.data) return;
    const next: Record<string, { counted: string; reason: string }> = {};
    for (const line of detail.data.lines) {
      next[line.id] = {
        counted: line.counted_qty === null ? '' : String(line.counted_qty),
        reason: line.reason ?? '',
      };
    }
    setEntries(next);
  }, [detail.data]);

  const refresh = () => {
    setVersion((value) => value + 1);
    onChanged();
  };

  const updateEntry = (lineId: string, patch: Partial<{ counted: string; reason: string }>) => {
    setEntries((current) => ({
      ...current,
      [lineId]: { counted: current[lineId]?.counted ?? '', reason: current[lineId]?.reason ?? '', ...patch },
    }));
  };

  const pendingLines = useMemo(() => {
    if (!data) return [] as Array<{ lineId: string; countedQty: number; reason?: string | null }>;
    return data.lines
      .filter((line) => {
        const raw = entries[line.id]?.counted ?? '';
        return raw !== '' && Number(raw) >= 0 && Number.isInteger(Number(raw));
      })
      .map((line) => ({
        lineId: line.id,
        countedQty: Number(entries[line.id].counted),
        reason: entries[line.id]?.reason.trim() ? entries[line.id].reason.trim() : null,
      }));
  }, [data, entries]);

  const saveCounts = async () => {
    if (!data || !pendingLines.length) return;
    const result = await saveAction.run(() =>
      api.post(
        `/cycle-counts/${data.id}/count`,
        { lines: pendingLines },
        idempotencyKey(),
      ),
    );
    if (result !== undefined) {
      toast.notify('Counted quantities recorded.', 'success');
      refresh();
    }
  };

  const submit = async () => {
    if (!data) return;
    const result = await transitionAction.run(() =>
      api.post<{ status: string; transactions?: string[] }>(`/cycle-counts/${data.id}/submit`, {}, idempotencyKey()),
    );
    if (result) {
      toast.notify(
        result.status === 'POSTED'
          ? `Count posted with ${result.transactions?.length ?? 0} adjustment movement(s).`
          : 'Count submitted for approval.',
        'success',
      );
      refresh();
    }
  };

  const approve = async () => {
    if (!data) return;
    const result = await transitionAction.run(() =>
      api.post<{ status: string; transactions: string[] }>(`/cycle-counts/${data.id}/approve`, {}, idempotencyKey()),
    );
    if (result) {
      toast.notify(`Count approved and posted with ${result.transactions.length} adjustment movement(s).`, 'success');
      refresh();
    }
  };

  const countedCount = data ? data.lines.filter((line) => line.counted_qty !== null).length : 0;
  const differenceCount = data ? data.lines.filter((line) => Number(line.difference ?? 0) !== 0).length : 0;
  const absoluteDifference = data
    ? data.lines.reduce((sum, line) => sum + Math.abs(Number(line.difference ?? 0)), 0)
    : 0;

  const columns: Array<Column<CountLine>> = [
    {
      key: 'sku',
      header: 'SKU / product',
      render: (line) => (
        <div className="cell-title">
          <strong>{line.sku}</strong>
          <span className="muted tiny clamp-1">{line.product_name}</span>
        </div>
      ),
    },
    {
      key: 'location',
      header: 'Location / pool',
      render: (line) => (
        <div>
          <strong>{line.location_code}</strong>
          <span className="muted tiny">{line.pool_code ?? '—'}</span>
        </div>
      ),
    },
    {
      key: 'batch',
      header: 'Batch / box',
      render: (line) => (
        <div>
          <span>{line.batch_no ?? '—'}</span>
          <span className="muted tiny">{line.box_code ?? ''}</span>
        </div>
      ),
    },
    { key: 'system_qty', header: 'System', className: 'num', render: (line) => formatNumber(line.system_qty) },
    {
      key: 'counted_qty',
      header: 'Counted',
      className: 'num',
      render: (line) =>
        editable ? (
          <input
            className="input compact-input counted-input"
            type="number"
            min={0}
            step={1}
            value={entries[line.id]?.counted ?? ''}
            placeholder="—"
            onChange={(event) => updateEntry(line.id, { counted: event.target.value })}
          />
        ) : line.counted_qty === null ? (
          <span className="muted">Not counted</span>
        ) : (
          formatNumber(line.counted_qty)
        ),
    },
    {
      key: 'difference',
      header: 'Difference',
      className: 'num',
      render: (line) => {
        if (line.counted_qty === null) return <span className="muted">—</span>;
        const difference = Number(line.difference ?? 0);
        return (
          <span className={difference === 0 ? 'text-success strong' : 'text-danger strong'}>
            {difference > 0 ? '+' : ''}
            {formatNumber(difference)}
          </span>
        );
      },
    },
    {
      key: 'reason',
      header: 'Variance note',
      render: (line) =>
        editable ? (
          <input
            className="input compact-input"
            value={entries[line.id]?.reason ?? ''}
            maxLength={500}
            placeholder="If counted differs"
            onChange={(event) => updateEntry(line.id, { reason: event.target.value })}
          />
        ) : (
          <span className="muted small">{line.reason ?? '—'}</span>
        ),
    },
    {
      key: 'adjustment',
      header: 'Adjustment',
      render: (line) =>
        line.adjustment_txn_no ? (
          <div>
            <code className="code">{line.adjustment_txn_no}</code>
            <span className="muted tiny">{titleCase(line.investigation_status ?? 'NONE')}</span>
          </div>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ];

  return (
    <Dialog
      open
      title={data ? `Cycle count ${data.count_no}` : 'Cycle count'}
      subtitle={data ? `${titleCase(data.count_type)} · ${titleCase(data.status)}` : 'Loading count'}
      onClose={onClose}
      extraWide
      footer={
        <div className="form-actions spread">
          <div className="inline-actions">
            <button type="button" className="btn btn-subtle" onClick={() => setLedgerOpen(true)}>
              <Icon name="audit" size={15} /> Ledger
            </button>
            {editable && canManage ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={saveAction.running || pendingLines.length === 0}
                onClick={() => void saveCounts()}
              >
                {saveAction.running ? 'Saving…' : `Save ${pendingLines.length || ''} counted line${pendingLines.length === 1 ? '' : 's'}`}
              </button>
            ) : null}
            {editable && canManage ? (
              <button type="button" className="btn btn-subtle" disabled={transitionAction.running} onClick={() => void submit()}>
                Submit
              </button>
            ) : null}
            {data?.status === 'PENDING_APPROVAL' && canApprove ? (
              <button type="button" className="btn btn-primary" disabled={transitionAction.running} onClick={() => void approve()}>
                Approve & post
              </button>
            ) : null}
            {data?.status === 'PENDING_APPROVAL' && canApprove ? (
              <button type="button" className="btn btn-danger" onClick={() => setRejectOpen(true)}>
                Reject
              </button>
            ) : null}
            {data && ['DRAFT', 'IN_PROGRESS', 'PENDING_APPROVAL'].includes(data.status) && canManage ? (
              <button type="button" className="btn btn-danger" onClick={() => setCancelOpen(true)}>
                Cancel count
              </button>
            ) : null}
          </div>
          <button type="button" className="btn btn-subtle" onClick={onClose}>
            Close
          </button>
        </div>
      }
    >
      {detail.loading && !data ? <Spinner label="Loading count lines…" /> : null}
      <ErrorNote error={detail.error ?? saveAction.error ?? transitionAction.error} />
      {data ? (
        <div className="stack">
          <div className="stat-grid four">
            <Stat label="Lines" value={formatNumber(data.lines.length)} icon="counts" />
            <Stat label="Counted" value={formatNumber(countedCount)} icon="check" tone="info" />
            <Stat label="Differences" value={formatNumber(differenceCount)} icon="alert" tone={differenceCount ? 'warning' : 'success'} />
            <Stat label="Absolute variance" value={formatNumber(absoluteDifference)} icon="adjust" tone={absoluteDifference ? 'danger' : 'success'} />
          </div>

          <div className="detail-grid">
            <MetaList
              items={[
                { label: 'Count no', value: <strong>{data.count_no}</strong> },
                { label: 'Type', value: titleCase(data.count_type) },
                { label: 'Status', value: <StatusPill value={data.status} /> },
                { label: 'Location', value: data.location ? `${data.location.code} · ${titleCase(data.location.type)}` : '—' },
                { label: 'Box', value: data.box ? `${data.box.box_code} · ${titleCase(data.box.status)}` : '—' },
                { label: 'Created by', value: data.created_by_name ?? '—' },
                { label: 'Created', value: formatDateTime(data.created_at) },
                { label: 'Submitted', value: data.submitted_at ? formatDateTime(data.submitted_at) : '—' },
                { label: 'Posted', value: data.posted_at ? formatDateTime(data.posted_at) : '—' },
              ]}
            />
            <div className="detail-actions">
              {data.notes ? <p className="muted small">{data.notes}</p> : null}
              {editable ? (
                <p className="muted small">
                  Enter the physically counted quantity for every line. Differences post as ledger adjustments only after
                  submission and any required approval.
                </p>
              ) : null}
              <p className="muted tiny">Approval must come from a user with <code>cycle_count.approve</code>.</p>
            </div>
          </div>

          <div>
            <h3 className="section-title">Count lines</h3>
            <DataTable
              columns={columns}
              rows={data.lines}
              rowKey={(line) => line.id}
              compact
              emptyTitle="No lines in this count"
            />
          </div>

          <div>
            <h3 className="section-title">Linked exceptions</h3>
            {data.exceptions.length === 0 ? (
              <EmptyState title="No discrepancies raised" message="Exceptions appear automatically when counted stock differs from the ledger." icon="check" />
            ) : (
              <div className="list-gap">
                {data.exceptions.map((exception) => (
                  <Link className="list-row" key={exception.id} to={`/exceptions?id=${exception.id}`}>
                    <div>
                      <strong>{exception.exception_no}</strong>
                      <span className="muted small clamp-1">{exception.description}</span>
                    </div>
                    <StatusPill value={exception.severity} />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      <LedgerDialog
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
        title="Cycle count ledger"
        subtitle={data ? data.count_no : undefined}
        referenceId={data?.id}
        canReverse={can('inventory.adjust.approve')}
        onChanged={refresh}
      />

      <ReasonDialog
        open={rejectOpen}
        title={data ? `Reject ${data.count_no}` : 'Reject count'}
        label="Rejection reason"
        confirmLabel="Reject count"
        danger
        onClose={() => setRejectOpen(false)}
        onConfirm={async (reason) => {
          if (!data) return;
          await api.post(`/cycle-counts/${data.id}/reject`, { reason }, idempotencyKey());
          toast.notify('Cycle count rejected.', 'warning');
          refresh();
        }}
      />

      <ReasonDialog
        open={cancelOpen}
        title={data ? `Cancel ${data.count_no}` : 'Cancel count'}
        label="Cancellation reason"
        confirmLabel="Cancel count"
        danger
        onClose={() => setCancelOpen(false)}
        onConfirm={async (reason) => {
          if (!data) return;
          await api.post(`/cycle-counts/${data.id}/cancel`, { reason }, idempotencyKey());
          toast.notify('Cycle count cancelled.', 'warning');
          refresh();
        }}
      />
    </Dialog>
  );
}
