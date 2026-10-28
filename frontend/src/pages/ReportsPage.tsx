import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  downloadFile,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
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
  Spinner,
  Stat,
  StatusPill,
  Tabs,
  type Column,
} from '../ui';
import {
  FORMAT_META,
  REPORT_LABEL,
  TEMPLATE_META,
  type OtpChannel,
  type ReportFormat,
  type ReportParams,
  type ReportTemplate,
  type ReportType,
  type SecurityStatus,
} from '../reports';

interface StockRow {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  base_uom: string;
  low_stock_threshold: number | null;
  cost_price?: number | null;
  on_hand: number;
  reserved: number;
  available: number;
  non_sellable: number;
  in_transit: number;
  return_pending: number;
  expired: number;
  stock_value?: number;
}

interface StockReport {
  rows: StockRow[];
  totals: { on_hand: number; available: number; non_sellable: number; stock_value: number };
  asOf: string;
}

interface MovementDay {
  day: string;
  count: number;
  quantity: number;
  byType: Record<string, number>;
}

interface MovementRow {
  day: string;
  movement_type: string;
  count: number;
  quantity: number;
}

interface MovementReport {
  from: string;
  to: string;
  days: MovementDay[];
  rows: MovementRow[];
}

interface ExpiryBucket {
  key: string;
  label: string;
  quantity: number;
  batches: number;
}

interface ExpiryBatch {
  id: string;
  batch_no: string;
  expiry_date: string | null;
  product_id: string;
  sku: string;
  name: string;
  quantity: number;
  daysLeft: number | null;
}

interface ExpiryReport {
  asOf: string;
  buckets: ExpiryBucket[];
  batches: ExpiryBatch[];
}

const TABS = [
  { key: 'stock', label: 'Stock summary' },
  { key: 'movements', label: 'Movements' },
  { key: 'expiry', label: 'Expiry' },
];

export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((entry) => entry.key === params.get('tab')) ? (params.get('tab') as string) : 'stock';

  return (
    <div className="page">
      <PageHeader
        eyebrow="Reporting"
        title="Operational reports"
        subtitle="Stock position, movement throughput and expiry exposure computed by the backend from the immutable ledger and canonical balances."
      />
      <Tabs
        tabs={TABS}
        active={tab}
        onChange={(key) => {
          const next = new URLSearchParams(params);
          next.set('tab', key);
          setParams(next, { replace: true });
        }}
      />
      {tab === 'stock' ? <StockReportTab /> : null}
      {tab === 'movements' ? <MovementReportTab /> : null}
      {tab === 'expiry' ? <ExpiryReportTab /> : null}
    </div>
  );
}

