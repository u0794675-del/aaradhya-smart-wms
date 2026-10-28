import { useEffect, useMemo, useState } from 'react';
import { api, formatDateTime, formatNumber, queryString, titleCase } from '../api';
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
  PageHeader,
  Spinner,
  Stat,
  StatusPill,
  type Column,
} from '../ui';
import { ReasonDialog } from '../components/forms';
import { BulkBar, BulkDeleteDialog, useBulkSelection } from '../components/BulkDelete';

interface Override {
  permission_code: string;
  effect: 'GRANT' | 'DENY';
}

interface EmployeeRow {
  id: string;
  employee_code: string;
  name: string;
  email: string;
  role_code: string;
  is_active: number;
  created_at: string;
  last_login_at: string | null;
  open_jobs: number;
  completed_operations: number;
  permissions: string[];
  overrides: Override[];
}

interface EmployeeList {
  rows?: EmployeeRow[];
  employees?: EmployeeRow[];
}

interface PermissionMeta {
  code: string;
  description: string;
  category: string;
}

const ROLE_OPTIONS = [
  { value: 'FIELD_OPERATOR', label: 'Picker / Putaway Operator' },
  { value: 'PICKER', label: 'Picker' },
];

const DEFAULT_OPERATOR = ['picking.execute', 'putaway.execute'];

// Baseline grants that come from the role itself. Dialog checkboxes must start
// from these, otherwise saving sends DENY overrides for the unticked baseline.
const ROLE_BASELINES: Record<string, string[]> = {
  FIELD_OPERATOR: DEFAULT_OPERATOR,
  PICKER: ['picking.execute', 'putaway.execute', 'inventory.read', 'task.manage', 'exception.manage'],
};

const ROLE_BASELINE_LABEL: Record<string, string> = {
  FIELD_OPERATOR: 'picking + putaway',
  PICKER: 'picking + putaway + inventory read + tasks + exceptions',
};

