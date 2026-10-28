import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  api,
  formatDateTime,
  formatNumber,
  idempotencyKey,
  queryString,
  titleCase,
} from '../api';
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
  PageHeader,
  Stat,
  StatusPill,
  type Column,
} from '../ui';
import { ProductSelect, useProductOptions } from '../components/forms';

interface OrderRow {
  id: string;
  order_no: string;
  channel: string;
  pool_code: string;
  customer_name: string;
  customer_ref: string | null;
  external_order_id: string | null;
  status: string;
  priority: string;
  sla_due_at: string | null;
  created_at: string;
  line_count: number;
  ordered_units: number;
  picked_units: number;
}

interface OrderList {
  rows: OrderRow[];
  total: number;
}

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'CONFIRMED', label: 'Confirmed — to allocate' },
  { value: 'ALLOCATED,PICKING', label: 'Allocated / picking' },
  { value: 'PICKED,PACKED', label: 'Picked / packed' },
  { value: 'DISPATCHED', label: 'Dispatched' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const CHANNELS = ['MANUAL', 'MARKETPLACE', 'B2B'] as const;
const POOL_CODES = ['B2B', 'SHARED'];

export function OrdersPage() {
  const { can, meta } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState('');
  const [version, setVersion] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const debounced = useDebouncedValue(search, 280);
  const status = params.get('status') ?? '';

  const orders = useApi<OrderList>(
    `/orders${queryString({ status: status || undefined, channel: channel || undefined, search: debounced.trim() || undefined, limit: 200 })}`,
    version,
  );
  const rows = orders.data?.rows ?? [];

  const setStatus = (value: string) => {
    const updated = new URLSearchParams(params);
    if (value) updated.set('status', value);
    else updated.delete('status');
    setParams(updated, { replace: true });
  };

  const counts = rows.reduce<Record<string, number>>((accumulator, row) => {
    accumulator[row.status] = (accumulator[row.status] ?? 0) + 1;
    return accumulator;
  }, {});

  const columns: Array<Column<OrderRow>> = [
    {
      key: 'order_no',
      header: 'Order',
      render: (row) => (
        <div className="cell-title">
          <strong>{row.order_no}</strong>
          <span className="muted tiny">{row.customer_name}</span>
        </div>
      ),
    },
    {
      key: 'channel',
      header: 'Channel',
      render: (row) => (
        <div className="cell-title">
          <span>{titleCase(row.channel)}</span>
          <span className="muted tiny">{row.pool_code} pool</span>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
    { key: 'priority', header: 'Priority', render: (row) => <StatusPill value={row.priority} dot={false} /> },
    {
      key: 'units',
      header: 'Units',
      className: 'num',
      render: (row) => (
        <div className="cell-title right">
          <strong>
            {formatNumber(row.picked_units)} / {formatNumber(row.ordered_units)}
          </strong>
          <span className="muted tiny">{row.line_count} line(s)</span>
        </div>
      ),
    },
    {
      key: 'sla_due_at',
      header: 'SLA',
      render: (row) => {
        if (!row.sla_due_at) return <span className="muted">—</span>;
        const late = new Date(row.sla_due_at).getTime() < Date.now() && !['DISPATCHED', 'COMPLETED', 'CANCELLED'].includes(row.status);
        return (
          <span className={late ? 'text-danger small' : 'small'}>
            {formatDateTime(row.sla_due_at)}
            {late ? ' · late' : ''}
          </span>
        );
      },
    },
    {
      key: 'created_at',
      header: 'Created',
      render: (row) => <span className="muted small">{formatDateTime(row.created_at)}</span>,
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
            navigate(`/orders/${row.id}`);
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
        eyebrow="Outbound fulfilment"
        title="Orders"
        subtitle="Manual, marketplace and B2B orders share one reserved-stock ledger from confirmation through dispatch."
        actions={
          <div className="inline-actions">
            {can('order.manage') ? (
              <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                <Icon name="plus" size={15} /> New order
              </button>
            ) : null}
            <button type="button" className="btn btn-subtle" onClick={() => setVersion((value) => value + 1)} disabled={orders.loading}>
              <Icon name="refresh" size={15} /> Refresh
            </button>
          </div>
        }
      />

      <div className="stat-grid four">
        <Stat label="Orders in view" value={formatNumber(orders.data?.total ?? 0)} icon="orders" />
        <Stat label="Draft / confirmed" value={formatNumber((counts.DRAFT ?? 0) + (counts.CONFIRMED ?? 0))} icon="clock" tone="info" />
        <Stat label="Allocated / picking" value={formatNumber((counts.ALLOCATED ?? 0) + (counts.PICKING ?? 0))} icon="scan" tone="warning" />
        <Stat label="Packed / dispatched" value={formatNumber((counts.PACKED ?? 0) + (counts.DISPATCHED ?? 0))} icon="inbound" tone="success" />
      </div>

      <Card
        title="Fulfilment queue"
        subtitle="Priority and SLA order the queue; stock is reserved at allocation and deducted only by posted pick movements."
        flush
        actions={
          <div className="filter-row">
            <input
              className="input compact-input"
              placeholder="Search order, customer, external ID"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select className="input compact-input" value={channel} onChange={(event) => setChannel(event.target.value)}>
              <option value="">All channels</option>
              {CHANNELS.map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </select>
            <select className="input compact-input" value={status} onChange={(event) => setStatus(event.target.value)}>
              {STATUS_FILTERS.map((option) => (
                <option key={option.value || 'all'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        }
      >
        <ErrorNote error={orders.error} />
        <DataTable
          columns={columns}
          rows={rows}
          loading={orders.loading}
          rowKey={(row) => row.id}
          onRowClick={(row) => navigate(`/orders/${row.id}`)}
          emptyTitle="No orders match"
          emptyMessage="Create an order or clear the filters to see the fulfilment queue."
        />
      </Card>

      {createOpen ? (
        <CreateOrderDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(order) => {
            setCreateOpen(false);
            setVersion((value) => value + 1);
            toast.notify(`Order ${order.orderNo} created as a draft.`, 'success');
            navigate(`/orders/${order.id}`);
          }}
          pools={(meta?.pools ?? []).filter((pool) => POOL_CODES.includes(pool.code))}
        />
      ) : null}
    </div>
  );
}

function CreateOrderDialog({
  onClose,
  onCreated,
  pools,
}: {
  onClose: () => void;
  onCreated: (order: { id: string; orderNo: string }) => void;
  pools: Array<{ id: string; code: string; name: string }>;
}) {
  const [channel, setChannel] = useState<string>('B2B');
  const [poolId, setPoolId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerRef, setCustomerRef] = useState('');
  const [externalOrderId, setExternalOrderId] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const [slaDueAt, setSlaDueAt] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Array<{ key: number; productId: string; qty: string }>>([
    { key: 1, productId: '', qty: '1' },
  ]);
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();
  const products = useProductOptions('', 'ACTIVE');

  const forcedPoolCode = channel === 'B2B' ? 'B2B' : null;
  const selectedPool = pools.find((pool) => pool.id === poolId);
  const effectivePoolCode = forcedPoolCode ?? selectedPool?.code ?? '';

  const updateLine = (key: number, patch: Partial<{ productId: string; qty: string }>) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  const submit = async () => {
    setFormError(null);
    if (!customerName.trim()) return setFormError('Customer name is required.');
    if (!effectivePoolCode) return setFormError('Choose a stock pool for this channel.');
    const payloadLines: Array<{ productId: string; quantity: number }> = [];
    for (const line of lines) {
      if (!line.productId) continue;
      const quantity = Number.parseInt(line.qty, 10);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return setFormError('Order quantities must be positive whole numbers.');
      }
      payloadLines.push({ productId: line.productId, quantity });
    }
    if (!payloadLines.length) return setFormError('Add at least one product line.');

    const result = await action.run(() =>
      api.post(
        '/orders',
        {
          channel,
          poolCode: effectivePoolCode,
          customerName: customerName.trim(),
          customerRef: customerRef.trim() || null,
          externalOrderId: externalOrderId.trim() || null,
          priority,
          slaDueAt: slaDueAt ? new Date(slaDueAt).toISOString() : null,
          notes: notes.trim() || null,
          lines: payloadLines,
        },
        idempotencyKey(),
      ),
    );
    if (result) onCreated(result as { id: string; orderNo: string });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      extraWide
      title="New order"
      subtitle="Orders start as drafts. Confirmation, allocation, picking, packing and dispatch are separate audited steps."
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={action.running}>
            {action.running ? 'Creating…' : 'Create draft order'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={formError ?? action.error} />
        <div className="form-grid three">
          <Field label="Channel" required>
            <select className="input" value={channel} onChange={(event) => setChannel(event.target.value)}>
              {CHANNELS.map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Stock pool"
            required
            hint={forcedPoolCode ? `The ${channel} channel is locked to the ${forcedPoolCode} pool.` : undefined}
          >
            <select
              className="input"
              value={forcedPoolCode ? (pools.find((pool) => pool.code === forcedPoolCode)?.id ?? '') : poolId}
              onChange={(event) => setPoolId(event.target.value)}
              disabled={Boolean(forcedPoolCode)}
            >
              <option value="">Select a pool</option>
              {pools.map((pool) => (
                <option key={pool.id} value={pool.id}>
                  {pool.code} · {pool.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select className="input" value={priority} onChange={(event) => setPriority(event.target.value)}>
              {['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Customer name" required>
            <input className="input" value={customerName} onChange={(event) => setCustomerName(event.target.value)} maxLength={200} autoFocus />
          </Field>
          <Field label="Customer reference">
            <input className="input" value={customerRef} onChange={(event) => setCustomerRef(event.target.value)} maxLength={120} />
          </Field>
          <Field label="External order ID" hint="Duplicates are rejected by the backend.">
            <input className="input" value={externalOrderId} onChange={(event) => setExternalOrderId(event.target.value)} maxLength={120} />
          </Field>
          <Field label="SLA due">
            <input className="input" type="datetime-local" value={slaDueAt} onChange={(event) => setSlaDueAt(event.target.value)} />
          </Field>
          <Field label="Notes" className="span-2">
            <input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} />
          </Field>
        </div>

        <div className="line-editor">
          <div className="line-editor-head">
            <strong>Order lines</strong>
            <button
              type="button"
              className="btn btn-subtle btn-xs"
              onClick={() => setLines((current) => [...current, { key: Date.now(), productId: '', qty: '1' }])}
            >
              <Icon name="plus" size={13} /> Add line
            </button>
          </div>
          {lines.map((line) => (
            <div className="line-row" key={line.key}>
              <div className="line-fields">
                <Field label="Product" required>
                  <ProductSelect
                    value={line.productId}
                    onChange={(value) => updateLine(line.key, { productId: value })}
                    products={products.products}
                  />
                </Field>
                <Field label="Quantity" required>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={line.qty}
                    onChange={(event) => updateLine(line.key, { qty: event.target.value })}
                  />
                </Field>
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
          ))}
        </div>
        <p className="muted small">
          Available stock is checked and reserved at allocation. A failed allocation leaves the order confirmed with no partial reservation.
        </p>
      </div>
    </Dialog>
  );
}
