import { useState } from 'react';
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
import { LedgerDialog } from '../components/LedgerDialog';
import {
  BatchSelect,
  LocationSelect,
  PoolSelect,
  ProductSelect,
  ReasonDialog,
  useProductOptions,
} from '../components/forms';

interface TransferRow {
  id: string;
  transfer_no: string;
  transfer_type: string;
  status: string;
  reason: string | null;
  from_location_code: string | null;
  transit_location_code: string | null;
  from_pool_code: string;
  to_pool_code: string;
  line_count: number;
  created_at: string;
  approved_at: string | null;
  dispatched_at: string | null;
  received_at: string | null;
}

interface TransferList {
  rows: TransferRow[];
  total: number;
}

interface TransferLine {
  id: string;
  line_no: number;
  product_id: string;
  batch_id: string | null;
  box_id: string | null;
  quantity: number;
  dispatched_qty: number;
  received_qty: number;
  destination_location_id: string | null;
  sku: string;
  product_name: string;
  batch_no: string | null;
  expiry_date: string | null;
  box_code: string | null;
  destination_location_code: string | null;
}

interface TransferDetail {
  id: string;
  transfer_no: string;
  transfer_type: string;
  status: string;
  reason: string | null;
  from_warehouse_id: string;
  from_location_id: string;
  from_pool_id: string;
  to_pool_id: string;
  transit_location_id: string;
  created_at: string;
  approved_at: string | null;
  dispatched_at: string | null;
  received_at: string | null;
  fromLocation: { id: string; code: string; type: string } | null;
  transitLocation: { id: string; code: string; type: string } | null;
  lines: TransferLine[];
}

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'IN_TRANSIT', label: 'In transit' },
  { value: 'PARTIALLY_RECEIVED', label: 'Partially received' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export function TransfersPage() {
  const { can, meta } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const selected = params.get('transfer');
  const [version, setVersion] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

  const transfers = useApi<TransferList>(
    `/transfers${queryString({ status: status || undefined, limit: 200 })}`,
    version,
  );
  const rows = transfers.data?.rows ?? [];

  const setStatus = (value: string) => {
    const updated = new URLSearchParams(params);
    if (value) updated.set('status', value);
    else updated.delete('status');
    setParams(updated, { replace: true });
  };
  const openTransfer = (id: string) => {
    const updated = new URLSearchParams(params);
    updated.set('transfer', id);
    setParams(updated, { replace: true });
  };
  const closeTransfer = () => {
    const updated = new URLSearchParams(params);
    updated.delete('transfer');
    setParams(updated, { replace: true });
  };
  const refresh = () => setVersion((value) => value + 1);

  const pending = rows.filter((row) => row.status === 'PENDING_APPROVAL').length;
  const transit = rows.filter((row) => ['IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(row.status)).length;
  const completed = rows.filter((row) => row.status === 'COMPLETED').length;

  const columns: Array<Column<TransferRow>> = [
    {
      key: 'transfer_no',
      header: 'Transfer',
      render: (row) => (
        <div className="cell-title">
          <strong>{row.transfer_no}</strong>
          <span className="muted tiny">{titleCase(row.transfer_type)}</span>
        </div>
      ),
    },
    {
      key: 'route',
      header: 'Route',
      render: (row) => (
        <div className="cell-title">
          <span>
            {row.from_pool_code} → {row.to_pool_code}
          </span>
          <span className="muted tiny">
            {row.from_location_code ?? '—'} → {row.transit_location_code ? `${row.transit_location_code} · transit` : '—'}
          </span>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
    { key: 'line_count', header: 'Lines', className: 'num', render: (row) => formatNumber(row.line_count) },
    {
      key: 'reason',
      header: 'Reason',
      render: (row) => <span className="muted small clamp-1">{row.reason ?? '—'}</span>,
    },
    { key: 'created_at', header: 'Created', render: (row) => <span className="muted small">{formatDateTime(row.created_at)}</span> },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <button
          type="button"
          className="btn btn-subtle btn-xs"
          onClick={(event) => {
            event.stopPropagation();
            openTransfer(row.id);
          }}
        >
          Open
        </button>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        eyebrow="Stock movements"
        title="Transfers"
        subtitle="Move stock between pools or between rack locations through transit, with approval and receiving recorded on the ledger."
        actions={
          <div className="inline-actions">
            {can('transfer.request') ? (
              <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                <Icon name="plus" size={15} /> New transfer
              </button>
            ) : null}
            <button type="button" className="btn btn-subtle" onClick={refresh} disabled={transfers.loading}>
              <Icon name="refresh" size={15} /> Refresh
            </button>
          </div>
        }
      />

      <div className="stat-grid four">
        <Stat label="Transfers in view" value={formatNumber(transfers.data?.total ?? 0)} icon="transfer" />
        <Stat label="Pending approval" value={formatNumber(pending)} icon="clock" tone="warning" />
        <Stat label="In transit" value={formatNumber(transit)} icon="inbound" tone="info" />
        <Stat label="Completed" value={formatNumber(completed)} icon="check" tone="success" />
      </div>

      <Card
        title="Transfer queue"
        subtitle="Transfers post outbound movements into transit and inbound movements on receipt; quantities cannot be silently adjusted."
        flush
        actions={
          <select className="input compact-input" value={status} onChange={(event) => setStatus(event.target.value)}>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value || 'all'} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        }
      >
        <ErrorNote error={transfers.error} />
        <DataTable
          columns={columns}
          rows={rows}
          loading={transfers.loading}
          rowKey={(row) => row.id}
          onRowClick={(row) => openTransfer(row.id)}
          emptyTitle="No transfers"
          emptyMessage="Create a transfer to move stock between pools or locations."
        />
      </Card>

      {selected ? (
        <TransferDetailDialog
          id={selected}
          onClose={closeTransfer}
          onChanged={() => {
            refresh();
            toast.notify('Transfer updated and ledger posted.', 'success');
          }}
        />
      ) : null}

      {createOpen ? (
        <NewTransferDialog
          pools={meta?.pools ?? []}
          onClose={() => setCreateOpen(false)}
          onCreated={(transfer) => {
            setCreateOpen(false);
            refresh();
            toast.notify(`Transfer ${transfer.transferNo} created (${titleCase(transfer.status)}).`, 'success');
            openTransfer(transfer.id);
          }}
        />
      ) : null}
    </div>
  );
}

function TransferDetailDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can, meta } = useAuth();
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const state = useApi<TransferDetail>(`/transfers/${id}`, version);
  const action = useAction();
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const transfer = state.data;
  const fromPool = meta?.pools.find((pool) => pool.id === transfer?.from_pool_id);
  const toPool = meta?.pools.find((pool) => pool.id === transfer?.to_pool_id);

  const refresh = () => {
    setVersion((value) => value + 1);
    onChanged();
  };

  const run = async (path: string, success: string) => {
    const result = await action.run(() => api.post(`/transfers/${id}/${path}`, {}, idempotencyKey()));
    if (result !== undefined) {
      toast.notify(success, 'success');
      refresh();
    }
  };

  const lineColumns: Array<Column<TransferLine>> = [
    { key: 'line_no', header: '#', className: 'num' },
    {
      key: 'sku',
      header: 'Item',
      render: (line) => (
        <div className="cell-title">
          <strong>{line.sku}</strong>
          <span className="muted tiny">{line.product_name}</span>
        </div>
      ),
    },
    {
      key: 'batch',
      header: 'Batch',
      render: (line) => (line.batch_no ? `${line.batch_no}${line.expiry_date ? ` · exp ${line.expiry_date}` : ''}` : '—'),
    },
    { key: 'quantity', header: 'Planned', className: 'num', render: (line) => formatNumber(line.quantity) },
    { key: 'dispatched_qty', header: 'Dispatched', className: 'num', render: (line) => formatNumber(line.dispatched_qty) },
    { key: 'received_qty', header: 'Received', className: 'num', render: (line) => formatNumber(line.received_qty) },
    { key: 'destination_location_code', header: 'Destination', render: (line) => line.destination_location_code ?? '—' },
  ];

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        extraWide
        title={transfer ? `Transfer ${transfer.transfer_no}` : 'Transfer'}
        subtitle={transfer ? `${titleCase(transfer.transfer_type)} · ${fromPool?.code ?? '—'} → ${toPool?.code ?? '—'}` : undefined}
        footer={
          <div className="dialog-footer-row">
            <span className="muted small">Approval, dispatch and receiving are separate permissions and separate ledger events.</span>
            <div className="inline-actions">
              <button type="button" className="btn btn-subtle" onClick={onClose}>
                Close
              </button>
              {transfer?.status === 'PENDING_APPROVAL' && can('transfer.approve') ? (
                <button type="button" className="btn btn-primary" disabled={action.running} onClick={() => void run('approve', 'Transfer approved.')}>
                  Approve
                </button>
              ) : null}
              {transfer?.status === 'APPROVED' && can('transfer.execute') ? (
                <button type="button" className="btn btn-primary" disabled={action.running} onClick={() => void run('dispatch', 'Transfer dispatched into transit.')}>
                  Dispatch
                </button>
              ) : null}
              {transfer && ['IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(transfer.status) && can('transfer.execute') ? (
                <button type="button" className="btn btn-primary" onClick={() => setReceiveOpen(true)}>
                  Receive
                </button>
              ) : null}
              {transfer && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(transfer.status) && can('transfer.request') ? (
                <button type="button" className="btn btn-danger" onClick={() => setCancelOpen(true)}>
                  Cancel
                </button>
              ) : null}
            </div>
          </div>
        }
      >
        {state.loading && !transfer ? <div className="center-pad"><Spinner label="Loading transfer…" /></div> : null}
        <ErrorNote error={state.error ?? action.error} />
        {transfer ? (
          <div className="stack">
            <div className="detail-grid">
              <MetaList
                items={[
                  { label: 'Status', value: <StatusPill value={transfer.status} /> },
                  { label: 'Type', value: titleCase(transfer.transfer_type) },
                  { label: 'From location', value: transfer.fromLocation?.code ?? '—' },
                  { label: 'Transit', value: transfer.transitLocation?.code ?? '—' },
                  { label: 'From pool', value: fromPool ? `${fromPool.code} · ${fromPool.name}` : '—' },
                  { label: 'To pool', value: toPool ? `${toPool.code} · ${toPool.name}` : '—' },
                ]}
              />
              <MetaList
                items={[
                  { label: 'Created', value: formatDateTime(transfer.created_at) },
                  { label: 'Approved', value: formatDateTime(transfer.approved_at) },
                  { label: 'Dispatched', value: formatDateTime(transfer.dispatched_at) },
                  { label: 'Received', value: formatDateTime(transfer.received_at) },
                  { label: 'Reason', value: transfer.reason ?? '—' },
                  { label: 'Lines', value: String(transfer.lines.length) },
                ]}
              />
            </div>

            <Card title="Transfer lines" flush>
              <DataTable columns={lineColumns} rows={transfer.lines} rowKey={(line) => line.id} emptyTitle="No lines" />
            </Card>

            <div className="inline-actions">
              <button type="button" className="btn btn-subtle" onClick={() => setLedgerOpen(true)}>
                <Icon name="trace" size={14} /> Ledger
              </button>
            </div>
          </div>
        ) : null}
      </Dialog>

      {receiveOpen && transfer ? (
        <ReceiveTransferDialog
          transfer={transfer}
          onClose={() => setReceiveOpen(false)}
          onDone={() => {
            setReceiveOpen(false);
            refresh();
          }}
        />
      ) : null}

      <ReasonDialog
        open={cancelOpen}
        title={`Cancel ${transfer?.transfer_no ?? 'transfer'}`}
        label="Cancellation reason"
        confirmLabel="Cancel transfer"
        danger
        onClose={() => setCancelOpen(false)}
        onConfirm={async (reason) => {
          const result = await api.post(`/transfers/${id}/cancel`, { reason }, idempotencyKey());
          toast.notify('Transfer cancelled.', 'success');
          refresh();
          return result;
        }}
      />

      <LedgerDialog
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
        title="Transfer ledger"
        subtitle={transfer?.transfer_no}
        referenceId={transfer?.id ?? id}
        canReverse={can('inventory.adjust.approve')}
        onChanged={() => setVersion((value) => value + 1)}
      />
    </>
  );
}

function ReceiveTransferDialog({
  transfer,
  onClose,
  onDone,
}: {
  transfer: TransferDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const outstandingLines = transfer.lines.filter((line) => Number(line.dispatched_qty) - Number(line.received_qty) > 0);
  const [quantities, setQuantities] = useState<Record<string, string>>(
    Object.fromEntries(outstandingLines.map((line) => [line.id, String(Number(line.dispatched_qty) - Number(line.received_qty))])),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();

  const submit = async () => {
    setFormError(null);
    const lines: Array<{ lineId: string; quantity: number }> = [];
    for (const line of outstandingLines) {
      const qty = Number.parseInt(quantities[line.id] ?? '0', 10);
      if (!Number.isInteger(qty) || qty < 0) return setFormError('Received quantities must be non-negative whole numbers.');
      if (qty > Number(line.dispatched_qty) - Number(line.received_qty)) {
        return setFormError(`Only ${Number(line.dispatched_qty) - Number(line.received_qty)} units of ${line.sku} remain in transit.`);
      }
      if (qty > 0) lines.push({ lineId: line.id, quantity: qty });
    }
    if (!lines.length) return setFormError('Enter a quantity to receive on at least one line.');
    const result = await action.run(() =>
      api.post(`/transfers/${transfer.id}/receive`, { lines }, idempotencyKey()),
    );
    if (result !== undefined) onDone();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Receive ${transfer.transfer_no}`}
      subtitle="Received units move from transit into the destination pool and location."
      wide
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={action.running}>
            {action.running ? 'Posting receipt…' : 'Receive stock'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={formError ?? action.error} />
        <div className="line-editor">
          <div className="line-editor-head">
            <strong>In-transit lines</strong>
            <span className="muted small">Defaults to the full outstanding quantity.</span>
          </div>
          {outstandingLines.map((line) => {
            const outstanding = Number(line.dispatched_qty) - Number(line.received_qty);
            return (
              <div className="line-row" key={line.id}>
                <div className="line-summary">
                  <strong>{line.sku}</strong>
                  <span className="muted small">{line.product_name}</span>
                  <span className="tiny muted">
                    {outstanding} in transit → {line.destination_location_code ?? 'destination'}
                    {line.batch_no ? ` · batch ${line.batch_no}` : ''}
                  </span>
                </div>
                <div className="line-fields">
                  <Field label="Receive qty">
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={outstanding}
                      value={quantities[line.id] ?? '0'}
                      onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value }))}
                    />
                  </Field>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}

interface TransferDraftLine {
  key: number;
  productId: string;
  quantity: string;
  batchId: string;
}

let transferLineKey = 1;

function newTransferLine(): TransferDraftLine {
  return { key: transferLineKey++, productId: '', quantity: '1', batchId: '' };
}

function NewTransferDialog({
  pools,
  onClose,
  onCreated,
}: {
  pools: Array<{ id: string; code: string; name: string }>;
  onClose: () => void;
  onCreated: (transfer: { id: string; transferNo: string; status: string }) => void;
}) {
  const [transferType, setTransferType] = useState<'POOL_TO_POOL' | 'LOCATION_TO_LOCATION'>('POOL_TO_POOL');
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [fromPoolId, setFromPoolId] = useState('');
  const [toPoolId, setToPoolId] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<TransferDraftLine[]>([newTransferLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();
  const products = useProductOptions('', 'ACTIVE');
  const productMap = new Map(products.products.map((product) => [product.id, product]));

  const updateLine = (key: number, patch: Partial<TransferDraftLine>) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  const submit = async () => {
    setFormError(null);
    if (!fromLocationId) return setFormError('Choose the source location.');
    if (transferType === 'LOCATION_TO_LOCATION' && !toLocationId) return setFormError('Choose the destination location.');
    if (!fromPoolId) return setFormError('Choose the source pool.');
    if (!toPoolId) return setFormError('Choose the destination pool.');
    if (transferType === 'POOL_TO_POOL' && fromPoolId === toPoolId) return setFormError('A pool transfer needs two different pools.');
    const payloadLines: Array<{
      productId: string;
      quantity: number;
      batchId: string | null;
      boxId: string | null;
      destinationLocationId: string | null;
    }> = [];
    for (const line of lines) {
      if (!line.productId) continue;
      const quantity = Number.parseInt(line.quantity, 10);
      if (!Number.isInteger(quantity) || quantity <= 0) return setFormError('Transfer quantities must be positive whole numbers.');
      const tracked = productMap.get(line.productId)?.is_batch_tracked === 1;
      if (tracked && !line.batchId) return setFormError('Choose a batch for every batch-tracked product.');
      payloadLines.push({
        productId: line.productId,
        quantity,
        batchId: tracked ? line.batchId : null,
        boxId: null,
        destinationLocationId: toLocationId || null,
      });
    }
    if (!payloadLines.length) return setFormError('Add at least one product line.');

    const result = await action.run(() =>
      api.post(
        '/transfers',
        {
          transferType,
          fromLocationId,
          toLocationId: toLocationId || null,
          fromPoolId,
          toPoolId,
          transitLocationId: null,
          reason: reason.trim() || null,
          lines: payloadLines,
        },
        idempotencyKey(),
      ),
    );
    if (result) onCreated(result as { id: string; transferNo: string; status: string });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      extraWide
      title="New transfer"
      subtitle="Transfers are requested, approved and dispatched as separate steps; stock is unavailable while it is in transit."
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={action.running}>
            {action.running ? 'Requesting…' : 'Request transfer'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={formError ?? action.error} />
        <div className="form-grid three">
          <Field label="Transfer type" required>
            <select className="input" value={transferType} onChange={(event) => setTransferType(event.target.value as typeof transferType)}>
              <option value="POOL_TO_POOL">Pool to pool</option>
              <option value="LOCATION_TO_LOCATION">Location to location</option>
            </select>
          </Field>
          <Field label="Source location" required hint="Storage or staging locations only.">
            <LocationSelect value={fromLocationId} onChange={setFromLocationId} types={['RACK', 'STAGING']} required />
          </Field>
          <Field
            label="Destination location"
            required={transferType === 'LOCATION_TO_LOCATION'}
            hint={transferType === 'POOL_TO_POOL' ? 'Optional — leave blank to keep the stock at the source rack.' : undefined}
          >
            <LocationSelect value={toLocationId} onChange={setToLocationId} types={['RACK']} />
          </Field>
          <Field label="From pool" required>
            <PoolSelect value={fromPoolId} onChange={setFromPoolId} required />
          </Field>
          <Field label="To pool" required>
            <PoolSelect value={toPoolId} onChange={setToPoolId} required />
          </Field>
          <Field label="Reason">
            <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
          </Field>
        </div>

        <div className="line-editor">
          <div className="line-editor-head">
            <strong>Transfer lines</strong>
            <button type="button" className="btn btn-subtle btn-xs" onClick={() => setLines((current) => [...current, newTransferLine()])}>
              <Icon name="plus" size={13} /> Add line
            </button>
          </div>
          {lines.map((line) => {
            const tracked = productMap.get(line.productId)?.is_batch_tracked === 1;
            return (
              <div className="line-row" key={line.key}>
                <div className="line-fields">
                  <Field label="Product" required>
                    <ProductSelect
                      value={line.productId}
                      onChange={(value) => updateLine(line.key, { productId: value, batchId: '' })}
                      products={products.products}
                    />
                  </Field>
                  <Field label="Quantity" required>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      value={line.quantity}
                      onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                    />
                  </Field>
                  {tracked ? (
                    <Field label="Batch" required>
                      <BatchSelect
                        productId={line.productId}
                        value={line.batchId}
                        onChange={(value) => updateLine(line.key, { batchId: value })}
                        required
                      />
                    </Field>
                  ) : null}
                  <button
                    type="button"
                    className="icon-btn line-remove"
                    aria-label="Remove line"
                    disabled={lines.length === 1}
                    onClick={() => setLines((current) => current.filter((entry) => entry.key !== line.key))}
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <p className="muted small">
          Box contents cannot be transferred as a container; unpack the box first. Transfer lines require available stock in the source pool.
        </p>
      </div>
    </Dialog>
  );
}
