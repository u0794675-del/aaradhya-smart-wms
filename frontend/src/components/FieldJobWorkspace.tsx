import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDateTime, formatNumber, idempotencyKey, queryString } from '../api';
import { useAuth } from '../auth';
import { useAction, useApi } from '../hooks';
import { useToast } from '../toast';
import {
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Icon,
  MetaList,
  PageHeader,
  Spinner,
  Stat,
  StatusPill,
} from '../ui';
import { BarcodeScanner } from './BarcodeScanner';
import { ReasonDialog } from './forms';

type JobKind = 'PICK' | 'PUTAWAY';

interface FieldJobRow {
  id: string;
  job_no: string;
  job_type: JobKind;
  status: string;
  employee_id: string;
  employee_name: string;
  employee_code: string;
  box_id: string;
  box_code: string;
  box_status: string;
  source_location_code: string | null;
  destination_location_code: string;
  sku: string | null;
  product_name: string | null;
  brand: string | null;
  pick_mode: string;
  pick_quantity: number | null;
  box_line_count: number;
  box_available_quantity: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  notes: string | null;
}

interface JobList {
  rows: FieldJobRow[];
  total: number;
}

interface JobDetailData {
  job: FieldJobRow & {
    employee_email: string;
    box_type: string;
    source_zone: string | null;
    destination_zone: string | null;
    created_by_name: string | null;
  };
  contents: Array<Record<string, any>>;
  availableContents: Array<Record<string, any>>;
  operation: Record<string, any> | null;
}

interface EmployeeOption {
  id: string;
  employee_code: string;
  name: string;
  open_jobs: number;
}

interface BoxRow {
  id: string;
  box_code: string;
  status: string;
  location_id: string | null;
  location_code: string | null;
  total_quantity: number;
  available_quantity: number;
}

interface BoxList {
  rows: BoxRow[];
  total: number;
}

interface BoxDetail {
  box: Record<string, any>;
  contents: Array<Record<string, any>>;
}

const COPY: Record<JobKind, { title: string; eyebrow: string; subtitle: string; noun: string; history: string }> = {
  PICK: {
    title: 'Picking workspace',
    eyebrow: 'Picker operations',
    subtitle: 'Open an assigned pick, scan the stock location first, then the box. Stock moves only after you confirm.',
    noun: 'pick',
    history: 'Picker history',
  },
  PUTAWAY: {
    title: 'Putaway workspace',
    eyebrow: 'Putaway operations',
    subtitle: 'Open an assigned putaway, scan the destination rack and the box, then confirm the physical move.',
    noun: 'putaway',
    history: 'Putaway history',
  },
};