function StockReportTab() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const debouncedSearch = useDebouncedValue(search, 300);
  const report = useApi<StockReport>(
    `/reports/stock-summary${queryString({ search: debouncedSearch.trim() || undefined, category: category.trim() || undefined })}`,
  );
  const rows = report.data?.rows ?? [];
  const showCost = can('product.cost.read');

  const columns: Array<Column<StockRow>> = [
    {
      key: 'sku',
      header: 'Product',
      render: (row) => (
        <div className="cell-title">
          <Link className="inline-link" to={`/inventory?product=${encodeURIComponent(row.id)}`}>
            {row.sku}
          </Link>
          <span className="muted tiny">{row.name}</span>
        </div>
      ),
    },
    { key: 'category', header: 'Category', render: (row) => row.category ?? '—' },
    { key: 'base_uom', header: 'UOM', render: (row) => <span className="muted small">{row.base_uom}</span> },
    { key: 'on_hand', header: 'On hand', className: 'num', render: (row) => formatNumber(row.on_hand) },
    { key: 'reserved', header: 'Reserved', className: 'num', render: (row) => formatNumber(row.reserved) },
    {
      key: 'available',
      header: 'Available',
      className: 'num',
      render: (row) => <strong>{formatNumber(row.available)}</strong>,
    },
    { key: 'non_sellable', header: 'Non-sellable', className: 'num', render: (row) => formatNumber(row.non_sellable) },
    { key: 'in_transit', header: 'In transit', className: 'num', render: (row) => formatNumber(row.in_transit) },
    { key: 'return_pending', header: 'Return pending', className: 'num', render: (row) => formatNumber(row.return_pending) },
    {
      key: 'expired',
      header: 'Expired',
      className: 'num',
      render: (row) => (
        <span className={row.expired > 0 ? 'text-danger' : 'muted'}>{formatNumber(row.expired)}</span>
      ),
    },
    ...(showCost
      ? [
          {
            key: 'stock_value',
            header: 'Stock value',
            className: 'num',
            render: (row: StockRow) => formatMoney(row.stock_value),
          } satisfies Column<StockRow>,
        ]
      : []),
  ];

  return (
    <div className="stack">
      <Card
        title="Stock summary"
        subtitle={report.data ? `As of ${formatDateTime(report.data.asOf)}` : 'Computing from canonical balances'}
        actions={
          <div className="toolbar wrap">
            <div className="search-inline">
              <Icon name="search" size={15} />
              <input
                className="input compact-input"
                placeholder="SKU or name"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <input
              className="input compact-input"
              placeholder="Category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            />
            <button type="button" className="btn btn-subtle btn-sm" onClick={() => report.reload()}>
              <Icon name="refresh" size={14} /> Refresh
            </button>
            {can('report.export') ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setExportOpen(true)}>
                <Icon name="download" size={14} /> Export report
              </button>
            ) : null}
          </div>
        }
      >
        <ErrorNote error={report.error} />
        {report.data ? (
          <div className="stat-grid four">
            <Stat label="Products" value={formatNumber(rows.length)} icon="products" />
            <Stat label="On hand" value={formatNumber(report.data.totals.on_hand)} icon="inventory" />
            <Stat label="Available" value={formatNumber(report.data.totals.available)} icon="check" tone="success" />
            {showCost ? (
              <Stat label="Stock value" value={formatMoney(report.data.totals.stock_value)} icon="reports" />
            ) : (
              <Stat label="Non-sellable" value={formatNumber(report.data.totals.non_sellable)} icon="alert" tone="warning" />
            )}
          </div>
        ) : report.loading ? (
          <Spinner label="Computing stock summary…" />
        ) : null}
      </Card>

      <Card
        title="Balances by product"
        subtitle={`${formatNumber(rows.length)} products · figures are base units`}
        flush
      >
        <DataTable
          columns={columns}
          rows={rows}
          loading={report.loading && !report.data}
          rowKey={(row) => row.id}
          emptyTitle="No products match this filter"
          emptyMessage="Adjust the search or category to widen the stock report."
        />
      </Card>

      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        reportType="STOCK_SUMMARY"
        params={{ search: debouncedSearch.trim(), category: category.trim() }}
      />
    </div>
  );
}

