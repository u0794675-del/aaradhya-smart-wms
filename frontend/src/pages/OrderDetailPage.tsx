import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, formatDateTime, formatNumber, idempotencyKey, titleCase } from '../api';
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
  ProgressSteps,
  Spinner,
  Stat,
  StatusPill,
  type Column,
} from '../ui';
import { LedgerDialog } from '../components/LedgerDialog';
import { ReasonDialog } from '../components/forms';

interface OrderLine {
  id: string;
  line_no: number;
  product_id: string;
  box_id: string | null;
  ordered_qty: number;
  allocated_qty: number;
  picked_qty: number;
  packed_qty: number;
  dispatched_qty: number;
  status: string;
  sku: string;
  product_name: string;
  base_uom: string;
  is_batch_tracked: number;
  is_expiry_tracked: number;
  barcode: string | null;
  reserved_remaining: number;
}

interface Reservation {
  id: string;
  reservation_no: string;
  order_line_id: string;
  product_id: string;
  quantity: number;
  remaining_quantity: number;
  status: string;
  location_id: string;
  location_code: string;
  box_id: string | null;
  box_code: string | null;
  batch_id: string | null;
  batch_no: string | null;
  expiry_date: string | null;
  sku: string;
}

interface PackageLine {
  id: string;
  order_line_id: string;
  product_id: string;
  quantity: number;
  batch_id: string | null;
  sku: string;
  product_name: string;
  batch_no: string | null;
}

interface OrderPackage {
  id: string;
  package_no: string;
  status: string;
  packed_at: string | null;
  weight_grams: number | null;
  dimensions: string | null;
  lines: PackageLine[];
}

interface ShipmentRow {
  id: string;
  shipment_no: string;
  carrier: string | null;
  tracking_no: string | null;
  status: string;
  package_count: number;
  dispatched_at: string | null;
}

interface OrderTask {
  id: string;
  task_no: string;
  task_type: string;
  status: string;
  priority: string;
  assigned_to: string | null;
  due_at: string | null;
}

interface OrderDetail {
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
  notes: string | null;
  cancel_reason: string | null;
  cancelled_at: string | null;
  created_at: string;
  lines: OrderLine[];
  reservations: Reservation[];
  packages: OrderPackage[];
  shipments: ShipmentRow[];
  tasks: OrderTask[];
}

const STEPS = ['DRAFT', 'CONFIRMED', 'ALLOCATED', 'PICKING', 'PICKED', 'PACKED', 'DISPATCHED'];

