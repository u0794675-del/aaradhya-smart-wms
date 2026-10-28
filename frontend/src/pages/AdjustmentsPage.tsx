import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, formatDateTime, formatNumber, idempotencyKey, queryString, titleCase } from '../api';
import { useAuth } from '../auth';
import { useApi, useAction } from '../hooks';
import { useToast } from '../toast';
import {
  Card,
  DataTable,
  Dialog,
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
import {
  BatchSelect,
  LocationSelect,
  PoolSelect,
  ProductSelect,
  ReasonDialog,
  useProductOptions,
} from '../components/forms';
import { LedgerDialog } from '../components/LedgerDialog';

interface AdjustmentRow {
  id: string;
  adjustment_no: string;
  product_id: string;
  warehouse_id: string;
  location_id: string;
  pool_id: string;
  batch_id: string | null;
  box_id: string | null;
  direction: 'IN' | 'OUT';
  quantity: number;
  reason: string;
  status: string;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  transaction_id: string | null;
  sku: string;
  location_code: string;
  pool_code: string;
  requested_by_name: string | null;
  decided_by_name: string | null;
}

interface AdjustmentList {
  rows: AdjustmentRow[];
  total: number;
  limit: number;
  offset: number;
}

interface AdjustmentDetail extends AdjustmentRow {
  sku: string;
  product_name: string | null;
  batch_no: string | null;
  batch_expiry: string | null;
  box_code: string | null;
  location: { id: string; code: string; type: string } | null;
  pool: { id: string; code: string } | null;
  transaction: { id: string; txn_no: string; movement_type: string; quantity: number; created_at: string } | null;
}

interface BoxOption {
  id: string;
  box_code: string;
  status: string;
  location_code: string | null;
}

const STATUSES = ['PENDING_APPROVAL', 'POSTED', 'REJECTED'];

export function AdjustmentsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [version, setVersion] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const selectedId = params.get('id');
  const list = useApi<AdjustmentList>(`/adjustments${queryString({ status: status || undefined, limit: 200 })}`, version);
  const rows = list.data?.rows ?? [];

  const openAdjustment = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('id', id);
    setParams(next, { replace: true });
  };
  const closeAdjustment = () => {
    const next = new URLSearchParams(params);
    next.delete('id');
    setParams(next, { replace: true });
  };

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => ({
          pending: acc.pending + (row.status === 'PENDING_APPROVAL' ? 1 : 0),
          posted: acc.posted + (row.status === 'POSTED' ? 1 : 0),
          inQty: acc.inQty + (row.status === 'POSTED' && row.direction === 'IN' ? Number(row.quantity) : 0),
          outQty: acc.outQty + (row.status === 'POSTED' && row.direction === 'OUT' ? Number(row.quantity) : 0),
        }),
        { pending: 0, posted: 0, inQty: 0, outQty: 0 },
      ),
    [rows],
  );

  const columns: Array<Column<AdjustmentRow>> = [
    {
      key: 'adjustment_no',
      header: 'Adjustment',
      render: (row) => (
        <div className="cell-title">
          <strong>{row.adjustment_no}</strong>
          <span className="muted tiny">{row.sku}</span>
        </div>
      ),
    },
    {
      key: 'direction',
      header: 'Direction',
      render: (row) => (
        <span className={row.direction === 'IN' ? 'text-success strong' : 'text-danger strong'}>
          {row.direction === 'IN' ? 'Increase' : 'Decrease'}
        </span>
      ),
    },
    { key: 'quantity', header: 'Quantity', className: 'num', render: (row) => formatNumber(row.quantity) },
    { key: 'location_code', header: 'Location', render: (row) => `${row.location_code} · ${row.pool_code}` },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
    {
      key: 'reason',
      header: 'Reason',
      render: (row) => <span className="muted small clamp-1">{row.reason}</span>,
    },
    { key: 'requested_by_name', header: 'Requested by', render: (row) => row.requested_by_name ?? '—' },
    {
      key: 'requested_at',
      header: 'Requested',
      render: (row) => <span className="muted small">{formatDateTime(row.requested_at)}</span>,
    },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <button type="button" className="btn btn-subtle btn-xs" onClick={() => openAdjustment(row.id)}>
          Open
        </button>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        eyebrow="Authorised corrections"
        title="Stock adjustments"
        subtitle="Every correction is a validated ledger movement with a reason, requester and a second-person approval above the configured threshold."
        actions={
          can('inventory.adjust') ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={16} /> New adjustment
            </button>
          ) : null
        }
      />

      <div className="stat-grid four">
        <Stat label="Requests in view" value={formatNumber(rows.length)} icon="adjust" />
        <Stat label="Awaiting approval" value={formatNumber(totals.pending)} icon="lock" tone="warning" />
        <Stat label="Posted increases" value={formatNumber(totals.inQty)} icon="inbound" tone="success" />
        <Stat label="Posted decreases" value={formatNumber(totals.outQty)} icon="external" tone="danger" />
      </div>

      <Card
        title="Adjustment register"
        subtitle={
          list.data
            ? `${formatNumber(list.data.total)} requests${list.data.total > rows.length ? ` · showing ${rows.length}` : ''}`
            : 'Loading adjustment register'
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
          onRowClick={(row) => openAdjustment(row.id)}
          emptyTitle="No adjustments match this filter"
          emptyMessage="Raise an adjustment when physical stock needs a documented correction."
        />
      </Card>

      {selectedId ? (
        <AdjustmentDetailDialog
          id={selectedId}
          onClose={closeAdjustment}
          onChanged={() => {
            setVersion((value) => value + 1);
            list.reload();
          }}
        />
      ) : null}

      <CreateAdjustmentDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id, adjustmentNo, posted) => {
          setCreateOpen(false);
          setVersion((value) => value + 1);
          toast.notify(
            posted ? `Adjustment ${adjustmentNo} auto-posted under threshold.` : `Adjustment ${adjustmentNo} submitted for approval.`,
            posted ? 'success' : 'info',
          );
          openAdjustment(id);
        }}
      />
    </div>
  );
}

function CreateAdjustmentDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string, adjustmentNo: string, posted: boolean) => void;
}) {
  const { meta } = useAuth();
  const [productId, setProductId] = useState('');
  const [direction, setDirection] = useState<'IN' | 'OUT'>('IN');
  const [quantity, setQuantity] = useState('1');
  const [locationId, setLocationId] = useState('');
  const [poolId, setPoolId] = useState('');
  const [batchId, setBatchId] = useState('');
  const [boxId, setBoxId] = useState('');
  const [reason, setReason] = useState('');
  const action = useAction();
  const { products } = useProductOptions('', 'ACTIVE');
  const boxes = useApi<{ rows: BoxOption[] }>(open ? '/boxes?limit=200' : null);
  const product = products.find((row) => row.id === productId);

  useEffect(() => {
    if (open) {
      setProductId('');
      setDirection('IN');
      setQuantity('1');
      setLocationId('');
      setPoolId(meta?.pools[0]?.id ?? '');
      setBatchId('');
      setBoxId('');
      setReason('');
      action.setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    setBatchId('');
  }, [productId]);

  const activeBoxes = (boxes.data?.rows ?? []).filter((box) => !['RETIRED', 'DAMAGED'].includes(box.status));

  const submit = async () => {
    const result = await action.run(() =>
      api.post<{ id: string; adjustmentNo: string; status: string }>(
        '/adjustments',
        {
          productId,
          locationId,
          poolId,
          batchId: product?.is_batch_tracked === 1 ? batchId || null : null,
          boxId: boxId || null,
          direction,
          quantity: Number(quantity),
          reason: reason.trim(),
        },
        idempotencyKey(),
      ),
    );
    if (result) onCreated(result.id, result.adjustmentNo, result.status === 'POSTED');
  };

  const ready =
    Boolean(productId && locationId && poolId) &&
    Number.isInteger(Number(quantity)) &&
    Number(quantity) > 0 &&
    reason.trim().length >= 3 &&
    (product?.is_batch_tracked !== 1 || Boolean(batchId));

  return (
    <Dialog
      open={open}
      title="Raise stock adjustment"
      subtitle="The request is validated against the live ledger before any stock is posted."
      onClose={onClose}
      wide
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={action.running || !ready}>
            {action.running ? 'Submitting…' : 'Submit adjustment'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={action.error} />
        <div className="form-grid two">
          <Field label="Product" required>
            <ProductSelect value={productId} onChange={setProductId} products={products} />
          </Field>
          <Field label="Direction" required>
            <select className="input" value={direction} onChange={(event) => setDirection(event.target.value as 'IN' | 'OUT')}>
              <option value="IN">Increase stock</option>
              <option value="OUT">Decrease stock</option>
            </select>
          </Field>
          <Field label="Quantity (base units)" required>
            <input className="input" type="number" min={1} step={1} value={quantity} onChange={(event) => setQuantity(event.target.value)} />
          </Field>
          <Field label="Location" required>
            <LocationSelect value={locationId} onChange={setLocationId} />
          </Field>
          <Field label="Stock pool" required>
            <PoolSelect value={poolId} onChange={setPoolId} />
          </Field>
          {product?.is_batch_tracked === 1 ? (
            <Field label="Batch" required hint="Required for batch-tracked SKUs.">
              <BatchSelect productId={productId} value={batchId} onChange={setBatchId} required />
            </Field>
          ) : null}
          <Field label="Box" hint="Optional — adjust stock held inside a specific box.">
            <select className="input" value={boxId} onChange={(event) => setBoxId(event.target.value)}>
              <option value="">No box</option>
              {activeBoxes.map((box) => (
                <option key={box.id} value={box.id}>
                  {box.box_code} · {box.location_code ?? 'unpositioned'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reason" required className="span-2" hint="At least 3 characters; recorded in the audit trail.">
            <textarea className="input textarea" rows={3} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
          </Field>
        </div>
        <p className="muted small">
          Adjustments at or below the configured threshold may post immediately for users with approval rights. Every other
          request waits for a different approver.
        </p>
      </div>
    </Dialog>
  );
}

function ApproveDialog({
  open,
  title,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  onConfirm: (note: string) => Promise<unknown>;
}) {
  const [note, setNote] = useState('');
  const action = useAction();

  useEffect(() => {
    if (open) {
      setNote('');
      action.setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog
      open={open}
      title={title}
      subtitle="Approving posts an immutable ledger movement linked to this request."
      onClose={onClose}
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={action.running}
            onClick={() => {
              void action.run(async () => {
                await onConfirm(note.trim());
                onClose();
              });
            }}
          >
            {action.running ? 'Posting…' : 'Approve & post'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={action.error} />
        <Field label="Decision note" hint="Optional context stored with the approval.">
          <textarea className="input textarea" rows={3} value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function AdjustmentDetailDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can, user } = useAuth();
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const detail = useApi<AdjustmentDetail>(`/adjustments/${id}`, version);
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const data = detail.data;
  const canApprove = can('inventory.adjust.approve');
  const isOwnRequest = Boolean(data && user && data.requested_by === user.id);

  const refresh = () => {
    setVersion((value) => value + 1);
    onChanged();
  };

  return (
    <Dialog
      open
      title={data ? `Adjustment ${data.adjustment_no}` : 'Adjustment'}
      subtitle={data ? `${titleCase(data.direction === 'IN' ? 'stock increase' : 'stock decrease')} · ${titleCase(data.status)}` : 'Loading request'}
      onClose={onClose}
      wide
      footer={
        <div className="form-actions spread">
          <div className="inline-actions">
            <button type="button" className="btn btn-subtle" onClick={() => setLedgerOpen(true)}>
              <Icon name="audit" size={15} /> Ledger
            </button>
            {data?.status === 'PENDING_APPROVAL' && canApprove && !isOwnRequest ? (
              <button type="button" className="btn btn-primary" onClick={() => setApproveOpen(true)}>
                Approve & post
              </button>
            ) : null}
            {data?.status === 'PENDING_APPROVAL' && canApprove && !isOwnRequest ? (
              <button type="button" className="btn btn-danger" onClick={() => setRejectOpen(true)}>
                Reject
              </button>
            ) : null}
          </div>
          <button type="button" className="btn btn-subtle" onClick={onClose}>
            Close
          </button>
        </div>
      }
    >
      {detail.loading && !data ? <Spinner label="Loading adjustment…" /> : null}
      <ErrorNote error={detail.error} />
      {data ? (
        <div className="stack">
          <div className="stat-grid four">
            <Stat label="Direction" value={data.direction === 'IN' ? 'Increase' : 'Decrease'} icon={data.direction === 'IN' ? 'inbound' : 'external'} tone={data.direction === 'IN' ? 'success' : 'danger'} />
            <Stat label="Quantity" value={formatNumber(data.quantity)} icon="inventory" />
            <Stat label="Status" value={<StatusPill value={data.status} />} icon="clock" />
            <Stat label="Ledger transaction" value={data.transaction ? data.transaction.txn_no : 'Not posted'} icon="audit" tone={data.transaction ? 'success' : 'neutral'} />
          </div>

          <div className="detail-grid">
            <MetaList
              items={[
                { label: 'Adjustment no', value: <strong>{data.adjustment_no}</strong> },
                {
                  label: 'Product',
                  value: data.product_name ? `${data.product_name} (${data.sku ?? '—'})` : (data.sku ?? '—'),
                },
                { label: 'Location', value: data.location ? `${data.location.code} · ${titleCase(data.location.type)}` : (data.location_code ?? '—') },
                { label: 'Pool', value: data.pool ? data.pool.code : (data.pool_code ?? '—') },
                {
                  label: 'Batch',
                  value: data.batch_no
                    ? `${data.batch_no}${data.batch_expiry ? ` · exp ${data.batch_expiry}` : ''}`
                    : '—',
                },
                { label: 'Box', value: data.box_code ?? '—' },
                { label: 'Requested by', value: data.requested_by_name ?? '—' },
                { label: 'Requested', value: formatDateTime(data.requested_at) },
                { label: 'Decided by', value: data.decided_by_name ?? '—' },
                { label: 'Decided', value: data.decided_at ? formatDateTime(data.decided_at) : '—' },
              ]}
            />
            <div className="detail-actions">
              <div className="callout">
                <strong>Reason</strong>
                <p>{data.reason}</p>
              </div>
              {data.decision_reason ? (
                <div className="callout callout-info">
                  <strong>Decision note</strong>
                  <p>{data.decision_reason}</p>
                </div>
              ) : null}
              {data.status === 'PENDING_APPROVAL' && isOwnRequest ? (
                <p className="muted small">You requested this adjustment. A different authorised user must decide it.</p>
              ) : null}
              <p className="muted tiny">Posted adjustments cannot be edited; corrections require a linked reversal.</p>
            </div>
          </div>
        </div>
      ) : null}

      <LedgerDialog
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
        title="Adjustment ledger"
        subtitle={data ? data.adjustment_no : undefined}
        referenceId={data?.id}
        canReverse={can('inventory.adjust.approve')}
        onChanged={refresh}
      />

      <ApproveDialog
        open={approveOpen}
        title={data ? `Approve ${data.adjustment_no}` : 'Approve adjustment'}
        onClose={() => setApproveOpen(false)}
        onConfirm={async (note) => {
          if (!data) return;
          await api.post(`/adjustments/${data.id}/approve`, { note: note || null }, idempotencyKey());
          toast.notify('Adjustment approved and posted to the ledger.', 'success');
          refresh();
        }}
      />

      <ReasonDialog
        open={rejectOpen}
        title={data ? `Reject ${data.adjustment_no}` : 'Reject adjustment'}
        label="Rejection reason"
        confirmLabel="Reject adjustment"
        danger
        onClose={() => setRejectOpen(false)}
        onConfirm={async (reason) => {
          if (!data) return;
          await api.post(`/adjustments/${data.id}/reject`, { reason }, idempotencyKey());
          toast.notify('Adjustment rejected.', 'warning');
          refresh();
        }}
      />
    </Dialog>
  );
}
