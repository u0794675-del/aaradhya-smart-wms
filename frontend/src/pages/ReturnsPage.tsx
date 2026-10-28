import { useEffect, useState } from 'react';
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
import { LocationSelect } from '../components/forms';

interface ReturnRow {
  id: string;
  return_no: string;
  order_id: string;
  order_no: string;
  customer_name: string;
  reason: string;
  status: string;
  disposition: string;
  notes: string | null;
  received_at: string | null;
  inspected_at: string | null;
  line_count: number;
}

interface ReturnList {
  rows: ReturnRow[];
  total: number;
}

interface ReturnLine {
  id: string;
  return_id: string;
  order_line_id: string;
  product_id: string;
  batch_id: string | null;
  expected_qty: number;
  received_qty: number;
  inspected_qty: number;
  restock_qty: number;
  damaged_qty: number;
  rejected_qty: number;
  rework_qty: number;
  disposed_qty: number;
  sku: string;
  product_name: string;
  is_expiry_tracked: number;
  batch_no: string | null;
  expiry_date: string | null;
}

interface ReturnDetail extends ReturnRow {
  lines: ReturnLine[];
}

interface OrderList {
  rows: Array<{
    id: string;
    order_no: string;
    customer_name: string;
    status: string;
    channel: string;
    pool_code: string;
    created_at: string;
  }>;
  total: number;
}

interface OrderLine {
  id: string;
  product_id: string;
  ordered_qty: number;
  dispatched_qty: number;
  sku: string;
  product_name: string;
  is_batch_tracked: number;
  is_expiry_tracked: number;
}

interface PackageLine {
  order_line_id: string;
  batch_id: string | null;
  batch_no: string | null;
  quantity: number;
}

interface OrderForReturn {
  id: string;
  order_no: string;
  customer_name: string;
  status: string;
  pool_code: string;
  lines: OrderLine[];
  packages: Array<{ id: string; package_no: string; lines: PackageLine[] }>;
}

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'RECEIVED', label: 'Awaiting inspection' },
  { value: 'INSPECTED', label: 'Partially inspected' },
  { value: 'COMPLETED', label: 'Completed' },
];

