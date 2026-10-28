import { useMemo, useRef, useState } from 'react';
import { api, downloadPath, formatDateTime, formatNumber, titleCase } from '../api';
import { useAuth } from '../auth';
import { BulkBar, BulkDeleteDialog, useBulkSelection } from '../components/BulkDelete';
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

interface ImportError {
  row: number;
  message: string;
  severity?: string;
  code?: string;
  sheet?: string;
  boxId?: string;
  sku?: string;
}

interface ImportJob {
  id: string;
  import_type: string;
  file_name: string;
  status: string;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  error_report_json: string | null;
  source_hash: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  completed_at: string | null;
  summary?: WorkbookSummary | null;
  errors?: ImportError[];
  products_since?: number;
}

interface ImportJobList {
  rows: ImportJob[];
}

interface ImportResult {
  job: ImportJob;
  createdProducts?: number;
  errors: ImportError[];
}

interface WorkbookIssue {
  severity: 'ERROR' | 'WARNING';
  code: string;
  sheet: string;
  row: number | null;
  message: string;
  boxId?: string;
  sku?: string;
}

interface WorkbookSummary {
  products: { created: number; blankTemplateRowsSkipped: number; nextMasterSku: string };
  boxes: {
    created: number;
    singleSku: number;
    mixedSku: number;
    active: number;
    staging: number;
    withoutDeclaredContents: number;
    missingFromRegister: number;
  };
  declarations: { rows: number; boxes: number; conflicts: number; missingQuantity: number };
  postings: { transactions: number; boxes: number; units: number; byZone: Array<{ zone: string; boxes: number; units: number }> };
  mappings: { imported: number };
  totals: { created: number; updated: number; skipped: number; failed: number; warnings: number };
  verification: { needsVerification: number; verified: number; sourceMarkedVerified?: number };
  issues: { errors: number; warnings: number; byCode: Array<{ code: string; severity: string; count: number }> };
}

interface WorkbookResult {
  committed: boolean;
  job: { id: string; file_name: string; status: string };
  summary: WorkbookSummary;
  issues: WorkbookIssue[];
  reconciliation?: { postedUnits: number; ledgerUnits: number; balanceUnits: number; ok: boolean };
}

interface StockListSummary {
  source: {
    fileName: string;
    sheet: string;
    headerRow: number;
    zone: string;
    brand: string;
    rows: number;
    products: number;
    boxes: number;
    units: number;
  };
  products: { created: number };
  boxes: { created: number };
  declarations: { rows: number };
  postings: { transactions: number; units: number; byZone: Array<{ zone: string; boxes: number; units: number }> };
  verification: { needsVerification: number };
  duplicates: { products: number; rows: number };
  totals: { created: number; updated: number; skipped: number; failed: number; warnings: number };
  issues: { errors: number; warnings: number; byCode: Array<{ code: string; severity: string; count: number }> };
}

interface StockListResult {
  committed: boolean;
  job: { id: string; file_name: string; status: string };
  summary: StockListSummary;
  issues: WorkbookIssue[];
  reconciliation?: { postedUnits: number; ledgerUnits: number; balanceUnits: number; ok: boolean };
}

const MAX_WORKBOOK_BYTES = 8 * 1024 * 1024;

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

const MAX_BYTES = 4_000_000;