export function EmployeesPage() {
  const toast = useToast();
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<EmployeeRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState<EmployeeRow | null>(null);
  const [resetTarget, setResetTarget] = useState<EmployeeRow | null>(null);
  const [issued, setIssued] = useState<{ employeeCode: string; email: string; password: string } | null>(null);
  const employeeSelection = useBulkSelection();
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const list = useApi<EmployeeList>(
    `/employees${queryString({
      search: search.trim() || undefined,
      role: role || undefined,
      includeInactive: includeInactive || undefined,
      limit: 300,
    })}`,
    version,
  );
  const permissionMeta = useApi<PermissionMeta[]>('/employees/permissions', version);
  const rows = list.data?.rows ?? list.data?.employees ?? [];
  const permissions = permissionMeta.data ?? [];
  const refresh = () => setVersion((value) => value + 1);
  const selectedEmployeeIds = employeeSelection.selected.filter((id) => rows.some((row) => row.id === id));
  const allEmployeesSelected = rows.length > 0 && selectedEmployeeIds.length === rows.length;

  const stats = useMemo(
    () => ({
      active: rows.filter((row) => row.is_active === 1).length,
      openJobs: rows.reduce((sum, row) => sum + Number(row.open_jobs), 0),
      operations: rows.reduce((sum, row) => sum + Number(row.completed_operations), 0),
    }),
    [rows],
  );

  const columns: Array<Column<EmployeeRow>> = [
    {
      key: 'select',
      className: 'select-col',
      header: (
        <input
          type="checkbox"
          aria-label="Select all employees"
          checked={allEmployeesSelected}
          onChange={() =>
            allEmployeesSelected
              ? employeeSelection.clear()
              : employeeSelection.selectMany(rows.map((row) => row.id))
          }
        />
      ),
      render: (row) => (
        <span onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            aria-label={`Select ${row.employee_code}`}
            checked={selectedEmployeeIds.includes(row.id)}
            onChange={() => employeeSelection.toggle(row.id)}
          />
        </span>
      ),
    },
    {
      key: 'employee',
      header: 'Employee',
      render: (row) => (
        <div className="cell-title">
          <strong>{row.name}</strong>
          <span className="muted tiny">
            {row.employee_code} · {row.email}
          </span>
        </div>
      ),
    },
    { key: 'role', header: 'Role', render: (row) => titleCase(row.role_code) },
    {
      key: 'permissions',
      header: 'Permissions',
      render: (row) => (
        <div className="pill-row">
          {row.permissions.length === 0 ? <span className="muted tiny">No permissions</span> : null}
          {row.permissions.map((permission) => (
            <span className="pill pill-neutral tiny" key={permission}>
              {permission}
            </span>
          ))}
        </div>
      ),
    },
    { key: 'open_jobs', header: 'Open jobs', className: 'num', render: (row) => formatNumber(row.open_jobs) },
    {
      key: 'completed_operations',
      header: 'Confirmed ops',
      className: 'num',
      render: (row) => formatNumber(row.completed_operations),
    },
    {
      key: 'last_login_at',
      header: 'Last sign-in',
      render: (row) => (row.last_login_at ? formatDateTime(row.last_login_at) : 'Never'),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusPill value={row.is_active === 1 ? 'ACTIVE' : 'INACTIVE'} /> },
    {
      key: 'actions',
      header: '',
      className: 'num',
      render: (row) => (
        <div className="inline-actions">
          <button
            type="button"
            className="btn btn-subtle btn-xs"
            onClick={(event) => {
              event.stopPropagation();
              setEditing(row);
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn btn-subtle btn-xs"
            onClick={(event) => {
              event.stopPropagation();
              setResetTarget(row);
            }}
          >
            Reset password
          </button>
          {row.is_active === 1 && row.id !== user?.id ? (
            <button
              type="button"
              className="btn btn-danger btn-xs"
              onClick={(event) => {
                event.stopPropagation();
                setDeactivateTarget(row);
              }}
            >
              Deactivate
            </button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        eyebrow="Administration"
        title="Employees & permissions"
        subtitle="Create and manage picker / putaway staffing. Names, employee IDs and backend permissions are controlled here."
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" size={15} /> New employee
          </button>
        }
      />

      <div className="stat-grid three">
        <Stat label="Active employees" value={formatNumber(stats.active)} icon="user" />
        <Stat label="Open field jobs" value={formatNumber(stats.openJobs)} icon="tasks" tone="warning" />
        <Stat label="Confirmed operations" value={formatNumber(stats.operations)} icon="check" tone="success" />
      </div>

      {issued ? (
        <Card title="Temporary credentials" subtitle="Share these once. The password is not stored in readable form.">
          <div className="stack tight">
            <div className="alert alert-success">
              <strong>{issued.employeeCode}</strong> · {issued.email}
              <div className="mono" style={{ marginTop: 6, fontSize: '1.05rem' }}>
                {issued.password}
              </div>
            </div>
            <p className="muted small">
              The employee can sign in immediately. Ask them to change the password after first sign-in from My Security.
            </p>
            <div className="inline-actions">
              <button
                type="button"
                className="btn btn-subtle btn-sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(`${issued.employeeCode} ${issued.email} ${issued.password}`);
                  toast.notify('Credentials copied', 'info');
                }}
              >
                <Icon name="download" size={14} /> Copy credentials
              </button>
              <button type="button" className="btn btn-subtle btn-sm" onClick={() => setIssued(null)}>
                Dismiss
              </button>
            </div>
          </div>
        </Card>
      ) : null}

      <Card title="Field staff" subtitle="Only active field operators appear in job assignment lists." flush>
        <div className="card-body toolbar">
          <input
            className="input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name, employee ID or email"
          />
          <select className="input" value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="">All field roles</option>
            {ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
            />
            Include inactive
          </label>
        </div>
        <ErrorNote error={list.error ?? permissionMeta.error} />
        {selectedEmployeeIds.length > 0 ? (
          <div className="card-body">
            <BulkBar
              count={selectedEmployeeIds.length}
              noun="employee"
              onClear={employeeSelection.clear}
              onDelete={() => setBulkDeleteOpen(true)}
            />
          </div>
        ) : null}
        {list.loading ? (
          <div className="card-body">
            <Spinner label="Loading employees…" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="user"
            title="No employees found"
            message="Create a picker or putaway employee to start assigning field jobs."
          />
        ) : (
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} compact />
        )}
        <BulkDeleteDialog
          open={bulkDeleteOpen}
          entityLabel="employee"
          endpoint="/employees/bulk-delete"
          ids={selectedEmployeeIds}
          onClose={() => setBulkDeleteOpen(false)}
          onCompleted={() => {
            employeeSelection.clear();
            refresh();
          }}
        />
      </Card>

      <CreateEmployeeDialog
        open={createOpen}
        permissions={permissions}
        onClose={() => setCreateOpen(false)}
        onCreated={(result) => {
          setCreateOpen(false);
          setIssued({
            employeeCode: result.employee.employee_code,
            email: result.employee.email,
            password: result.temporaryPassword ?? '(password set by administrator)',
          });
          refresh();
        }}
      />

      <EditEmployeeDialog
        employee={editing}
        permissions={permissions}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />

      <ResetPasswordDialog
        employee={resetTarget}
        onClose={() => setResetTarget(null)}
        onReset={(result, employee) => {
          setResetTarget(null);
          setIssued({ employeeCode: employee.employee_code, email: result.email, password: result.password });
          refresh();
        }}
      />

      <ReasonDialog
        open={Boolean(deactivateTarget)}
        title={`Deactivate ${deactivateTarget?.employee_code ?? 'employee'}`}
        label="Reason for deactivation"
        hint="Open sessions are revoked immediately. Existing history is preserved and the employee can no longer sign in."
        confirmLabel="Deactivate employee"
        danger
        onClose={() => setDeactivateTarget(null)}
        onConfirm={async () => {
          if (!deactivateTarget) return;
          await api.patch(`/employees/${deactivateTarget.id}`, { isActive: false });
          toast.notify(`${deactivateTarget.employee_code} deactivated`, 'info');
          setDeactivateTarget(null);
          refresh();
        }}
      />
    </div>
  );
}

function PermissionPicker({
  permissions,
  selected,
  role,
  onChange,
}: {
  permissions: PermissionMeta[];
  selected: string[];
  role: string;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="permission-grid">
      {permissions.map((permission) => {
        const checked = selected.includes(permission.code);
        return (
          <label className={`permission-card ${checked ? 'checked' : ''}`} key={permission.code}>
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(permission.code);
                else next.delete(permission.code);
                onChange(Array.from(next));
              }}
            />
            <span>
              <strong>{permission.code}</strong>
              <small>{permission.description}</small>
            </span>
          </label>
        );
      })}
      <p className="muted tiny">
        Role baseline: {ROLE_BASELINE_LABEL[role] ?? 'no backend permissions'}. Ticks above become explicit grant/deny
        overrides for this employee and are enforced by the backend.
      </p>
    </div>
  );
}

function CreateEmployeeDialog({
  open,
  permissions,
  onClose,
  onCreated,
}: {
  open: boolean;
  permissions: PermissionMeta[];
  onClose: () => void;
  onCreated: (result: { employee: EmployeeRow; temporaryPassword: string | null }) => void;
}) {
  const [employeeCode, setEmployeeCode] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('FIELD_OPERATOR');
  const [selected, setSelected] = useState<string[]>(ROLE_BASELINES.FIELD_OPERATOR);
  const action = useAction();

  useEffect(() => {
    if (!open) return;
    setEmployeeCode('');
    setName('');
    setEmail('');
    setRole('FIELD_OPERATOR');
    setSelected(ROLE_BASELINES.FIELD_OPERATOR);
    action.setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    setSelected(ROLE_BASELINES[role] ?? []);
  }, [role]);

  const submit = async () => {
    const result = await action.run(() =>
      api.post<{ employee: EmployeeRow; temporaryPassword: string | null }>('/employees', {
        employeeCode: employeeCode.trim() || undefined,
        name: name.trim(),
        email: email.trim(),
        role,
        permissions: selected,
      }),
    );
    if (result) onCreated(result);
  };

  return (
    <Dialog
      open={open}
      title="New field employee"
      subtitle="An employee ID is generated automatically if you leave the code blank."
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
            onClick={() => void submit()}
            disabled={action.running || name.trim().length < 2 || !email.includes('@')}
          >
            {action.running ? 'Creating…' : 'Create employee'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={action.error} />
        <div className="form-grid">
          <Field label="Full name" required>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </Field>
          <Field label="Employee ID" hint="e.g. EMP-0012. Leave blank to auto-generate.">
            <input
              className="input"
              value={employeeCode}
              onChange={(event) => setEmployeeCode(event.target.value.toUpperCase())}
              placeholder="EMP-0012"
              autoComplete="off"
            />
          </Field>
          <Field label="Sign-in email" required>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@aaradhya.local"
              autoComplete="off"
            />
          </Field>
          <Field label="Role" required>
            <select className="input" value={role} onChange={(event) => setRole(event.target.value)}>
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Backend permissions" hint="Permissions are enforced on every API call, not only in the UI.">
          <PermissionPicker permissions={permissions} selected={selected} role={role} onChange={setSelected} />
        </Field>
        <p className="muted small">
          A temporary password is generated once and shown after creation. The employee can change it from My Security.
        </p>
      </div>
    </Dialog>
  );
}

function EditEmployeeDialog({
  employee,
  permissions,
  onClose,
  onSaved,
}: {
  employee: EmployeeRow | null;
  permissions: PermissionMeta[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [employeeCode, setEmployeeCode] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('FIELD_OPERATOR');
  const [isActive, setIsActive] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const action = useAction();

  useEffect(() => {
    if (!employee) return;
    setEmployeeCode(employee.employee_code);
    setName(employee.name);
    setEmail(employee.email);
    setRole(employee.role_code);
    setIsActive(employee.is_active === 1);
    const managed = new Set(permissions.map((permission) => permission.code));
    setSelected(employee.permissions.filter((code) => managed.has(code)));
    action.setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee, permissions]);

  const submit = async () => {
    if (!employee) return;
    const result = await action.run(() =>
      api.patch<EmployeeRow>(`/employees/${employee.id}`, {
        employeeCode: employeeCode.trim(),
        name: name.trim(),
        email: email.trim(),
        role,
        isActive,
        permissions: selected,
      }),
    );
    if (result) {
      toast.notify(`${result.employee_code} updated`, 'success');
      onSaved();
    }
  };

  return (
    <Dialog
      open={Boolean(employee)}
      title={employee ? `Edit ${employee.employee_code}` : 'Edit employee'}
      subtitle="Employee IDs and permission overrides are audited."
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
            onClick={() => void submit()}
            disabled={action.running || name.trim().length < 2 || !email.includes('@')}
          >
            {action.running ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={action.error} />
        <div className="form-grid">
          <Field label="Full name" required>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Employee ID" required>
            <input
              className="input"
              value={employeeCode}
              onChange={(event) => setEmployeeCode(event.target.value.toUpperCase())}
              autoComplete="off"
            />
          </Field>
          <Field label="Sign-in email" required>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="Role" required>
            <select
              className="input"
              value={role}
              onChange={(event) => {
                const next = event.target.value;
                setRole(next);
                setSelected(ROLE_BASELINES[next] ?? []);
              }}
            >
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
          Active — can sign in and receive field jobs
        </label>
        <Field label="Backend permissions" hint="Changes take effect on the employee's next request.">
          <PermissionPicker permissions={permissions} selected={selected} role={role} onChange={setSelected} />
        </Field>
        <p className="muted small">
          Deactivating revokes every open session immediately. Existing picker and putaway history stays intact.
        </p>
      </div>
    </Dialog>
  );
}

function ResetPasswordDialog({
  employee,
  onClose,
  onReset,
}: {
  employee: EmployeeRow | null;
  onClose: () => void;
  onReset: (result: { email: string; password: string }, employee: EmployeeRow) => void;
}) {
  const action = useAction();

  return (
    <Dialog
      open={Boolean(employee)}
      title={employee ? `Reset password for ${employee.employee_code}` : 'Reset password'}
      subtitle="A new temporary password is generated and all existing sessions are revoked."
      onClose={onClose}
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              if (!employee) return;
              const result = await action.run(() =>
                api.post<{ email: string; password: string }>(`/employees/${employee.id}/reset-password`),
              );
              if (result) onReset(result, employee);
            }}
            disabled={action.running}
          >
            {action.running ? 'Resetting…' : 'Reset password'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={action.error} />
        <p className="muted">
          {employee?.name} ({employee?.employee_code}) will be signed out everywhere. The new password is shown once
          after reset and is never stored in readable form.
        </p>
      </div>
    </Dialog>
  );
}
