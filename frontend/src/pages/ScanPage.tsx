import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, formatDateTime, formatNumber } from '../api';
import { useAuth } from '../auth';
import { useAction } from '../hooks';
import {
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ErrorNote,
  Icon,
  MetaList,
  PageHeader,
  Spinner,
  StatusPill,
} from '../ui';
import { BarcodeScanner } from '../components/BarcodeScanner';
import { LedgerDialog } from '../components/LedgerDialog';
import { entityLink } from '../links';

interface ScanBox {
  type: 'BOX';
  box: { id: string; code: string; boxType: string; status: string; locationId: string | null; poolId: string | null };
  contents: Array<Record<string, any>>;
  totalQuantity: number;
}

interface ScanBatch {
  type: 'BATCH';
  batch: { id: string; batchNo: string; expiryDate: string | null; productId: string };
}

interface ScanProduct {
  type: 'PRODUCT';
  product: { id: string; sku: string; name: string; barcode: string; baseUom: string };
  balances: Array<Record<string, any>>;
}

interface ScanLocation {
  type: 'LOCATION';
  location: { id: string; code: string; type: string; status: string };
}

interface ScanTask {
  type: 'TASK';
  task: { id: string; taskNo: string; type: string; status: string };
}

type ScanResult = ScanBox | ScanBatch | ScanProduct | ScanLocation | ScanTask;

interface ScanHistory {
  code: string;
  label: string;
  type: string;
  at: string;
}

function describe(result: ScanResult): string {
  switch (result.type) {
    case 'BOX':
      return `${result.box.code} · ${result.totalQuantity} units`;
    case 'BATCH':
      return `${result.batch.batchNo} · expires ${result.batch.expiryDate ?? 'n/a'}`;
    case 'PRODUCT':
      return `${result.product.sku} · ${result.product.name}`;
    case 'LOCATION':
      return `${result.location.code} · ${result.location.type}`;
    case 'TASK':
      return `${result.task.taskNo} · ${result.task.type}`;
    default:
      return 'Scan result';
  }
}

