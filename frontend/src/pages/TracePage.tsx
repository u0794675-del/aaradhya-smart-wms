import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatDateTime, formatNumber, queryString, titleCase } from '../api';
import { useApi } from '../hooks';
import {
  Card,
  DataTable,
  ErrorNote,
  Field,
  Icon,
  JsonView,
  MetaList,
  PageHeader,
  Spinner,
  Stat,
  StatusPill,
  type Column,
} from '../ui';
import { entityLink } from '../links';

const TYPES = ['PRODUCT', 'BATCH', 'BOX', 'ORDER', 'RECEIPT', 'TRANSFER', 'RETURN', 'CYCLE_COUNT', 'ADJUSTMENT'] as const;

const PRIMARY_FIELD: Record<string, string> = {
  PRODUCT: 'sku',
  BATCH: 'batch_no',
  BOX: 'box_code',
  ORDER: 'order_no',
  RECEIPT: 'receipt_no',
  TRANSFER: 'transfer_no',
  RETURN: 'return_no',
  CYCLE_COUNT: 'count_no',
  ADJUSTMENT: 'adjustment_no',
};

interface GenealogyTransaction {
  id: string;
  txn_no: string;
  movement_type: string;
  quantity: number;
  created_at: string;
  user_name: string | null;
  reference_type: string | null;
  reference_no: string | null;
  reference_id: string | null;
  reason: string | null;
  reversal_of: string | null;
  from_location_code: string | null;
  to_location_code: string | null;
  from_pool_code: string | null;
  to_pool_code: string | null;
  from_box_code: string | null;
  to_box_code: string | null;
  from_batch_no: string | null;
  to_batch_no: string | null;
}

interface GenealogyAudit {
  id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_name: string | null;
  outcome: string | null;
  reason: string | null;
  created_at: string;
  transaction_id: string | null;
}

interface GenealogyResult {
  type: string;
  entity: Record<string, unknown>;
  transactions: GenealogyTransaction[];
  auditEvents: GenealogyAudit[];
  related: Record<string, unknown>;
}

export function TracePage() {
  const [params, setParams] = useSearchParams();
  const type = (params.get('type') ?? 'PRODUCT').toUpperCase();
  const id = params.get('id') ?? '';
  const validType = (TYPES as readonly string[]).includes(type);
  const state = useApi<GenealogyResult>(
    id && validType ? `/genealogy${queryString({ type, id })}` : null,
  );
  const data = state.data;

  const navigate = (nextType: string, nextId: string) => {
    const next = new URLSearchParams(params);
    next.set('type', nextType);
    if (nextId) next.set('id', nextId);
    else next.delete('id');
    setParams(next, { replace: true });
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Control"
        title="Item genealogy"
        subtitle="Trace any product, batch, box, order, receipt, transfer, return, cycle count or adjustment through its stock movements and audit events."
        actions={
          data ? (
            <div className="toolbar">
              <Link className="btn btn-subtle" to={entityLink(data.type, String(data.entity.id)) ?? '/inventory'}>
                <Icon name="external" size={15} /> Open workspace
              </Link>
              <Link className="btn btn-subtle" to={`/audit${queryString({ entityType: data.type, entityId: String(data.entity.id) })}`}>
                <Icon name="audit" size={15} /> Audit events
              </Link>
            </div>
          ) : null
        }
      />

      <Card title="Trace a record" subtitle="Accept a record id or its business number, e.g. AHP00001, ORD-…, BX-…">
        <TraceLookup type={type} id={id} onTrace={navigate} />
        {!validType ? <ErrorNote error={`Unsupported trace type '${type}'. Choose one of ${TYPES.join(', ')}.`} /> : null}
      </Card>

      {!id ? (
        <Card>
          <div className="empty-state">
            <span className="empty-icon">
              <Icon name="trace" size={26} />
            </span>
            <strong>No record selected</strong>
            <p>Pick a record type and enter its id or number to load its full movement history.</p>
          </div>
        </Card>
      ) : null}

      {state.loading && !data ? <Spinner label="Tracing record…" /> : null}
      <ErrorNote error={state.error} />

      {data ? <TraceResult data={data} onNavigate={navigate} /> : null}
    </div>
  );
}

