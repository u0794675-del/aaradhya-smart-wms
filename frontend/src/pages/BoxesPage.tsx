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
  InlineLink,
  MetaList,
  PageHeader,
  Spinner,
  Stat,
  StatusPill,
  type Column,
} from '../ui';
import { BatchSelect, LocationSelect, PoolSelect, ProductSelect, ReasonDialog } from '../components/forms';
import { BulkBar, BulkDeleteDialog, useBulkSelection } from '../components/BulkDelete';
import { LedgerDialog } from '../components/LedgerDialog';

interface BoxRow {
  id: string;
  box_code: string;
  box_type: string;
  status: string;
  location_id: string | null;
  pool_id: string | null;
  created_at: string;
  notes: string | null;
  location_code: string | null;
  pool_code: string | null;
  total_quantity: number;
  available_quantity: number;
  sku_count: number;
  verification_status?: string | null;
  source_barcode?: string | null;
  source_zone?: string | null;
  source_rack?: string | null;
  source_bin?: string | null;
  source_box_quantity?: number | null;
}

interface BoxList {
  rows: BoxRow[];
  total: number;
}

interface BoxContent {
  product_id: string;
  sku: string;
  product_name: string;
  batch_id: string | null;
  batch_no: string | null;
  expiry_date: string | null;
  status: string;
  location_code: string | null;
  quantity: number;
  reserved_quantity: number;
}

interface TimelineEntry {
  kind: string;
  id: string;
  at: string;
  type: string;
  reference: string;
  quantity: number | null;
  sku: string | null;
  actor: string | null;
  reason: string | null;
}

interface BoxDetail {
  box: {
    id: string;
    box_code: string;
    box_type: string;
    status: string;
    notes: string | null;
    created_at: string;
    reuse_count: number;
  };
  location: { id: string; code: string; type: string } | null;
  pool: { id: string; code: string; name: string } | null;
  contents: BoxContent[];
  totals: { total: number; reserved: number; available: number };
  skuCount: number;
  createdBy: string | null;
  source?: Record<string, any> | null;
  sourceJob?: { id: string; file_name: string; created_at: string } | null;
  timeline: TimelineEntry[];
}

