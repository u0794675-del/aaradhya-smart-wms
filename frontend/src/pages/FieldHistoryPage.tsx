import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDateTime, formatNumber, queryString } from '../api';
import { useAuth } from '../auth';
import { useApi } from '../hooks';
import { Card, DataTable, EmptyState, ErrorNote, Field, Icon, PageHeader, Spinner, Stat, StatusPill } from '../ui';

type HistoryKind = 'PICK' | 'PUTAWAY';

interface HistoryRow {
  id: string;
  operation_no: string;
  job_no: string;
  operation_type: HistoryKind;
  employee_id: string;
  employee_code: string;
  employee_name: string;
  box_code: string;
  brand: string | null;
  sku: string | null;
  source_location_code: string | null;
  destination_location_code: string | null;
  pick_mode: string;
  box_count_before: number;
  box_count_after: number;
  quantity_before: number;
  quantity_moved: number;
  quantity_after: number;
  reference_no: string;
  status: string;
  confirmed_at: string;
}

interface SummaryRow {
  employee_id: string;
  employee_code: string;
  employee_name: string;
  operations: number;
  putaway_operations: number;
  pick_operations: number;
  quantity_moved: number;
}

interface HistoryData {
  rows: HistoryRow[];
  total: number;
  summary: SummaryRow[];
}

interface EmployeeOption {
  id: string;
  employee_code: string;
  name: string;
}

interface Filters {
  employeeId: string;
  employee: string;
  brand: string;
  box: string;
  location: string;
  from: string;
  to: string;
}

const EMPTY: Filters = { employeeId: '', employee: '', brand: '', box: '', location: '', from: '', to: '' };

const COPY: Record<HistoryKind, { title: string; eyebrow: string; subtitle: string; workspace: string }> = {
  PICK: {
    title: 'Picker history',
    eyebrow: 'Confirmed picking operations',
    subtitle: 'Every confirmed pick with its employee, box, brand, locations and before/after stock. Records are immutable.',
    workspace: '/picker',
  },
  PUTAWAY: {
    title: 'Putaway history',
    eyebrow: 'Confirmed putaway operations',
    subtitle: 'Every confirmed putaway with its employee, box, brand, source and destination. Records are immutable.',
    workspace: '/putaway',
  },
};