function MovementReportTab() {
  const { can } = useAuth();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const report = useApi<MovementReport>(
    `/reports/movements${queryString({ from: from || undefined, to: to || undefined })}`,
  );
  const data = report.data;
  const days = data?.days ?? [];
  const rows = data?.rows ?? [];

  const totals = days.reduce(
    (acc, day) => ({ count: acc.count + day.count, quantity: acc.quantity + day.quantity }),
    { count: 0, quantity: 0 },
  );
  const maxQuantity = days.reduce((max, day) => Math.max(max, day.quantity), 0);
  const typeTotals = new Map<string, { count: number; quantity: number }>();
  for (const row of rows) {
    const entry = typeTotals.get(row.movement_type) ?? { count: 0, quantity: 0 };
    entry.count += Number(row.count);
    entry.quantity += Number(row.quantity);
    typeTotals.set(row.movement_type, entry);
  }
  const typeRows = [...typeTotals.entries()]
    .map(([movement_type, value]) => ({ movement_type, ...value }))
    .sort((a, b) => b.quantity - a.quantity);

  const dayColumns: Array<Column<MovementDay>> = [
    { key: 'day', header: 'Day', render: (row) => <strong>{formatDate(row.day)}</strong> },
    { key: 'count', header: 'Transactions', className: 'num', render: (row) => formatNumber(row.count) },
    { key: 'quantity', header: 'Units moved', className: 'num', render: (row) => formatNumber(row.quantity) },
    {
      key: 'types',
      header: 'Mix',
      render: (row) => (
        <div className="tag-list">
          {Object.entries(row.byType)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([type, quantity]) => (
              <span className="tag" key={type}>
                {titleCase(type)} · {formatNumber(quantity)}
              </span>
            ))}
        </div>
      ),
    },
  ];

  const typeColumns: Array<Column<{ movement_type: string; count: number; quantity: number }>> = [
    { key: 'movement_type', header: 'Movement type', render: (row) => <strong>{titleCase(row.movement_type)}</strong> },
    { key: 'count', header: 'Transactions', className: 'num', render: (row) => formatNumber(row.count) },
    { key: 'quantity', header: 'Units moved', className: 'num', render: (row) => formatNumber(row.quantity) },
    {
      key: 'share',
      header: 'Share of units',
      className: 'num',
      render: (row) => `${totals.quantity ? Math.round((row.quantity / totals.quantity) * 100) : 0}%`,
    },
  ];

  return (
    <div className="stack">
      <Card
        title="Movement throughput"
        subtitle="Derived from posted inventory transactions; reversals appear as separate linked movements."
        actions={
          <div className="toolbar wrap">
            <Field label="From">
              <input type="date" className="input compact-input" value={from} onChange={(event) => setFrom(event.target.value)} />
            </Field>
            <Field label="To">
              <input type="date" className="input compact-input" value={to} onChange={(event) => setTo(event.target.value)} />
            </Field>
            <button type="button" className="btn btn-subtle btn-sm" onClick={() => report.reload()}>
              <Icon name="refresh" size={14} /> Refresh
            </button>
            {can('report.export') ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setExportOpen(true)}>
                <Icon name="download" size={14} /> Export report
              </button>
            ) : null}
          </div>
        }
      >
        <ErrorNote error={report.error} />
        {data ? (
          <>
            <div className="stat-grid four">
              <Stat label="Period" value={`${formatDate(data.from)} → ${formatDate(data.to)}`} icon="clock" />
              <Stat label="Transactions" value={formatNumber(totals.count)} icon="audit" />
              <Stat label="Units moved" value={formatNumber(totals.quantity)} icon="inventory" />
              <Stat label="Active days" value={formatNumber(days.length)} icon="reports" />
            </div>
            {days.length > 0 ? (
              <div className="bar-chart">
                {days.map((day) => (
                  <div className="bar-row" key={day.day}>
                    <span className="bar-label">{formatDate(day.day)}</span>
                    <span className="bar-track">
                      <span
                        className="bar-fill"
                        style={{ width: `${maxQuantity ? Math.max(2, (day.quantity / maxQuantity) * 100) : 2}%` }}
                      />
                    </span>
                    <span className="bar-value">{formatNumber(day.quantity)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted small">No posted movements in this period.</p>
            )}
          </>
        ) : report.loading ? (
          <Spinner label="Loading movement report…" />
        ) : null}
      </Card>

      <div className="detail-grid">
        <Card title="Daily activity" flush>
          <DataTable
            columns={dayColumns}
            rows={days}
            loading={report.loading && !data}
            rowKey={(row) => row.day}
            emptyTitle="No movement days"
            emptyMessage="Choose a period that contains posted transactions."
          />
        </Card>
        <Card title="By movement type" flush>
          <DataTable
            columns={typeColumns}
            rows={typeRows}
            loading={report.loading && !data}
            rowKey={(row) => row.movement_type}
            emptyTitle="No movement types"
            emptyMessage="No posted movements in the selected period."
          />
        </Card>
      </div>

      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        reportType="MOVEMENTS"
        params={{ from, to }}
      />
    </div>
  );
}

function ExpiryReportTab() {
  const { can } = useAuth();
  const [exportOpen, setExportOpen] = useState(false);
  const report = useApi<ExpiryReport>('/reports/expiry');
  const data = report.data;
  const buckets = data?.buckets ?? [];
  const batches = data?.batches ?? [];

  const columns: Array<Column<ExpiryBatch>> = [
    {
      key: 'batch_no',
      header: 'Batch',
      render: (row) => (
        <div className="cell-title">
          <Link className="inline-link" to={`/trace?type=BATCH&id=${encodeURIComponent(row.id)}`}>
            {row.batch_no}
          </Link>
          <span className="muted tiny">{row.sku}</span>
        </div>
      ),
    },
    {
      key: 'name',
      header: 'Product',
      render: (row) => (
        <Link className="inline-link" to={`/inventory?product=${encodeURIComponent(row.product_id)}`}>
          {row.name}
        </Link>
      ),
    },
    { key: 'expiry_date', header: 'Expiry', render: (row) => formatDate(row.expiry_date) },
    {
      key: 'daysLeft',
      header: 'Days left',
      className: 'num',
      render: (row) =>
        row.daysLeft === null ? (
          <span className="muted">—</span>
        ) : (
          <StatusPill
            value={row.daysLeft < 0 ? `${Math.abs(row.daysLeft)}d overdue` : `${row.daysLeft}d`}
            tone={row.daysLeft < 0 ? 'danger' : row.daysLeft <= 30 ? 'warning' : 'success'}
            dot={false}
          />
        ),
    },
    { key: 'quantity', header: 'Available units', className: 'num', render: (row) => formatNumber(row.quantity) },
  ];

  return (
    <div className="stack">
      <Card
        title="Expiry exposure"
        subtitle={data ? `Available batches only · as of ${formatDate(data.asOf)}` : 'Loading expiry report'}
        actions={
          <div className="toolbar">
            <button type="button" className="btn btn-subtle btn-sm" onClick={() => report.reload()}>
              <Icon name="refresh" size={14} /> Refresh
            </button>
            {can('report.export') ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setExportOpen(true)}>
                <Icon name="download" size={14} /> Export report
              </button>
            ) : null}
          </div>
        }
      >
        <ErrorNote error={report.error} />
        {data ? (
          <div className="stat-grid six">
            {buckets.map((bucket) => (
              <Stat
                key={bucket.key}
                label={bucket.label}
                value={formatNumber(bucket.quantity)}
                hint={`${formatNumber(bucket.batches)} batches`}
                tone={bucket.key === 'EXPIRED' && bucket.quantity > 0 ? 'danger' : bucket.key === 'D0_30' ? 'warning' : 'neutral'}
                icon="clock"
              />
            ))}
          </div>
        ) : report.loading ? (
          <Spinner label="Loading expiry buckets…" />
        ) : null}
      </Card>

      <Card
        title="Batches by expiry"
        subtitle={`${formatNumber(batches.length)} batches with available stock`}
        flush
      >
        <DataTable
          columns={columns}
          rows={batches}
          loading={report.loading && !data}
          rowKey={(row) => row.id}
          emptyTitle="No batches with available stock"
          emptyMessage="Batches appear here as soon as stock is received and available."
        />
      </Card>

      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        reportType="EXPIRY"
        params={{}}
      />
    </div>
  );
}