export function ImportsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const action = useAction();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [version, setVersion] = useState(0);
  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState('');
  const [xlsxUpload, setXlsxUpload] = useState<{ fileName: string; contentBase64: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const workbookInputRef = useRef<HTMLInputElement | null>(null);
  const [workbookFile, setWorkbookFile] = useState<File | null>(null);
  const [workbookError, setWorkbookError] = useState<string | null>(null);
  const [workbookResult, setWorkbookResult] = useState<WorkbookResult | null>(null);
  const workbookAction = useAction();
  const stockListInputRef = useRef<HTMLInputElement | null>(null);
  const [stockListFile, setStockListFile] = useState<File | null>(null);
  const [stockListBrand, setStockListBrand] = useState('');
  const [stockListZone, setStockListZone] = useState('Zone B');
  const [stockListError, setStockListError] = useState<string | null>(null);
  const [stockListResult, setStockListResult] = useState<StockListResult | null>(null);
  const stockListAction = useAction();
  const [templateError, setTemplateError] = useState<string | null>(null);
  const jobs = useApi<ImportJobList>('/imports', version);
  const rows = jobs.data?.rows ?? [];
  const [jobId, setJobId] = useState<string | null>(null);
  const jobDetail = useApi<{ job: ImportJob }>(jobId ? `/imports/${jobId}` : null, version);
  const importSelection = useBulkSelection();
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const selectedJobIds = importSelection.selected.filter((id) => rows.some((row) => row.id === id));
  const allJobsSelected = rows.length > 0 && selectedJobIds.length === rows.length;

  const dataRows = useMemo(() => (csv ? Math.max(0, csv.trim().split(/\r?\n/).length - 1) : 0), [csv]);

  const pickFile = async (file: File | undefined) => {
    setFileError(null);
    setResult(null);
    setXlsxUpload(null);
    if (!file) {
      setFileName('');
      setCsv('');
      return;
    }
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.xlsx')) {
      setFileError('Choose a .csv or .xlsx file. Download the template above to start from the correct columns.');
      return;
    }
    const isWorkbook = lower.endsWith('.xlsx');
    const limit = isWorkbook ? MAX_WORKBOOK_BYTES : MAX_BYTES;
    if (file.size > limit) {
      setFileError(`The file exceeds the ${isWorkbook ? 8 : 4} MB import limit.`);
      return;
    }
    try {
      if (isWorkbook) {
        const contentBase64 = await fileToBase64(file);
        setFileName(file.name);
        setCsv('');
        setXlsxUpload({ fileName: file.name, contentBase64 });
      } else {
        const text = await file.text();
        setFileName(file.name);
        setCsv(text);
      }
    } catch {
      setFileError('The file could not be read. Choose it again.');
    }
  };

  const submit = async () => {
    setFileError(null);
    const outcome = await action.run(() =>
      api.post<ImportResult>(
        '/imports/products',
        xlsxUpload ? { fileName: xlsxUpload.fileName, contentBase64: xlsxUpload.contentBase64 } : { fileName, csv },
      ),
    );
    if (!outcome) return;
    setResult(outcome);
    setVersion((value) => value + 1);
    if (outcome.errors.length) {
      toast.notify(`Import rejected: ${outcome.errors.length} invalid row(s). No products were created.`, 'danger');
    } else {
      toast.notify(`Imported ${formatNumber(outcome.createdProducts ?? 0)} products.`, 'success');
    }
  };

  const reset = () => {
    setFileName('');
    setCsv('');
    setXlsxUpload(null);
    setResult(null);
    setFileError(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const pickWorkbook = (file: File | undefined) => {
    setWorkbookError(null);
    setWorkbookResult(null);
    if (!file) {
      setWorkbookFile(null);
      return;
    }
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setWorkbookError('Choose the .xlsx workbook. The B2B import reads Excel sheets directly.');
      setWorkbookFile(null);
      return;
    }
    if (file.size > MAX_WORKBOOK_BYTES) {
      setWorkbookError('The workbook exceeds the 8 MB import limit.');
      setWorkbookFile(null);
      return;
    }
    setWorkbookFile(file);
  };

  const runWorkbook = async (dryRun: boolean) => {
    if (!workbookFile) return;
    setWorkbookError(null);
    const contentBase64 = await fileToBase64(workbookFile);
    const outcome = await workbookAction.run(() =>
      api.post<WorkbookResult>('/imports/workbook', { fileName: workbookFile.name, contentBase64, dryRun }),
    );
    if (!outcome) return;
    setWorkbookResult(outcome);
    setVersion((value) => value + 1);
    const errors = outcome.summary.issues.errors;
    if (dryRun) {
      toast.notify(
        errors
          ? `Validation found ${formatNumber(errors)} error(s). Nothing was imported.`
          : `Workbook validated: ${formatNumber(outcome.summary.boxes.created)} boxes and ${formatNumber(outcome.summary.postings.units)} opening units ready to import.`,
        errors ? 'danger' : 'success',
      );
    } else {
      toast.notify(
        `Workbook imported: ${formatNumber(outcome.summary.postings.units)} opening units reconciled without errors.`,
        'success',
      );
    }
  };

  const resetWorkbook = () => {
    setWorkbookFile(null);
    setWorkbookResult(null);
    setWorkbookError(null);
    if (workbookInputRef.current) workbookInputRef.current.value = '';
  };

  const downloadTemplate = async (kind: 'products' | 'stock-list') => {
    setTemplateError(null);
    try {
      await downloadPath(
        `/imports/${kind}/template.xlsx`,
        kind === 'products' ? 'product-import-template.xlsx' : 'stock-list-import-template.xlsx',
      );
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : 'The template could not be downloaded.');
    }
  };

  const pickStockList = (file: File | undefined) => {
    setStockListError(null);
    setStockListResult(null);
    if (!file) {
      setStockListFile(null);
      return;
    }
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setStockListError('Choose the .xlsx stock list. The importer reads Excel sheets directly.');
      setStockListFile(null);
      return;
    }
    if (file.size > MAX_WORKBOOK_BYTES) {
      setStockListError('The stock list exceeds the 8 MB import limit.');
      setStockListFile(null);
      return;
    }
    setStockListFile(file);
  };

  const runStockList = async (dryRun: boolean) => {
    if (!stockListFile) return;
    setStockListError(null);
    const contentBase64 = await fileToBase64(stockListFile);
    const outcome = await stockListAction.run(() =>
      api.post<StockListResult>('/imports/stock-list', {
        fileName: stockListFile.name,
        contentBase64,
        brand: stockListBrand.trim() || undefined,
        zone: stockListZone.trim() || undefined,
        dryRun,
      }),
    );
    if (!outcome) return;
    setStockListResult(outcome);
    setVersion((value) => value + 1);
    const errors = outcome.summary.issues.errors;
    if (dryRun) {
      toast.notify(
        errors
          ? `Validation found ${formatNumber(errors)} error(s). Nothing was imported.`
          : `Validated: ${formatNumber(outcome.summary.source.products)} products, ${formatNumber(outcome.summary.source.boxes)} boxes and ${formatNumber(outcome.summary.source.units)} units ready.`,
        errors ? 'danger' : 'success',
      );
    } else {
      toast.notify(
        `Stock list imported for ${outcome.summary.source.brand || 'brand'} · ${outcome.summary.source.zone}: ${formatNumber(outcome.summary.source.units)} opening units.`,
        'success',
      );
    }
  };

  const resetStockList = () => {
    setStockListFile(null);
    setStockListResult(null);
    setStockListError(null);
    if (stockListInputRef.current) stockListInputRef.current.value = '';
  };

  const workbookIssues = useMemo(
    () =>
      (workbookResult?.issues ?? []).slice(0, 100).sort((a, b) =>
        a.severity === b.severity ? 0 : a.severity === 'ERROR' ? -1 : 1,
      ),
    [workbookResult],
  );
  const canCommitWorkbook = Boolean(
    workbookFile && workbookResult && !workbookResult.committed && workbookResult.summary.issues.errors === 0,
  );
  const stockListIssues = useMemo(
    () =>
      (stockListResult?.issues ?? []).slice(0, 100).sort((a, b) =>
        a.severity === b.severity ? 0 : a.severity === 'ERROR' ? -1 : 1,
      ),
    [stockListResult],
  );
  const canCommitStockList = Boolean(
    stockListFile && stockListResult && !stockListResult.committed && stockListResult.summary.issues.errors === 0,
  );
  const detailJob = jobDetail.data?.job ?? null;
  const detailIssues = (detailJob?.errors ?? []).slice(0, 200);
  const detailTotals = detailJob?.summary?.totals ?? null;

  const columns: Array<Column<ImportJob>> = [
    ...(can('import.manage')
      ? [
          {
            key: 'select',
            className: 'select-col',
            header: (
              <input
                type="checkbox"
                aria-label="Select all import jobs"
                checked={allJobsSelected}
                onChange={() =>
                  allJobsSelected ? importSelection.clear() : importSelection.selectMany(rows.map((row) => row.id))
                }
              />
            ),
            render: (row: ImportJob) => (
              <span onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  aria-label={`Select ${row.file_name}`}
                  checked={selectedJobIds.includes(row.id)}
                  onChange={() => importSelection.toggle(row.id)}
                />
              </span>
            ),
          } satisfies Column<ImportJob>,
        ]
      : []),
    {
      key: 'file_name',
      header: 'File',
      render: (row) => (
        <div className="cell-title">
          <strong>{row.file_name}</strong>
          <span className="muted tiny">{titleCase(row.import_type)}</span>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
    { key: 'total_rows', header: 'Rows', className: 'num', render: (row) => formatNumber(row.total_rows) },
    { key: 'valid_rows', header: 'Valid', className: 'num', render: (row) => formatNumber(row.valid_rows) },
    {
      key: 'invalid_rows',
      header: 'Invalid',
      className: 'num',
      render: (row) => (
        <span className={row.invalid_rows > 0 ? 'text-danger' : 'muted'}>{formatNumber(row.invalid_rows)}</span>
      ),
    },
    {
      key: 'totals',
      header: 'Created / skipped / failed',
      className: 'num',
      render: (row) => {
        const totals = row.summary?.totals;
        if (!totals) return <span className="muted">—</span>;
        return (
          <span className="small">
            {formatNumber(totals.created)} · {formatNumber(totals.skipped)} ·{' '}
            <span className={totals.failed > 0 ? 'text-danger' : 'muted'}>{formatNumber(totals.failed)}</span>
          </span>
        );
      },
    },
    { key: 'created_by_name', header: 'Run by', render: (row) => row.created_by_name ?? '—' },
    {
      key: 'created_at',
      header: 'Started',
      render: (row) => <span className="muted small">{formatDateTime(row.created_at)}</span>,
    },
    {
      key: 'completed_at',
      header: 'Completed',
      render: (row) => <span className="muted small">{row.completed_at ? formatDateTime(row.completed_at) : '—'}</span>,
    },
    {
      key: 'actions',
      header: '',
      className: 'actions',
      render: (row) => (
        <div className="row-actions">
          <button type="button" className="btn btn-subtle btn-xs" onClick={() => setJobId(row.id)}>
            Details
          </button>
          <a
            className="btn btn-subtle btn-xs"
            href={`/api/imports/${row.id}/errors.csv`}
            onClick={(event) => event.stopPropagation()}
          >
            <Icon name="download" size={13} /> Errors
          </a>
        </div>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        eyebrow="Administration"
        title="Controlled data imports"
        subtitle="Product master and B2B workbook imports are validated row by row inside a database transaction. Invalid data is reported without writing, existing SKUs and Box IDs are never silently replaced, and source values stay traceable."
        actions={
          <button type="button" className="btn btn-subtle" onClick={() => void downloadTemplate('products')}>
            <Icon name="download" size={16} /> Product template (.xlsx)
          </button>
        }
      />
      {templateError ? <ErrorNote error={templateError} /> : null}

      <Card
        title="Import product master"
        subtitle="Required column: name. Optional: sku, brand, category, baseuom, isbatchtracked, isexpirytracked, qcrequired, costprice, lowstockthreshold."
      >
        <div className="stack">
          <div className="upload-zone">
            <Icon name="imports" size={28} />
            <div>
              <strong>{fileName || 'Choose a CSV or Excel file'}</strong>
              <p className="muted small">
                {csv
                  ? `${formatNumber(dataRows)} data row(s) detected · ${formatNumber(csv.length)} characters`
                  : xlsxUpload
                    ? 'Excel workbook selected — the Products sheet header and rows are validated before any write.'
                    : 'Up to 8 MB. UTF-8 CSV or the .xlsx template, with a header row.'}
              </p>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="file-input"
              onChange={(event) => void pickFile(event.target.files?.[0])}
            />
            <button type="button" className="btn btn-subtle" onClick={() => inputRef.current?.click()}>
              <Icon name="search" size={15} /> Browse
            </button>
          </div>

          <ErrorNote error={fileError} />
          <ErrorNote error={action.error} />

          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={(!csv && !xlsxUpload) || action.running}
              onClick={() => void submit()}
            >
              {action.running ? 'Validating and importing…' : 'Validate & import'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={reset}
              disabled={action.running || (!csv && !xlsxUpload)}
            >
              Clear
            </button>
            <span className="muted tiny">Every import attempt is recorded as an import job and an audit event.</span>
          </div>

          {action.running ? <Spinner label="Validating rows inside a transaction…" /> : null}

          {result ? (
            <div className={`callout ${result.errors.length ? 'callout-danger' : 'callout-success'}`}>
              <div className="callout-head">
                <strong>
                  {result.errors.length
                    ? 'Import rejected — no products were created'
                    : `Import completed — ${formatNumber(result.createdProducts ?? 0)} products created`}
                </strong>
                <StatusPill value={result.job.status} />
              </div>
              <p className="small">
                {result.job.file_name} · {formatNumber(result.job.total_rows)} rows ·{' '}
                {formatNumber(result.job.valid_rows)} valid · {formatNumber(result.job.invalid_rows)} invalid
              </p>
              {result.errors.length ? (
                <div className="table-wrap compact">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th style={{ width: '80px' }}>Row</th>
                        <th>Validation message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.errors.map((error, index) => (
                        <tr key={`${error.row}-${index}`}>
                          <td className="num">{error.row || '—'}</td>
                          <td className="text-danger">{error.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>

      <Card
        title="Import B2B workbook"
        subtitle="Reads Master SKU, B2B Box Register, B2B Box Contents, B2B Unit Stock Ledger, B2B Stock Ledger, Box ID Mapping and the audit logs. Source IDs, mixed-box mappings and verification statuses are preserved; every imported box stays Needs Verification until it is physically checked."
      >
        <div className="stack">
          <div className="upload-zone">
            <Icon name="imports" size={28} />
            <div>
              <strong>{workbookFile?.name || 'Choose the .xlsx workbook'}</strong>
              <p className="muted small">
                {workbookFile
                  ? `${formatNumber(workbookFile.size)} bytes · validate first, then commit`
                  : 'Up to 8 MB. Non-B2B stock pools are rejected before any write.'}
              </p>
            </div>
            <input
              ref={workbookInputRef}
              type="file"
              accept=".xlsx"
              className="file-input"
              onChange={(event) => pickWorkbook(event.target.files?.[0])}
            />
            <button type="button" className="btn btn-subtle" onClick={() => workbookInputRef.current?.click()}>
              <Icon name="search" size={15} /> Browse
            </button>
          </div>

          <ErrorNote error={workbookError} />
          <ErrorNote error={workbookAction.error} />

          <div className="form-actions">
            <button
              type="button"
              className="btn btn-subtle"
              disabled={!workbookFile || workbookAction.running}
              onClick={() => void runWorkbook(true)}
            >
              Validate only (dry run)
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canCommitWorkbook || workbookAction.running}
              onClick={() => void runWorkbook(false)}
            >
              {workbookAction.running && workbookResult ? 'Importing…' : 'Commit import'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={resetWorkbook}
              disabled={workbookAction.running || (!workbookFile && !workbookResult)}
            >
              Clear
            </button>
            <span className="muted tiny">A dry run records a validation job but writes no products, boxes or stock.</span>
          </div>

          {workbookAction.running ? <Spinner label="Parsing sheets and reconciling opening units…" /> : null}

          {workbookResult ? (
            <div className={`callout ${workbookResult.summary.issues.errors ? 'callout-danger' : 'callout-success'}`}>
              <div className="callout-head">
                <strong>
                  {workbookResult.committed
                    ? `Workbook committed — ${formatNumber(workbookResult.summary.postings.units)} opening units posted`
                    : workbookResult.summary.issues.errors
                      ? `Validation failed — ${formatNumber(workbookResult.summary.issues.errors)} error(s), nothing was written`
                      : 'Validation passed — nothing has been written yet'}
                </strong>
                <StatusPill value={workbookResult.job.status} />
              </div>

              <p className="small">
                {formatNumber(workbookResult.summary.products.created)} products ·{' '}
                {formatNumber(workbookResult.summary.boxes.created)} boxes (
                {formatNumber(workbookResult.summary.boxes.singleSku)} single,{' '}
                {formatNumber(workbookResult.summary.boxes.mixedSku)} mixed) ·{' '}
                {formatNumber(workbookResult.summary.declarations.rows)} declared contents ·{' '}
                {formatNumber(workbookResult.summary.mappings.imported)} box ID mappings ·{' '}
                {formatNumber(workbookResult.summary.verification.needsVerification)} records need verification
              </p>

              {workbookResult.summary.totals ? (
                <p className="small">
                  <strong>Created</strong> {formatNumber(workbookResult.summary.totals.created)} ·{' '}
                  <strong>Updated</strong> {formatNumber(workbookResult.summary.totals.updated)} ·{' '}
                  <strong>Skipped</strong> {formatNumber(workbookResult.summary.totals.skipped)} ·{' '}
                  <strong>Failed</strong>{' '}
                  <span className={workbookResult.summary.totals.failed > 0 ? 'text-danger' : ''}>
                    {formatNumber(workbookResult.summary.totals.failed)}
                  </span>
                </p>
              ) : null}

              {workbookResult.reconciliation ? (
                <p className="small">
                  Reconciled posting {formatNumber(workbookResult.reconciliation.postedUnits)} · ledger{' '}
                  {formatNumber(workbookResult.reconciliation.ledgerUnits)} · balances{' '}
                  {formatNumber(workbookResult.reconciliation.balanceUnits)}{' '}
                  <StatusPill value={workbookResult.reconciliation.ok ? 'RECONCILED' : 'MISMATCH'} />
                </p>
              ) : null}

              <p className="muted tiny">
                {formatNumber(workbookResult.summary.issues.warnings)} warning(s) ·{' '}
                {formatNumber(workbookResult.summary.declarations.conflicts)} quantity conflict(s) ·{' '}
                {formatNumber(workbookResult.summary.declarations.missingQuantity)} declared quantity missing ·{' '}
                {formatNumber(workbookResult.summary.boxes.withoutDeclaredContents)} registered box(es) without contents
              </p>

              {workbookIssues.length ? (
                <div className="table-wrap compact">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th style={{ width: '90px' }}>Severity</th>
                        <th style={{ width: '110px' }}>Sheet</th>
                        <th style={{ width: '70px' }}>Row</th>
                        <th style={{ width: '200px' }}>Code</th>
                        <th>Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {workbookIssues.map((issue, index) => (
                        <tr key={`${issue.code}-${issue.sheet}-${issue.row}-${index}`}>
                          <td className={issue.severity === 'ERROR' ? 'text-danger' : 'muted'}>{issue.severity}</td>
                          <td className="small">{issue.sheet}</td>
                          <td className="num">{issue.row ?? '—'}</td>
                          <td className="small">{issue.code}</td>
                          <td className="small">{issue.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>

      <Card
        title="Import brand stock list (zone-wise)"
        subtitle="Upload a brand's photographed stock list with Box Quantity and Qty per Box. One product is created per SKU and one box record per physical box; stock is posted once as a MIGRATION opening-stock movement into the chosen zone location, never as picking or putaway."
        actions={
          <button type="button" className="btn btn-subtle btn-sm" onClick={() => void downloadTemplate('stock-list')}>
            <Icon name="download" size={15} /> Stock-list template (.xlsx)
          </button>
        }
      >
        <div className="stack">
          <div className="form-grid two">
            <Field label="Default brand" hint="Used when the Brand column is blank. Leave empty to read the Brand column.">
              <input
                className="input"
                value={stockListBrand}
                maxLength={100}
                placeholder="e.g. Allen"
                onChange={(event) => setStockListBrand(event.target.value)}
              />
            </Field>
            <Field label="Zone / location" hint="Stock is posted to this zone's location in the B2B pool.">
              <input
                className="input"
                value={stockListZone}
                maxLength={50}
                placeholder="Zone B"
                onChange={(event) => setStockListZone(event.target.value)}
              />
            </Field>
          </div>

          <div className="upload-zone">
            <Icon name="imports" size={28} />
            <div>
              <strong>{stockListFile?.name || 'Choose the .xlsx stock list'}</strong>
              <p className="muted small">
                {stockListFile
                  ? `${formatNumber(stockListFile.size)} bytes · validate first, then commit`
                  : 'Up to 8 MB. Columns: Brand, Product Name / SKU, Box Quantity, Qty per Box.'}
              </p>
            </div>
            <input
              ref={stockListInputRef}
              type="file"
              accept=".xlsx"
              className="file-input"
              onChange={(event) => pickStockList(event.target.files?.[0])}
            />
            <button type="button" className="btn btn-subtle" onClick={() => stockListInputRef.current?.click()}>
              <Icon name="search" size={15} /> Browse
            </button>
          </div>

          <ErrorNote error={stockListError} />
          <ErrorNote error={stockListAction.error} />

          <div className="form-actions">
            <button
              type="button"
              className="btn btn-subtle"
              disabled={!stockListFile || stockListAction.running}
              onClick={() => void runStockList(true)}
            >
              Validate only (dry run)
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canCommitStockList || stockListAction.running}
              onClick={() => void runStockList(false)}
            >
              {stockListAction.running && stockListResult ? 'Importing…' : 'Commit opening stock'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={resetStockList}
              disabled={stockListAction.running || (!stockListFile && !stockListResult)}
            >
              Clear
            </button>
            <span className="muted tiny">Every product and box stays Needs Verification until physically checked.</span>
          </div>

          {stockListAction.running ? <Spinner label="Reading stock list and checking duplicate products…" /> : null}

          {stockListResult ? (
            <div className={`callout ${stockListResult.summary.issues.errors ? 'callout-danger' : 'callout-success'}`}>
              <div className="callout-head">
                <strong>
                  {stockListResult.committed
                    ? `Committed — ${formatNumber(stockListResult.summary.source.units)} opening units posted`
                    : stockListResult.summary.issues.errors
                      ? `Validation failed — ${formatNumber(stockListResult.summary.issues.errors)} error(s), nothing was written`
                      : 'Validation passed — nothing has been written yet'}
                </strong>
                <StatusPill value={stockListResult.job.status} />
              </div>
              <p className="small">
                {stockListResult.summary.source.brand || 'Brand not set'} · {stockListResult.summary.source.zone} ·{' '}
                {formatNumber(stockListResult.summary.source.products)} products ·{' '}
                {formatNumber(stockListResult.summary.source.boxes)} boxes ·{' '}
                {formatNumber(stockListResult.summary.source.units)} units · sheet "{stockListResult.summary.source.sheet}"
                (header row {stockListResult.summary.source.headerRow})
              </p>
              <p className="small">
                <strong>Created</strong> {formatNumber(stockListResult.summary.totals.created)} ·{' '}
                <strong>Skipped</strong> {formatNumber(stockListResult.summary.totals.skipped)} ·{' '}
                <strong>Failed</strong>{' '}
                <span className={stockListResult.summary.totals.failed > 0 ? 'text-danger' : ''}>
                  {formatNumber(stockListResult.summary.totals.failed)}
                </span>{' '}
                · <strong>Warnings</strong> {formatNumber(stockListResult.summary.issues.warnings)} ·{' '}
                {formatNumber(stockListResult.summary.verification.needsVerification)} need verification ·{' '}
                {formatNumber(stockListResult.summary.duplicates.products)} duplicate product name(s) merged
              </p>
              {stockListResult.reconciliation ? (
                <p className="small">
                  Reconciled posting {formatNumber(stockListResult.reconciliation.postedUnits)} · ledger{' '}
                  {formatNumber(stockListResult.reconciliation.ledgerUnits)} · balances{' '}
                  {formatNumber(stockListResult.reconciliation.balanceUnits)}{' '}
                  <StatusPill value={stockListResult.reconciliation.ok ? 'RECONCILED' : 'MISMATCH'} />
                </p>
              ) : null}

              {stockListIssues.length ? (
                <div className="table-wrap compact">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th style={{ width: '90px' }}>Severity</th>
                        <th style={{ width: '150px' }}>Sheet</th>
                        <th style={{ width: '70px' }}>Row</th>
                        <th style={{ width: '190px' }}>Code</th>
                        <th>Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stockListIssues.map((issue, index) => (
                        <tr key={`${issue.code}-${issue.row}-${index}`}>
                          <td className={issue.severity === 'ERROR' ? 'text-danger' : 'muted'}>{issue.severity}</td>
                          <td className="small">{issue.sheet}</td>
                          <td className="num">{issue.row ?? '—'}</td>
                          <td className="small">{issue.code}</td>
                          <td className="small">{issue.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>

      <Card
        title="Import jobs"
        subtitle={`${formatNumber(rows.length)} recent jobs · newest first`}
        actions={
          <button type="button" className="btn btn-subtle btn-sm" onClick={() => jobs.reload()}>
            <Icon name="refresh" size={14} /> Refresh
          </button>
        }
        flush
      >
        <ErrorNote error={jobs.error} />
        <BulkBar
          count={selectedJobIds.length}
          noun="job"
          onClear={importSelection.clear}
          onDelete={() => setBulkDeleteOpen(true)}
        />
        <DataTable
          columns={columns}
          rows={rows}
          loading={jobs.loading && !jobs.data}
          rowKey={(row) => row.id}
          emptyTitle="No imports yet"
          emptyMessage="Download the template, complete it, and run the first controlled product import."
        />
        <BulkDeleteDialog
          open={bulkDeleteOpen}
          entityLabel="import job"
          endpoint="/imports/bulk-delete"
          ids={selectedJobIds}
          onClose={() => setBulkDeleteOpen(false)}
          onCompleted={() => {
            importSelection.clear();
            setVersion((value) => value + 1);
          }}
        />
      </Card>

      <div className="stat-grid four">
        <Stat label="Jobs" value={formatNumber(rows.length)} icon="imports" />
        <Stat
          label="Imported"
          value={formatNumber(rows.filter((row) => row.status === 'IMPORTED').length)}
          icon="check"
          tone="success"
        />
        <Stat
          label="Rejected"
          value={formatNumber(rows.filter((row) => row.status === 'FAILED').length)}
          icon="alert"
          tone={rows.some((row) => row.status === 'FAILED') ? 'danger' : 'neutral'}
        />
        <Stat
          label="Rows created"
          value={formatNumber(rows.filter((row) => row.status === 'IMPORTED').reduce((sum, row) => sum + row.valid_rows, 0))}
          icon="products"
        />
      </div>

      <Dialog
        open={Boolean(jobId)}
        onClose={() => setJobId(null)}
        title="Import job detail"
        subtitle="Validation outcome, record totals and the downloadable error report."
        wide
        footer={
          <>
            {detailJob ? (
              <a className="btn btn-subtle" href={`/api/imports/${detailJob.id}/errors.csv`}>
                <Icon name="download" size={15} /> Download errors CSV
              </a>
            ) : null}
            <button type="button" className="btn btn-primary" onClick={() => setJobId(null)}>
              Close
            </button>
          </>
        }
      >
        <ErrorNote error={jobDetail.error} />
        {jobDetail.loading && !detailJob ? <Spinner label="Loading import job…" /> : null}
        {detailJob ? (
          <div className="stack">
            <MetaList
              items={[
                { label: 'File', value: detailJob.file_name },
                { label: 'Type', value: titleCase(detailJob.import_type) },
                { label: 'Status', value: <StatusPill value={detailJob.status} /> },
                { label: 'Rows', value: `${formatNumber(detailJob.total_rows)} total · ${formatNumber(detailJob.valid_rows)} valid · ${formatNumber(detailJob.invalid_rows)} invalid` },
                ...(detailTotals
                  ? [
                      { label: 'Created', value: formatNumber(detailTotals.created) },
                      { label: 'Updated', value: formatNumber(detailTotals.updated) },
                      { label: 'Skipped', value: formatNumber(detailTotals.skipped) },
                      {
                        label: 'Failed',
                        value: (
                          <span className={detailTotals.failed > 0 ? 'text-danger' : ''}>
                            {formatNumber(detailTotals.failed)}
                          </span>
                        ),
                      },
                    ]
                  : []),
                { label: 'Run by', value: detailJob.created_by_name ?? '—' },
                { label: 'Started', value: formatDateTime(detailJob.created_at) },
                { label: 'Completed', value: detailJob.completed_at ? formatDateTime(detailJob.completed_at) : '—' },
                { label: 'Source hash', value: <code className="code">{detailJob.source_hash?.slice(0, 16) ?? '—'}</code> },
              ]}
            />

            {detailIssues.length ? (
              <div className="table-wrap compact">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: '85px' }}>Severity</th>
                      <th style={{ width: '120px' }}>Sheet</th>
                      <th style={{ width: '60px' }}>Row</th>
                      <th style={{ width: '170px' }}>Code</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailIssues.map((entry, index) => (
                      <tr key={`${entry.code ?? entry.row}-${entry.row}-${index}`}>
                        <td className={entry.severity === 'WARNING' ? 'muted' : 'text-danger'}>
                          {entry.severity ?? 'ERROR'}
                        </td>
                        <td className="small">{entry.sheet ?? '—'}</td>
                        <td className="num">{entry.row || '—'}</td>
                        <td className="small">{entry.code ?? 'ROW_ERROR'}</td>
                        <td className="small">{entry.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted small">This job recorded no row-level issues.</p>
            )}
            {(detailJob.errors?.length ?? 0) > detailIssues.length ? (
              <p className="muted tiny">
                Showing {formatNumber(detailIssues.length)} of {formatNumber(detailJob.errors?.length ?? 0)} issues. Download the CSV for the full report.
              </p>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
