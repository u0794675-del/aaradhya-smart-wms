import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  idempotencyKey,
  queryString,
  titleCase,
} from '../api';
import { useAuth } from '../auth';
import { BulkBar, BulkDeleteDialog, useBulkSelection } from '../components/BulkDelete';
import { LedgerDialog } from '../components/LedgerDialog';
import { useApi, useDebouncedValue } from '../hooks';
import { useToast } from '../toast';
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
  Spinner,
  StatusPill,
  Tabs,
  type Column,
} from '../ui';

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  base_uom: string;
  on_hand: number;
  available: number;
  box_count: number;
  is_batch_tracked: number;
  is_expiry_tracked: number;
  qc_required: number;
  low_stock_threshold: number | null;
  cost_price?: number;
  status: string;
  created_at: string;
  verification_status?: string | null;
  source_verification?: string | null;
  source_row_no?: number | null;
  source_file?: string | null;
}

interface ProductDetailData {
  product: Record<string, any>;
  barcodes: Array<Record<string, any>>;
  aliases: Array<Record<string, any>>;
  conversions: Array<Record<string, any>>;
  batches: Array<Record<string, any>>;
  children: Array<Record<string, any>>;
  parent: Record<string, any> | null;
  summary: {
    rows: Array<Record<string, any>>;
    onHand: number;
    available: number;
  };
  source?: Record<string, any> | null;
}

interface BalanceRow {
  id: string;
  product_id: string;
  sku: string;
  product_name: string;
  base_uom: string;
  status: string;
  quantity: number;
  reserved_quantity: number;
  pool_code: string;
  location_code: string;
  location_type: string;
  box_id: string | null;
  box_code: string | null;
  batch_id: string | null;
  batch_no: string | null;
  expiry_date: string | null;
  updated_at: string;
}

interface ProductList {
  rows: ProductRow[];
  total: number;
}

const UOMS = ['PIECE', 'STRIP', 'PACK', 'CARTON', 'BOX', 'CASE'];

export function InventoryPage() {
  return <InventoryWorkspace initialTab="stock" />;
}

export function ProductsPage() {
  return <InventoryWorkspace initialTab="products" />;
}

