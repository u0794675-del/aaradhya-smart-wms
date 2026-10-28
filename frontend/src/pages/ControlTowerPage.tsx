import { Link } from 'react-router-dom';
import { formatDateTime, formatNumber, titleCase } from '../api';
import { useApi } from '../hooks';
import { Card, EmptyState, ErrorNote, Icon, PageHeader, Spinner, Stat, StatusPill } from '../ui';

interface QueueOrder {
  id: string;
  order_no: string;
  channel: string;
  customer_name: string;
  priority: string;
  created_at: string;
}

interface ControlData {
  generatedAt: string;
  orders: {
    byStatus: Record<string, number>;
    open: number;
    dispatchQueue: number;
    pickQueue: number;
    allocateQueue: number;
  };
  tasks: { open: number; overdue: number; byType: Record<string, number> };
  inventory: {
    lowStock: number;
    expiring: number;
    expired: number;
    nonSellable: number;
    inTransit: number;
    availableUnits: number;
  };
  approvals: { transfers: number; adjustments: number; cycleCounts: number };
  exceptions: { open: number; critical: number };
  today: { dispatchedOrders: number; movements: number };
  lowStockItems: Array<{ id: string; sku: string; name: string; available: number; threshold: number }>;
  expiringBatches: Array<{
    id: string;
    batch_no: string;
    expiry_date: string;
    sku: string;
    name: string;
    quantity: number;
  }>;
  warningDays: number;
  openExceptions: Array<{
    id: string;
    exception_no: string;
    type: string;
    severity: string;
    status: string;
    description: string;
    created_at: string;
  }>;
  recentActivity: Array<{
    id: string;
    event_type: string;
    entity_type: string;
    entity_id: string | null;
    outcome: string;
    created_at: string;
    actor_name: string | null;
  }>;
  queues: {
    allocations: QueueOrder[];
    picks: QueueOrder[];
    packing: QueueOrder[];
    dispatch: QueueOrder[];
  };
}

const QUEUE_META: Array<{ key: keyof ControlData['queues']; title: string; icon: Parameters<typeof Icon>[0]['name'] }> = [
  { key: 'allocations', title: 'To allocate', icon: 'transfer' },
  { key: 'picks', title: 'To pick', icon: 'scan' },
  { key: 'packing', title: 'To pack', icon: 'package' },
  { key: 'dispatch', title: 'To dispatch', icon: 'inbound' },
];

