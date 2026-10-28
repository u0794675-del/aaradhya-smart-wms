import { useEffect, useState, type ChangeEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, formatDate, formatDateTime, formatMoney, formatNumber, idempotencyKey, titleCase } from '../api';
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
  Tabs,
  type Column,
} from '../ui';
import { LedgerDialog } from '../components/LedgerDialog';
import {
  LocationSelect,
  PoolSelect,
  ProductSelect,
  useProductOptions,
  type ProductOption,
} from '../components/forms';

interface ReceiptRow {
  id: string;
  receipt_no: string;
  po_id: string | null;
  vendor_id: string;
  status: string;
  received_at: string | null;
  created_at: string;
  vendor_invoice_ref: string | null;
  vendor_name: string;
  po_no: string | null;
  received_qty: number;
  accepted_qty: number;
  rejected_qty: number;
  putaway_qty: number;
}

interface ReceiptLine {
  id: string;
  product_id: string;
  batch_id: string | null;
  expected_qty: number;
  received_qty: number;
  accepted_qty: number;
  rejected_qty: number;
  quarantined_qty: number;
  putaway_qty: number;
  qc_status: string;
  sku: string;
  product_name: string;
  base_uom: string;
  batch_no: string | null;
  expiry_date: string | null;
  remaining_to_putaway: number;
}

interface ReceiptDetail {
  receipt: Record<string, any>;
  lines: ReceiptLine[];
  inspections: Array<Record<string, any>>;
  tasks: Array<Record<string, any>>;
  vendor: { id: string; vendor_code: string; name: string } | null;
  staging: { id: string; code: string; type: string } | null;
}

interface PurchaseOrderRow {
  id: string;
  po_no: string;
  vendor_id: string;
  status: string;
  expected_date: string | null;
  created_at: string;
  notes: string | null;
  vendor_name: string;
  created_by_name: string | null;
  line_count: number;
  open_qty: number;
}

interface PurchaseOrderLine {
  id: string;
  po_id: string;
  line_no: number;
  product_id: string;
  ordered_qty: number;
  received_qty: number;
  unit_cost: number | null;
  sku: string;
  product_name: string;
  base_uom: string;
}

interface PurchaseOrderDetail {
  po: Record<string, any>;
  lines: PurchaseOrderLine[];
  receipts: Array<{ id: string; receipt_no: string; status: string; received_at: string | null }>;
}

interface VendorRow {
  id: string;
  vendor_code: string | null;
  name: string;
  status: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  gstin: string | null;
  payment_terms: string | null;
  lead_time_days: number | null;
  min_order_qty: number | null;
  purchase_order_count: number;
  receipt_count: number;
}

type TabKey = 'receipts' | 'purchase-orders' | 'vendors';

