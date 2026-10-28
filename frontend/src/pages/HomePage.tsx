import { Link, useNavigate } from 'react-router-dom';
import { formatDateTime, formatNumber, titleCase } from '../api';
import { useAuth } from '../auth';
import { useApi } from '../hooks';
import {
  Card,
  DataTable,
  ErrorNote,
  Icon,
  PageHeader,
  Spinner,
  Stat,
  StatusPill,
  type Column,
} from '../ui';

interface OverviewLocation {
  id: string;
  code: string;
  type: string;
  zone: string | null;
  status: string;
  skuCount: number;
  boxCount: number;
  quantity: number;
  available: number;
}

interface OverviewData {
  generatedAt: string;
  totals: {
    totalUnits: number;
    availableUnits: number;
    skuCount: number;
    boxCount: number;
    locationCount: number;
    lowStock: number;
    expiringSoon: number;
  };
  locations: OverviewLocation[];
}

export function HomePage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi<OverviewData>('/inventory/overview');

  const totals = data?.totals;
  const locations = data?.locations ?? [];

  const columns: Array<Column<OverviewLocation>> = [
    {
      key: 'location',
      header: 'Rack / location',
      render: (row) => (
        <div>
          <strong className="cell-title">{row.code}</strong>
          <span className="muted tiny">
            {titleCase(row.type)}
            {row.zone ? ` · ${row.zone}` : ''}
          </span>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.status} /> },
    { key: 'skuCount', header: 'SKUs', className: 'num', render: (row) => formatNumber(row.skuCount) },
    { key: 'boxCount', header: 'Boxes', className: 'num', render: (row) => formatNumber(row.boxCount) },
    { key: 'quantity', header: 'Units on hand', className: 'num', render: (row) => formatNumber(row.quantity) },
    { key: 'available', header: 'Available', className: 'num', render: (row) => formatNumber(row.available) },
    {
      key: 'actions',
      header: '',
      className: 'actions',
      render: (row) => (
        <Link
          className="btn btn-subtle btn-xs"
          to={`/inventory?locationId=${row.id}`}
          onClick={(event) => event.stopPropagation()}
        >
          View stock
        </Link>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="My Inventory"
        subtitle="Every unit you own, by SKU, box, batch and rack location — derived from the immutable ledger."
        eyebrow="Aaradhya Smart WMS"
        actions={
          <>
            <span className="muted small">
              {data ? `Updated ${formatDateTime(data.generatedAt)}` : 'Reading stock'}
            </span>
            {can('inbound.receive') ? (
              <Link className="btn btn-primary" to="/inbound">
                <Icon name="inbound" size={16} /> Receive stock
              </Link>
            ) : null}
            <button type="button" className="btn btn-subtle" onClick={reload} disabled={loading}>
              <Icon name="refresh" size={16} /> Refresh
            </button>
          </>
        }
      />

      <ErrorNote error={error} />

      {loading && !data ? (
        <Card>
          <div className="center-pad">
            <Spinner label="Counting stock across every location…" />
          </div>
        </Card>
      ) : totals ? (
        <>
          <div className="stat-grid">
            <Stat
              label="Total units"
              value={formatNumber(totals.totalUnits)}
              icon="inventory"
              tone="info"
              hint="Every piece recorded in the warehouse"
            />
            <Stat
              label="Available units"
              value={formatNumber(totals.availableUnits)}
              icon="check"
              tone="success"
              hint="Sellable after reservations"
            />
            <Stat
              label="SKUs in stock"
              value={formatNumber(totals.skuCount)}
              icon="products"
              to="/products"
              hint="Distinct products with stock"
            />
            <Stat
              label="Boxes"
              value={formatNumber(totals.boxCount)}
              icon="boxes"
              to="/boxes"
              hint="Single and mixed boxes holding stock"
            />
            <Stat
              label="Rack locations"
              value={formatNumber(totals.locationCount)}
              icon="boxes"
              hint="Locations with stock on hand"
            />
            <Stat
              label="Low stock SKUs"
              value={formatNumber(totals.lowStock)}
              icon="alert"
              tone={totals.lowStock ? 'warning' : 'success'}
              to="/control-tower"
              hint="Below the configured threshold"
            />
            <Stat
              label="Expiring soon"
              value={formatNumber(totals.expiringSoon)}
              icon="clock"
              tone={totals.expiringSoon ? 'warning' : 'success'}
              to="/reports?tab=expiry"
              hint="Sellable batches inside the warning window"
            />
          </div>

          <div className="dashboard-grid">
            <Card
              className="span-2"
              title="Stock by location"
              subtitle="Quantities physically present in each rack, staging area and box location."
              actions={
                <Link className="btn btn-subtle btn-sm" to="/inventory">
                  Full stock ledger <Icon name="chevron" size={13} />
                </Link>
              }
              flush
            >
              <DataTable
                columns={columns}
                rows={locations}
                rowKey={(row) => row.id}
                emptyTitle="No stock on hand yet"
                emptyMessage="Receive stock, pass QC and put it away to see it appear here."
                onRowClick={(row) => navigate(`/inventory?locationId=${row.id}`)}
              />
              <div className="table-foot">
                Showing {locations.length} stocked location{locations.length === 1 ? '' : 's'} · click a row to see every SKU, box and batch inside it
              </div>
            </Card>

            <Card title="Quick actions" subtitle="Jump straight into the inventory workflows.">
              <div className="approval-list">
                {can('inbound.receive') ? (
                  <Link to="/inbound" className="approval-row">
                    <span><Icon name="inbound" size={16} /> Receive &amp; put away</span>
                    <Icon name="chevron" size={14} />
                  </Link>
                ) : null}
                <Link to="/scan" className="approval-row">
                  <span><Icon name="scan" size={16} /> Scan a box or SKU</span>
                  <Icon name="chevron" size={14} />
                </Link>
                <Link to="/boxes" className="approval-row">
                  <span><Icon name="boxes" size={16} /> Box contents</span>
                  <Icon name="chevron" size={14} />
                </Link>
                <Link to="/transfers" className="approval-row">
                  <span><Icon name="transfer" size={16} /> Move stock</span>
                  <Icon name="chevron" size={14} />
                </Link>
                <Link to="/counts" className="approval-row">
                  <span><Icon name="counts" size={16} /> Cycle counts</span>
                  <Icon name="chevron" size={14} />
                </Link>
                <Link to="/adjustments" className="approval-row">
                  <span><Icon name="adjust" size={16} /> Adjustments</span>
                  <Icon name="chevron" size={14} />
                </Link>
                <Link to="/trace" className="approval-row">
                  <span><Icon name="trace" size={16} /> Trace a batch or box</span>
                  <Icon name="chevron" size={14} />
                </Link>
              </div>
              <p className="muted small">
                Every movement is posted through the inventory engine, validated on the server and recorded in the audit trail.
              </p>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