export function ReturnsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const selected = params.get('return');
  const orderIdParam = params.get('orderId');
  const [version, setVersion] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

  const returns = useApi<ReturnList>(
    `/returns${queryString({ status: status || undefined, orderId: orderIdParam || undefined, limit: 200 })}`,
    version,
  );
  const rows = returns.data?.rows ?? [];

  useEffect(() => {
    if (orderIdParam) setCreateOpen(true);
  }, [orderIdParam]);

  const setStatus = (value: string) => {
    const updated = new URLSearchParams(params);
    if (value) updated.set('status', value);
    else updated.delete('status');
    setParams(updated, { replace: true });
  };
  const openReturn = (id: string) => {
    const updated = new URLSearchParams(params);
    updated.set('return', id);
    setParams(updated, { replace: true });
  };
  const closeReturn = () => {
    const updated = new URLSearchParams(params);
    updated.delete('return');
    setParams(updated, { replace: true });
  };
  const closeCreate = () => {
    setCreateOpen(false);
    if (orderIdParam) {
      const updated = new URLSearchParams(params);
      updated.delete('orderId');
      setParams(updated, { replace: true });
    }
  };
  const refresh = () => setVersion((value) => value + 1);

  const awaiting = rows.filter((row) => row.status === 'RECEIVED').length;
  const partial = rows.filter((row) => row.status === 'INSPECTED').length;
  const completed = rows.filter((row) => row.status === 'COMPLETED').length;

  const columns: Array<Column<ReturnRow>> = [
    {
      key: 'return_no',
      header: 'Return',
      render: (row) => (
        <div className="cell-title">
          <strong>{row.return_no}</strong>
          <span className="muted tiny">{row.order_no} · {row.customer_name}</span>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
    { key: 'disposition', header: 'Disposition', render: (row) => <StatusPill value={row.disposition} dot={false} /> },
    { key: 'line_count', header: 'Lines', className: 'num', render: (row) => formatNumber(row.line_count) },
    { key: 'reason', header: 'Reason', render: (row) => <span className="muted small clamp-1">{row.reason}</span> },
    { key: 'received_at', header: 'Received', render: (row) => <span className="muted small">{formatDateTime(row.received_at)}</span> },
    { key: 'inspected_at', header: 'Inspected', render: (row) => <span className="muted small">{formatDateTime(row.inspected_at)}</span> },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <button
          type="button"
          className="btn btn-subtle btn-xs"
          onClick={(event) => {
            event.stopPropagation();
            openReturn(row.id);
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
        eyebrow="Reverse logistics"
        title="Returns & RTO"
        subtitle="Returned units land in a non-sellable RETURN_PENDING status. Inspection decides what is restocked, quarantined or disposed."
        actions={
          <div className="inline-actions">
            {can('return.inspect') ? (
              <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                <Icon name="plus" size={15} /> Receive return
              </button>
            ) : null}
            <button type="button" className="btn btn-subtle" onClick={refresh} disabled={returns.loading}>
              <Icon name="refresh" size={15} /> Refresh
            </button>
          </div>
        }
      />

      <div className="stat-grid four">
        <Stat label="Returns in view" value={formatNumber(returns.data?.total ?? 0)} icon="returns" />
        <Stat label="Awaiting inspection" value={formatNumber(awaiting)} icon="clock" tone="warning" />
        <Stat label="Partially inspected" value={formatNumber(partial)} icon="scan" tone="info" />
        <Stat label="Completed" value={formatNumber(completed)} icon="check" tone="success" />
      </div>

      {orderIdParam ? (
        <div className="alert alert-info">
          <Icon name="info" size={17} />
          <div>
            <strong>Showing returns for the selected order.</strong>
            <span className="muted small"> Close the create dialog to see every return.</span>
          </div>
        </div>
      ) : null}

      <Card
        title="Return queue"
        subtitle="Only dispatched or completed orders can be returned; returned quantities cannot exceed the dispatched quantity."
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
        <ErrorNote error={returns.error} />
        <DataTable
          columns={columns}
          rows={rows}
          loading={returns.loading}
          rowKey={(row) => row.id}
          onRowClick={(row) => openReturn(row.id)}
          emptyTitle="No returns"
          emptyMessage="Receive a return against a dispatched order."
        />
      </Card>

      {selected ? (
        <ReturnDetailDialog
          id={selected}
          onClose={closeReturn}
          onChanged={() => {
            refresh();
            toast.notify('Return inspection posted to the ledger.', 'success');
          }}
        />
      ) : null}

      {createOpen ? (
        <NewReturnDialog
          initialOrderId={orderIdParam ?? undefined}
          onClose={closeCreate}
          onCreated={(created) => {
            closeCreate();
            refresh();
            toast.notify(`Return ${created.returnNo} received into pending inspection.`, 'success');
            openReturn(created.id);
          }}
        />
      ) : null}
    </div>
  );
}

function ReturnDetailDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const state = useApi<ReturnDetail>(`/returns/${id}`, version);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const returned = state.data;

  const refresh = () => {
    setVersion((value) => value + 1);
    onChanged();
  };

  const lineColumns: Array<Column<ReturnLine>> = [
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
    { key: 'received_qty', header: 'Received', className: 'num', render: (line) => formatNumber(line.received_qty) },
    { key: 'inspected_qty', header: 'Inspected', className: 'num', render: (line) => formatNumber(line.inspected_qty) },
    { key: 'restock_qty', header: 'Restock', className: 'num', render: (line) => formatNumber(line.restock_qty) },
    { key: 'damaged_qty', header: 'Damaged', className: 'num', render: (line) => formatNumber(line.damaged_qty) },
    { key: 'rejected_qty', header: 'Rejected', className: 'num', render: (line) => formatNumber(line.rejected_qty) },
    { key: 'rework_qty', header: 'Rework', className: 'num', render: (line) => formatNumber(line.rework_qty) },
    { key: 'disposed_qty', header: 'Disposed', className: 'num', render: (line) => formatNumber(line.disposed_qty) },
  ];

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        extraWide
        title={returned ? `Return ${returned.return_no}` : 'Return'}
        subtitle={returned ? `${returned.order_no} · ${returned.customer_name}` : undefined}
        footer={
          <div className="dialog-footer-row">
            <span className="muted small">Restocked units become sellable; all other dispositions remain non-sellable in quarantine.</span>
            <div className="inline-actions">
              <button type="button" className="btn btn-subtle" onClick={() => setLedgerOpen(true)}>
                <Icon name="trace" size={14} /> Ledger
              </button>
              <button type="button" className="btn btn-subtle" onClick={onClose}>
                Close
              </button>
              {returned && ['RECEIVED', 'INSPECTED'].includes(returned.status) && can('return.inspect') ? (
                <button type="button" className="btn btn-primary" onClick={() => setInspectOpen(true)}>
                  Inspect return
                </button>
              ) : null}
            </div>
          </div>
        }
      >
        {state.loading && !returned ? <div className="center-pad"><Spinner label="Loading return…" /></div> : null}
        <ErrorNote error={state.error} />
        {returned ? (
          <div className="stack">
            <div className="detail-grid">
              <MetaList
                items={[
                  { label: 'Status', value: <StatusPill value={returned.status} /> },
                  { label: 'Disposition', value: <StatusPill value={returned.disposition} dot={false} /> },
                  { label: 'Order', value: returned.order_no },
                  { label: 'Customer', value: returned.customer_name },
                  { label: 'Reason', value: returned.reason },
                ]}
              />
              <MetaList
                items={[
                  { label: 'Received', value: formatDateTime(returned.received_at) },
                  { label: 'Inspected', value: formatDateTime(returned.inspected_at) },
                  { label: 'Notes', value: returned.notes ?? '—' },
                  { label: 'Lines', value: String(returned.lines.length) },
                  {
                    label: 'Pending inspection',
                    value: formatNumber(
                      returned.lines.reduce(
                        (sum, line) => sum + Math.max(Number(line.received_qty) - Number(line.inspected_qty), 0),
                        0,
                      ),
                    ),
                  },
                ]}
              />
            </div>
            <Card title="Return lines" flush>
              <DataTable columns={lineColumns} rows={returned.lines} rowKey={(line) => line.id} emptyTitle="No lines" />
            </Card>
          </div>
        ) : null}
      </Dialog>

      {inspectOpen && returned ? (
        <InspectReturnDialog
          returned={returned}
          onClose={() => setInspectOpen(false)}
          onDone={(result) => {
            setInspectOpen(false);
            toast.notify(`Inspection posted · disposition ${titleCase(result.disposition)}.`, 'success');
            refresh();
          }}
        />
      ) : null}

      <LedgerDialog
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
        title="Return ledger"
        subtitle={returned?.return_no}
        referenceId={returned?.id ?? id}
        canReverse={can('inventory.adjust.approve')}
        onChanged={() => setVersion((value) => value + 1)}
      />
    </>
  );
}

interface InspectDraft {
  restock: string;
  damaged: string;
  rejected: string;
  rework: string;
  disposed: string;
}

function InspectReturnDialog({
  returned,
  onClose,
  onDone,
}: {
  returned: ReturnDetail;
  onClose: () => void;
  onDone: (result: { status: string; disposition: string }) => void;
}) {
  const pending = returned.lines.filter((line) => Number(line.received_qty) - Number(line.inspected_qty) > 0);
  const [drafts, setDrafts] = useState<Record<string, InspectDraft>>(
    Object.fromEntries(
      pending.map((line) => [
        line.id,
        {
          restock: String(Number(line.received_qty) - Number(line.inspected_qty)),
          damaged: '0',
          rejected: '0',
          rework: '0',
          disposed: '0',
        },
      ]),
    ),
  );
  const [restockLocationId, setRestockLocationId] = useState('');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();

  const update = (lineId: string, key: keyof InspectDraft, value: string) => {
    setDrafts((current) => ({ ...current, [lineId]: { ...current[lineId], [key]: value } }));
  };

  const submit = async () => {
    setFormError(null);
    const lines: Array<{
      returnLineId: string;
      restockQty: number;
      damagedQty: number;
      rejectedQty: number;
      reworkQty: number;
      disposedQty: number;
    }> = [];
    for (const line of pending) {
      const draft = drafts[line.id];
      const quantities = {
        restockQty: Number.parseInt(draft.restock || '0', 10),
        damagedQty: Number.parseInt(draft.damaged || '0', 10),
        rejectedQty: Number.parseInt(draft.rejected || '0', 10),
        reworkQty: Number.parseInt(draft.rework || '0', 10),
        disposedQty: Number.parseInt(draft.disposed || '0', 10),
      };
      if (Object.values(quantities).some((value) => !Number.isInteger(value) || value < 0)) {
        return setFormError('Inspection quantities must be non-negative whole numbers.');
      }
      const total = Object.values(quantities).reduce((sum, value) => sum + value, 0);
      const remaining = Number(line.received_qty) - Number(line.inspected_qty);
      if (total !== remaining) {
        return setFormError(`${line.sku}: inspection must account for exactly ${remaining} units (entered ${total}).`);
      }
      lines.push({ returnLineId: line.id, ...quantities });
    }
    if (!lines.length) return setFormError('No return line remains to inspect.');
    const result = await action.run(() =>
      api.post(
        `/returns/${returned.id}/inspect`,
        { lines, restockLocationId: restockLocationId || null, notes: notes.trim() || null },
        idempotencyKey(),
      ),
    );
    if (result) onDone(result as { status: string; disposition: string });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      extraWide
      title={`Inspect ${returned.return_no}`}
      subtitle="Each line must be fully accounted as restock, damaged, rejected, rework or disposed."
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={action.running}>
            {action.running ? 'Posting inspection…' : 'Post inspection'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={formError ?? action.error} />
        <div className="form-grid two">
          <Field label="Restock location" hint="Restocked units go to an active RACK. Leave blank for the default rack.">
            <LocationSelect value={restockLocationId} onChange={setRestockLocationId} types={['RACK']} />
          </Field>
          <Field label="Inspection notes">
            <input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} />
          </Field>
        </div>

        {pending.map((line) => {
          const remaining = Number(line.received_qty) - Number(line.inspected_qty);
          const draft = drafts[line.id];
          const total =
            Number.parseInt(draft.restock || '0', 10) +
            Number.parseInt(draft.damaged || '0', 10) +
            Number.parseInt(draft.rejected || '0', 10) +
            Number.parseInt(draft.rework || '0', 10) +
            Number.parseInt(draft.disposed || '0', 10);
          return (
            <div className="line-editor" key={line.id}>
              <div className="line-editor-head">
                <div>
                  <strong>
                    {line.sku} · {line.product_name}
                  </strong>
                  <span className="muted tiny">
                    {line.batch_no ? `Batch ${line.batch_no} · ` : ''}
                    {remaining} unit(s) awaiting inspection
                  </span>
                </div>
                <span className={total === remaining ? 'pill pill-success' : 'pill pill-warning'}>
                  {total} / {remaining} accounted
                </span>
              </div>
              <div className="inspect-grid">
                {(['restock', 'damaged', 'rejected', 'rework', 'disposed'] as const).map((key) => (
                  <Field key={key} label={titleCase(key)}>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      value={draft[key]}
                      onChange={(event) => update(line.id, key, event.target.value)}
                    />
                  </Field>
                ))}
              </div>
              {line.is_expiry_tracked === 1 && line.expiry_date ? (
                <p className="muted small">Expiry {line.expiry_date}. Expired batches cannot be restocked.</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

interface ReturnDraftLine {
  key: string;
  orderLineId: string;
  productId: string;
  quantity: string;
  batchId: string;
}

function NewReturnDialog({
  initialOrderId,
  onClose,
  onCreated,
}: {
  initialOrderId?: string;
  onClose: () => void;
  onCreated: (created: { id: string; returnNo: string }) => void;
}) {
  const [orderId, setOrderId] = useState(initialOrderId ?? '');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [drafts, setDrafts] = useState<Record<string, ReturnDraftLine>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();
  const orders = useApi<OrderList>(`/orders?status=DISPATCHED,COMPLETED&limit=200`);
  const detail = useApi<OrderForReturn>(orderId ? `/orders/${orderId}` : null);

  useEffect(() => {
    if (!detail.data) return;
    const byLine = new Map<string, PackageLine[]>();
    for (const pkg of detail.data.packages) {
      for (const line of pkg.lines) {
        const list = byLine.get(line.order_line_id) ?? [];
        list.push(line);
        byLine.set(line.order_line_id, list);
      }
    }
    const next: Record<string, ReturnDraftLine> = {};
    for (const line of detail.data.lines) {
      const batches = byLine.get(line.id) ?? [];
      next[line.id] = {
        key: line.id,
        orderLineId: line.id,
        productId: line.product_id,
        quantity: '0',
        batchId: batches.length === 1 ? (batches[0].batch_id ?? '') : '',
      };
    }
    setDrafts(next);
  }, [detail.data]);

  const order = detail.data;
  const batchOptions = (lineId: string) => {
    if (!order) return [];
    const seen = new Map<string, { id: string; batch_no: string; quantity: number }>();
    for (const pkg of order.packages) {
      for (const line of pkg.lines) {
        if (line.order_line_id !== lineId || !line.batch_id) continue;
        const existing = seen.get(line.batch_id);
        if (existing) existing.quantity += Number(line.quantity);
        else seen.set(line.batch_id, { id: line.batch_id, batch_no: line.batch_no ?? 'Batch', quantity: Number(line.quantity) });
      }
    }
    return [...seen.values()];
  };

  const submit = async () => {
    setFormError(null);
    if (!orderId) return setFormError('Choose a dispatched order.');
    if (reason.trim().length < 3) return setFormError('A return reason of at least 3 characters is required.');
    if (!order) return setFormError('The selected order is still loading.');
    const lines: Array<{ orderLineId: string; productId: string; quantity: number; batchId: string | null }> = [];
    for (const line of order.lines) {
      const draft = drafts[line.id];
      if (!draft) continue;
      const quantity = Number.parseInt(draft.quantity || '0', 10);
      if (!Number.isInteger(quantity) || quantity < 0) return setFormError('Return quantities must be non-negative whole numbers.');
      if (quantity === 0) continue;
      if (line.is_batch_tracked === 1 && !draft.batchId) {
        return setFormError(`${line.sku} is batch tracked — choose the returned batch.`);
      }
      lines.push({
        orderLineId: line.id,
        productId: line.product_id,
        quantity,
        batchId: line.is_batch_tracked === 1 ? draft.batchId : null,
      });
    }
    if (!lines.length) return setFormError('Enter a returned quantity on at least one line.');
    const result = await action.run(() =>
      api.post(
        '/returns',
        { orderId, reason: reason.trim(), notes: notes.trim() || null, lines },
        idempotencyKey(),
      ),
    );
    if (result) onCreated(result as { id: string; returnNo: string });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      extraWide
      title="Receive customer return"
      subtitle="Only dispatched or completed orders can be returned. Units land in RETURN_PENDING until inspected."
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={action.running || !orderId}>
            {action.running ? 'Receiving…' : 'Receive return'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={formError ?? action.error} />
        <ErrorNote error={orders.error ?? detail.error} />
        <div className="form-grid three">
          <Field label="Dispatched order" required>
            <select className="input" value={orderId} onChange={(event) => setOrderId(event.target.value)}>
              <option value="">Select a dispatched order</option>
              {(orders.data?.rows ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {row.order_no} · {row.customer_name} · {titleCase(row.status)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reason" required>
            <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
          </Field>
          <Field label="Notes">
            <input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} />
          </Field>
        </div>

        {detail.loading && !order ? <div className="centerPad center-pad"><Spinner label="Loading order…" /></div> : null}

        {order ? (
          <div className="line-editor">
            <div className="line-editor-head">
              <strong>Returned lines</strong>
              <span className="muted small">Dispatched quantities limit what can be returned.</span>
            </div>
            {order.lines.map((line) => {
              const draft = drafts[line.id];
              if (!draft) return null;
              const batches = batchOptions(line.id);
              return (
                <div className="line-row" key={line.id}>
                  <div className="line-summary">
                    <strong>{line.sku}</strong>
                    <span className="muted small">{line.product_name}</span>
                    <span className="tiny muted">Dispatched {formatNumber(line.dispatched_qty)}</span>
                  </div>
                  <div className="line-fields">
                    <Field label="Return qty">
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={line.dispatched_qty}
                        value={draft.quantity}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [line.id]: { ...current[line.id], quantity: event.target.value },
                          }))
                        }
                      />
                    </Field>
                    {line.is_batch_tracked === 1 ? (
                      <Field label="Batch" required>
                        <select
                          className="input"
                          value={draft.batchId}
                          onChange={(event) =>
                            setDrafts((current) => ({
                              ...current,
                              [line.id]: { ...current[line.id], batchId: event.target.value },
                            }))
                          }
                        >
                          <option value="">Select the returned batch</option>
                          {batches.map((batch) => (
                            <option key={batch.id} value={batch.id}>
                              {batch.batch_no} · {formatNumber(batch.quantity)} dispatched
                            </option>
                          ))}
                        </select>
                      </Field>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        <p className="muted small">
          Returned stock is posted immediately into RETURN_PENDING. The unit is not sellable until inspection restocks it to an active rack.
        </p>
      </div>
    </Dialog>
  );
}