function toInt(value: string): number {
  if (!value.trim()) return 0;
  return Number.parseInt(value, 10);
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function lineAccounted(line: ReceiptLine): number {
  return Number(line.accepted_qty) + Number(line.rejected_qty) + Number(line.quarantined_qty);
}

function lineUninspected(line: ReceiptLine): number {
  return Math.max(Number(line.received_qty) - lineAccounted(line), 0);
}

export function InboundPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab');
  const tab: TabKey = rawTab === 'purchase-orders' || rawTab === 'vendors' ? rawTab : 'receipts';
  const selectedReceipt = params.get('receipt');
  const selectedPo = params.get('po');
  const [status, setStatus] = useState('');
  const [version, setVersion] = useState(0);
  const [createReceiptOpen, setCreateReceiptOpen] = useState(false);
  const [createPoOpen, setCreatePoOpen] = useState(false);
  const [createVendorOpen, setCreateVendorOpen] = useState(false);
  const [prefilledPo, setPrefilledPo] = useState<string | null>(null);
  const [performanceVendor, setPerformanceVendor] = useState<VendorRow | null>(null);

  const receipts = useApi<ReceiptRow[]>(`/receipts${status ? `?status=${encodeURIComponent(status)}` : ''}`, version);
  const orders = useApi<PurchaseOrderRow[]>('/purchase-orders', version);
  const vendors = useApi<VendorRow[]>('/vendors', version);

  const setTab = (next: TabKey) => {
    const updated = new URLSearchParams(params);
    updated.set('tab', next);
    setParams(updated, { replace: true });
  };
  const openReceipt = (id: string) => {
    const updated = new URLSearchParams(params);
    updated.set('tab', 'receipts');
    updated.set('receipt', id);
    updated.delete('po');
    setParams(updated, { replace: true });
  };
  const openPo = (id: string) => {
    const updated = new URLSearchParams(params);
    updated.set('tab', 'purchase-orders');
    updated.set('po', id);
    updated.delete('receipt');
    setParams(updated, { replace: true });
  };
  const closeParam = (key: string) => {
    const updated = new URLSearchParams(params);
    updated.delete(key);
    setParams(updated, { replace: true });
  };
  const refresh = () => setVersion((value) => value + 1);

  const pendingQc = (receipts.data ?? []).filter((row) => ['PENDING_QC', 'PARTIALLY_INSPECTED'].includes(row.status)).length;
  const openPos = (orders.data ?? []).filter((row) => ['PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_RECEIVED'].includes(row.status)).length;
  const unitsAccepted = (receipts.data ?? []).reduce((sum, row) => sum + Number(row.accepted_qty), 0);

  const receiptColumns: Array<Column<ReceiptRow>> = [
    {
      key: 'receipt_no',
      header: 'Receipt',
      render: (row) => (
        <div className="cell-title">
          <strong>{row.receipt_no}</strong>
          <span className="muted tiny">{row.po_no ?? 'No purchase order'}</span>
        </div>
      ),
    },
    { key: 'vendor_name', header: 'Vendor', render: (row) => row.vendor_name },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
    {
      key: 'received_qty',
      header: 'Received',
      className: 'num',
      render: (row) => (
        <div className="cell-title right">
          <strong>{formatNumber(row.received_qty)}</strong>
          <span className="muted tiny">{formatNumber(row.accepted_qty)} accepted</span>
        </div>
      ),
    },
    { key: 'putaway_qty', header: 'Put away', className: 'num', render: (row) => formatNumber(row.putaway_qty) },
    {
      key: 'received_at',
      header: 'Received',
      render: (row) => <span className="muted small">{formatDateTime(row.received_at ?? row.created_at)}</span>,
    },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <button type="button" className="btn btn-subtle btn-xs" onClick={() => openReceipt(row.id)}>
          Open
        </button>
      ),
    },
  ];

  const poColumns: Array<Column<PurchaseOrderRow>> = [
    {
      key: 'po_no',
      header: 'Purchase order',
      render: (row) => (
        <div className="cell-title">
          <strong>{row.po_no}</strong>
          <span className="muted tiny">{row.line_count} line(s)</span>
        </div>
      ),
    },
    { key: 'vendor_name', header: 'Vendor' },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
    { key: 'open_qty', header: 'Open qty', className: 'num', render: (row) => formatNumber(row.open_qty) },
    { key: 'expected_date', header: 'Expected', render: (row) => formatDate(row.expected_date) },
    { key: 'created_by_name', header: 'Requested by', render: (row) => row.created_by_name ?? '—' },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <button type="button" className="btn btn-subtle btn-xs" onClick={() => openPo(row.id)}>
          Open
        </button>
      ),
    },
  ];

  const vendorColumns: Array<Column<VendorRow>> = [
    {
      key: 'name',
      header: 'Vendor',
      render: (row) => (
        <div className="cell-title">
          <strong>{row.name}</strong>
          <span className="muted tiny">{row.vendor_code ?? 'No code'}</span>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
    { key: 'contact_name', header: 'Contact', render: (row) => row.contact_name ?? '—' },
    { key: 'phone', header: 'Phone', render: (row) => row.phone ?? row.email ?? '—' },
    { key: 'purchase_order_count', header: 'POs', className: 'num', render: (row) => formatNumber(row.purchase_order_count) },
    { key: 'receipt_count', header: 'Receipts', className: 'num', render: (row) => formatNumber(row.receipt_count) },
    {
      key: 'actions',
      header: '',
      render: (row) =>
        can('report.read') ? (
          <button type="button" className="btn btn-subtle btn-xs" onClick={() => setPerformanceVendor(row)}>
            Performance
          </button>
        ) : null,
    },
  ];

  return (
    <div className="page">
      <PageHeader
        eyebrow="Procurement to stock"
        title="Inbound & QC"
        subtitle="Receive against an approved purchase order, inspect into accepted, rejected or quarantined stock, then put away accepted units to a rack."
        actions={
          <div className="inline-actions">
            {can('inbound.receive') ? (
              <button type="button" className="btn btn-subtle" onClick={() => setCreatePoOpen(true)}>
                <Icon name="plus" size={15} /> New PO
              </button>
            ) : null}
            {can('inbound.receive') ? (
              <button type="button" className="btn btn-primary" onClick={() => setCreateReceiptOpen(true)}>
                <Icon name="inbound" size={15} /> Receive goods
              </button>
            ) : null}
          </div>
        }
      />

      <div className="stat-grid four">
        <Stat label="Receipts in view" value={formatNumber((receipts.data ?? []).length)} icon="inbound" />
        <Stat label="Awaiting QC" value={formatNumber(pendingQc)} icon="clock" tone="warning" to="/inbound?tab=receipts" />
        <Stat label="Open purchase orders" value={formatNumber(openPos)} icon="orders" tone="info" to="/inbound?tab=purchase-orders" />
        <Stat label="Accepted units" value={formatNumber(unitsAccepted)} icon="check" tone="success" />
      </div>

      <Tabs
        tabs={[
          { key: 'receipts', label: 'Receipts', count: receipts.data?.length },
          { key: 'purchase-orders', label: 'Purchase orders', count: orders.data?.length },
          { key: 'vendors', label: 'Vendors', count: vendors.data?.length },
        ]}
        active={tab}
        onChange={(key) => setTab(key as TabKey)}
      />

      {tab === 'receipts' ? (
        <Card
          title="Goods receipts"
          subtitle="Every receipt starts in staging as QC-pending stock. QC moves units to accepted, rejected or quarantined statuses."
          actions={
            <select className="input compact-input" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              {['PENDING_QC', 'PARTIALLY_INSPECTED', 'COMPLETED', 'CANCELLED'].map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </select>
          }
          flush
        >
          <ErrorNote error={receipts.error} />
          <DataTable
            columns={receiptColumns}
            rows={receipts.data ?? []}
            loading={receipts.loading}
            rowKey={(row) => row.id}
            onRowClick={(row) => openReceipt(row.id)}
            emptyTitle="No goods receipts"
            emptyMessage="Receive goods against an approved purchase order to begin QC."
          />
        </Card>
      ) : null}

      {tab === 'purchase-orders' ? (
        <Card
          title="Purchase orders"
          subtitle="Purchase orders require approval before goods can be received. Receipt quantities cannot silently exceed the open quantity."
          flush
        >
          <ErrorNote error={orders.error} />
          <DataTable
            columns={poColumns}
            rows={orders.data ?? []}
            loading={orders.loading}
            rowKey={(row) => row.id}
            onRowClick={(row) => openPo(row.id)}
            emptyTitle="No purchase orders"
            emptyMessage="Raise a purchase order to start the procurement flow."
          />
        </Card>
      ) : null}

      {tab === 'vendors' ? (
        <Card
          title="Vendors"
          subtitle="Vendor performance is computed from purchase orders and receipt lines, not entered manually."
          actions={
            can('inbound.approve') ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateVendorOpen(true)}>
                <Icon name="plus" size={14} /> New vendor
              </button>
            ) : null
          }
          flush
        >
          <ErrorNote error={vendors.error} />
          <DataTable
            columns={vendorColumns}
            rows={vendors.data ?? []}
            loading={vendors.loading}
            rowKey={(row) => row.id}
            emptyTitle="No vendors"
            emptyMessage="Create a vendor before raising purchase orders."
          />
        </Card>
      ) : null}

      {selectedReceipt ? (
        <ReceiptDetailDialog
          id={selectedReceipt}
          onClose={() => closeParam('receipt')}
          onOpenPo={(poId) => {
            closeParam('receipt');
            openPo(poId);
          }}
          onChanged={() => {
            refresh();
            toast.notify('Receipt updated and stock ledger posted.', 'success');
          }}
        />
      ) : null}

      {selectedPo ? (
        <PurchaseOrderDialog
          id={selectedPo}
          onClose={() => closeParam('po')}
          onChanged={refresh}
          onOpenReceipt={(receiptId) => {
            closeParam('po');
            openReceipt(receiptId);
          }}
          onReceive={(poId) => {
            closeParam('po');
            setPrefilledPo(poId);
            setCreateReceiptOpen(true);
          }}
        />
      ) : null}

      <NewReceiptDialog
        open={createReceiptOpen}
        initialPoId={prefilledPo}
        onClose={() => {
          setCreateReceiptOpen(false);
          setPrefilledPo(null);
        }}
        onCreated={(receipt) => {
          setCreateReceiptOpen(false);
          setPrefilledPo(null);
          refresh();
          toast.notify(`Receipt ${receipt.receiptNo} created in staging.`, 'success');
          openReceipt(receipt.id);
        }}
      />

      <NewPurchaseOrderDialog
        open={createPoOpen}
        onClose={() => setCreatePoOpen(false)}
        onCreated={(po) => {
          setCreatePoOpen(false);
          refresh();
          toast.notify(`Purchase order ${po.poNo} submitted for approval.`, 'success');
          openPo(po.id);
        }}
      />

      <NewVendorDialog
        open={createVendorOpen}
        onClose={() => setCreateVendorOpen(false)}
        onCreated={() => {
          setCreateVendorOpen(false);
          refresh();
          toast.notify('Vendor created.', 'success');
        }}
      />

      {performanceVendor ? (
        <VendorPerformanceDialog vendor={performanceVendor} onClose={() => setPerformanceVendor(null)} />
      ) : null}
    </div>
  );
}