export function FieldJobWorkspace({ kind }: { kind: JobKind }) {
  const copy = COPY[kind];
  const { can, user, meta } = useAuth();
  const toast = useToast();
  const admin = can('task.assign');
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const jobs = useApi<JobList>(`/fieldops/jobs${queryString({ jobType: kind, limit: 200 })}`, version);
  const employees = useApi<EmployeeOption[]>(admin ? '/fieldops/employees' : null, version);
  const detail = useApi<JobDetailData>(selected ? `/fieldops/jobs/${selected}` : null, version);

  const rows = jobs.data?.rows ?? [];
  useEffect(() => {
    if (!selected && rows.length) setSelected(rows[0].id);
  }, [rows, selected]);

  const counts = useMemo(
    () =>
      rows.reduce(
        (acc, row) => ({
          assigned: acc.assigned + (row.status === 'ASSIGNED' ? 1 : 0),
          inProgress: acc.inProgress + (row.status === 'IN_PROGRESS' ? 1 : 0),
          completed: acc.completed + (row.status === 'COMPLETED' ? 1 : 0),
        }),
        { assigned: 0, inProgress: 0, completed: 0 },
      ),
    [rows],
  );

  const refresh = () => setVersion((value) => value + 1);

  const job = detail.data;
  const cancellable = admin && job && !['COMPLETED', 'CANCELLED'].includes(job.job.status);

  return (
    <div className="page">
      <PageHeader
        eyebrow={copy.eyebrow}
        title={copy.title}
        subtitle={copy.subtitle}
        actions={
          <div className="inline-actions">
            <Link className="btn btn-subtle btn-sm" to={kind === 'PICK' ? '/picker-history' : '/putaway-history'}>
              <Icon name="audit" size={14} /> {copy.history}
            </Link>
            {admin ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
                <Icon name="plus" size={15} /> Assign {copy.noun}
              </button>
            ) : null}
          </div>
        }
      />

      <div className="stat-grid four">
        <Stat label="Open assignments" value={counts.assigned} icon="tasks" tone="warning" />
        <Stat label="In progress" value={counts.inProgress} icon="play" tone="info" />
        <Stat label="Completed" value={counts.completed} icon="check" tone="success" />
        <Stat label={admin ? 'All employees' : 'Signed in as'} value={admin ? employees.data?.length ?? '—' : user?.employeeCode ?? '—'} icon="user" />
      </div>

      <div className="detail-grid">
        <div className="stack">
          <Card
            title={admin ? 'All assigned jobs' : 'My assigned jobs'}
            subtitle={admin ? 'Administrators see every employee and can assign new jobs.' : 'You only see jobs assigned to your employee ID.'}
            flush
          >
            {jobs.loading ? (
              <div className="card-body">
                <Spinner label="Loading jobs…" />
              </div>
            ) : jobs.error ? (
              <div className="card-body">
                <ErrorNote error={jobs.error} />
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                icon="tasks"
                title="No jobs assigned"
                message={
                  admin
                    ? `Assign a ${copy.noun} job to start the workflow.`
                    : 'Your administrator has not assigned a job yet. Check back after the next assignment.'
                }
              />
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Employee</th>
                      <th>Box / brand</th>
                      <th>From → To</th>
                      <th>Status</th>
                      <th className="num">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.id}
                        className={`clickable${selected === row.id ? ' is-selected' : ''}`}
                        onClick={() => setSelected(row.id)}
                      >
                        <td>
                          <div className="cell-title">
                            <strong>{row.job_no}</strong>
                            <span className="muted tiny">
                              {row.pick_mode === 'UNITS'
                                ? `Partial ${row.pick_quantity ?? 0} units`
                                : kind === 'PICK'
                                  ? 'Whole box'
                                  : 'Whole box putaway'}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="cell-title">
                            <strong>{row.employee_name}</strong>
                            <span className="muted tiny">{row.employee_code}</span>
                          </div>
                        </td>
                        <td>
                          <div className="cell-title">
                            <strong>{row.box_code}</strong>
                            <span className="muted tiny">{row.brand ?? row.sku ?? 'Mixed contents'}</span>
                          </div>
                        </td>
                        <td className="muted tiny">
                          {(row.source_location_code ?? '—') + ' → ' + row.destination_location_code}
                        </td>
                        <td>
                          <StatusPill value={row.status} />
                        </td>
                        <td className="num">{formatNumber(row.box_available_quantity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {job ? (
            <Card
              title={`Job ${job.job.job_no}`}
              subtitle={`${job.job.employee_name} · ${job.job.employee_code}`}
              actions={<StatusPill value={job.job.status} />}
            >
              <div className="stack">
                <MetaList
                  items={[
                    { label: 'Company / brand', value: job.job.brand ?? '—' },
                    { label: 'Product / SKU', value: job.job.sku ? `${job.job.sku} · ${job.job.product_name ?? ''}` : 'Mixed box' },
                    { label: 'Box', value: <strong>{job.job.box_code}</strong> },
                    { label: 'Source location', value: job.job.source_location_code ?? '—' },
                    { label: 'Destination', value: `${job.job.destination_location_code}${job.job.destination_zone ? ` · zone ${job.job.destination_zone}` : ''}` },
                    { label: 'Mode', value: job.job.pick_mode === 'UNITS' ? `Partial · ${job.job.pick_quantity} units` : 'Whole box' },
                    { label: 'Assigned', value: formatDateTime(job.job.created_at) },
                    { label: 'Completed', value: job.job.completed_at ? formatDateTime(job.job.completed_at) : '—' },
                  ]}
                />
                <DataTable
                  columns={[
                    { key: 'sku', header: 'SKU', render: (row: Record<string, any>) => `${row.sku} · ${row.product_name}` },
                    { key: 'batch_no', header: 'Batch', render: (row: Record<string, any>) => row.batch_no ?? '—' },
                    { key: 'quantity', header: 'On hand', className: 'num', render: (row: Record<string, any>) => formatNumber(row.quantity) },
                    { key: 'reserved_quantity', header: 'Reserved', className: 'num', render: (row: Record<string, any>) => formatNumber(row.reserved_quantity) },
                    { key: 'status', header: 'Status', render: (row: Record<string, any>) => <StatusPill value={String(row.status)} /> },
                  ]}
                  rows={job.contents}
                  compact
                  emptyTitle="Box is empty"
                />
              </div>
            </Card>
          ) : null}
        </div>

        <div className="stack">
          {!job && !detail.loading ? (
            <Card>
              <EmptyState icon="scan" title="Select a job" message="Open an assigned job to see the box, brand, source and destination before scanning." />
            </Card>
          ) : null}
          {detail.loading ? (
            <Card>
              <Spinner label="Opening job…" />
            </Card>
          ) : null}
          <ErrorNote error={detail.error} />

          {job ? (
            <>
              {job.job.status === 'COMPLETED' && job.operation ? (
                <Card title="Confirmed operation" subtitle={job.operation.operation_no}>
                  <MetaList
                    items={[
                      { label: 'Confirmed', value: formatDateTime(job.operation.confirmed_at) },
                      { label: 'Quantity moved', value: formatNumber(job.operation.quantity_moved) },
                      { label: 'Stock before', value: formatNumber(job.operation.quantity_before) },
                      { label: 'Stock after', value: formatNumber(job.operation.quantity_after) },
                      { label: 'Boxes at source', value: `${job.operation.box_count_before} → ${job.operation.box_count_after}` },
                      { label: 'Reference', value: job.operation.reference_no },
                      { label: 'Ledger rows', value: formatNumber(job.operation.txn_count) },
                      { label: 'Status', value: <StatusPill value={job.operation.status} /> },
                    ]}
                  />
                  <div className="inline-actions" style={{ marginTop: 12 }}>
                    <Link className="btn btn-subtle btn-sm" to={`/trace?type=BOX&id=${job.job.box_id}`}>
                      <Icon name="trace" size={14} /> Box genealogy
                    </Link>
                  </div>
                </Card>
              ) : null}

              {['ASSIGNED', 'IN_PROGRESS'].includes(job.job.status) ? (
                <ConfirmPanel
                  kind={kind}
                  job={job.job}
                  onDone={() => {
                    refresh();
                    toast.notify(`${kind === 'PICK' ? 'Pick' : 'Putaway'} confirmed and stock ledger updated`, 'success');
                  }}
                  onStart={async () => {
                    await api.post(`/fieldops/jobs/${job.job.id}/start`);
                    refresh();
                  }}
                />
              ) : null}

              {cancellable ? (
                <Card title="Administrator action" subtitle="Cancelling a job never changes stock.">
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => setCancelOpen(true)}>
                    Cancel this job
                  </button>
                </Card>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {admin ? (
        <AssignJobDialog
          kind={kind}
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          employees={employees.data ?? []}
          racks={(meta?.locations ?? []).filter((location) => location.type === 'RACK' && location.status === 'ACTIVE')}
          onCreated={(jobNo) => {
            setCreateOpen(false);
            toast.notify(`${jobNo} assigned`, 'success');
            refresh();
          }}
        />
      ) : null}

      <ReasonDialog
        open={cancelOpen}
        title={`Cancel ${job?.job.job_no ?? 'job'}`}
        label="Cancellation reason"
        hint="The job closes without any stock movement. The reason is audited."
        confirmLabel="Cancel job"
        danger
        onClose={() => setCancelOpen(false)}
        onConfirm={async (reason) => {
          if (!job) return;
          await api.post(`/fieldops/jobs/${job.job.id}/cancel`, { reason });
          toast.notify('Job cancelled', 'info');
          setCancelOpen(false);
          refresh();
        }}
      />
    </div>
  );
}

function ConfirmPanel({
  kind,
  job,
  onDone,
  onStart,
}: {
  kind: JobKind;
  job: JobDetailData['job'];
  onDone: () => void;
  onStart: () => Promise<void>;
}) {
  const toast = useToast();
  const [locationCode, setLocationCode] = useState('');
  const [boxCode, setBoxCode] = useState('');
  const [target, setTarget] = useState<'location' | 'box'>('location');
  const action = useAction();
  const starting = useAction();

  const submit = async () => {
    const body =
      kind === 'PICK'
        ? { locationCode: locationCode.trim(), boxCode: boxCode.trim() }
        : { destinationCode: locationCode.trim(), boxCode: boxCode.trim() };
    const result = await action.run(() =>
      api.post(
        `/fieldops/jobs/${job.id}/${kind === 'PICK' ? 'confirm-pick' : 'confirm-putaway'}`,
        body,
        idempotencyKey(),
      ),
    );
    if (result !== undefined) {
      setLocationCode('');
      setBoxCode('');
      onDone();
    }
  };

  const expectedLocation = kind === 'PICK' ? job.source_location_code ?? '—' : job.destination_location_code;
  const locationLabel = kind === 'PICK' ? 'Step 1 · Scan stock location' : 'Step 1 · Scan destination rack';
  const boxLabel = 'Step 2 · Scan box barcode';

  return (
    <Card title={kind === 'PICK' ? 'Pick confirmation' : 'Putaway confirmation'} subtitle="Scanning alone never changes stock. Confirm the scans to post the movement.">
      <div className="stack">
        {job.status === 'ASSIGNED' ? (
          <div className="inline-actions">
            <button
              type="button"
              className="btn btn-subtle btn-sm"
              disabled={starting.running}
              onClick={async () => {
                await starting.run(onStart);
                toast.notify('Job started', 'info');
              }}
            >
              <Icon name="play" size={14} /> {starting.running ? 'Starting…' : 'Start job'}
            </button>
            <span className="muted tiny">Starting only marks the job in progress; it does not move stock.</span>
          </div>
        ) : null}
        <ErrorNote error={starting.error} />
        <Field label={locationLabel} hint={`Expected: ${expectedLocation}`} required>
          <input
            className="input"
            value={locationCode}
            onChange={(event) => setLocationCode(event.target.value)}
            onFocus={() => setTarget('location')}
            placeholder={expectedLocation}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label={boxLabel} hint={`Assigned box: ${job.box_code}`} required>
          <input
            className="input"
            value={boxCode}
            onChange={(event) => setBoxCode(event.target.value)}
            onFocus={() => setTarget('box')}
            placeholder={job.box_code}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <div className="inline-actions">
          <button
            type="button"
            className={`btn btn-sm ${target === 'location' ? 'btn-primary' : 'btn-subtle'}`}
            onClick={() => setTarget('location')}
          >
            Camera → location
          </button>
          <button
            type="button"
            className={`btn btn-sm ${target === 'box' ? 'btn-primary' : 'btn-subtle'}`}
            onClick={() => setTarget('box')}
          >
            Camera → box
          </button>
        </div>
        <BarcodeScanner
          disabled={action.running}
          onDetected={(text) => {
            if (target === 'location') {
              setLocationCode(text);
              setTarget('box');
            } else {
              setBoxCode(text);
            }
          }}
        />

        <ErrorNote error={action.error} />
        <button
          type="button"
          className="btn btn-primary"
          disabled={action.running || !locationCode.trim() || !boxCode.trim()}
          onClick={() => void submit()}
        >
          {action.running ? 'Posting movement…' : kind === 'PICK' ? 'Confirm pick and deduct stock' : 'Confirm putaway'}
        </button>
        <p className="muted tiny">
          The backend re-validates the box, location, task assignment and stock balance inside one database transaction.
        </p>
      </div>
    </Card>
  );
}

function AssignJobDialog({
  kind,
  open,
  onClose,
  employees,
  racks,
  onCreated,
}: {
  kind: JobKind;
  open: boolean;
  onClose: () => void;
  employees: EmployeeOption[];
  racks: Array<{ id: string; code: string; zone?: string | null }>;
  onCreated: (jobNo: string) => void;
}) {
  const [employeeId, setEmployeeId] = useState('');
  const [boxId, setBoxId] = useState('');
  const [destinationLocationId, setDestination] = useState('');
  const [pickMode, setPickMode] = useState<'BOX' | 'UNITS'>('BOX');
  const [productId, setProductId] = useState('');
  const [pickQuantity, setPickQuantity] = useState('1');
  const [notes, setNotes] = useState('');
  const action = useAction();

  const boxes = useApi<BoxList>(open ? '/boxes?limit=200' : null, open ? 1 : 0);
  const boxDetail = useApi<BoxDetail>(open && boxId ? `/boxes/${boxId}` : null, open && boxId ? 1 : 0);

  useEffect(() => {
    if (!open) {
      setEmployeeId('');
      setBoxId('');
      setDestination('');
      setPickMode('BOX');
      setProductId('');
      setPickQuantity('1');
      setNotes('');
      action.setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    setProductId('');
  }, [boxId]);

  const selectableBoxes = (boxes.data?.rows ?? []).filter(
    (box) => Number(box.total_quantity) > 0 && box.location_id && box.status !== 'RETIRED' && box.status !== 'DAMAGED',
  );
  const availableLines = (boxDetail.data?.contents ?? []).filter(
    (line) => line.status === 'AVAILABLE' && Number(line.quantity) - Number(line.reserved_quantity) > 0,
  );
  const products = Array.from(
    new Map(
      availableLines.map((line) => [
        String(line.product_id),
        {
          id: String(line.product_id),
          sku: String(line.sku),
          name: String(line.product_name),
          available: Number(line.quantity) - Number(line.reserved_quantity),
        },
      ]),
    ).values(),
  );

  const submit = async () => {
    const body: Record<string, unknown> = {
      jobType: kind,
      employeeId,
      boxId,
      notes: notes.trim() || null,
    };
    if (kind === 'PUTAWAY') {
      body.destinationLocationId = destinationLocationId;
    } else {
      body.pickMode = pickMode;
      if (pickMode === 'UNITS') {
        body.productId = productId;
        body.pickQuantity = Number(pickQuantity);
      }
    }
    const result = await action.run(() => api.post<{ job_no: string }>('/fieldops/jobs', body));
    if (result) onCreated(result.job_no);
  };

  return (
    <Dialog
      open={open}
      title={kind === 'PICK' ? 'Assign a pick job' : 'Assign a putaway job'}
      subtitle="The employee will only see jobs assigned to their own employee ID."
      onClose={onClose}
      wide
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={action.running || !employeeId || !boxId || (kind === 'PUTAWAY' ? !destinationLocationId : pickMode === 'UNITS' && (!productId || Number(pickQuantity) <= 0))}
            onClick={() => void submit()}
          >
            {action.running ? 'Assigning…' : 'Assign job'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={action.error} />
        <Field label="Employee" required hint="Only active field staff with the required permission can be assigned.">
          <select className="input" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
            <option value="">Select employee</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.employee_code} · {employee.name} ({employee.open_jobs} open)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Box" required hint="Boxes with available stock and a recorded location.">
          <select className="input" value={boxId} onChange={(event) => setBoxId(event.target.value)}>
            <option value="">Select box</option>
            {selectableBoxes.map((box) => (
              <option key={box.id} value={box.id}>
                {box.box_code} · {box.location_code ?? '—'} · {formatNumber(box.available_quantity)} available
              </option>
            ))}
          </select>
        </Field>
        {boxDetail.loading ? <Spinner label="Loading box contents…" /> : null}
        <ErrorNote error={boxDetail.error} />
        {kind === 'PUTAWAY' ? (
          <Field label="Destination rack" required hint="The employee must scan this exact location during confirmation.">
            <select className="input" value={destinationLocationId} onChange={(event) => setDestination(event.target.value)}>
              <option value="">Select destination rack</option>
              {racks.map((rack) => (
                <option key={rack.id} value={rack.id}>
                  {rack.code}
                  {rack.zone ? ` · zone ${rack.zone}` : ''}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <>
            <Field label="Pick mode" required>
              <select className="input" value={pickMode} onChange={(event) => setPickMode(event.target.value as 'BOX' | 'UNITS')}>
                <option value="BOX">Whole box — moves every unit in the box</option>
                <option value="UNITS">Partial units — moves only a confirmed SKU quantity</option>
              </select>
            </Field>
            {pickMode === 'UNITS' ? (
              <>
                <Field label="Product" required>
                  <select className="input" value={productId} onChange={(event) => setProductId(event.target.value)}>
                    <option value="">Select product</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.sku} · {product.name} ({product.available} available)
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Quantity" required hint="Cannot exceed the unreserved units currently inside the box.">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={pickQuantity}
                    onChange={(event) => setPickQuantity(event.target.value)}
                  />
                </Field>
              </>
            ) : null}
          </>
        )}
        <Field label="Notes">
          <textarea className="input textarea" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
        {boxDetail.data ? (
          <p className="muted tiny">
            Box contents: {availableLines.length} available line(s),{' '}
            {formatNumber(availableLines.reduce((sum, line) => sum + Number(line.quantity) - Number(line.reserved_quantity), 0))} units.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