export function ScanPage() {
  const { can } = useAuth();
  const [code, setCode] = useState('');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [scanning, setScanning] = useState(false);
  const [history, setHistory] = useState<ScanHistory[]>([]);
  const [ledgerOpen, setLedgerOpen] = useState(false);

  const scan = async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    setScanning(true);
    setError(null);
    setResult(null);
    try {
      const payload = await api.get<ScanResult>(`/scan/${encodeURIComponent(value)}`);
      setResult(payload);
      setHistory((current) =>
        [{ code: value, label: describe(payload), type: payload.type, at: new Date().toISOString() }, ...current].slice(0, 12),
      );
    } catch (reason) {
      setError(reason instanceof ApiError ? reason : new ApiError(0, 'SCAN_FAILED', String(reason)));
    } finally {
      setScanning(false);
    }
  };

  const ledgerTarget = result
    ? result.type === 'BOX'
      ? { boxId: result.box.id, title: `Box ${result.box.code} ledger` }
      : result.type === 'PRODUCT'
        ? { productId: result.product.id, title: `${result.product.sku} ledger` }
        : result.type === 'BATCH'
          ? { productId: result.batch.productId, title: `Batch ${result.batch.batchNo} movements` }
          : null
    : null;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Barcode / QR workstation"
        title="Scan station"
        subtitle="Scan a box, batch, product, location or task. The backend resolves every code authoritatively and returns the live stock position."
      />

      <div className="scan-layout">
        <div className="stack">
          <Card title="Scan a code" subtitle="Use a USB scanner, type the code, or start the camera.">
            <form
              className="scan-form"
              onSubmit={(event) => {
                event.preventDefault();
                void scan(code);
              }}
            >
              <div className="scan-input">
                <Icon name="scan" size={22} />
                <input
                  className="input"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="Scan or type a barcode"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="submit" className="btn btn-primary" disabled={scanning || !code.trim()}>
                  {scanning ? 'Resolving…' : 'Resolve'}
                </button>
              </div>
            </form>
            <BarcodeScanner
              disabled={scanning}
              onDetected={(text) => {
                setCode(text);
                void scan(text);
              }}
            />
            <p className="muted tiny">
              Camera decoding happens in the browser; the code itself is resolved by the server. Scans do not change stock.
            </p>
          </Card>

          <Card title="Recent scans" subtitle="Session only — stock records remain the source of truth.">
            {history.length === 0 ? (
              <EmptyState icon="scan" title="No scans yet" message="Resolved codes will appear here for quick re-checks." />
            ) : (
              <div className="scan-history">
                {history.map((entry, index) => (
                  <button
                    type="button"
                    className="scan-history-row"
                    key={`${entry.code}-${index}`}
                    onClick={() => {
                      setCode(entry.code);
                      void scan(entry.code);
                    }}
                  >
                    <span className={`scan-type type-${entry.type.toLowerCase()}`}>{entry.type}</span>
                    <span className="scan-history-main">
                      <strong>{entry.code}</strong>
                      <span className="muted tiny">{entry.label}</span>
                    </span>
                    <span className="muted tiny">{formatDateTime(entry.at)}</span>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <ErrorNote error={error} />
          {scanning ? (
            <Card>
              <Spinner label="Resolving code against the warehouse ledger…" />
            </Card>
          ) : null}
          {result ? (
            <Card
              title={`${result.type} found`}
              subtitle={describe(result)}
              actions={
                ledgerTarget ? (
                  <button type="button" className="btn btn-subtle btn-sm" onClick={() => setLedgerOpen(true)}>
                    <Icon name="audit" size={14} /> Ledger
                  </button>
                ) : null
              }
            >
              <ScanResultView result={result} />
            </Card>
          ) : !scanning && !error ? (
            <Card>
              <EmptyState
                icon="scan"
                title="Nothing scanned"
                message="Every scan is resolved by the backend. Products, boxes, batches, locations and tasks are supported."
              />
            </Card>
          ) : null}
        </div>
      </div>

      <LedgerDialog
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
        title={ledgerTarget?.title}
        productId={ledgerTarget && 'productId' in ledgerTarget ? ledgerTarget.productId : undefined}
        boxId={ledgerTarget && 'boxId' in ledgerTarget ? ledgerTarget.boxId : undefined}
        canReverse={can('inventory.adjust.approve')}
      />
    </div>
  );
}

function ScanResultView({ result }: { result: ScanResult }) {
  if (result.type === 'BOX') {
    return (
      <div className="stack">
        <MetaList
          items={[
            { label: 'Box code', value: <strong>{result.box.code}</strong> },
            { label: 'Type', value: result.box.boxType },
            { label: 'Status', value: <StatusPill value={result.box.status} /> },
            { label: 'Total units', value: formatNumber(result.totalQuantity) },
            { label: 'Contents', value: `${result.contents.length} stock line(s)` },
          ]}
        />
        <DataTable
          columns={[
            { key: 'sku', header: 'SKU', render: (row: Record<string, any>) => `${row.sku} · ${row.product_name}` },
            { key: 'batch_no', header: 'Batch', render: (row: Record<string, any>) => row.batch_no ?? '—' },
            { key: 'status', header: 'Status', render: (row: Record<string, any>) => <StatusPill value={String(row.status)} /> },
            { key: 'quantity', header: 'Qty', className: 'num', render: (row: Record<string, any>) => formatNumber(row.quantity) },
          ]}
          rows={result.contents}
          compact
          emptyTitle="Empty box"
        />
        <div className="inline-actions">
          <Link className="btn btn-primary btn-sm" to={`/boxes?box=${result.box.id}`}>
            Open box workspace
          </Link>
          <Link className="btn btn-subtle btn-sm" to={`/trace?type=BOX&id=${result.box.id}`}>
            Genealogy
          </Link>
        </div>
      </div>
    );
  }
  if (result.type === 'PRODUCT') {
    return (
      <div className="stack">
        <MetaList
          items={[
            { label: 'SKU', value: <strong>{result.product.sku}</strong> },
            { label: 'Product', value: result.product.name },
            { label: 'Base UOM', value: result.product.baseUom },
            { label: 'Barcode', value: <code>{result.product.barcode}</code> },
          ]}
        />
        <DataTable
          columns={[
            { key: 'status', header: 'Status', render: (row: Record<string, any>) => <StatusPill value={String(row.status)} /> },
            { key: 'quantity', header: 'Qty', className: 'num', render: (row: Record<string, any>) => formatNumber(row.quantity) },
            { key: 'reserved_quantity', header: 'Reserved', className: 'num', render: (row: Record<string, any>) => formatNumber(row.reserved_quantity) },
            { key: 'location', header: 'Location', render: (row: Record<string, any>) => row.location ?? '—' },
            { key: 'box_code', header: 'Box', render: (row: Record<string, any>) => row.box_code ?? '—' },
          ]}
          rows={result.balances}
          compact
          emptyTitle="No stock on hand"
        />
        <div className="inline-actions">
          <Link className="btn btn-primary btn-sm" to={`/inventory?product=${result.product.id}`}>
            Open inventory
          </Link>
          <Link className="btn btn-subtle btn-sm" to={`/trace?type=PRODUCT&id=${result.product.id}`}>
            Genealogy
          </Link>
        </div>
      </div>
    );
  }
  if (result.type === 'BATCH') {
    return (
      <div className="stack">
        <MetaList
          items={[
            { label: 'Batch', value: <strong>{result.batch.batchNo}</strong> },
            { label: 'Expiry', value: result.batch.expiryDate ?? 'Not set' },
            { label: 'Status', value: <StatusPill value={result.batch.expiryDate && result.batch.expiryDate < new Date().toISOString().slice(0, 10) ? 'EXPIRED' : 'ACTIVE'} /> },
          ]}
        />
        <div className="inline-actions">
          <Link className="btn btn-primary btn-sm" to={`/trace?type=BATCH&id=${result.batch.id}`}>
            Open batch genealogy
          </Link>
          <Link className="btn btn-subtle btn-sm" to={`/inventory?product=${result.batch.productId}`}>
            View product stock
          </Link>
        </div>
      </div>
    );
  }
  if (result.type === 'LOCATION') {
    return (
      <div className="stack">
        <MetaList
          items={[
            { label: 'Location', value: <strong>{result.location.code}</strong> },
            { label: 'Type', value: result.location.type },
            { label: 'Status', value: <StatusPill value={result.location.status} /> },
          ]}
        />
        <Link className="btn btn-subtle btn-sm" to="/inventory">
          Browse inventory
        </Link>
      </div>
    );
  }
  return (
    <div className="stack">
      <MetaList
        items={[
          { label: 'Task', value: <strong>{result.task.taskNo}</strong> },
          { label: 'Type', value: result.task.type },
          { label: 'Status', value: <StatusPill value={result.task.status} /> },
        ]}
      />
      <Link className="btn btn-primary btn-sm" to={`/tasks?task=${result.task.id}`}>
        Open task
      </Link>
    </div>
  );
}