function ReceiptDetailDialog({
  id,
  onClose,
  onOpenPo,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onOpenPo: (poId: string) => void;
  onChanged: () => void;
}) {
  const { can, meta } = useAuth();
  const [version, setVersion] = useState(0);
  const state = useApi<ReceiptDetail>(`/receipts/${id}`, version);
  const [inspectLine, setInspectLine] = useState<ReceiptLine | null>(null);
  const [putawayLine, setPutawayLine] = useState<ReceiptLine | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const detail = state.data;
  const receipt = detail?.receipt;
  const pool = meta?.pools.find((entry) => entry.id === receipt?.pool_id);

  const refresh = () => {
    setVersion((value) => value + 1);
    onChanged();
  };

  const lineColumns: Array<Column<ReceiptLine>> = [
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
      header: 'Batch / expiry',
      render: (line) =>
        line.batch_no ? (
          <div className="cell-title">
            <span>{line.batch_no}</span>
            <span className="muted tiny">{line.expiry_date ? `exp ${formatDate(line.expiry_date)}` : 'no expiry'}</span>
          </div>
        ) : (
          <span className="muted">No batch</span>
        ),
    },
    { key: 'received_qty', header: 'Received', className: 'num', render: (line) => formatNumber(line.received_qty) },
    { key: 'accepted_qty', header: 'Accepted', className: 'num', render: (line) => formatNumber(line.accepted_qty) },
    { key: 'rejected_qty', header: 'Rejected', className: 'num', render: (line) => formatNumber(line.rejected_qty) },
    {
      key: 'quarantined_qty',
      header: 'Quarantined',
      className: 'num',
      render: (line) => formatNumber(line.quarantined_qty),
    },
    {
      key: 'putaway_qty',
      header: 'Put away',
      className: 'num',
      render: (line) => (
        <div className="cell-title right">
          <strong>{formatNumber(line.putaway_qty)}</strong>
          <span className="muted tiny">{formatNumber(line.remaining_to_putaway)} pending</span>
        </div>
      ),
    },
    { key: 'qc_status', header: 'QC', render: (line) => <StatusPill value={line.qc_status} /> },
    {
      key: 'actions',
      header: '',
      render: (line) => {
        const uninspected = lineUninspected(line);
        const canInspect = can('qc.inspect') && uninspected > 0 && receipt?.status !== 'CANCELLED';
        const canPutaway =
          can('putaway.execute') &&
          Number(line.remaining_to_putaway) > 0 &&
          ['COMPLETED', 'PARTIALLY_INSPECTED'].includes(String(receipt?.status));
        if (!canInspect && !canPutaway) return null;
        return (
          <div className="inline-actions">
            {canInspect ? (
              <button type="button" className="btn btn-subtle btn-xs" onClick={() => setInspectLine(line)}>
                Inspect
              </button>
            ) : null}
            {canPutaway ? (
              <button type="button" className="btn btn-primary btn-xs" onClick={() => setPutawayLine(line)}>
                Put away
              </button>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        extraWide
        title={receipt ? `Receipt ${receipt.receipt_no}` : 'Goods receipt'}
        subtitle={detail?.vendor ? `${detail.vendor.name}${detail.vendor.vendor_code ? ` · ${detail.vendor.vendor_code}` : ''}` : undefined}
        footer={
          <div className="dialog-footer-row">
            <span className="muted small">
              Receipts post STRICT ledger movements; posted lines cannot be edited, only inspected and put away.
            </span>
            <div className="inline-actions">
              <button type="button" className="btn btn-subtle" onClick={() => setLedgerOpen(true)}>
                <Icon name="trace" size={14} /> Ledger
              </button>
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        }
      >
        {state.loading && !detail ? <div className="center-pad"><Spinner label="Loading receipt…" /></div> : null}
        <ErrorNote error={state.error} />

        {detail && receipt ? (
          <div className="stack">
            <div className="stat-grid four">
              <Stat label="Received" value={formatNumber(detail.lines.reduce((sum, line) => sum + Number(line.received_qty), 0))} />
              <Stat label="Accepted" value={formatNumber(detail.lines.reduce((sum, line) => sum + Number(line.accepted_qty), 0))} tone="success" />
              <Stat label="Put away" value={formatNumber(detail.lines.reduce((sum, line) => sum + Number(line.putaway_qty), 0))} tone="info" />
              <Stat
                label="Remaining to put away"
                value={formatNumber(detail.lines.reduce((sum, line) => sum + Number(line.remaining_to_putaway), 0))}
                tone="warning"
              />
            </div>

            <div className="detail-grid">
              <MetaList
                items={[
                  { label: 'Status', value: <StatusPill value={receipt.status} /> },
                  {
                    label: 'Purchase order',
                    value: receipt.po_id ? (
                      <button type="button" className="link-button" onClick={() => onOpenPo(String(receipt.po_id))}>
                        Open linked PO
                      </button>
                    ) : (
                      '—'
                    ),
                  },
                  { label: 'Vendor invoice', value: receipt.vendor_invoice_ref ?? '—' },
                  { label: 'Received at', value: formatDateTime(receipt.received_at) },
                ]}
              />
              <MetaList
                items={[
                  { label: 'Staging location', value: detail.staging ? `${detail.staging.code} · ${titleCase(detail.staging.type)}` : '—' },
                  { label: 'Stock pool', value: pool ? `${pool.code} · ${pool.name}` : '—' },
                  { label: 'Vendor', value: detail.vendor?.name ?? '—' },
                  { label: 'Notes', value: receipt.notes ?? '—' },
                ]}
              />
            </div>

            <Card title="Receipt lines" flush>
              <DataTable
                columns={lineColumns}
                rows={detail.lines}
                rowKey={(line) => line.id}
                emptyTitle="No lines"
                emptyMessage="This receipt has no lines."
              />
            </Card>

            {detail.inspections.length ? (
              <Card title="QC inspections" subtitle="Every inspection is an immutable ledger posting." flush>
                <DataTable
                  columns={[
                    { key: 'inspection_no', header: 'Inspection' },
                    { key: 'result', header: 'Result', render: (row) => <StatusPill value={String(row.result)} /> },
                    { key: 'inspected_qty', header: 'Inspected', className: 'num' },
                    { key: 'accepted_qty', header: 'Accepted', className: 'num' },
                    { key: 'rejected_qty', header: 'Rejected', className: 'num' },
                    { key: 'quarantined_qty', header: 'Quarantined', className: 'num' },
                    { key: 'inspector_name', header: 'Inspector' },
                    { key: 'inspected_at', header: 'When', render: (row) => formatDateTime(row.inspected_at) },
                  ]}
                  rows={detail.inspections}
                  rowKey={(row) => String(row.id)}
                  emptyTitle="No inspections"
                />
              </Card>
            ) : null}

            {detail.tasks.length ? (
              <Card title="Open work" subtitle="Tasks are generated by the workflow; completing them records an audit event." flush>
                <div className="stack list-gap">
                  {detail.tasks.map((task) => (
                    <div className="list-row" key={String(task.id)}>
                      <div>
                        <strong>{task.description}</strong>
                        <div className="muted tiny">
                          {titleCase(task.task_type)} · due {formatDateTime(task.due_at)}
                        </div>
                      </div>
                      <div className="inline-actions">
                        <StatusPill value={task.status} />
                        <Link className="btn btn-subtle btn-xs" to={`/tasks?task=${task.id}`}>
                          Open task
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}
          </div>
        ) : null}
      </Dialog>

      {inspectLine && receipt ? (
        <InspectLineDialog
          receiptId={String(receipt.id)}
          line={inspectLine}
          onClose={() => setInspectLine(null)}
          onDone={() => {
            setInspectLine(null);
            refresh();
          }}
        />
      ) : null}

      {putawayLine && receipt ? (
        <PutawayDialog
          receiptId={String(receipt.id)}
          line={putawayLine}
          onClose={() => setPutawayLine(null)}
          onDone={() => {
            setPutawayLine(null);
            refresh();
          }}
        />
      ) : null}

      <LedgerDialog
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
        title="Receipt ledger"
        subtitle={receipt?.receipt_no}
        referenceId={String(receipt?.id ?? id)}
        canReverse={can('inventory.adjust.approve')}
        onChanged={() => setVersion((value) => value + 1)}
      />
    </>
  );
}

function InspectLineDialog({
  receiptId,
  line,
  onClose,
  onDone,
}: {
  receiptId: string;
  line: ReceiptLine;
  onClose: () => void;
  onDone: () => void;
}) {
  const remaining = lineUninspected(line);
  const [accepted, setAccepted] = useState(String(remaining));
  const [rejected, setRejected] = useState('0');
  const [quarantined, setQuarantined] = useState('0');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();

  const submit = async () => {
    setFormError(null);
    const acceptedQty = toInt(accepted);
    const rejectedQty = toInt(rejected);
    const quarantinedQty = toInt(quarantined);
    if ([acceptedQty, rejectedQty, quarantinedQty].some((value) => !Number.isInteger(value) || value < 0)) {
      setFormError('Quantities must be non-negative whole numbers.');
      return;
    }
    const total = acceptedQty + rejectedQty + quarantinedQty;
    if (total <= 0) {
      setFormError('Inspect at least one unit.');
      return;
    }
    if (total > remaining) {
      setFormError(`Only ${remaining} units remain uninspected on this line.`);
      return;
    }
    const result = await action.run(() =>
      api.post(
        `/receipts/${receiptId}/lines/${line.id}/inspect`,
        {
          acceptedQty,
          rejectedQty,
          quarantinedQty,
          notes: notes.trim() || null,
        },
        idempotencyKey(),
      ),
    );
    if (result !== undefined) onDone();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Inspect ${line.sku}`}
      subtitle={`${line.product_name}${line.batch_no ? ` · batch ${line.batch_no}` : ''}`}
      wide
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={action.running}>
            {action.running ? 'Posting inspection…' : 'Record inspection'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={formError ?? action.error} />
        <div className="callout callout-info">
          <Icon name="info" size={16} />
          <div>
            <strong>{remaining} unit(s) remain uninspected.</strong>
            <span className="muted small"> Accepted units become sellable in staging; rejected and quarantined units stay blocked in the ledger.</span>
          </div>
        </div>
        <div className="form-grid three">
          <Field label="Accepted" required>
            <input className="input" type="number" min={0} max={remaining} value={accepted} onChange={(event) => setAccepted(event.target.value)} />
          </Field>
          <Field label="Rejected">
            <input className="input" type="number" min={0} max={remaining} value={rejected} onChange={(event) => setRejected(event.target.value)} />
          </Field>
          <Field label="Quarantined">
            <input className="input" type="number" min={0} max={remaining} value={quarantined} onChange={(event) => setQuarantined(event.target.value)} />
          </Field>
        </div>
        <Field label="Inspection notes" hint="Notes are stored with the inspection and audit event.">
          <textarea className="input textarea" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
        <p className="muted small">
          Total inspected: {formatNumber(toInt(accepted) + toInt(rejected) + toInt(quarantined))} of {formatNumber(remaining)} remaining.
        </p>
      </div>
    </Dialog>
  );
}

function PutawayDialog({
  receiptId,
  line,
  onClose,
  onDone,
}: {
  receiptId: string;
  line: ReceiptLine;
  onClose: () => void;
  onDone: () => void;
}) {
  const remaining = Number(line.remaining_to_putaway);
  const [quantity, setQuantity] = useState(String(remaining));
  const [locationId, setLocationId] = useState('');
  const [reason, setReason] = useState('Putaway');
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();

  const submit = async () => {
    setFormError(null);
    const qty = toInt(quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      setFormError('Putaway quantity must be a positive whole number.');
      return;
    }
    if (qty > remaining) {
      setFormError(`Only ${remaining} accepted units remain to be put away.`);
      return;
    }
    if (!locationId) {
      setFormError('Choose a RACK destination.');
      return;
    }
    const result = await action.run(() =>
      api.post(
        '/putaway',
        {
          receiptId,
          productId: line.product_id,
          batchId: line.batch_id,
          quantity: qty,
          toLocationId: locationId,
          boxId: null,
          reason: reason.trim() || 'Putaway',
        },
        idempotencyKey(),
      ),
    );
    if (result !== undefined) onDone();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Put away ${line.sku}`}
      subtitle={`${line.product_name}${line.batch_no ? ` · batch ${line.batch_no}` : ''}`}
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={action.running}>
            {action.running ? 'Posting…' : 'Post putaway'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={formError ?? action.error} />
        <p className="muted small">
          {remaining} accepted unit(s) are available in staging. Putaway moves stock to a RACK location in the same warehouse.
        </p>
        <div className="form-grid two">
          <Field label="Quantity" required>
            <input className="input" type="number" min={1} max={remaining} value={quantity} onChange={(event) => setQuantity(event.target.value)} />
          </Field>
          <Field label="Destination rack" required>
            <LocationSelect value={locationId} onChange={setLocationId} types={['RACK']} required />
          </Field>
        </div>
        <Field label="Reason">
          <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

interface ReceiptDraftLine {
  qty: string;
  batchNo: string;
  expiryDate: string;
}

function NewReceiptDialog({
  open,
  initialPoId,
  onClose,
  onCreated,
}: {
  open: boolean;
  initialPoId?: string | null;
  onClose: () => void;
  onCreated: (receipt: { id: string; receiptNo: string; status: string }) => void;
}) {
  const { can } = useAuth();
  const [poId, setPoId] = useState('');
  const [stagingLocationId, setStagingLocationId] = useState('');
  const [poolId, setPoolId] = useState('');
  const [vendorInvoiceRef, setVendorInvoiceRef] = useState('');
  const [notes, setNotes] = useState('');
  const [allowExcess, setAllowExcess] = useState(false);
  const [excessReason, setExcessReason] = useState('');
  const [drafts, setDrafts] = useState<Record<string, ReceiptDraftLine>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();

  const poList = useApi<PurchaseOrderRow[]>(open ? '/purchase-orders' : null);
  const detail = useApi<PurchaseOrderDetail>(open && poId ? `/purchase-orders/${poId}` : null);
  const products = useProductOptions('', '');
  const productMap = new Map<string, ProductOption>(products.products.map((product) => [product.id, product]));

  useEffect(() => {
    if (!open) return;
    setPoId(initialPoId ?? '');
    setStagingLocationId('');
    setPoolId('');
    setVendorInvoiceRef('');
    setNotes('');
    setAllowExcess(false);
    setExcessReason('');
    setDrafts({});
    setFormError(null);
    action.setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPoId]);

  useEffect(() => {
    if (!detail.data) return;
    const next: Record<string, ReceiptDraftLine> = {};
    for (const line of detail.data.lines) {
      const openQty = Math.max(Number(line.ordered_qty) - Number(line.received_qty), 0);
      next[line.id] = { qty: String(openQty), batchNo: '', expiryDate: '' };
    }
    setDrafts(next);
  }, [detail.data]);

  const receivablePos = (poList.data ?? []).filter((po) => ['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status));
  const lines = detail.data?.lines.filter((line) => Number(line.ordered_qty) - Number(line.received_qty) > 0) ?? [];

  const updateDraft = (lineId: string, patch: Partial<ReceiptDraftLine>) => {
    setDrafts((current) => ({ ...current, [lineId]: { ...current[lineId], ...patch } }));
  };

  const submit = async () => {
    setFormError(null);
    if (!poId) return setFormError('Choose an approved purchase order.');
    if (!stagingLocationId) return setFormError('Choose a staging location.');
    if (!poolId) return setFormError('Choose a stock pool.');
    if (!lines.length) return setFormError('This purchase order has no open quantity to receive.');

    const receiptLines: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      const draft = drafts[line.id] ?? { qty: '', batchNo: '', expiryDate: '' };
      const qty = toInt(draft.qty);
      if (qty === 0) continue;
      if (!Number.isInteger(qty) || qty < 0) return setFormError(`Enter a whole number for ${line.sku}.`);
      const tracked = productMap.get(line.product_id)?.is_batch_tracked === 1;
      if (tracked && !draft.batchNo.trim()) {
        return setFormError(`SKU ${line.sku} is batch tracked — enter the batch number.`);
      }
      const openQty = Number(line.ordered_qty) - Number(line.received_qty);
      if (qty > openQty && !allowExcess) {
        return setFormError(`Receiving ${qty} × ${line.sku} exceeds the open quantity ${openQty}. Enable excess receipt with an approval reason.`);
      }
      receiptLines.push({
        poLineId: line.id,
        productId: line.product_id,
        quantity: qty,
        batchNo: tracked ? draft.batchNo.trim() : null,
        expiryDate: tracked && draft.expiryDate ? draft.expiryDate : null,
      });
    }
    if (!receiptLines.length) return setFormError('Enter a received quantity on at least one line.');
    if (allowExcess && !excessReason.trim()) return setFormError('Explain why the excess receipt is authorized.');

    const result = await action.run(() =>
      api.post(
        '/receipts',
        {
          poId,
          stagingLocationId,
          poolId,
          vendorInvoiceRef: vendorInvoiceRef.trim() || null,
          notes: notes.trim() || null,
          allowExcess: can('inbound.approve') ? allowExcess : false,
          excessReason: allowExcess ? excessReason.trim() : null,
          lines: receiptLines,
        },
        idempotencyKey(),
      ),
    );
    if (result) onCreated(result as { id: string; receiptNo: string; status: string });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      extraWide
      title="Receive goods"
      subtitle="Receipts are posted against an approved purchase order and land in staging as QC-pending stock."
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={action.running || !poId}>
            {action.running ? 'Posting receipt…' : 'Post receipt'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={formError ?? action.error} />
        <ErrorNote error={poList.error ?? detail.error} />
        <div className="form-grid two">
          <Field label="Purchase order" required hint="Only approved or partially received POs can be received.">
            <select className="input" value={poId} onChange={(event) => setPoId(event.target.value)} required>
              <option value="">Select an approved purchase order</option>
              {receivablePos.map((po) => (
                <option key={po.id} value={po.id}>
                  {po.po_no} · {po.vendor_name} · {formatNumber(po.open_qty)} open
                </option>
              ))}
            </select>
          </Field>
          <Field label="Vendor invoice reference">
            <input className="input" value={vendorInvoiceRef} onChange={(event) => setVendorInvoiceRef(event.target.value)} placeholder="Invoice / DC number" />
          </Field>
          <Field label="Staging location" required hint="Received stock first lands in STAGING and is held for QC.">
            <LocationSelect value={stagingLocationId} onChange={setStagingLocationId} types={['STAGING']} required />
          </Field>
          <Field label="Stock pool" required>
            <PoolSelect value={poolId} onChange={setPoolId} required />
          </Field>
        </div>

        {poId ? (
          detail.loading && !detail.data ? (
            <div className="center-pad"><Spinner label="Loading purchase order…" /></div>
          ) : lines.length === 0 ? (
            <div className="empty-state">
              <strong>Nothing open on this purchase order</strong>
              <p>All ordered quantities have already been received.</p>
            </div>
          ) : (
            <div className="line-editor">
              <div className="line-editor-head">
                <strong>Receipt lines</strong>
                <span className="muted small">Quantities default to the open ordered quantity. Clear a quantity to skip a line.</span>
              </div>
              {lines.map((line) => {
                const product = productMap.get(line.product_id);
                const tracked = product?.is_batch_tracked === 1;
                const draft = drafts[line.id] ?? { qty: '', batchNo: '', expiryDate: '' };
                const openQty = Number(line.ordered_qty) - Number(line.received_qty);
                return (
                  <div className="line-row" key={line.id}>
                    <div className="line-summary">
                      <strong>{line.sku}</strong>
                      <span className="muted small">{line.product_name}</span>
                      <span className="tiny muted">
                        Ordered {formatNumber(line.ordered_qty)} · received {formatNumber(line.received_qty)} · open{' '}
                        {formatNumber(openQty)}
                      </span>
                      {tracked ? <StatusPill value="Batch tracked" tone="info" dot={false} /> : null}
                    </div>
                    <div className="line-fields">
                      <Field label="Receive qty">
                        <input
                          className="input"
                          type="number"
                          min={0}
                          value={draft.qty}
                          onChange={(event) => updateDraft(line.id, { qty: event.target.value })}
                        />
                      </Field>
                      {tracked ? (
                        <>
                          <Field label="Batch no" required>
                            <input
                              className="input"
                              value={draft.batchNo}
                              onChange={(event) => updateDraft(line.id, { batchNo: event.target.value })}
                              placeholder="Batch number"
                            />
                          </Field>
                          <Field label="Expiry date">
                            <input
                              className="input"
                              type="date"
                              value={draft.expiryDate}
                              onChange={(event) => updateDraft(line.id, { expiryDate: event.target.value })}
                            />
                          </Field>
                        </>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : null}

        {can('inbound.approve') ? (
          <div className="stack">
            <label className="check-row">
              <input type="checkbox" checked={allowExcess} onChange={(event) => setAllowExcess(event.target.checked)} />
              <span>
                <strong>Authorize excess receipt</strong>
                <span className="muted small"> Allows quantities above the open ordered quantity with an audited reason.</span>
              </span>
            </label>
            {allowExcess ? (
              <Field label="Excess reason" required>
                <input className="input" value={excessReason} onChange={(event) => setExcessReason(event.target.value)} />
              </Field>
            ) : null}
          </div>
        ) : null}

        <Field label="Notes">
          <textarea className="input textarea" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function PurchaseOrderDialog({
  id,
  onClose,
  onChanged,
  onOpenReceipt,
  onReceive,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
  onOpenReceipt: (receiptId: string) => void;
  onReceive: (poId: string) => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const state = useApi<PurchaseOrderDetail>(`/purchase-orders/${id}`, version);
  const vendors = useApi<VendorRow[]>('/vendors', version);
  const approve = useAction();
  const detail = state.data;
  const po = detail?.po;
  const vendor = (vendors.data ?? []).find((row) => row.id === po?.vendor_id);

  const runApprove = async () => {
    if (!po) return;
    const result = await approve.run(() => api.post(`/purchase-orders/${po.id}/approve`));
    if (result !== undefined) {
      toast.notify(`Purchase order ${po.po_no} approved.`, 'success');
      setVersion((value) => value + 1);
      onChanged();
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      extraWide
      title={po ? `Purchase order ${po.po_no}` : 'Purchase order'}
      subtitle={vendor ? vendor.name : 'Procurement'}
      footer={
        <div className="dialog-footer-row">
          <span className="muted small">Approval is separated from receiving and recorded in the audit trail.</span>
          <div className="inline-actions">
            <button type="button" className="btn btn-subtle" onClick={onClose}>
              Close
            </button>
            {po?.status === 'PENDING_APPROVAL' && can('inbound.approve') ? (
              <button type="button" className="btn btn-primary" onClick={() => void runApprove()} disabled={approve.running}>
                {approve.running ? 'Approving…' : 'Approve PO'}
              </button>
            ) : null}
            {po && ['APPROVED', 'PARTIALLY_RECEIVED'].includes(String(po.status)) && can('inbound.receive') ? (
              <button type="button" className="btn btn-primary" onClick={() => onReceive(String(po.id))}>
                Receive goods
              </button>
            ) : null}
          </div>
        </div>
      }
    >
      {state.loading && !detail ? <div className="center-pad"><Spinner label="Loading purchase order…" /></div> : null}
      <ErrorNote error={state.error ?? approve.error} />
      {detail && po ? (
        <div className="stack">
          <div className="detail-grid">
            <MetaList
              items={[
                { label: 'Status', value: <StatusPill value={po.status} /> },
                { label: 'Vendor', value: vendor ? `${vendor.name}${vendor.vendor_code ? ` · ${vendor.vendor_code}` : ''}` : po.vendor_id },
                { label: 'Expected date', value: formatDate(po.expected_date) },
                { label: 'Created', value: formatDateTime(po.created_at) },
              ]}
            />
            <MetaList
              items={[
                { label: 'Open quantity', value: formatNumber(detail.lines.reduce((sum, line) => sum + Math.max(Number(line.ordered_qty) - Number(line.received_qty), 0), 0)) },
                { label: 'Receipts', value: String(detail.receipts.length) },
                { label: 'Approved at', value: formatDateTime(po.approved_at) },
                { label: 'Notes', value: po.notes ?? '—' },
              ]}
            />
          </div>

          <Card title="Ordered lines" flush>
            <DataTable
              columns={[
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
                { key: 'ordered_qty', header: 'Ordered', className: 'num', render: (line) => formatNumber(line.ordered_qty) },
                { key: 'received_qty', header: 'Received', className: 'num', render: (line) => formatNumber(line.received_qty) },
                {
                  key: 'open_qty',
                  header: 'Open',
                  className: 'num',
                  render: (line) => formatNumber(Math.max(Number(line.ordered_qty) - Number(line.received_qty), 0)),
                },
                { key: 'unit_cost', header: 'Unit cost', className: 'num', render: (line) => (line.unit_cost === null ? '—' : formatMoney(line.unit_cost)) },
              ]}
              rows={detail.lines}
              rowKey={(line) => line.id}
              emptyTitle="No lines"
            />
          </Card>

          <Card title="Receipts against this PO" flush>
            <DataTable
              columns={[
                { key: 'receipt_no', header: 'Receipt' },
                { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
                { key: 'received_at', header: 'Received', render: (row) => formatDateTime(row.received_at) },
                {
                  key: 'actions',
                  header: '',
                  render: (row) => (
                    <button type="button" className="btn btn-subtle btn-xs" onClick={() => onOpenReceipt(row.id)}>
                      Open receipt
                    </button>
                  ),
                },
              ]}
              rows={detail.receipts}
              rowKey={(row) => row.id}
              emptyTitle="No receipts yet"
              emptyMessage="Receive goods against this purchase order to create a receipt."
            />
          </Card>
        </div>
      ) : null}
    </Dialog>
  );
}

interface PoDraftLine {
  key: number;
  productId: string;
  qty: string;
  unitCost: string;
}

let poLineKey = 1;

function newPoLine(): PoDraftLine {
  return { key: poLineKey++, productId: '', qty: '1', unitCost: '' };
}

function NewPurchaseOrderDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (po: { id: string; poNo: string }) => void;
}) {
  const [vendorId, setVendorId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<PoDraftLine[]>([newPoLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();
  const vendors = useApi<VendorRow[]>(open ? '/vendors' : null);
  const products = useProductOptions('', 'ACTIVE');

  useEffect(() => {
    if (!open) return;
    setVendorId('');
    setExpectedDate('');
    setNotes('');
    setRows([newPoLine()]);
    setFormError(null);
    action.setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const updateRow = (key: number, patch: Partial<PoDraftLine>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const submit = async () => {
    setFormError(null);
    if (!vendorId) return setFormError('Choose a vendor.');
    const complete = rows.filter((row) => row.productId);
    if (!complete.length) return setFormError('Add at least one product line.');
    const lines: Array<{ productId: string; orderedQty: number; unitCost: number | null }> = [];
    for (const row of complete) {
      const qty = toInt(row.qty);
      if (!Number.isInteger(qty) || qty <= 0) return setFormError('Ordered quantities must be positive whole numbers.');
      let unitCost: number | null = null;
      if (row.unitCost.trim()) {
        const parsed = Number(row.unitCost);
        if (!Number.isFinite(parsed) || parsed < 0) return setFormError('Unit cost must be zero or more.');
        unitCost = Math.round(parsed * 100) / 100;
      }
      if (new Set(complete.map((entry) => entry.productId)).size !== complete.length) {
        return setFormError('Each product can appear on only one purchase order line.');
      }
      lines.push({ productId: row.productId, orderedQty: qty, unitCost });
    }
    const result = await action.run(() =>
      api.post('/purchase-orders', {
        vendorId,
        expectedDate: expectedDate || null,
        notes: notes.trim() || null,
        lines,
      }),
    );
    if (result) onCreated(result as { id: string; poNo: string });
  };

  const activeVendors = (vendors.data ?? []).filter((vendor) => vendor.status === 'ACTIVE');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      extraWide
      title="New purchase order"
      subtitle="Purchase orders start as pending approval and cannot be received until approved."
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={action.running}>
            {action.running ? 'Creating…' : 'Submit for approval'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={formError ?? action.error} />
        <ErrorNote error={vendors.error} />
        <div className="form-grid three">
          <Field label="Vendor" required>
            <select className="input" value={vendorId} onChange={(event) => setVendorId(event.target.value)} required>
              <option value="">Select an active vendor</option>
              {activeVendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendor.name}
                  {vendor.vendor_code ? ` · ${vendor.vendor_code}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Expected date">
            <input className="input" type="date" value={expectedDate} onChange={(event) => setExpectedDate(event.target.value)} />
          </Field>
          <Field label="Notes">
            <input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} />
          </Field>
        </div>

        <div className="line-editor">
          <div className="line-editor-head">
            <strong>Order lines</strong>
            <button type="button" className="btn btn-subtle btn-xs" onClick={() => setRows((current) => [...current, newPoLine()])}>
              <Icon name="plus" size={13} /> Add line
            </button>
          </div>
          {rows.map((row) => (
            <div className="line-row" key={row.key}>
              <div className="line-fields">
                <Field label="Product" required>
                  <ProductSelect value={row.productId} onChange={(value) => updateRow(row.key, { productId: value })} products={products.products} />
                </Field>
                <Field label="Ordered qty" required>
                  <input className="input" type="number" min={1} value={row.qty} onChange={(event) => updateRow(row.key, { qty: event.target.value })} />
                </Field>
                <Field label="Unit cost (optional)">
                  <input
                    className="input"
                    type="number"
                    min={0}
                    step="0.01"
                    value={row.unitCost}
                    onChange={(event) => updateRow(row.key, { unitCost: event.target.value })}
                    placeholder="0.00"
                  />
                </Field>
                <button
                  type="button"
                  className="icon-btn line-remove"
                  aria-label="Remove line"
                  disabled={rows.length === 1}
                  onClick={() => setRows((current) => current.filter((entry) => entry.key !== row.key))}
                >
                  <Icon name="close" size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

function NewVendorDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState({
    name: '',
    vendorCode: '',
    gstin: '',
    contactName: '',
    email: '',
    phone: '',
    address: '',
    paymentTerms: '',
    leadTimeDays: '',
    minOrderQty: '',
  });
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();

  useEffect(() => {
    if (!open) return;
    setForm({
      name: '',
      vendorCode: '',
      gstin: '',
      contactName: '',
      email: '',
      phone: '',
      address: '',
      paymentTerms: '',
      leadTimeDays: '',
      minOrderQty: '',
    });
    setFormError(null);
    action.setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (key: keyof typeof form) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async () => {
    setFormError(null);
    if (!form.name.trim()) return setFormError('Vendor name is required.');
    const result = await action.run(() =>
      api.post('/vendors', {
        name: form.name.trim(),
        vendorCode: form.vendorCode.trim() || undefined,
        gstin: form.gstin.trim() || null,
        contactName: form.contactName.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        address: form.address.trim() || null,
        paymentTerms: form.paymentTerms.trim() || null,
        leadTimeDays: form.leadTimeDays.trim() ? toInt(form.leadTimeDays) : null,
        minOrderQty: form.minOrderQty.trim() ? toInt(form.minOrderQty) : null,
      }),
    );
    if (result) onCreated((result as { id: string }).id);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="New vendor"
      subtitle="Vendors must be active before purchase orders can be raised."
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={action.running}>
            {action.running ? 'Saving…' : 'Create vendor'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={formError ?? action.error} />
        <div className="form-grid two">
          <Field label="Vendor name" required>
            <input className="input" value={form.name} onChange={set('name')} maxLength={200} autoFocus />
          </Field>
          <Field label="Vendor code">
            <input className="input" value={form.vendorCode} onChange={set('vendorCode')} maxLength={30} placeholder="Auto-generated when blank" />
          </Field>
          <Field label="GSTIN">
            <input className="input" value={form.gstin} onChange={set('gstin')} maxLength={30} />
          </Field>
          <Field label="Contact name">
            <input className="input" value={form.contactName} onChange={set('contactName')} maxLength={120} />
          </Field>
          <Field label="Email">
            <input className="input" type="email" value={form.email} onChange={set('email')} maxLength={200} />
          </Field>
          <Field label="Phone">
            <input className="input" value={form.phone} onChange={set('phone')} maxLength={40} />
          </Field>
          <Field label="Payment terms">
            <input className="input" value={form.paymentTerms} onChange={set('paymentTerms')} maxLength={100} placeholder="e.g. Net 30" />
          </Field>
          <Field label="Lead time (days)">
            <input className="input" type="number" min={0} value={form.leadTimeDays} onChange={set('leadTimeDays')} />
          </Field>
          <Field label="Minimum order qty">
            <input className="input" type="number" min={0} value={form.minOrderQty} onChange={set('minOrderQty')} />
          </Field>
          <Field label="Address" className="span-2">
            <textarea className="input textarea" rows={2} value={form.address} onChange={set('address')} maxLength={1000} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

interface VendorPerformance {
  vendor: { id: string; vendor_code: string | null; name: string };
  summary: {
    purchaseOrders: number;
    fullyReceived: number;
    openOrders: number;
    receiptCount: number;
    receivedQty: number;
    acceptedQty: number;
    rejectedQty: number;
    quarantinedQty: number;
    rejectionRate: number | null;
    onTimeReceipts: number;
    onTimeRate: number | null;
  };
  formulaNotes: { rejectionRate: string; onTimeRate: string };
}

function VendorPerformanceDialog({ vendor, onClose }: { vendor: VendorRow; onClose: () => void }) {
  const state = useApi<VendorPerformance>(`/vendors/${vendor.id}/performance`);

  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title={`${vendor.name} · performance`}
      subtitle={vendor.vendor_code ?? 'Vendor metrics'}
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      }
    >
      {state.loading && !state.data ? <div className="center-pad"><Spinner label="Computing performance…" /></div> : null}
      <ErrorNote error={state.error} />
      {state.data ? (
        <div className="stack">
          <div className="stat-grid four">
            <Stat label="Purchase orders" value={formatNumber(state.data.summary.purchaseOrders)} />
            <Stat label="Fully received" value={formatNumber(state.data.summary.fullyReceived)} tone="success" />
            <Stat label="Open orders" value={formatNumber(state.data.summary.openOrders)} tone="warning" />
            <Stat label="Receipts" value={formatNumber(state.data.summary.receiptCount)} tone="info" />
          </div>
          <div className="stat-grid four">
            <Stat label="Received units" value={formatNumber(state.data.summary.receivedQty)} />
            <Stat label="Accepted units" value={formatNumber(state.data.summary.acceptedQty)} tone="success" />
            <Stat label="Rejected units" value={formatNumber(state.data.summary.rejectedQty)} tone="danger" />
            <Stat label="Quarantined units" value={formatNumber(state.data.summary.quarantinedQty)} tone="warning" />
          </div>
          <div className="detail-grid">
            <MetaList
              items={[
                { label: 'Rejection rate', value: percent(state.data.summary.rejectionRate) },
                { label: 'Formula', value: state.data.formulaNotes.rejectionRate },
              ]}
            />
            <MetaList
              items={[
                { label: 'On-time receipts', value: `${formatNumber(state.data.summary.onTimeReceipts)} · ${percent(state.data.summary.onTimeRate)}` },
                { label: 'Formula', value: state.data.formulaNotes.onTimeRate },
              ]}
            />
          </div>
          <p className="muted small">Metrics are computed from posted purchase orders and receipt lines; they are never entered manually.</p>
        </div>
      ) : null}
    </Dialog>
  );
}