function ExportDialog({
  open,
  onClose,
  reportType,
  params,
}: {
  open: boolean;
  onClose: () => void;
  reportType: ReportType;
  params: ReportParams;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const security = useApi<SecurityStatus>(open ? '/security/status' : null);
  const exportAction = useAction();
  const sendAction = useAction();
  const [format, setFormat] = useState<ReportFormat>('PDF');
  const [template, setTemplate] = useState<ReportTemplate>('EXECUTIVE');
  const [channel, setChannel] = useState<OtpChannel>('TOTP');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);

  const status = security.data;
  const required = status?.policy.reportOtpRequired ?? false;
  const totpReady = status?.totp.enrolled ?? false;
  const emailReady = status?.email.configured ?? false;
  const noChannel = Boolean(status) && !totpReady && !emailReady;

  useEffect(() => {
    if (!open) return;
    setValidation(null);
    setCode('');
    setSentTo(null);
    setSentAt(null);
  }, [open]);

  useEffect(() => {
    if (status) setTemplate(status.branding.template);
  }, [status?.branding.template]);

  useEffect(() => {
    if (!open || !status) return;
    setChannel((current) => {
      if (current === 'TOTP' && totpReady) return current;
      if (current === 'EMAIL' && emailReady) return current;
      return totpReady ? 'TOTP' : 'EMAIL';
    });
  }, [open, status, totpReady, emailReady]);

  const filters = [
    params.search ? `Search “${params.search}”` : null,
    params.category ? `Category “${params.category}”` : null,
    params.from ? `From ${formatDate(params.from)}` : null,
    params.to ? `To ${formatDate(params.to)}` : null,
  ].filter((value): value is string => Boolean(value));

  const sendEmail = async () => {
    setValidation(null);
    const result = await sendAction.run(() =>
      api.post<{ sentTo: string; expiresAt: string }>('/reports/otp/email'),
    );
    if (result) {
      setChannel('EMAIL');
      setSentTo(result.sentTo);
      setSentAt(result.expiresAt);
      setCode('');
      toast.notify(`A code was sent to ${result.sentTo}. It expires in 5 minutes.`, 'success');
    }
  };

  const runExport = async () => {
    setValidation(null);
    const token = code.replace(/\s+/g, '');
    if (required) {
      if (channel === 'TOTP' && !totpReady) {
        setValidation('No authenticator is connected. Set one up in My security, or use an email code.');
        return;
      }
      if (channel === 'EMAIL' && !emailReady) {
        setValidation('Email codes are not configured on this server. Use an authenticator code.');
        return;
      }
      if (token.length < 6) {
        setValidation(
          channel === 'EMAIL'
            ? 'Request a code by email, then enter the 6 digits.'
            : 'Enter the current 6-digit code from your authenticator app.',
        );
        return;
      }
    }
    const cleanParams = Object.fromEntries(Object.entries(params).filter(([, value]) => Boolean(value)));
    const fallback = `${reportType.toLowerCase().replace(/_/g, '-')}-${new Date()
      .toISOString()
      .slice(0, 10)}.${FORMAT_META[format].extension}`;
    const saved = await exportAction.run(() =>
      downloadFile(
        '/reports/export',
        {
          reportType,
          format,
          template: format === 'CSV' ? undefined : template,
          params: cleanParams,
          otp: required ? { channel, code: token } : undefined,
        },
        fallback,
      ),
    );
    if (saved) {
      toast.notify(`${REPORT_LABEL[reportType]} downloaded as ${format}.`, 'success');
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      title="Export report"
      subtitle={`${REPORT_LABEL[reportType]} · generated by the backend from posted ledger data`}
      onClose={onClose}
      wide
      footer={
        <div className="dialog-footer-row">
          <span className="dialog-footnote">
            {required ? 'A one-time code is required by policy.' : 'One-time code is optional for this workspace.'}
          </span>
          <div className="toolbar">
            <button type="button" className="btn btn-subtle" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={exportAction.running || (required && noChannel)}
              onClick={() => void runExport()}
            >
              <Icon name="download" size={15} />
              {exportAction.running ? 'Building file…' : `Download ${format}`}
            </button>
          </div>
        </div>
      }
    >
      <div className="stack">
        <div className="export-summary">
          <Icon name="filter" size={14} />
          <span>{filters.length ? filters.join(' · ') : 'All records for this report'}</span>
        </div>

        <div>
          <div className="export-label">File format</div>
          <div className="format-grid">
            {(Object.keys(FORMAT_META) as ReportFormat[]).map((key) => (
              <button
                key={key}
                type="button"
                className={`format-card ${format === key ? 'active' : ''}`}
                onClick={() => setFormat(key)}
              >
                <strong>{FORMAT_META[key].label}</strong>
                <span className="muted tiny">{FORMAT_META[key].description}</span>
              </button>
            ))}
          </div>
        </div>

        {format !== 'CSV' ? (
          <div>
            <div className="export-label">Report template</div>
            <div className="template-grid">
              {(Object.keys(TEMPLATE_META) as ReportTemplate[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`template-card compact ${template === key ? 'active' : ''}`}
                  onClick={() => setTemplate(key)}
                >
                  <strong>{TEMPLATE_META[key].label}</strong>
                  <span className="muted tiny">{TEMPLATE_META[key].description}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {required ? (
          <div className="otp-box">
            <div className="inline-form-head">
              <div>
                <strong>One-time code required</strong>
                <p className="muted tiny">The code is checked and consumed on the backend before the file is built.</p>
              </div>
              <Link className="inline-link" to="/security">
                My security
              </Link>
            </div>

            {noChannel ? (
              <div className="alert alert-danger">
                <Icon name="alert" size={17} />
                <div>
                  No OTP channel is available. Connect an authenticator in My security, or ask an administrator to
                  configure SMTP. Export stays blocked until then.
                </div>
              </div>
            ) : (
              <div className="otp-channel-grid">
                <button
                  type="button"
                  className={`channel-card ${channel === 'TOTP' ? 'active' : ''}`}
                  disabled={!totpReady}
                  onClick={() => setChannel('TOTP')}
                >
                  <strong>Authenticator app</strong>
                  <span className="muted tiny">
                    {totpReady ? 'Use the rotating 6-digit code from your app.' : 'Not connected yet.'}
                  </span>
                </button>
                <button
                  type="button"
                  className={`channel-card ${channel === 'EMAIL' ? 'active' : ''}`}
                  disabled={!emailReady}
                  onClick={() => setChannel('EMAIL')}
                >
                  <strong>Email code</strong>
                  <span className="muted tiny">
                    {emailReady ? 'Send a code to your account email.' : 'SMTP is not configured.'}
                  </span>
                </button>
              </div>
            )}

            {channel === 'EMAIL' && emailReady ? (
              <div className="otp-send-row">
                <button
                  type="button"
                  className="btn btn-subtle btn-sm"
                  disabled={sendAction.running}
                  onClick={() => void sendEmail()}
                >
                  <Icon name="notifications" size={14} />
                  {sendAction.running ? 'Sending…' : sentTo ? 'Send a new code' : 'Send code by email'}
                </button>
                {sentTo ? (
                  <span className="otp-sent">
                    Sent to {sentTo}
                    {sentAt ? ` · expires ${formatDateTime(sentAt)}` : ''}
                  </span>
                ) : null}
              </div>
            ) : null}

            <Field
              label="6-digit code"
              hint={
                channel === 'TOTP'
                  ? 'Codes rotate every 30 seconds and cannot be reused.'
                  : 'The code is valid for 5 minutes and allows 5 attempts.'
              }
            >
              <input
                className="input code-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))}
              />
            </Field>

            <ErrorNote error={sendAction.error} />
          </div>
        ) : (
          <div className="export-otp-note">
            <Icon name="info" size={15} />
            <span>
              Report OTP is optional and currently off.{' '}
              {can('settings.manage') ? (
                <Link className="inline-link" to="/report-studio">
                  Turn it on in Report Studio
                </Link>
              ) : (
                'An administrator can enable it in Report Studio.'
              )}
            </span>
          </div>
        )}

        {validation ? <ErrorNote error={validation} /> : null}
        <ErrorNote error={exportAction.error} />
        <ErrorNote error={security.error} />
      </div>
    </Dialog>
  );
}