function TraceLookup({
  type,
  id,
  onTrace,
}: {
  type: string;
  id: string;
  onTrace: (type: string, id: string) => void;
}) {
  const [nextType, setNextType] = useState(type);
  const [nextId, setNextId] = useState(id);

  return (
    <form
      className="form-grid three"
      onSubmit={(event) => {
        event.preventDefault();
        onTrace(nextType, nextId.trim());
      }}
    >
      <Field label="Record type">
        <select className="input" value={nextType} onChange={(event) => setNextType(event.target.value)}>
          {TYPES.map((value) => (
            <option key={value} value={value}>
              {titleCase(value)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Record id or number">
        <input
          className="input"
          value={nextId}
          maxLength={100}
          placeholder="UUID, AHP00001, BX-000001…"
          onChange={(event) => setNextId(event.target.value)}
        />
      </Field>
      <div className="field">
        <span className="field-label">Action</span>
        <div className="toolbar">
          <button type="submit" className="btn btn-primary" disabled={!nextId.trim()}>
            <Icon name="trace" size={15} /> Trace
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => onTrace(nextType, '')} disabled={!id}>
            Clear
          </button>
        </div>
      </div>
    </form>
  );
}

function TraceResult({
  data,
  onNavigate,
}: {
  data: GenealogyResult;
  onNavigate: (type: string, id: string) => void;
}) {
  const entity = data.entity;
  const primary = PRIMARY_FIELD[data.type] ? String(entity[PRIMARY_FIELD[data.type]] ?? '') : String(entity.id ?? '');
  const name = typeof entity.name === 'string' ? entity.name : typeof entity.customer_name === 'string' ? entity.customer_name : null;
  const status = typeof entity.status === 'string' ? entity.status : null;
  const totalUnits = data.transactions.reduce((sum, txn) => sum + Number(txn.quantity ?? 0), 0);

  const summaryItems = Object.entries(entity)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value) || value === null)
    .filter(([key]) => !['id', 'created_by', 'updated_by'].includes(key))
    .slice(0, 16)
    .map(([key, value]) => ({
      label: titleCase(key),
      value:
        value === null ? '—' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : key.endsWith('_at') ? formatDateTime(String(value)) : String(value),
    }));

  const txnColumns: Array<Column<GenealogyTransaction>> = [
    {
      key: 'txn_no',
      header: 'Movement',
      render: (row) => (
        <div className="cell-title">
          <strong>{titleCase(row.movement_type)}</strong>
          <span className="muted tiny">
            {row.txn_no}
            {row.reversal_of ? ' · reversal' : ''}
          </span>
        </div>
      ),
    },
    { key: 'quantity', header: 'Qty', className: 'num', render: (row) => formatNumber(row.quantity) },
    {
      key: 'from',
      header: 'From',
      render: (row) => <span className="small">{endpoint(row.from_location_code, row.from_pool_code, row.from_box_code, row.from_batch_no)}</span>,
    },
    {
      key: 'to',
      header: 'To',
      render: (row) => <span className="small">{endpoint(row.to_location_code, row.to_pool_code, row.to_box_code, row.to_batch_no)}</span>,
    },
    {
      key: 'reference',
      header: 'Reference',
      render: (row) =>
        row.reference_no ? (
          <span className="small">
            {row.reference_type ? `${titleCase(row.reference_type)} · ` : ''}
            {row.reference_no}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { key: 'user_name', header: 'User', render: (row) => row.user_name ?? 'System' },
    {
      key: 'created_at',
      header: 'When',
      render: (row) => <span className="muted small">{formatDateTime(row.created_at)}</span>,
    },
  ];

  return (
    <div className="stack">
      <div className="stat-grid four">
        <Stat label="Record" value={primary || '—'} hint={titleCase(data.type)} icon="trace" />
        <Stat label="Movements" value={formatNumber(data.transactions.length)} icon="inventory" hint="Most recent 200 shown" />
        <Stat label="Units moved" value={formatNumber(totalUnits)} icon="audit" />
        <Stat label="Audit events" value={formatNumber(data.auditEvents.length)} icon="audit" />
      </div>

      <Card
        title={`${titleCase(data.type)} ${primary ? `· ${primary}` : ''}`}
        subtitle={name ?? undefined}
        actions={status ? <StatusPill value={status} /> : null}
      >
        <MetaList items={summaryItems} />
      </Card>

      <Card title="Stock movements" subtitle="Every transaction touching this record, newest first." flush>
        <DataTable
          columns={txnColumns}
          rows={data.transactions}
          rowKey={(row) => row.id}
          emptyTitle="No stock movements"
          emptyMessage="This record has no inventory transactions yet."
        />
      </Card>

      <div className="detail-grid">
        <Card title="Audit timeline" subtitle="Who did what, with reasons and references." flush>
          {data.auditEvents.length === 0 ? (
            <p className="muted small" style={{ padding: 16 }}>
              No audit events recorded for this record.
            </p>
          ) : (
            <div className="timeline timeline-padded">
              {data.auditEvents.map((event) => (
                <div className="timeline-row" key={event.id}>
                  <div className="timeline-main">
                    <strong>{titleCase(event.event_type)}</strong>
                    {event.reason ? <span className="muted small">{event.reason}</span> : null}
                    {event.transaction_id ? <code className="code tiny">txn {event.transaction_id.slice(0, 8)}</code> : null}
                  </div>
                  <div className="timeline-meta">
                    <span>{event.actor_name ?? 'System'}</span>
                    <span>{formatDateTime(event.created_at)}</span>
                    {event.outcome ? <StatusPill value={event.outcome} dot={false} /> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Related records" subtitle="Children and snapshots loaded with this trace.">
          <div className="stack tight">
            {Object.entries(data.related).map(([key, value]) => (
              <details className="json-details" key={key}>
                <summary>
                  {titleCase(key)}
                  {Array.isArray(value) ? ` · ${formatNumber(value.length)}` : ''}
                </summary>
                <JsonView value={value} />
              </details>
            ))}
            {Object.keys(data.related).length === 0 ? <p className="muted small">No child records.</p> : null}
            {data.type === 'BATCH' && typeof data.related.product === 'object' && data.related.product ? (
              <button
                type="button"
                className="btn btn-subtle btn-sm"
                onClick={() => onNavigate('PRODUCT', String((data.related.product as Record<string, unknown>).id))}
              >
                Trace the parent product
              </button>
            ) : null}
            {data.type === 'BOX' ? (
              <Link className="btn btn-subtle btn-sm" to={`/boxes?box=${encodeURIComponent(String(entity.id))}`}>
                Open mixed-box contents
              </Link>
            ) : null}
          </div>
        </Card>
      </div>

      <details className="json-details">
        <summary>Raw trace payload</summary>
        <JsonView value={data} />
      </details>
    </div>
  );
}

function endpoint(
  location: string | null | undefined,
  pool: string | null | undefined,
  box: string | null | undefined,
  batch: string | null | undefined,
): string {
  const parts = [location, pool, box ? `box ${box}` : null, batch ? `batch ${batch}` : null].filter(Boolean);
  return parts.length ? parts.join(' / ') : '—';
}