export function BoxesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('box');
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [version, setVersion] = useState(0);
  const [page, setPage] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const boxSelection = useBulkSelection();
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const pageSize = 100;
  const query = queryString({ search, type, status, limit: pageSize, offset: page * pageSize });
  const list = useApi<BoxList>(`/boxes${query}`, version);

  const openBox = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('box', id);
    setParams(next, { replace: true });
  };
  const closeBox = () => {
    const next = new URLSearchParams(params);
    next.delete('box');
    setParams(next, { replace: true });
  };

  const boxRows = list.data?.rows ?? [];
  const selectedBoxIds = boxSelection.selected.filter((id) => boxRows.some((row) => row.id === id));
  const allBoxesSelected = boxRows.length > 0 && selectedBoxIds.length === boxRows.length;

  const columns: Array<Column<BoxRow>> = [
    ...(can('box.manage')
      ? [
          {
            key: 'select',
            className: 'select-col',
            header: (
              <input
                type="checkbox"
                aria-label="Select all boxes"
                checked={allBoxesSelected}
                onChange={() =>
                  allBoxesSelected
                    ? boxSelection.clear()
                    : boxSelection.selectMany(boxRows.map((row) => row.id))
                }
              />
            ),
            render: (row: BoxRow) => (
              <span onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  aria-label={`Select ${row.box_code}`}
                  checked={selectedBoxIds.includes(row.id)}
                  onChange={() => boxSelection.toggle(row.id)}
                />
              </span>
            ),
          } satisfies Column<BoxRow>,
        ]
      : []),
    {
      key: 'box_code',
      header: 'Box',
      render: (row) => (
        <div className="cell-title">
          <strong>{row.box_code}</strong>
          <span className="muted tiny">{titleCase(row.box_type)} box</span>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
    {
      key: 'verification_status',
      header: 'Verification',
      render: (row) =>
        row.verification_status ? <StatusPill value={row.verification_status} /> : <span className="muted">—</span>,
    },
    {
      key: 'source',
      header: 'Source label / location',
      render: (row) =>
        row.source_barcode || row.source_rack || row.source_bin ? (
          <div className="cell-title">
            <code className="code">{row.source_barcode ?? row.box_code}</code>
            <span className="muted tiny">
              {[row.source_zone, row.source_rack, row.source_bin].filter(Boolean).join(' · ') || 'No source position'}
            </span>
          </div>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { key: 'location_code', header: 'Location', render: (row) => row.location_code ?? <span className="muted">Unpositioned</span> },
    { key: 'pool_code', header: 'Pool', render: (row) => row.pool_code ?? '—' },
    {
      key: 'total_quantity',
      header: 'On hand',
      className: 'num',
      render: (row) => (
        <div className="cell-title right">
          <strong>{formatNumber(row.total_quantity)}</strong>
          <span className="muted tiny">{formatNumber(row.sku_count)} SKU{Number(row.sku_count) === 1 ? '' : 's'}</span>
        </div>
      ),
    },
    {
      key: 'available_quantity',
      header: 'Available',
      className: 'num',
      render: (row) => formatNumber(row.available_quantity),
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
        <button type="button" className="btn btn-subtle btn-xs" onClick={() => openBox(row.id)}>
          Open
        </button>
      ),
    },
  ];

  const boxes = boxRows;
  const totals = boxes.reduce(
    (acc, row) => ({
      boxes: acc.boxes + 1,
      units: acc.units + Number(row.total_quantity),
      available: acc.available + Number(row.available_quantity),
      skus: acc.skus + Number(row.sku_count),
    }),
    { boxes: 0, units: 0, available: 0, skus: 0 },
  );

  const totalBoxes = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalBoxes / pageSize));
  const clampedPage = Math.min(page, pageCount - 1);
  const showingFrom = totalBoxes === 0 ? 0 : clampedPage * pageSize + 1;
  const showingTo = clampedPage * pageSize + boxes.length;

  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  const goToPage = (next: number) => {
    boxSelection.clear();
    setPage(Math.max(0, Math.min(next, pageCount - 1)));
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Mixed-box inventory"
        title="Boxes"
        subtitle="One authoritative box record for every single and mixed box, with direct access to its contents, movements and audit history."
        actions={
          can('box.manage') ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={16} /> New box
            </button>
          ) : null
        }
      />

      <div className="stat-grid four">
        <Stat label="Boxes on this page" value={formatNumber(totals.boxes)} icon="boxes" />
        <Stat label="Units on this page" value={formatNumber(totals.units)} icon="inventory" tone="info" />
        <Stat label="Available units" value={formatNumber(totals.available)} icon="check" tone="success" />
        <Stat label="Distinct SKUs" value={formatNumber(totals.skus)} icon="products" />
      </div>

      <Card
        title="Box register"
        subtitle={
          list.data
            ? totalBoxes === 0
              ? 'No boxes match this filter'
              : `${formatNumber(totalBoxes)} boxes · showing ${formatNumber(showingFrom)}–${formatNumber(showingTo)}`
            : 'Loading box register'
        }
        actions={
          <div className="toolbar">
            <div className="search-inline">
              <Icon name="search" size={15} />
              <input
                className="input compact-input"
                placeholder="Box code, SKU or product"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
              />
            </div>
            <select
              className="input compact-input"
              value={type}
              onChange={(event) => {
                setType(event.target.value);
                setPage(0);
              }}
            >
              <option value="">All types</option>
              <option value="SINGLE">Single</option>
              <option value="MIXED">Mixed</option>
            </select>
            <select
              className="input compact-input"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(0);
              }}
            >
              <option value="">All statuses</option>
              {['ACTIVE', 'EMPTY', 'STAGING', 'DAMAGED', 'RETIRED'].map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </select>
          </div>
        }
        flush
      >
        <ErrorNote error={list.error} />
        <BulkBar
          count={selectedBoxIds.length}
          noun="box"
          onClear={boxSelection.clear}
          onDelete={() => setBulkDeleteOpen(true)}
        />
        <DataTable
          columns={columns}
          rows={boxes}
          loading={list.loading}
          rowKey={(row) => row.id}
          onRowClick={(row) => openBox(row.id)}
          emptyTitle="No boxes match this filter"
          emptyMessage="Create a box or clear the filters to see the register."
        />
        {pageCount > 1 ? (
          <div className="toolbar pagination">
            <span className="muted small">
              Page {clampedPage + 1} of {pageCount}
            </span>
            <span className="toolbar-spacer" />
            <button
              type="button"
              className="btn btn-subtle btn-sm"
              disabled={clampedPage === 0}
              onClick={() => goToPage(clampedPage - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn btn-subtle btn-sm"
              disabled={clampedPage >= pageCount - 1}
              onClick={() => goToPage(clampedPage + 1)}
            >
              Next
            </button>
          </div>
        ) : null}
        <BulkDeleteDialog
          open={bulkDeleteOpen}
          entityLabel="box"
          endpoint="/boxes/bulk-delete"
          ids={selectedBoxIds}
          onClose={() => setBulkDeleteOpen(false)}
          onCompleted={() => {
            boxSelection.clear();
            setVersion((value) => value + 1);
          }}
        />
      </Card>

      {selectedId ? (
        <BoxDetailDialog
          id={selectedId}
          onClose={closeBox}
          onChanged={() => {
            setVersion((value) => value + 1);
            toast.notify('Box updated and inventory ledger refreshed.', 'success');
          }}
        />
      ) : null}

      <CreateBoxDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(box) => {
          setCreateOpen(false);
          toast.notify(`Box ${box.boxCode} created.`, 'success');
          setVersion((value) => value + 1);
          openBox(box.id);
        }}
      />
    </div>
  );
}

function CreateBoxDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (box: { id: string; boxCode: string }) => void;
}) {
  const [boxType, setBoxType] = useState<'SINGLE' | 'MIXED'>('MIXED');
  const [locationId, setLocationId] = useState('');
  const [poolId, setPoolId] = useState('');
  const [notes, setNotes] = useState('');
  const action = useAction();

  useEffect(() => {
    if (open) {
      setBoxType('MIXED');
      setLocationId('');
      setPoolId('');
      setNotes('');
      action.setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    const result = await action.run(() =>
      api.post<{ id: string; boxCode: string }>(
        '/boxes',
        { boxType, locationId, poolId, notes: notes.trim() || undefined },
        idempotencyKey(),
      ),
    );
    if (result) onCreated(result);
  };

  return (
    <Dialog
      open={open}
      title="Create box"
      subtitle="The box receives a unique scannable code and starts empty."
      onClose={onClose}
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={action.running || !locationId || !poolId}
          >
            {action.running ? 'Creating…' : 'Create box'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={action.error} />
        <div className="form-grid">
          <Field label="Box type" required>
            <select className="input" value={boxType} onChange={(event) => setBoxType(event.target.value as 'SINGLE' | 'MIXED')}>
              <option value="MIXED">Mixed box</option>
              <option value="SINGLE">Single SKU box</option>
            </select>
          </Field>
          <Field label="Current location" required>
            <LocationSelect value={locationId} onChange={setLocationId} />
          </Field>
          <Field label="Stock pool" required>
            <PoolSelect value={poolId} onChange={setPoolId} />
          </Field>
          <Field label="Notes">
            <input className="input" value={notes} maxLength={500} onChange={(event) => setNotes(event.target.value)} />
          </Field>
        </div>
        <p className="muted small">
          A mixed box can hold multiple SKUs and batches. Every addition is posted as a validated stock movement to the ledger.
        </p>
      </div>
    </Dialog>
  );
}

type BoxAction = 'add' | 'remove' | 'move' | null;

function BoxDetailDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const detail = useApi<BoxDetail>(`/boxes/${id}`, version);
  const [action, setAction] = useState<BoxAction>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [reuseOpen, setReuseOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<BoxContent | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);

  const refresh = () => {
    setVersion((value) => value + 1);
    onChanged();
  };

  const data = detail.data;
  const box = data?.box;
  const canMove = can('inventory.move');
  const canManage = can('box.manage');

  return (
    <Dialog
      open
      title={box ? `Box ${box.box_code}` : 'Box detail'}
      subtitle={box ? `${titleCase(box.box_type)} box · ${titleCase(box.status)}` : 'Loading box record'}
      onClose={onClose}
      extraWide
      footer={
        <div className="form-actions spread">
          <div className="inline-actions">
            <button type="button" className="btn btn-subtle" onClick={() => setLedgerOpen(true)}>
              <Icon name="audit" size={15} /> Ledger
            </button>
            {canManage && box && ['RETIRED', 'EMPTY', 'DAMAGED'].includes(box.status) ? (
              <button type="button" className="btn btn-subtle" onClick={() => setReuseOpen(true)}>
                <Icon name="refresh" size={15} /> Reuse box
              </button>
            ) : null}
            {canManage && box && box.status !== 'RETIRED' ? (
              <button type="button" className="btn btn-danger" onClick={() => setRetireOpen(true)}>
                Retire
              </button>
            ) : null}
          </div>
          <button type="button" className="btn btn-subtle" onClick={onClose}>
            Close
          </button>
        </div>
      }
    >
      {detail.loading && !data ? <Spinner label="Loading box contents…" /> : null}
      <ErrorNote error={detail.error} />
      {data && box ? (
        <div className="stack">
          <div className="stat-grid four">
            <Stat label="Total units" value={formatNumber(data.totals.total)} icon="inventory" />
            <Stat label="Reserved" value={formatNumber(data.totals.reserved)} icon="lock" tone="warning" />
            <Stat label="Available" value={formatNumber(data.totals.available)} icon="check" tone="success" />
            <Stat label="SKUs" value={formatNumber(data.skuCount)} icon="products" />
          </div>

          <div className="detail-grid">
            <MetaList
              items={[
                { label: 'Box code', value: <strong>{box.box_code}</strong> },
                { label: 'Type', value: titleCase(box.box_type) },
                { label: 'Status', value: <StatusPill value={box.status} /> },
                { label: 'Location', value: data.location ? `${data.location.code} · ${titleCase(data.location.type)}` : 'Unpositioned' },
                { label: 'Pool', value: data.pool ? `${data.pool.code} · ${data.pool.name}` : '—' },
                { label: 'Created', value: formatDateTime(box.created_at) },
                { label: 'Created by', value: data.createdBy ?? '—' },
                { label: 'Reuse count', value: formatNumber(box.reuse_count) },
              ]}
            />
            {data.source ? (
              <MetaList
                items={[
                  {
                    label: 'Source verification',
                    value: <StatusPill value={data.source.verification_status ?? 'NEEDS_VERIFICATION'} />,
                  },
                  { label: 'Source barcode', value: <code className="code">{data.source.source_barcode ?? '—'}</code> },
                  {
                    label: 'Source position',
                    value:
                      [data.source.source_zone, data.source.source_rack, data.source.source_bin]
                        .filter(Boolean)
                        .join(' · ') || '—',
                  },
                  {
                    label: 'Source box qty',
                    value: data.source.source_box_quantity === null ? '—' : formatNumber(data.source.source_box_quantity),
                  },
                  {
                    label: 'Source row',
                    value: `${data.source.source_sheet ?? '—'}${data.source.source_row_no ? ` · row ${data.source.source_row_no}` : ''}`,
                  },
                  { label: 'Import file', value: data.sourceJob?.file_name ?? '—' },
                ]}
              />
            ) : null}
            <div className="detail-actions">
              {canMove ? (
                <button type="button" className="btn btn-primary" onClick={() => setAction(action === 'add' ? null : 'add')}>
                  <Icon name="plus" size={15} /> Add stock
                </button>
              ) : null}
              {canMove ? (
                <button type="button" className="btn btn-subtle" onClick={() => setMoveOpen(true)}>
                  <Icon name="transfer" size={15} /> Move box
                </button>
              ) : null}
              {box.notes ? <p className="muted small">Notes: {box.notes}</p> : null}
              <p className="muted tiny">
                Box contents are a projection of the canonical inventory ledger. They cannot be edited directly.
              </p>
            </div>
          </div>

          {action === 'add' ? (
            <BoxAddPanel
              boxId={box.id}
              boxLocationId={data.location?.id ?? ''}
              onDone={() => {
                setAction(null);
                refresh();
                toast.notify('Stock added to box.', 'success');
              }}
              onCancel={() => setAction(null)}
            />
          ) : null}

          <div>
            <h3 className="section-title">Contents</h3>
            <DataTable
              columns={[
                {
                  key: 'sku',
                  header: 'SKU',
                  render: (row: BoxContent) => (
                    <div className="cell-title">
                      <strong>{row.sku}</strong>
                      <span className="muted tiny">{row.product_name}</span>
                    </div>
                  ),
                },
                { key: 'batch_no', header: 'Batch / expiry', render: (row: BoxContent) => row.batch_no ?? <span className="muted">—</span> },
                { key: 'status', header: 'Status', render: (row: BoxContent) => <StatusPill value={row.status} /> },
                { key: 'quantity', header: 'Quantity', className: 'num', render: (row: BoxContent) => formatNumber(row.quantity) },
                {
                  key: 'reserved_quantity',
                  header: 'Reserved',
                  className: 'num',
                  render: (row: BoxContent) => formatNumber(row.reserved_quantity),
                },
                {
                  key: 'actions',
                  header: '',
                  render: (row: BoxContent) =>
                    canMove ? (
                      <button
                        type="button"
                        className="btn btn-subtle btn-xs"
                        onClick={() => {
                          setRemoveTarget(row);
                          setAction('remove');
                        }}
                      >
                        Remove
                      </button>
                    ) : null,
                },
              ]}
              rows={data.contents}
              compact
              emptyTitle="This box is empty"
              emptyMessage="Add stock to begin tracking mixed-box contents."
            />
          </div>

          {action === 'remove' && removeTarget ? (
            <BoxRemovePanel
              boxId={box.id}
              content={removeTarget}
              onDone={() => {
                setAction(null);
                setRemoveTarget(null);
                refresh();
                toast.notify('Stock removed from box.', 'success');
              }}
              onCancel={() => {
                setAction(null);
                setRemoveTarget(null);
              }}
            />
          ) : null}

          <div>
            <h3 className="section-title">Audit timeline</h3>
            <div className="timeline">
              {data.timeline.length === 0 ? <p className="muted small">No movements recorded for this box yet.</p> : null}
              {data.timeline.map((entry) => (
                <div className="timeline-row" key={`${entry.kind}-${entry.id}`}>
                  <div className="timeline-main">
                    <strong>{titleCase(entry.type)}</strong>
                    <span className="muted small">
                      {entry.reference}
                      {entry.sku ? ` · ${entry.sku}` : ''}
                      {entry.quantity !== null ? ` · ${formatNumber(entry.quantity)} units` : ''}
                    </span>
                    {entry.reason ? <span className="muted tiny">{entry.reason}</span> : null}
                  </div>
                  <div className="timeline-meta">
                    <span>{formatDateTime(entry.at)}</span>
                    <span>{entry.actor ?? 'System'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <LedgerDialog
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
        title="Box ledger"
        subtitle={box ? `${box.box_code} · every movement` : undefined}
        boxId={id}
        canReverse={can('inventory.adjust.approve')}
        onChanged={refresh}
      />

      <ReasonDialog
        open={retireOpen}
        title={box ? `Retire ${box.box_code}` : 'Retire box'}
        label="Retirement reason"
        hint="A box can only be retired when it holds no stock."
        confirmLabel="Retire box"
        danger
        onClose={() => setRetireOpen(false)}
        onConfirm={async (reason) => {
          await api.post(`/boxes/${id}/retire`, { reason }, idempotencyKey());
          toast.notify('Box retired.', 'success');
          refresh();
        }}
      />

      <ReuseBoxDialog
        open={reuseOpen}
        boxId={id}
        onClose={() => setReuseOpen(false)}
        onDone={() => {
          setReuseOpen(false);
          toast.notify('Box reused and repositioned.', 'success');
          refresh();
        }}
      />

      <MoveBoxDialog
        open={moveOpen}
        boxId={id}
        onClose={() => setMoveOpen(false)}
        onDone={() => {
          setMoveOpen(false);
          toast.notify('Box moved.', 'success');
          refresh();
        }}
      />

      <BoxLinkFooter boxId={id} />
    </Dialog>
  );
}

function BoxLinkFooter({ boxId }: { boxId: string }) {
  return (
    <div className="dialog-footnote">
      <InlineLink to={`/trace?type=BOX&id=${boxId}`}>Open full genealogy in a new workspace</InlineLink>
    </div>
  );
}

function BoxAddPanel({
  boxId,
  boxLocationId,
  onDone,
  onCancel,
}: {
  boxId: string;
  boxLocationId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [batchId, setBatchId] = useState('');
  const [fromLocationId, setFromLocationId] = useState('');
  const action = useAction();
  const products = useApi<{ rows: Array<{ id: string; is_batch_tracked: number }> }>('/products?status=ACTIVE&limit=200');
  const product = products.data?.rows.find((row) => row.id === productId);

  useEffect(() => {
    setBatchId('');
  }, [productId]);

  const submit = async () => {
    await action.run(async () => {
      await api.post(
        `/boxes/${boxId}/contents`,
        {
          productId,
          quantity: Number(quantity),
          batchId: batchId || null,
          fromLocationId,
          sourceBoxId: null,
          reason: 'Stock added to box',
        },
        idempotencyKey(),
      );
      onDone();
    });
  };

  return (
    <div className="inline-form-panel">
      <div className="inline-form-head">
        <strong>Add stock to this box</strong>
        <span className="muted tiny">Posted as a BOX_TRANSFER movement</span>
      </div>
      <ErrorNote error={action.error} />
      <div className="form-grid">
        <Field label="Product" required>
          <ProductSelect value={productId} onChange={setProductId} />
        </Field>
        <Field label="Quantity" required>
          <input
            className="input"
            type="number"
            min={1}
            step={1}
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </Field>
        {product?.is_batch_tracked === 1 ? (
          <Field label="Batch" required hint="Batch-tracked SKU">
            <BatchSelect productId={productId} value={batchId} onChange={setBatchId} required />
          </Field>
        ) : null}
        <Field label="Source location" required hint={boxLocationId ? 'Stock leaves this location and enters the box.' : undefined}>
          <LocationSelect value={fromLocationId} onChange={setFromLocationId} />
        </Field>
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn-subtle" onClick={onCancel} disabled={action.running}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit()}
          disabled={action.running || !productId || !fromLocationId || Number(quantity) < 1}
        >
          Add to box
        </button>
      </div>
    </div>
  );
}

function BoxRemovePanel({
  boxId,
  content,
  onDone,
  onCancel,
}: {
  boxId: string;
  content: BoxContent;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [quantity, setQuantity] = useState(String(content.quantity));
  const [toLocationId, setToLocationId] = useState('');
  const action = useAction();

  const submit = async () => {
    await action.run(async () => {
      await api.post(
        `/boxes/${boxId}/remove-contents`,
        {
          productId: content.product_id,
          quantity: Number(quantity),
          batchId: content.batch_id,
          toLocationId,
          reason: 'Stock removed from box',
        },
        idempotencyKey(),
      );
      onDone();
    });
  };

  return (
    <div className="inline-form-panel">
      <div className="inline-form-head">
        <strong>
          Remove {content.sku} from box
        </strong>
        <span className="muted tiny">
          {content.batch_no ? `Batch ${content.batch_no}` : 'No batch'} · {formatNumber(content.quantity)} available
        </span>
      </div>
      <ErrorNote error={action.error} />
      <div className="form-grid">
        <Field label="Quantity" required>
          <input
            className="input"
            type="number"
            min={1}
            max={content.quantity}
            step={1}
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </Field>
        <Field label="Destination location" required>
          <LocationSelect value={toLocationId} onChange={setToLocationId} />
        </Field>
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn-subtle" onClick={onCancel} disabled={action.running}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit()}
          disabled={action.running || !toLocationId || Number(quantity) < 1 || Number(quantity) > content.quantity}
        >
          Remove stock
        </button>
      </div>
    </div>
  );
}

function MoveBoxDialog({
  open,
  boxId,
  onClose,
  onDone,
}: {
  open: boolean;
  boxId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [toLocationId, setToLocationId] = useState('');
  const [reason, setReason] = useState('');
  const action = useAction();

  useEffect(() => {
    if (open) {
      setToLocationId('');
      setReason('');
      action.setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    const result = await action.run(() =>
      api.post(`/boxes/${boxId}/move`, { toLocationId, reason: reason.trim() || undefined }, idempotencyKey()),
    );
    if (result !== undefined) onDone();
  };

  return (
    <Dialog
      open={open}
      title="Move box"
      onClose={onClose}
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={action.running || !toLocationId}>
            Move box
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={action.error} />
        <Field label="Destination" required>
          <LocationSelect value={toLocationId} onChange={setToLocationId} />
        </Field>
        <Field label="Reason">
          <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
        </Field>
        <p className="muted small">The box and all of its contents move together. Each SKU is posted as a validated movement.</p>
      </div>
    </Dialog>
  );
}

function ReuseBoxDialog({
  open,
  boxId,
  onClose,
  onDone,
}: {
  open: boolean;
  boxId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [locationId, setLocationId] = useState('');
  const [poolId, setPoolId] = useState('');
  const action = useAction();

  useEffect(() => {
    if (open) {
      setLocationId('');
      setPoolId('');
      action.setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    const result = await action.run(() => api.post(`/boxes/${boxId}/reuse`, { locationId, poolId }, idempotencyKey()));
    if (result !== undefined) onDone();
  };

  return (
    <Dialog
      open={open}
      title="Reuse box"
      onClose={onClose}
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={action.running || !locationId || !poolId}
          >
            Return to service
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={action.error} />
        <div className="form-grid">
          <Field label="Location" required>
            <LocationSelect value={locationId} onChange={setLocationId} />
          </Field>
          <Field label="Stock pool" required>
            <PoolSelect value={poolId} onChange={setPoolId} />
          </Field>
        </div>
        <p className="muted small">Reusing a box resets its status and increments its reuse counter. The action is audited.</p>
      </div>
    </Dialog>
  );
}