function InventoryWorkspace({ initialTab }: { initialTab: 'stock' | 'products' }) {
  const { can, meta } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'stock' | 'products'>(initialTab);
  const [productSearch, setProductSearch] = useState('');
  const debouncedProductSearch = useDebouncedValue(productSearch, 300);
  const [statusFilter, setStatusFilter] = useState('');

  const [stockProductId, setStockProductId] = useState(params.get('product') ?? '');
  const [poolId, setPoolId] = useState('');
  const [locationId, setLocationId] = useState(params.get('locationId') ?? '');
  const [balanceStatus, setBalanceStatus] = useState('');
  const [ledgerTarget, setLedgerTarget] = useState<{ productId: string; label: string } | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const productSelection = useBulkSelection();
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  useEffect(() => {
    const productParam = params.get('product');
    if (productParam) {
      setStockProductId(productParam);
      setTab('stock');
    }
    const locationParam = params.get('locationId');
    if (locationParam) {
      setLocationId(locationParam);
      setTab('stock');
    }
  }, [params]);

  const productIndex = useApi<ProductList>('/products?limit=200');
  const productListPath = `/products${queryString({
    search: debouncedProductSearch || undefined,
    status: statusFilter || undefined,
    limit: 200,
  })}`;
  const products = useApi<ProductList>(productListPath);
  const balances = useApi<{ rows: BalanceRow[]; total: number }>(
    `/inventory/balances${queryString({
      productId: stockProductId || undefined,
      poolId: poolId || undefined,
      locationId: locationId || undefined,
      status: balanceStatus || undefined,
      limit: 500,
    })}`,
  );

  const productMap = useMemo(() => {
    const map = new Map<string, ProductRow>();
    for (const product of productIndex.data?.rows ?? []) map.set(product.id, product);
    return map;
  }, [productIndex.data]);

  function reloadAll() {
    products.reload();
    productIndex.reload();
    balances.reload();
  }

  const productRows = products.data?.rows ?? [];
  const selectedProductIds = productSelection.selected.filter((id) => productRows.some((row) => row.id === id));
  const allProductsSelected = productRows.length > 0 && selectedProductIds.length === productRows.length;

  const productColumns: Array<Column<ProductRow>> = [
    ...(can('product.manage')
      ? [
          {
            key: 'select',
            className: 'select-col',
            header: (
              <input
                type="checkbox"
                aria-label="Select all products"
                checked={allProductsSelected}
                onChange={() =>
                  allProductsSelected
                    ? productSelection.clear()
                    : productSelection.selectMany(productRows.map((row) => row.id))
                }
              />
            ),
            render: (row: ProductRow) => (
              <span onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  aria-label={`Select ${row.sku}`}
                  checked={selectedProductIds.includes(row.id)}
                  onChange={() => productSelection.toggle(row.id)}
                />
              </span>
            ),
          } satisfies Column<ProductRow>,
        ]
      : []),
    {
      key: 'sku',
      header: 'SKU',
      render: (row) => (
        <div>
          <code className="code">{row.sku}</code>
          {row.status !== 'ACTIVE' ? <div><StatusPill value={row.status} dot={false} /></div> : null}
        </div>
      ),
    },
    {
      key: 'name',
      header: 'Product',
      render: (row) => (
        <div>
          <strong className="cell-title">{row.name}</strong>
          <span className="muted tiny">{row.category ?? 'Uncategorised'} · {titleCase(row.base_uom)}</span>
        </div>
      ),
    },
    {
      key: 'tracking',
      header: 'Tracking',
      render: (row) => (
        <div className="tag-row">
          {row.is_batch_tracked ? <span className="tag">Batch</span> : null}
          {row.is_expiry_tracked ? <span className="tag">Expiry</span> : null}
          {row.qc_required ? <span className="tag">QC</span> : null}
          {!row.is_batch_tracked && !row.is_expiry_tracked && !row.qc_required ? <span className="muted tiny">—</span> : null}
        </div>
      ),
    },
    { key: 'on_hand', header: 'On hand', className: 'num', render: (row) => formatNumber(row.on_hand) },
    {
      key: 'available',
      header: 'Available',
      className: 'num',
      render: (row) => {
        const threshold = Number(row.low_stock_threshold ?? 20);
        const low = Number(row.available) < threshold;
        return <span className={low ? 'text-warning strong' : ''}>{formatNumber(row.available)}</span>;
      },
    },
    { key: 'box_count', header: 'Boxes', className: 'num', render: (row) => formatNumber(row.box_count) },
    {
      key: 'verification_status',
      header: 'Verification',
      render: (row) =>
        row.verification_status ? <StatusPill value={row.verification_status} /> : <span className="muted">—</span>,
    },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
    {
      key: 'actions',
      header: '',
      className: 'actions',
      render: (row) => (
        <button type="button" className="btn btn-subtle btn-xs" onClick={() => setSelectedProductId(row.id)}>
          View
        </button>
      ),
    },
  ];

  const balanceColumns: Array<Column<BalanceRow>> = [
    {
      key: 'sku',
      header: 'SKU / product',
      render: (row) => (
        <div>
          <code className="code">{row.sku}</code>
          <span className="muted tiny clamp-1">{row.product_name}</span>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
    { key: 'quantity', header: 'On hand', className: 'num', render: (row) => formatNumber(row.quantity) },
    { key: 'reserved_quantity', header: 'Reserved', className: 'num', render: (row) => formatNumber(row.reserved_quantity) },
    {
      key: 'available',
      header: 'Available',
      className: 'num',
      render: (row) => formatNumber(Number(row.quantity) - Number(row.reserved_quantity)),
    },
    { key: 'pool_code', header: 'Pool', render: (row) => <span className="tag">{row.pool_code}</span> },
    {
      key: 'location',
      header: 'Location',
      render: (row) => (
        <div>
          <strong>{row.location_code}</strong>
          <span className="muted tiny">{titleCase(row.location_type)}</span>
        </div>
      ),
    },
    {
      key: 'box',
      header: 'Box',
      render: (row) =>
        row.box_id ? (
          <Link className="inline-link" to={`/boxes?box=${row.box_id}`} onClick={(event) => event.stopPropagation()}>
            {row.box_code}
          </Link>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'batch',
      header: 'Batch / expiry',
      render: (row) => (
        <div>
          <span>{row.batch_no ?? '—'}</span>
          {row.expiry_date ? <span className="muted tiny">exp {formatDate(row.expiry_date)}</span> : null}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'actions',
      render: (row) => (
        <button
          type="button"
          className="btn btn-subtle btn-xs"
          onClick={(event) => {
            event.stopPropagation();
            setLedgerTarget({ productId: row.product_id, label: `${row.sku} — ${row.product_name}` });
          }}
        >
          Ledger
        </button>
      ),
    },
  ];

  const stockProduct = stockProductId ? productMap.get(stockProductId) : null;

  return (
    <div className="page">
      <PageHeader
        title={initialTab === 'products' ? 'Product Master' : 'Inventory'}
        subtitle={
          initialTab === 'products'
            ? 'SKUs, barcodes, UOM conversions, batches and stock visibility.'
            : 'Canonical stock by pool, location, box, batch and status.'
        }
        eyebrow="Single authoritative ledger"
        actions={
          <>
            {can('audit.read') ? (
              <Link className="btn btn-subtle" to="/reports?tab=stock">
                <Icon name="reports" size={16} /> Stock report
              </Link>
            ) : null}
            {tab === 'products' && can('product.manage') ? (
              <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                <Icon name="plus" size={16} /> New product
              </button>
            ) : null}
            <button type="button" className="btn btn-subtle" onClick={reloadAll}>
              <Icon name="refresh" size={16} /> Refresh
            </button>
          </>
        }
      />

      <Tabs
        tabs={[
          { key: 'stock', label: 'Stock balances', count: balances.data?.total },
          { key: 'products', label: 'Products', count: products.data?.total },
        ]}
        active={tab}
        onChange={(key) => {
          setTab(key as 'stock' | 'products');
          if (key === 'stock' && params.has('product')) {
            const next = new URLSearchParams(params);
            next.delete('product');
            setParams(next, { replace: true });
          }
        }}
      />

      {tab === 'products' ? (
        <Card flush>
          <div className="toolbar">
            <div className="search-inline">
              <Icon name="search" size={16} />
              <input
                className="input"
                placeholder="Search SKU, name or barcode…"
                value={productSearch}
                onChange={(event) => setProductSearch(event.target.value)}
              />
            </div>
            <select className="input compact-input" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
          </div>
          <ErrorNote error={products.error} />
          <BulkBar
            count={selectedProductIds.length}
            noun="product"
            onClear={productSelection.clear}
            onDelete={() => setBulkDeleteOpen(true)}
          />
          <DataTable
            columns={productColumns}
            rows={products.data?.rows ?? []}
            loading={products.loading && !products.data}
            emptyTitle="No products found"
            emptyMessage={productSearch ? 'Try a different SKU or product name.' : 'Create the first product or run a controlled import.'}
            onRowClick={(row) => setSelectedProductId(row.id)}
          />
          <div className="table-foot">
            Showing {products.data?.rows.length ?? 0} of {products.data?.total ?? 0} products
          </div>
          <BulkDeleteDialog
            open={bulkDeleteOpen}
            entityLabel="product"
            endpoint="/products/bulk-delete"
            ids={selectedProductIds}
            onClose={() => setBulkDeleteOpen(false)}
            onCompleted={() => {
              productSelection.clear();
              reloadAll();
            }}
          />
        </Card>
      ) : (
        <div className="stack">
          {can('audit.read') ? <ReconciliationPanel /> : null}
          <Card flush>
            <div className="toolbar wrap">
              <select
                className="input compact-input"
                value={stockProductId}
                onChange={(event) => setStockProductId(event.target.value)}
              >
                <option value="">All products</option>
                {(productIndex.data?.rows ?? []).map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} — {product.name}
                  </option>
                ))}
              </select>
              <select className="input compact-input" value={poolId} onChange={(event) => setPoolId(event.target.value)}>
                <option value="">All pools</option>
                {(meta?.pools ?? []).map((pool) => (
                  <option key={pool.id} value={pool.id}>{pool.code}</option>
                ))}
              </select>
              <select className="input compact-input" value={locationId} onChange={(event) => setLocationId(event.target.value)}>
                <option value="">All locations</option>
                {(meta?.locations ?? []).map((location) => (
                  <option key={location.id} value={location.id}>{location.code}</option>
                ))}
              </select>
              <select className="input compact-input" value={balanceStatus} onChange={(event) => setBalanceStatus(event.target.value)}>
                <option value="">All statuses</option>
                {['AVAILABLE', 'RESERVED', 'PICKED', 'IN_TRANSIT', 'QC_PENDING', 'QUARANTINED', 'DAMAGED', 'REJECTED', 'EXPIRED', 'RETURN_PENDING', 'REWORK'].map((status) => (
                  <option key={status} value={status}>{titleCase(status)}</option>
                ))}
              </select>
              {stockProduct || poolId || locationId || balanceStatus ? (
                <button
                  type="button"
                  className="btn btn-subtle btn-sm"
                  onClick={() => {
                    setStockProductId('');
                    setPoolId('');
                    setLocationId('');
                    setBalanceStatus('');
                    if (params.has('product') || params.has('locationId')) {
                      const next = new URLSearchParams(params);
                      next.delete('product');
                      next.delete('locationId');
                      setParams(next, { replace: true });
                    }
                  }}
                >
                  Clear filters
                </button>
              ) : null}
              <span className="toolbar-spacer" />
              <button type="button" className="btn btn-subtle btn-sm" onClick={() => balances.reload()}>
                <Icon name="refresh" size={14} /> Refresh
              </button>
            </div>
            <ErrorNote error={balances.error} />
            <DataTable
              columns={balanceColumns}
              rows={balances.data?.rows ?? []}
              rowKey={(row) => row.id}
              loading={balances.loading && !balances.data}
              emptyTitle="No stock matches these filters"
              emptyMessage="Receive and put away stock, or clear the filters to see the full ledger state."
              onRowClick={(row) => setLedgerTarget({ productId: row.product_id, label: `${row.sku} — ${row.product_name}` })}
            />
            <div className="table-foot">
              Showing {balances.data?.rows.length ?? 0} of {balances.data?.total ?? 0} balance rows · every stock quantity is derived from the immutable ledger
            </div>
          </Card>
        </div>
      )}

      <LedgerDialog
        open={Boolean(ledgerTarget)}
        onClose={() => setLedgerTarget(null)}
        subtitle={ledgerTarget?.label}
        productId={ledgerTarget?.productId}
        canReverse={can('inventory.adjust.approve')}
        onChanged={reloadAll}
      />

      <Dialog
        open={Boolean(selectedProductId)}
        onClose={() => setSelectedProductId(null)}
        title="Product detail"
        subtitle="Master data, batches and stock breakdown."
        extraWide
      >
        {selectedProductId ? (
          <ProductDetail
            productId={selectedProductId}
            onChanged={reloadAll}
            onOpenLedger={(productId, label) => setLedgerTarget({ productId, label })}
          />
        ) : null}
      </Dialog>

      <CreateProductDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(productId) => {
          setCreateOpen(false);
          reloadAll();
          setSelectedProductId(productId);
          toast.notify('Product created and audited', 'success');
        }}
      />
    </div>
  );
}