export function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { can, meta } = useAuth();
  const [version, setVersion] = useState(0);
  const state = useApi<OrderDetail>(id ? `/orders/${id}` : null, version);
  const statusAction = useAction();
  const [pickTarget, setPickTarget] = useState<Reservation | null>(null);
  const [packOpen, setPackOpen] = useState(false);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const order = state.data;

  const reload = () => setVersion((value) => value + 1);

  const runStatusAction = async (path: string, success: string) => {
    const result = await statusAction.run(() => api.post(`/orders/${id}/${path}`, {}, idempotencyKey()));
    if (result !== undefined) {
      toast.notify(success, 'success');
      reload();
    }
  };

  if (state.error) {
    return (
      <div className="page">
        <PageHeader title="Order" eyebrow="Outbound fulfilment" />
        <ErrorNote error={state.error} />
        <div className="inline-actions">
          <button type="button" className="btn btn-subtle" onClick={() => navigate('/orders')}>
            <Icon name="back" size={15} /> Back to orders
          </button>
        </div>
      </div>
    );
  }

  if (state.loading || !order) {
    return (
      <div className="page">
        <PageHeader title="Order" eyebrow="Outbound fulfilment" />
        <Card>
          <div className="center-pad">
            <Spinner label="Loading order…" />
          </div>
        </Card>
      </div>
    );
  }

  const ordered = order.lines.reduce((sum, line) => sum + Number(line.ordered_qty), 0);
  const picked = order.lines.reduce((sum, line) => sum + Number(line.picked_qty), 0);
  const packed = order.lines.reduce((sum, line) => sum + Number(line.packed_qty), 0);
  const dispatched = order.lines.reduce((sum, line) => sum + Number(line.dispatched_qty), 0);
  const activeReservations = order.reservations.filter(
    (reservation) => ['ACTIVE', 'PARTIALLY_CONSUMED'].includes(reservation.status) && Number(reservation.remaining_quantity) > 0,
  );
  const lineById = new Map(order.lines.map((line) => [line.id, line]));
  const requireScan =
    (meta?.settings.find((setting) => setting.key === 'picking_require_scan')?.value ?? true) !== false;

  const lineColumns: Array<Column<OrderLine>> = [
    { key: 'line_no', header: '#', className: 'num', width: '44px' },
    {
      key: 'sku',
      header: 'Item',
      render: (line) => (
        <div className="cell-title">
          <strong>{line.sku}</strong>
          <span className="muted tiny">{line.product_name}</span>
          {line.is_batch_tracked === 1 ? <span className="tiny muted">Batch tracked · {line.barcode ?? 'no barcode'}</span> : null}
        </div>
      ),
    },
    { key: 'ordered_qty', header: 'Ordered', className: 'num', render: (line) => formatNumber(line.ordered_qty) },
    {
      key: 'reserved_remaining',
      header: 'Reserved',
      className: 'num',
      render: (line) => formatNumber(line.reserved_remaining),
    },
    { key: 'picked_qty', header: 'Picked', className: 'num', render: (line) => formatNumber(line.picked_qty) },
    { key: 'packed_qty', header: 'Packed', className: 'num', render: (line) => formatNumber(line.packed_qty) },
    { key: 'dispatched_qty', header: 'Dispatched', className: 'num', render: (line) => formatNumber(line.dispatched_qty) },
    { key: 'status', header: 'Status', render: (line) => <StatusPill value={line.status} /> },
  ];

  const reservationColumns: Array<Column<Reservation>> = [
    { key: 'reservation_no', header: 'Reservation', render: (row) => <code className="code">{row.reservation_no}</code> },
    { key: 'sku', header: 'SKU' },
    {
      key: 'stock',
      header: 'Stock location',
      render: (row) => (
        <div className="cell-title">
          <span>{row.location_code}</span>
          <span className="muted tiny">{row.box_code ? `Box ${row.box_code}` : 'Loose stock'}</span>
        </div>
      ),
    },
    {
      key: 'batch',
      header: 'Batch',
      render: (row) => (row.batch_no ? `${row.batch_no}${row.expiry_date ? ` · exp ${row.expiry_date}` : ''}` : '—'),
    },
    { key: 'quantity', header: 'Reserved', className: 'num', render: (row) => formatNumber(row.quantity) },
    { key: 'remaining_quantity', header: 'Remaining', className: 'num', render: (row) => formatNumber(row.remaining_quantity) },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
    {
      key: 'actions',
      header: '',
      render: (row) => {
        const line = lineById.get(row.order_line_id);
        if (
          !line ||
          !can('picking.execute') ||
          !['ALLOCATED', 'PICKING'].includes(order.status) ||
          Number(row.remaining_quantity) <= 0
        ) {
          return null;
        }
        return (
          <button
            type="button"
            className="btn btn-primary btn-xs"
            onClick={() => {
              statusAction.setError(null);
              setPickTarget(row);
            }}
          >
            Pick
          </button>
        );
      },
    },
  ];

  return (
    <div className="page">
      <PageHeader
        eyebrow={`${titleCase(order.channel)} · ${order.pool_code} pool`}
        title={
          <span className="title-inline">
            {order.order_no} <StatusPill value={order.status} />
          </span>
        }
        subtitle={`${order.customer_name}${order.customer_ref ? ` · ${order.customer_ref}` : ''}`}
        actions={
          <div className="inline-actions">
            <button type="button" className="btn btn-subtle" onClick={() => navigate('/orders')}>
              <Icon name="back" size={15} /> Orders
            </button>
            <button type="button" className="btn btn-subtle" onClick={reload} disabled={state.loading}>
              <Icon name="refresh" size={15} /> Refresh
            </button>
            {order.status === 'DRAFT' && can('order.manage') ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={statusAction.running}
                onClick={() => void runStatusAction('confirm', `${order.order_no} confirmed.`)}
              >
                Confirm order
              </button>
            ) : null}
            {order.status === 'CONFIRMED' && can('order.manage') ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={statusAction.running}
                onClick={() => void runStatusAction('allocate', `Stock reserved for ${order.order_no}.`)}
              >
                {statusAction.running ? 'Allocating…' : 'Allocate stock'}
              </button>
            ) : null}
            {order.status === 'PICKED' && can('packing.execute') ? (
              <button type="button" className="btn btn-primary" onClick={() => setPackOpen(true)}>
                Pack picked units
              </button>
            ) : null}
            {order.status === 'PACKED' && can('dispatch.execute') ? (
              <button type="button" className="btn btn-primary" onClick={() => setDispatchOpen(true)}>
                Dispatch
              </button>
            ) : null}
            {!['DISPATCHED', 'COMPLETED', 'PACKED', 'CANCELLED'].includes(order.status) && can('order.cancel') ? (
              <button type="button" className="btn btn-danger" onClick={() => setCancelOpen(true)}>
                Cancel
              </button>
            ) : null}
          </div>
        }
      />

      <ErrorNote error={statusAction.error} />

      {order.status === 'CANCELLED' ? (
        <div className="alert alert-warning">
          <Icon name="alert" size={17} />
          <div>
            <strong>Order cancelled</strong>
            {order.cancel_reason ? <span className="muted small"> · {order.cancel_reason}</span> : null}
          </div>
        </div>
      ) : (
        <Card className="progress-card">
          <ProgressSteps steps={STEPS} current={order.status} />
          <p className="muted small">
            {order.status === 'ALLOCATED' || order.status === 'PICKING'
              ? 'Pick each active reservation below. Box and location scans are validated against the reserved stock location.'
              : order.status === 'PICKED'
                ? 'Every unit is picked. Packing combines selected quantities into packages before dispatch.'
                : order.status === 'PACKED'
                  ? 'Packages are ready. Dispatch posts outbound movements and closes the fulfilment tasks.'
                  : 'Each transition is validated on the backend and recorded in the audit trail.'}
          </p>
        </Card>
      )}

      <div className="stat-grid four">
        <Stat label="Ordered units" value={formatNumber(ordered)} icon="orders" />
        <Stat label="Picked" value={formatNumber(picked)} icon="scan" tone={picked >= ordered ? 'success' : 'warning'} />
        <Stat label="Packed" value={formatNumber(packed)} icon="package" tone={packed >= ordered ? 'success' : 'info'} />
        <Stat label="Dispatched" value={formatNumber(dispatched)} icon="inbound" tone={dispatched >= ordered ? 'success' : 'neutral'} />
      </div>

      <div className="detail-grid">
        <MetaList
          items={[
            { label: 'Status', value: <StatusPill value={order.status} /> },
            { label: 'Priority', value: <StatusPill value={order.priority} dot={false} /> },
            { label: 'Channel', value: `${titleCase(order.channel)} · ${order.pool_code} pool` },
            { label: 'Customer', value: order.customer_name },
            { label: 'Customer reference', value: order.customer_ref ?? '—' },
            { label: 'External order ID', value: order.external_order_id ?? '—' },
          ]}
        />
        <MetaList
          items={[
            { label: 'Created', value: formatDateTime(order.created_at) },
            { label: 'SLA due', value: formatDateTime(order.sla_due_at) },
            { label: 'Active reservations', value: String(activeReservations.length) },
            { label: 'Packages', value: String(order.packages.length) },
            { label: 'Shipments', value: String(order.shipments.length) },
            { label: 'Notes', value: order.notes ?? '—' },
          ]}
        />
      </div>

      <Card
        title="Order lines"
        subtitle="Ordered, reserved, picked, packed and dispatched quantities are maintained by the ledger, never edited directly."
        flush
        actions={
          <button type="button" className="btn btn-subtle btn-sm" onClick={() => setLedgerOpen(true)}>
            <Icon name="trace" size={14} /> Ledger
          </button>
        }
      >
        <DataTable columns={lineColumns} rows={order.lines} rowKey={(line) => line.id} emptyTitle="No lines" />
      </Card>

      <Card
        title="Reservations"
        subtitle={
          requireScan
            ? 'Scanning is required: boxed reservations must be picked with the box code, and the backend rejects wrong locations, boxes or SKUs.'
            : 'Scan validation is available but not mandatory for this warehouse configuration.'
        }
        flush
      >
        <DataTable
          columns={reservationColumns}
          rows={order.reservations}
          rowKey={(row) => row.id}
          emptyTitle="No reservations"
          emptyMessage="Allocation creates reservations against available stock."
        />
      </Card>

      <Card title="Packages" subtitle="Packing is posted per package; every package line references its order line and batch." flush>
        {order.packages.length === 0 ? (
          <div className="empty-state">
            <strong>No packages yet</strong>
            <p>Picked units are packed before dispatch.</p>
          </div>
        ) : (
          <div className="package-list">
            {order.packages.map((pkg) => (
              <div className="package-card" key={pkg.id}>
                <div className="package-head">
                  <div>
                    <strong>{pkg.package_no}</strong>
                    <span className="muted small">
                      {pkg.weight_grams ? `${formatNumber(pkg.weight_grams)} g` : 'No weight'} ·{' '}
                      {pkg.dimensions ?? 'No dimensions'}
                    </span>
                  </div>
                  <div className="inline-actions">
                    <StatusPill value={pkg.status} />
                    <span className="muted tiny">{formatDateTime(pkg.packed_at)}</span>
                  </div>
                </div>
                <div className="package-lines">
                  {pkg.lines.map((line) => (
                    <div className="package-line" key={line.id}>
                      <span>
                        {line.sku} · {line.product_name}
                        {line.batch_no ? ` · batch ${line.batch_no}` : ''}
                      </span>
                      <strong>× {formatNumber(line.quantity)}</strong>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Shipments" subtitle="Dispatch creates a shipment and posts outbound movements for every package line." flush>
        <DataTable
          columns={[
            { key: 'shipment_no', header: 'Shipment' },
            { key: 'carrier', header: 'Carrier', render: (row) => row.carrier ?? '—' },
            { key: 'tracking_no', header: 'Tracking', render: (row) => row.tracking_no ?? '—' },
            { key: 'package_count', header: 'Packages', className: 'num' },
            { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
            { key: 'dispatched_at', header: 'Dispatched', render: (row) => formatDateTime(row.dispatched_at) },
          ]}
          rows={order.shipments}
          rowKey={(row) => row.id}
          emptyTitle="Not dispatched"
          emptyMessage="A shipment appears once the packed order is dispatched."
        />
      </Card>

      <Card title="Tasks" subtitle="Workflow tasks generated for this order." flush>
        {order.tasks.length === 0 ? (
          <div className="empty-state">
            <strong>No tasks</strong>
          </div>
        ) : (
          <div className="stack list-gap">
            {order.tasks.map((task) => (
              <div className="list-row" key={task.id}>
                <div>
                  <strong>
                    {task.task_no} · {titleCase(task.task_type)}
                  </strong>
                  <span className="muted tiny">Due {formatDateTime(task.due_at)}</span>
                </div>
                <div className="inline-actions">
                  <StatusPill value={task.priority} dot={false} />
                  <StatusPill value={task.status} />
                  <Link className="btn btn-subtle btn-xs" to={`/tasks?task=${task.id}`}>
                    Open task
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="inline-actions">
        <Link className="btn btn-subtle" to={`/trace?type=ORDER&id=${order.id}`}>
          <Icon name="trace" size={15} /> Trace this order
        </Link>
        <Link className="btn btn-subtle" to={`/returns?orderId=${order.id}`}>
          <Icon name="returns" size={15} /> Returns for this order
        </Link>
      </div>

      {pickTarget ? (
        <PickDialog
          orderId={order.id}
          orderNo={order.order_no}
          reservation={pickTarget}
          line={lineById.get(pickTarget.order_line_id)!}
          requireScan={requireScan}
          onClose={() => setPickTarget(null)}
          onDone={(message) => {
            setPickTarget(null);
            toast.notify(message, 'success');
            reload();
          }}
        />
      ) : null}

      {packOpen ? (
        <PackDialog
          orderId={order.id}
          lines={order.lines}
          onClose={() => setPackOpen(false)}
          onDone={(count) => {
            setPackOpen(false);
            toast.notify(`${count} package(s) created.`, 'success');
            reload();
          }}
        />
      ) : null}

      {dispatchOpen ? (
        <DispatchDialog
          orderId={order.id}
          onClose={() => setDispatchOpen(false)}
          onDone={(shipmentNo) => {
            setDispatchOpen(false);
            toast.notify(`Shipment ${shipmentNo} dispatched.`, 'success');
            reload();
          }}
        />
      ) : null}

      <ReasonDialog
        open={cancelOpen}
        title={`Cancel ${order.order_no}`}
        label="Cancellation reason"
        hint="Reservations are released and every posted pick is reversed with a linked ledger transaction."
        confirmLabel="Cancel order"
        danger
        onClose={() => setCancelOpen(false)}
        onConfirm={async (reason) => {
          const result = await api.post<{ status: string; releasedReservations: number; reversedPicks: number }>(
            `/orders/${order.id}/cancel`,
            { reason },
            idempotencyKey(),
          );
          toast.notify(
            `Order cancelled · ${result.releasedReservations} reservation(s) released, ${result.reversedPicks} pick(s) reversed.`,
            'success',
          );
          reload();
          return result;
        }}
      />

      <LedgerDialog
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
        title="Order ledger"
        subtitle={order.order_no}
        referenceId={order.id}
        canReverse={can('inventory.adjust.approve')}
        onChanged={reload}
      />
    </div>
  );
}

function PickDialog({
  orderId,
  orderNo,
  reservation,
  line,
  requireScan,
  onClose,
  onDone,
}: {
  orderId: string;
  orderNo: string;
  reservation: Reservation;
  line: OrderLine;
  requireScan: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const maxQty = Math.min(
    Number(reservation.remaining_quantity),
    Math.max(Number(line.ordered_qty) - Number(line.picked_qty), 0),
  );
  const [quantity, setQuantity] = useState(String(maxQty));
  const [scannedLocation, setScannedLocation] = useState('');
  const [scannedBox, setScannedBox] = useState('');
  const [scannedBarcode, setScannedBarcode] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();

  const submit = async () => {
    setFormError(null);
    const qty = Number.parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty <= 0) return setFormError('Pick quantity must be a positive whole number.');
    if (qty > maxQty) return setFormError(`Only ${maxQty} units can be picked from this reservation.`);
    if (requireScan && reservation.box_id && !scannedBox.trim()) {
      return setFormError(`Scan the box labelled ${reservation.box_code} to pick from this mixed-box reservation.`);
    }
    if (requireScan && !scannedLocation.trim()) {
      return setFormError(`Scan the location labelled ${reservation.location_code}.`);
    }
    const result = await action.run(() =>
      api.post(
        `/orders/${orderId}/pick`,
        {
          lines: [
            {
              orderLineId: line.id,
              reservationId: reservation.id,
              quantity: qty,
              scannedBoxId: scannedBox.trim() || null,
              scannedLocationId: scannedLocation.trim() || null,
              scannedBarcode: scannedBarcode.trim() || null,
            },
          ],
        },
        idempotencyKey(),
      ),
    );
    if (result) {
      const response = result as { status: string; transaction?: string; transactions?: string[] };
      onDone(
        `Picked ${qty} × ${line.sku} from ${reservation.location_code}${reservation.box_code ? ` / ${reservation.box_code}` : ''} · order ${titleCase(response.status)}.`,
      );
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Pick ${line.sku}`}
      subtitle={`${orderNo} · ${reservation.reservation_no}`}
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={action.running}>
            {action.running ? 'Posting pick…' : 'Post pick'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={formError ?? action.error} />
        <div className="callout callout-info">
          <Icon name="scan" size={17} />
          <div>
            <strong>
              Reserved at {reservation.location_code}
              {reservation.box_code ? ` in box ${reservation.box_code}` : ''}
            </strong>
            <span className="muted small">
              {reservation.batch_no ? `Batch ${reservation.batch_no} · ` : ''}
              {maxQty} unit(s) available on this reservation.
            </span>
          </div>
        </div>
        <div className="form-grid two">
          <Field label="Quantity" required>
            <input className="input" type="number" min={1} max={maxQty} value={quantity} onChange={(event) => setQuantity(event.target.value)} />
          </Field>
          <Field label="Location scan" required={requireScan} hint={`Expected ${reservation.location_code}`}>
            <input
              className="input"
              value={scannedLocation}
              onChange={(event) => setScannedLocation(event.target.value)}
              placeholder="Scan or type location code"
              autoFocus
            />
          </Field>
          <Field
            label="Box scan"
            required={requireScan && Boolean(reservation.box_id)}
            hint={reservation.box_code ? `Expected ${reservation.box_code}` : 'Loose stock — no box expected'}
          >
            <input
              className="input"
              value={scannedBox}
              onChange={(event) => setScannedBox(event.target.value)}
              placeholder={reservation.box_code ?? 'Not applicable'}
              disabled={!reservation.box_id}
            />
          </Field>
          <Field label="Product barcode (optional)" hint="The backend rejects a barcode that belongs to another SKU.">
            <input
              className="input"
              value={scannedBarcode}
              onChange={(event) => setScannedBarcode(event.target.value)}
              placeholder={line.barcode ?? 'Scan product barcode'}
            />
          </Field>
        </div>
        <p className="muted small">
          Wrong location, wrong box and wrong SKU scans are rejected by the backend before any stock is moved. The pick posts an immutable
          ledger transaction and consumes reservation quantity.
        </p>
      </div>
    </Dialog>
  );
}

function PackDialog({
  orderId,
  lines,
  onClose,
  onDone,
}: {
  orderId: string;
  lines: OrderLine[];
  onClose: () => void;
  onDone: (packageCount: number) => void;
}) {
  const toPack = lines
    .filter((line) => line.status !== 'CANCELLED')
    .map((line) => ({
      orderLineId: line.id,
      quantity: Number(line.picked_qty) - Number(line.packed_qty),
      sku: line.sku,
    }))
    .filter((line) => line.quantity > 0);
  const [weight, setWeight] = useState('');
  const [dimensions, setDimensions] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();

  const submit = async () => {
    setFormError(null);
    if (!toPack.length) return setFormError('There are no picked units left to pack.');
    let weightGrams: number | null = null;
    if (weight.trim()) {
      const parsed = Number.parseInt(weight, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) return setFormError('Weight must be a positive whole number of grams.');
      weightGrams = parsed;
    }
    const body = weightGrams || dimensions.trim()
      ? {
          packages: [
            {
              weightGrams,
              dimensions: dimensions.trim() || null,
              lines: toPack.map((line) => ({ orderLineId: line.orderLineId, quantity: line.quantity, batchId: null })),
            },
          ],
        }
      : {};
    const result = await action.run(() => api.post(`/orders/${orderId}/pack`, body, idempotencyKey()));
    if (result) {
      const response = result as { packages?: unknown[] };
      onDone(response.packages?.length ?? 1);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Pack picked units"
      subtitle="Every picked unit must be packed in this submission. The backend rejects partial packing."
      wide
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={action.running}>
            {action.running ? 'Creating package…' : 'Create package'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={formError ?? action.error} />
        <div className="line-editor">
          <div className="line-editor-head">
            <strong>Units to pack</strong>
            <span className="muted small">{formatNumber(toPack.reduce((sum, line) => sum + line.quantity, 0))} units</span>
          </div>
          {toPack.map((line) => (
            <div className="list-row" key={line.orderLineId}>
              <span>{line.sku}</span>
              <strong>× {formatNumber(line.quantity)}</strong>
            </div>
          ))}
        </div>
        <div className="form-grid two">
          <Field label="Weight (grams)" hint="Optional package metadata.">
            <input className="input" type="number" min={1} value={weight} onChange={(event) => setWeight(event.target.value)} />
          </Field>
          <Field label="Dimensions">
            <input className="input" value={dimensions} onChange={(event) => setDimensions(event.target.value)} placeholder="e.g. 30 × 20 × 15 cm" />
          </Field>
        </div>
        <p className="muted small">
          Leave both fields blank to let the backend pack every picked unit into a single package. Batch-tracked lines require a single picked
          batch per line for automatic packing.
        </p>
      </div>
    </Dialog>
  );
}

function DispatchDialog({
  orderId,
  onClose,
  onDone,
}: {
  orderId: string;
  onClose: () => void;
  onDone: (shipmentNo: string) => void;
}) {
  const [carrier, setCarrier] = useState('');
  const [trackingNo, setTrackingNo] = useState('');
  const [proofNotes, setProofNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();

  const submit = async () => {
    setFormError(null);
    if (!carrier.trim()) return setFormError('Carrier is required for dispatch.');
    const result = await action.run(() =>
      api.post(
        `/orders/${orderId}/dispatch`,
        {
          carrier: carrier.trim(),
          trackingNo: trackingNo.trim() || null,
          proof: proofNotes.trim() ? { notes: proofNotes.trim() } : null,
        },
        idempotencyKey(),
      ),
    );
    if (result) {
      const response = result as { shipmentNo: string };
      onDone(response.shipmentNo);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Dispatch shipment"
      subtitle="Dispatch posts outbound movements for every packed unit and closes open fulfilment tasks."
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={action.running}>
            {action.running ? 'Dispatching…' : 'Dispatch order'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={formError ?? action.error} />
        <div className="form-grid two">
          <Field label="Carrier" required>
            <input className="input" value={carrier} onChange={(event) => setCarrier(event.target.value)} autoFocus />
          </Field>
          <Field label="Tracking number">
            <input className="input" value={trackingNo} onChange={(event) => setTrackingNo(event.target.value)} />
          </Field>
        </div>
        <Field label="Proof of dispatch notes">
          <textarea className="input textarea" rows={3} value={proofNotes} onChange={(event) => setProofNotes(event.target.value)} />
        </Field>
        <p className="muted small">The shipment, outbound transactions and audit event are committed together.</p>
      </div>
    </Dialog>
  );
}