export function FieldHistoryPage({ kind }: { kind: HistoryKind }) {
  const copy = COPY[kind];
  const { can } = useAuth();
  const admin = can('task.assign') || can('user.manage') || can('audit.read');
  const canListEmployees = can('task.assign');
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const employees = useApi<EmployeeOption[]>(canListEmployees ? '/fieldops/employees' : null);

  const path = `/fieldops/history${queryString({
    type: kind,
    employeeId: applied.employeeId || undefined,
    employee: applied.employee || undefined,
    brand: applied.brand || undefined,
    box: applied.box || undefined,
    location: applied.location || undefined,
    from: applied.from || undefined,
    to: applied.to || undefined,
    limit: 300,
  })}`;
  const history = useApi<HistoryData>(path);

  const rows = history.data?.rows ?? [];
  const summary = history.data?.summary ?? [];
  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => ({
          operations: acc.operations + 1,
          moved: acc.moved + Number(row.quantity_moved),
        }),
        { operations: 0, moved: 0 },
      ),
    [rows],
  );

  return (
    <div className="page">
      <PageHeader
        eyebrow={copy.eyebrow}
        title={copy.title}
        subtitle={copy.subtitle}
        actions={
          <Link className="btn btn-subtle btn-sm" to={copy.workspace}>
            <Icon name={kind === 'PICK' ? 'orders' : 'inbound'} size={14} /> Open {kind === 'PICK' ? 'picking' : 'putaway'} workspace
          </Link>
        }
      />

      <div className="stat-grid three">
        <Stat label="Matching operations" value={formatNumber(history.data?.total ?? 0)} icon="audit" />
        <Stat label="Quantity moved (page)" value={formatNumber(totals.moved)} icon="package" tone="info" />
        <Stat label={admin ? 'Employees in filter' : 'Scope'} value={admin ? summary.length : 'My records only'} icon="user" tone="accent" />
      </div>

      <Card title="Filters" subtitle="Filter by employee, brand, box, location or date. Employees only ever see their own records.">
        <form
          className="stack tight"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied({ ...draft });
          }}
        >
          <div className="inspect-grid">
            {canListEmployees ? (
              <Field label="Employee">
                <select
                  className="input"
                  value={draft.employeeId}
                  onChange={(event) => setDraft({ ...draft, employeeId: event.target.value })}
                >
                  <option value="">All employees</option>
                  {(employees.data ?? []).map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.employee_code} · {employee.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="Employee name / ID">
                <input
                  className="input"
                  value={draft.employee}
                  onChange={(event) => setDraft({ ...draft, employee: event.target.value })}
                  placeholder="Name or employee code"
                />
              </Field>
            )}
            <Field label="Company / brand">
              <input
                className="input"
                value={draft.brand}
                onChange={(event) => setDraft({ ...draft, brand: event.target.value })}
                placeholder="Brand"
              />
            </Field>
            <Field label="Box ID / barcode">
              <input
                className="input"
                value={draft.box}
                onChange={(event) => setDraft({ ...draft, box: event.target.value })}
                placeholder="BOX-001"
              />
            </Field>
            <Field label="Location">
              <input
                className="input"
                value={draft.location}
                onChange={(event) => setDraft({ ...draft, location: event.target.value })}
                placeholder="RACK-A01"
              />
            </Field>
            <Field label="From date">
              <input
                className="input"
                type="date"
                value={draft.from}
                onChange={(event) => setDraft({ ...draft, from: event.target.value })}
              />
            </Field>
            <Field label="To date">
              <input
                className="input"
                type="date"
                value={draft.to}
                onChange={(event) => setDraft({ ...draft, to: event.target.value })}
              />
            </Field>
          </div>
          <div className="inline-actions">
            <button type="submit" className="btn btn-primary btn-sm">
              <Icon name="filter" size={14} /> Apply filters
            </button>
            <button
              type="button"
              className="btn btn-subtle btn-sm"
              onClick={() => {
                setDraft(EMPTY);
                setApplied(EMPTY);
              }}
            >
              Reset
            </button>
          </div>
        </form>
      </Card>

      {admin && summary.length ? (
        <Card title="Employee-wise totals" subtitle="Totals follow the same filters as the operation table." flush>
          <DataTable
            columns={[
              {
                key: 'employee',
                header: 'Employee',
                render: (row: SummaryRow) => (
                  <div className="cell-title">
                    <strong>{row.employee_name}</strong>
                    <span className="muted tiny">{row.employee_code}</span>
                  </div>
                ),
              },
              { key: 'operations', header: 'Operations', className: 'num', render: (row: SummaryRow) => formatNumber(row.operations) },
              { key: 'putaway_operations', header: 'Putaway', className: 'num', render: (row: SummaryRow) => formatNumber(row.putaway_operations) },
              { key: 'pick_operations', header: 'Picks', className: 'num', render: (row: SummaryRow) => formatNumber(row.pick_operations) },
              { key: 'quantity_moved', header: 'Units moved', className: 'num', render: (row: SummaryRow) => formatNumber(row.quantity_moved) },
            ]}
            rows={summary}
            rowKey={(row) => row.employee_id}
            compact
          />
        </Card>
      ) : null}

      <Card title="Confirmed operations" subtitle="Immutable history; corrections require an authorised reversal in the ledger." flush>
        <ErrorNote error={history.error} />
        {history.loading ? (
          <div className="card-body">
            <Spinner label="Loading history…" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon="audit" title="No confirmed operations" message="Confirmed picks and putaways appear here with full before/after quantities." />
        ) : (
          <DataTable
            columns={[
              {
                key: 'confirmed_at',
                header: 'Date / time',
                render: (row: HistoryRow) => (
                  <div className="cell-title">
                    <strong>{formatDateTime(row.confirmed_at)}</strong>
                    <span className="muted tiny">{row.operation_no}</span>
                  </div>
                ),
              },
              {
                key: 'employee',
                header: 'Employee',
                render: (row: HistoryRow) => (
                  <div className="cell-title">
                    <strong>{row.employee_name}</strong>
                    <span className="muted tiny">{row.employee_code}</span>
                  </div>
                ),
              },
              { key: 'brand', header: 'Company / brand', render: (row: HistoryRow) => row.brand ?? '—' },
              {
                key: 'box',
                header: 'Box / SKU',
                render: (row: HistoryRow) => (
                  <div className="cell-title">
                    <strong>{row.box_code}</strong>
                    <span className="muted tiny">{row.sku ?? 'Mixed box'}</span>
                  </div>
                ),
              },
              {
                key: 'locations',
                header: 'Source → destination',
                render: (row: HistoryRow) => `${row.source_location_code ?? '—'} → ${row.destination_location_code ?? '—'}`,
              },
              {
                key: 'boxes',
                header: 'Boxes',
                className: 'num',
                render: (row: HistoryRow) => `${formatNumber(row.box_count_before)} → ${formatNumber(row.box_count_after)}`,
              },
              {
                key: 'quantity',
                header: 'Qty before / moved / after',
                className: 'num',
                render: (row: HistoryRow) => (
                  <span>
                    {formatNumber(row.quantity_before)} / <strong>{formatNumber(row.quantity_moved)}</strong> /{' '}
                    {formatNumber(row.quantity_after)}
                  </span>
                ),
              },
              {
                key: 'reference',
                header: 'Reference',
                render: (row: HistoryRow) => (
                  <div className="cell-title">
                    <strong>{row.reference_no}</strong>
                    <span className="muted tiny">{row.pick_mode === 'UNITS' ? 'Partial units' : 'Whole box'}</span>
                  </div>
                ),
              },
              { key: 'status', header: 'Status', render: (row: HistoryRow) => <StatusPill value={row.status} /> },
            ]}
            rows={rows}
            rowKey={(row) => row.id}
            compact
          />
        )}
      </Card>
    </div>
  );
}