export function ControlTowerPage() {
  const { data, loading, error, reload } = useApi<ControlData>('/control-tower');

  return (
    <div className="page">
      <PageHeader
        title="Control Tower"
        subtitle="Live fulfilment, inventory health and approvals across the warehouse."
        eyebrow="Aaradhya Smart WMS"
        actions={
          <>
            <span className="muted small">
              {data ? `Updated ${formatDateTime(data.generatedAt)}` : 'Loading live state'}
            </span>
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
            <Spinner label="Reading the warehouse ledger…" />
          </div>
        </Card>
      ) : data ? (
        <>
          <div className="stat-grid">
            <Stat label="Open orders" value={formatNumber(data.orders.open)} icon="orders" tone="info" to="/orders" hint="Not yet dispatched" />
            <Stat label="Available units" value={formatNumber(data.inventory.availableUnits)} icon="inventory" tone="success" to="/inventory" hint="Sellable after reservations" />
            <Stat label="Pick queue" value={formatNumber(data.orders.pickQueue)} icon="scan" tone="warning" to="/orders?status=ALLOCATED,PICKING" hint="Awaiting or in picking" />
            <Stat label="Dispatch queue" value={formatNumber(data.orders.dispatchQueue)} icon="inbound" tone="warning" to="/orders?status=PACKED" hint="Packed, ready to dispatch" />
            <Stat label="Overdue tasks" value={formatNumber(data.tasks.overdue)} icon="clock" tone={data.tasks.overdue ? 'danger' : 'success'} to="/tasks?overdue=1" hint={`${formatNumber(data.tasks.open)} tasks open`} />
            <Stat label="Open exceptions" value={formatNumber(data.exceptions.open)} icon="exceptions" tone={data.exceptions.critical ? 'danger' : data.exceptions.open ? 'warning' : 'success'} to="/exceptions" hint={`${formatNumber(data.exceptions.critical)} critical`} />
            <Stat label="Low stock SKUs" value={formatNumber(data.inventory.lowStock)} icon="products" tone={data.inventory.lowStock ? 'warning' : 'success'} hint="Below configured threshold" />
            <Stat label="Movements today" value={formatNumber(data.today.movements)} icon="audit" tone="accent" hint={`${formatNumber(data.today.dispatchedOrders)} shipments dispatched`} />
          </div>

          <div className="dashboard-grid">
            <Card
              className="span-2"
              title="Fulfilment pipeline"
              subtitle="Oldest orders waiting in each stage."
              actions={<Link className="btn btn-subtle btn-sm" to="/orders">All orders <Icon name="chevron" size={13} /></Link>}
            >
              <div className="queue-grid">
                {QUEUE_META.map((queue) => {
                  const orders = data.queues[queue.key] ?? [];
                  return (
                    <div className="queue-column" key={queue.key}>
                      <div className="queue-head">
                        <span><Icon name={queue.icon} size={15} /> {queue.title}</span>
                        <span className="queue-count">{orders.length}</span>
                      </div>
                      {orders.length === 0 ? (
                        <p className="queue-empty">Clear</p>
                      ) : (
                        orders.map((order) => (
                          <Link to={`/orders/${order.id}`} className="queue-item" key={order.id}>
                            <div className="queue-item-top">
                              <strong>{order.order_no}</strong>
                              <StatusPill value={order.priority} dot={false} />
                            </div>
                            <span>{order.customer_name}</span>
                            <span className="muted small">{order.channel} · {formatDateTime(order.created_at)}</span>
                          </Link>
                        ))
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>

            <Card title="Approvals & health" subtitle="Decisions waiting and stock that cannot sell.">
              <div className="approval-list">
                <Link to="/transfers?status=PENDING_APPROVAL" className="approval-row">
                  <span><Icon name="transfer" size={16} /> Transfers</span>
                  <strong>{data.approvals.transfers}</strong>
                </Link>
                <Link to="/adjustments?status=PENDING_APPROVAL" className="approval-row">
                  <span><Icon name="adjust" size={16} /> Adjustments</span>
                  <strong>{data.approvals.adjustments}</strong>
                </Link>
                <Link to="/counts?status=PENDING_APPROVAL" className="approval-row">
                  <span><Icon name="counts" size={16} /> Cycle counts</span>
                  <strong>{data.approvals.cycleCounts}</strong>
                </Link>
              </div>
              <div className="health-grid">
                <div><span>Expired batches</span><strong className={data.inventory.expired ? 'text-danger' : ''}>{formatNumber(data.inventory.expired)}</strong></div>
                <div><span>Expiring ≤ {data.warningDays} days</span><strong>{formatNumber(data.inventory.expiring)}</strong></div>
                <div><span>Non-sellable units</span><strong>{formatNumber(data.inventory.nonSellable)}</strong></div>
                <div><span>In transit</span><strong>{formatNumber(data.inventory.inTransit)}</strong></div>
              </div>
            </Card>

            <Card
              title="Low stock"
              subtitle="Available after reservations against threshold."
              actions={<Link className="btn btn-subtle btn-sm" to="/inventory">Stock <Icon name="chevron" size={13} /></Link>}
              flush
            >
              {data.lowStockItems.length === 0 ? (
                <EmptyState title="Stock levels healthy" message="No active SKU is below its threshold." icon="check" />
              ) : (
                <div className="mini-list">
                  {data.lowStockItems.map((item) => (
                    <Link className="mini-row" to={`/inventory?product=${item.id}`} key={item.id}>
                      <div>
                        <strong>{item.sku}</strong>
                        <span>{item.name}</span>
                      </div>
                      <div className="mini-value danger">
                        {formatNumber(item.available)}
                        <span>of {formatNumber(item.threshold)}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </Card>

            <Card
              title="Expiring batches"
              subtitle={`Sellable stock expiring within ${data.warningDays} days.`}
              actions={<Link className="btn btn-subtle btn-sm" to="/reports?tab=expiry">Report <Icon name="chevron" size={13} /></Link>}
              flush
            >
              {data.expiringBatches.length === 0 ? (
                <EmptyState title="No batches expiring soon" message="No sellable batch falls inside the warning window." icon="check" />
              ) : (
                <div className="mini-list">
                  {data.expiringBatches.map((batch) => (
                    <Link className="mini-row" to={`/trace?type=BATCH&id=${batch.id}`} key={batch.id}>
                      <div>
                        <strong>{batch.sku} · {batch.batch_no}</strong>
                        <span>{batch.name}</span>
                      </div>
                      <div className="mini-value warning">
                        {formatNumber(batch.quantity)}
                        <span>exp {batch.expiry_date}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </Card>

            <Card
              title="Open exceptions"
              subtitle="Operational issues under investigation."
              actions={<Link className="btn btn-subtle btn-sm" to="/exceptions">All <Icon name="chevron" size={13} /></Link>}
              flush
            >
              {data.openExceptions.length === 0 ? (
                <EmptyState title="No open exceptions" message="The floor is clear of reported issues." icon="check" />
              ) : (
                <div className="mini-list">
                  {data.openExceptions.map((exception) => (
                    <Link className="mini-row" to={`/exceptions?id=${exception.id}`} key={exception.id}>
                      <div>
                        <strong>{exception.exception_no} · {titleCase(exception.type)}</strong>
                        <span className="clamp-2">{exception.description}</span>
                      </div>
                      <StatusPill value={exception.severity} />
                    </Link>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Recent audit activity" subtitle="The latest recorded events across the warehouse." className="span-2" flush>
              {data.recentActivity.length === 0 ? (
                <EmptyState title="No activity yet" />
              ) : (
                <div className="timeline">
                  {data.recentActivity.map((event) => (
                    <div className="timeline-row" key={event.id}>
                      <span className={`timeline-dot ${event.outcome === 'FAILURE' ? 'danger' : ''}`} />
                      <div className="timeline-main">
                        <strong>{titleCase(event.event_type)}</strong>
                        <span>{event.entity_type}{event.entity_id ? ` · ${event.entity_id.slice(0, 8)}` : ''}</span>
                      </div>
                      <div className="timeline-meta">
                        <span>{event.actor_name ?? 'System'}</span>
                        <span className="muted">{formatDateTime(event.created_at)}</span>
                      </div>
                      {event.outcome === 'FAILURE' ? <StatusPill value="FAILURE" /> : null}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