function ReconciliationPanel() {
  const [result, setResult] = useState<{ ok: boolean; checks: Array<{ name: string; ok: boolean; details: unknown }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const data = await api.get<{ ok: boolean; checks: Array<{ name: string; ok: boolean; details: unknown }> }>('/inventory/reconciliation');
      setResult(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error('Reconciliation failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Ledger reconciliation"
      subtitle="Verifies balances against the ledger, reservation totals and box contents."
      actions={
        <button type="button" className="btn btn-subtle btn-sm" onClick={() => void run()} disabled={busy}>
          <Icon name="audit" size={14} /> {busy ? 'Checking…' : 'Run check'}
        </button>
      }
    >
      <ErrorNote error={error} />
      {!result ? (
        <p className="muted small">Run a reconciliation check to confirm every module agrees with the ledger.</p>
      ) : (
        <div className="recon">
          <div className={`recon-head ${result.ok ? 'ok' : 'bad'}`}>
            <Icon name={result.ok ? 'check' : 'alert'} size={18} />
            <strong>{result.ok ? 'All reconciliation checks passed' : 'Reconciliation mismatch detected'}</strong>
          </div>
          <div className="recon-checks">
            {result.checks.map((check) => (
              <details key={check.name} className={`recon-check ${check.ok ? 'ok' : 'bad'}`}>
                <summary>
                  <StatusPill value={check.ok ? 'PASSED' : 'FAILED'} tone={check.ok ? 'success' : 'danger'} />
                  <span>{titleCase(check.name)}</span>
                </summary>
                <JsonView value={check.details} />
              </details>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function CreateProductDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (productId: string) => void;
}) {
  const [form, setForm] = useState({
    name: '',
    sku: '',
    category: '',
    brand: '',
    baseUom: 'PIECE',
    isBatchTracked: false,
    isExpiryTracked: false,
    qcRequired: true,
    costPrice: '',
    lowStockThreshold: '20',
    barcode: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  function reset() {
    setForm({
      name: '',
      sku: '',
      category: '',
      brand: '',
      baseUom: 'PIECE',
      isBatchTracked: false,
      isExpiryTracked: false,
      qcRequired: true,
      costPrice: '',
      lowStockThreshold: '20',
      barcode: '',
    });
    setError(null);
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="Create product"
      subtitle="SKUs are permanent identifiers; stock is always recorded in the base UOM."
      wide
      footer={
        <>
          <button type="button" className="btn btn-subtle" onClick={() => { onClose(); reset(); }}>Cancel</button>
          <button
            type="submit"
            form="create-product-form"
            className="btn btn-primary"
            disabled={busy || !form.name.trim()}
          >
            {busy ? 'Creating…' : 'Create product'}
          </button>
        </>
      }
    >
      <ErrorNote error={error} />
      <form
        id="create-product-form"
        className="form-grid"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const created = await api.post<ProductDetailData>('/products', {
              name: form.name.trim(),
              sku: form.sku.trim() || undefined,
              category: form.category.trim() || null,
              brand: form.brand.trim() || null,
              baseUom: form.baseUom,
              isBatchTracked: form.isBatchTracked,
              isExpiryTracked: form.isExpiryTracked,
              qcRequired: form.qcRequired,
              costPrice: form.costPrice === '' ? null : Number(form.costPrice),
              lowStockThreshold: form.lowStockThreshold === '' ? null : Number(form.lowStockThreshold),
              barcode: form.barcode.trim() || null,
            });
            reset();
            onCreated(created.product.id);
          } catch (reason) {
            setError(reason instanceof Error ? reason : new Error('Product creation failed'));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Product name" required className="span-2">
          <input className="input" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Arnica Montana 30C Dilution" />
        </Field>
        <Field label="SKU" hint="Leave blank to auto-generate AHP…">
          <input className="input" value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value.toUpperCase() })} placeholder="AHP00001" />
        </Field>
        <Field label="Base UOM" required>
          <select className="input" value={form.baseUom} onChange={(event) => setForm({ ...form, baseUom: event.target.value })}>
            {UOMS.map((uom) => <option key={uom} value={uom}>{titleCase(uom)}</option>)}
          </select>
        </Field>
        <Field label="Category">
          <input className="input" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} />
        </Field>
        <Field label="Brand">
          <input className="input" value={form.brand} onChange={(event) => setForm({ ...form, brand: event.target.value })} />
        </Field>
        <Field label="Cost price (₹)">
          <input className="input" inputMode="decimal" value={form.costPrice} onChange={(event) => setForm({ ...form, costPrice: event.target.value })} />
        </Field>
        <Field label="Low stock threshold">
          <input className="input" inputMode="numeric" value={form.lowStockThreshold} onChange={(event) => setForm({ ...form, lowStockThreshold: event.target.value })} />
        </Field>
        <Field label="Primary barcode" hint="Optional; can be added later.">
          <input className="input" value={form.barcode} onChange={(event) => setForm({ ...form, barcode: event.target.value })} />
        </Field>
        <div className="check-grid span-2">
          <label className="check">
            <input type="checkbox" checked={form.isBatchTracked} onChange={(event) => setForm({ ...form, isBatchTracked: event.target.checked, isExpiryTracked: event.target.checked ? form.isExpiryTracked : false })} />
            Batch tracked
          </label>
          <label className="check">
            <input type="checkbox" checked={form.isExpiryTracked} disabled={!form.isBatchTracked} onChange={(event) => setForm({ ...form, isExpiryTracked: event.target.checked })} />
            Expiry tracked
          </label>
          <label className="check">
            <input type="checkbox" checked={form.qcRequired} onChange={(event) => setForm({ ...form, qcRequired: event.target.checked })} />
            QC required on receipt
          </label>
        </div>
      </form>
    </Dialog>
  );
}

function ProductDetail({
  productId,
  onChanged,
  onOpenLedger,
}: {
  productId: string;
  onChanged: () => void;
  onOpenLedger: (productId: string, label: string) => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const detail = useApi<ProductDetailData>(`/products/${productId}`, version);
  const [batch, setBatch] = useState({ batchNo: '', mfgDate: '', expiryDate: '' });
  const [barcode, setBarcode] = useState({ barcode: '', type: 'INTERNAL' });
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function refresh() {
    setVersion((value) => value + 1);
    onChanged();
    toast.notify('Product updated', 'success');
  }

  async function addBatch() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/products/${productId}/batches`, {
        batchNo: batch.batchNo.trim(),
        mfgDate: batch.mfgDate || null,
        expiryDate: batch.expiryDate || null,
      });
      setBatch({ batchNo: '', mfgDate: '', expiryDate: '' });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error('Could not add batch'));
    } finally {
      setBusy(false);
    }
  }

  async function addBarcode() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/products/${productId}/barcodes`, { barcode: barcode.barcode.trim(), type: barcode.type });
      setBarcode({ barcode: '', type: 'INTERNAL' });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error('Could not add barcode'));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/products/${productId}`, {
        name: edit.name,
        brand: edit.brand || null,
        category: edit.category || null,
        costPrice: edit.costPrice === '' || edit.costPrice === null ? null : Number(edit.costPrice),
        lowStockThreshold: edit.lowStockThreshold === '' || edit.lowStockThreshold === null ? null : Number(edit.lowStockThreshold),
        status: edit.status,
        isBatchTracked: Boolean(edit.is_batch_tracked),
        isExpiryTracked: Boolean(edit.is_expiry_tracked),
        qcRequired: Boolean(edit.qc_required),
      });
      setEditing(false);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error('Could not update product'));
    } finally {
      setBusy(false);
    }
  }

  if (detail.loading && !detail.data) {
    return <div className="center-pad"><Spinner label="Loading product…" /></div>;
  }
  if (detail.error || !detail.data) {
    return <ErrorNote error={detail.error ?? 'Product could not be loaded'} />;
  }

  const { product, barcodes, conversions, batches, summary, children, parent, source } = detail.data;
  const label = `${product.sku} — ${product.name}`;

  return (
    <div className="stack">
      <ErrorNote error={detail.error ?? error} />
      <div className="detail-head">
        <div>
          <div className="detail-title-row">
            <h3>{product.name}</h3>
            <StatusPill value={product.status} />
          </div>
          <div className="muted">{product.sku} · {titleCase(product.base_uom)} {product.category ? `· ${product.category}` : ''}</div>
        </div>
        <div className="detail-actions">
          <button type="button" className="btn btn-subtle btn-sm" onClick={() => onOpenLedger(product.id, label)}>
            <Icon name="audit" size={14} /> Ledger
          </button>
          <Link className="btn btn-subtle btn-sm" to={`/trace?type=PRODUCT&id=${product.id}`}>
            <Icon name="trace" size={14} /> Trace
          </Link>
          {can('product.manage') ? (
            <button
              type="button"
              className="btn btn-subtle btn-sm"
              onClick={() => {
                setEdit({ ...product, costPrice: product.cost_price ?? '', lowStockThreshold: product.low_stock_threshold ?? '' });
                setEditing((value) => !value);
              }}
            >
              <Icon name="adjust" size={14} /> {editing ? 'Cancel edit' : 'Edit'}
            </button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="inline-form-panel">
          <div className="form-grid">
            <Field label="Name" required><input className="input" value={edit.name ?? ''} onChange={(event) => setEdit({ ...edit, name: event.target.value })} /></Field>
            <Field label="Category"><input className="input" value={edit.category ?? ''} onChange={(event) => setEdit({ ...edit, category: event.target.value })} /></Field>
            <Field label="Brand"><input className="input" value={edit.brand ?? ''} onChange={(event) => setEdit({ ...edit, brand: event.target.value })} /></Field>
            <Field label="Status">
              <select className="input" value={edit.status ?? 'ACTIVE'} onChange={(event) => setEdit({ ...edit, status: event.target.value })}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </select>
            </Field>
            <Field label="Cost price"><input className="input" inputMode="decimal" value={edit.costPrice ?? ''} onChange={(event) => setEdit({ ...edit, costPrice: event.target.value })} /></Field>
            <Field label="Low stock threshold"><input className="input" inputMode="numeric" value={edit.lowStockThreshold ?? ''} onChange={(event) => setEdit({ ...edit, lowStockThreshold: event.target.value })} /></Field>
            <div className="check-grid span-2">
              <label className="check"><input type="checkbox" checked={Boolean(edit.is_batch_tracked)} onChange={(event) => setEdit({ ...edit, is_batch_tracked: event.target.checked ? 1 : 0 })} /> Batch tracked</label>
              <label className="check"><input type="checkbox" checked={Boolean(edit.is_expiry_tracked)} onChange={(event) => setEdit({ ...edit, is_expiry_tracked: event.target.checked ? 1 : 0 })} /> Expiry tracked</label>
              <label className="check"><input type="checkbox" checked={Boolean(edit.qc_required)} onChange={(event) => setEdit({ ...edit, qc_required: event.target.checked ? 1 : 0 })} /> QC required</label>
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !edit.name} onClick={() => void saveEdit()}>Save changes</button>
          </div>
        </div>
      ) : null}

      <div className="detail-grid">
        <div>
          <h4 className="section-title">Master data</h4>
          <MetaList
            items={[
              { label: 'SKU', value: <code className="code">{product.sku}</code> },
              { label: 'Base UOM', value: titleCase(product.base_uom) },
              { label: 'Brand', value: product.brand ?? '—' },
              { label: 'Category', value: product.category ?? '—' },
              { label: 'Batch tracked', value: product.is_batch_tracked ? 'Yes' : 'No' },
              { label: 'Expiry tracked', value: product.is_expiry_tracked ? 'Yes' : 'No' },
              { label: 'QC required', value: product.qc_required ? 'Yes' : 'No' },
              { label: 'Low stock threshold', value: product.low_stock_threshold ?? 'Default' },
              ...(product.cost_price !== undefined ? [{ label: 'Cost price', value: formatMoney(product.cost_price) }] : []),
              { label: 'Created', value: formatDateTime(product.created_at) },
              ...(parent ? [{ label: 'Parent SKU', value: parent.sku }] : []),
            ]}
          />
          {source ? (
            <>
              <h4 className="section-title">Source provenance</h4>
              <MetaList
                items={[
                  { label: 'Verification', value: <StatusPill value={source.verification_status ?? 'NEEDS_VERIFICATION'} /> },
                  { label: 'Source SKU', value: <code className="code">{source.source_sku ?? product.sku}</code> },
                  { label: 'Source product key', value: source.source_product_key ?? '—' },
                  { label: 'Source barcode', value: source.source_barcode ?? '—' },
                  { label: 'Source verification text', value: source.source_verification ?? '—' },
                  {
                    label: 'Source row',
                    value: `${source.source_sheet ?? '—'}${source.source_row_no ? ` · row ${source.source_row_no}` : ''}`,
                  },
                  { label: 'Import file', value: source.source_file ?? '—' },
                ]}
              />
            </>
          ) : null}
        </div>
        <div>
          <h4 className="section-title">Stock summary</h4>
          <div className="summary-numbers">
            <div><span>On hand</span><strong>{formatNumber(summary.onHand)}</strong></div>
            <div><span>Available</span><strong>{formatNumber(summary.available)}</strong></div>
          </div>
          <div className="table-wrap compact">
            <table className="data-table">
              <thead><tr><th>Pool</th><th>Status</th><th className="num">Qty</th><th className="num">Reserved</th><th className="num">Avail.</th></tr></thead>
              <tbody>
                {summary.rows.length === 0 ? (
                  <tr><td colSpan={5} className="muted center">No stock on hand</td></tr>
                ) : summary.rows.map((row, index) => (
                  <tr key={`${row.pool}-${row.status}-${index}`}>
                    <td>{row.pool}</td>
                    <td><StatusPill value={row.status} dot={false} /></td>
                    <td className="num">{formatNumber(row.quantity)}</td>
                    <td className="num">{formatNumber(row.reserved)}</td>
                    <td className="num">{formatNumber(row.available)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="detail-grid">
        <div>
          <h4 className="section-title">Batches</h4>
          {batches.length === 0 ? (
            <p className="muted small">No batches recorded.</p>
          ) : (
            <div className="table-wrap compact">
              <table className="data-table">
                <thead><tr><th>Batch</th><th>Mfg</th><th>Expiry</th><th /></tr></thead>
                <tbody>
                  {batches.map((row) => (
                    <tr key={row.id}>
                      <td>{row.batch_no}</td>
                      <td>{row.mfg_date ? formatDate(row.mfg_date) : '—'}</td>
                      <td>{row.expiry_date ? formatDate(row.expiry_date) : '—'}</td>
                      <td className="actions"><Link className="inline-link" to={`/trace?type=BATCH&id=${row.id}`}>Trace</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {can('inbound.receive') ? (
            <div className="inline-form-panel tight">
              <strong className="small">Add batch</strong>
              <div className="form-grid three">
                <Field label="Batch number" required><input className="input" value={batch.batchNo} onChange={(event) => setBatch({ ...batch, batchNo: event.target.value })} /></Field>
                <Field label="Mfg date"><input className="input" type="date" value={batch.mfgDate} onChange={(event) => setBatch({ ...batch, mfgDate: event.target.value })} /></Field>
                <Field label="Expiry date"><input className="input" type="date" value={batch.expiryDate} onChange={(event) => setBatch({ ...batch, expiryDate: event.target.value })} /></Field>
              </div>
              <button type="button" className="btn btn-subtle btn-sm" disabled={busy || !batch.batchNo.trim()} onClick={() => void addBatch()}>Add batch</button>
            </div>
          ) : null}
        </div>
        <div>
          <h4 className="section-title">Barcodes & conversions</h4>
          <div className="tag-row">
            {barcodes.map((code) => (
              <span className="tag" key={code.id}>{code.barcode} · {code.barcode_type}</span>
            ))}
            {barcodes.length === 0 ? <span className="muted small">No barcodes.</span> : null}
          </div>
          {can('product.manage') ? (
            <div className="inline-form-row">
              <input className="input" placeholder="New barcode" value={barcode.barcode} onChange={(event) => setBarcode({ ...barcode, barcode: event.target.value })} />
              <select className="input compact-input" value={barcode.type} onChange={(event) => setBarcode({ ...barcode, type: event.target.value })}>
                {['INTERNAL', 'EAN', 'CODE128', 'QR'].map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
              <button type="button" className="btn btn-subtle btn-sm" disabled={busy || !barcode.barcode.trim()} onClick={() => void addBarcode()}>Add</button>
            </div>
          ) : null}
          <div className="conversion-list">
            {conversions.length === 0 ? (
              <span className="muted small">No UOM conversions.</span>
            ) : conversions.map((row) => (
              <span className="tag" key={row.id}>1 {titleCase(row.from_uom)} = {row.factor} {titleCase(row.to_uom)}</span>
            ))}
          </div>
          {children.length > 0 ? (
            <>
              <h4 className="section-title">Variants</h4>
              {children.map((child) => <div key={child.id} className="muted small">{child.sku} — {child.name}</div>)}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
