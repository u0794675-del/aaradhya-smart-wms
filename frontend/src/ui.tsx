import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ApiError, titleCase } from './api';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

const STATUS_TONES: Record<string, Tone> = {
  ACTIVE: 'success',
  AVAILABLE: 'success',
  ACCEPTED: 'success',
  APPROVED: 'success',
  COMPLETED: 'success',
  CONSUMED: 'success',
  DISPATCHED: 'success',
  IMPORTED: 'success',
  POSTED: 'success',
  RECEIVED: 'success',
  RESTOCK: 'success',
  VALIDATED: 'success',
  VERIFIED: 'success',
  ALLOCATED: 'info',
  CONFIRMED: 'info',
  DELIVERED: 'success',
  PICKING: 'warning',
  PICKED: 'warning',
  PACKED: 'warning',
  ASSIGNED: 'warning',
  ACKNOWLEDGED: 'warning',
  IN_PROGRESS: 'warning',
  INVESTIGATING: 'warning',
  OPEN: 'warning',
  ON_HOLD: 'warning',
  PARTIALLY_ACCEPTED: 'warning',
  PARTIALLY_CONSUMED: 'warning',
  PARTIALLY_INSPECTED: 'warning',
  PARTIALLY_PICKED: 'warning',
  PARTIALLY_RECEIVED: 'warning',
  PENDING: 'warning',
  PENDING_APPROVAL: 'warning',
  PENDING_QC: 'warning',
  QC_PENDING: 'warning',
  NEEDS_VERIFICATION: 'warning',
  RETURN_PENDING: 'warning',
  REWORK: 'warning',
  STAGING: 'warning',
  IN_TRANSIT: 'info',
  INSPECTED: 'info',
  WARNING: 'warning',
  MEDIUM: 'warning',
  HIGH: 'danger',
  CRITICAL: 'danger',
  BLOCKED: 'danger',
  CANCELLED: 'danger',
  DAMAGED: 'danger',
  EXPIRED: 'danger',
  EXCEPTION: 'danger',
  FAILED: 'danger',
  FAILED_VERIFICATION: 'danger',
  FAILURE: 'danger',
  OVERDUE: 'danger',
  QUARANTINED: 'danger',
  REJECTED: 'danger',
  RETIRED: 'danger',
  CLOSED: 'neutral',
  DRAFT: 'neutral',
  EMPTY: 'neutral',
  INACTIVE: 'neutral',
  LOW: 'neutral',
  NONE: 'neutral',
  RESOLVED: 'neutral',
  INFO: 'info',
};

export function toneForStatus(value: string | null | undefined): Tone {
  if (!value) return 'neutral';
  return STATUS_TONES[value.toUpperCase()] ?? 'neutral';
}

export function StatusPill({
  value,
  tone,
  dot = true,
}: {
  value: ReactNode;
  tone?: Tone;
  dot?: boolean;
}) {
  const label = typeof value === 'string' ? titleCase(value) : value;
  const resolved = tone ?? (typeof value === 'string' ? toneForStatus(value) : 'neutral');
  return (
    <span className={`pill pill-${resolved}`}>
      {dot ? <span className="pill-dot" aria-hidden="true" /> : null}
      {label}
    </span>
  );
}

type IconName =
  | 'dashboard' | 'orders' | 'scan' | 'inbound' | 'transfer' | 'returns' | 'counts' | 'adjust'
  | 'tasks' | 'inventory' | 'boxes' | 'products' | 'reports' | 'exceptions' | 'notifications'
  | 'audit' | 'trace' | 'search' | 'assistant' | 'settings' | 'imports' | 'logout' | 'plus'
  | 'close' | 'refresh' | 'chevron' | 'menu' | 'camera' | 'check' | 'clock' | 'alert'
  | 'back' | 'external' | 'user' | 'download' | 'lock' | 'play' | 'package' | 'arrowRight'
  | 'filter' | 'info' | 'chevronLeft' | 'chevronRight' | 'dot' | 'spinnerIcon' | 'trash';

const ICON_PATHS: Record<IconName, ReactNode> = {
  dashboard: (
    <>
      <path d="M4 13a8 8 0 1 1 16 0" />
      <path d="M12 13l3.5-3.5" />
      <path d="M4 19h16" />
    </>
  ),
  orders: (
    <>
      <path d="M7 4h10a2 2 0 0 1 2 2v14H5V6a2 2 0 0 1 2-2Z" />
      <path d="M9 4V2h6v2" />
      <path d="M9 10h6M9 14h6M9 18h3" />
    </>
  ),
  scan: (
    <>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="M8 8h8v8H8z" />
    </>
  ),
  inbound: (
    <>
      <path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M8 3v4M6 5l2 2 2-2" />
    </>
  ),
  transfer: (
    <>
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </>
  ),
  returns: (
    <>
      <path d="M4 9a7 7 0 1 1 1.6 7.1" />
      <path d="M4 4v5h5" />
      <path d="M9 12h6" />
    </>
  ),
  counts: (
    <>
      <path d="M8 5h11v15H5V8" />
      <path d="M9 12l2 2 4-4M5 5l1.5-2L8 5" />
    </>
  ),
  adjust: (
    <>
      <path d="M4 7h8M16 7h4M4 17h4M12 17h8" />
      <circle cx="14" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
  tasks: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 12l3 3 5-6" />
    </>
  ),
  inventory: (
    <>
      <path d="M4 8l8-4 8 4-8 4-8-4Z" />
      <path d="M4 8v8l8 4 8-4V8" />
      <path d="M12 12v8" />
    </>
  ),
  boxes: (
    <>
      <path d="M4 9l8-4 8 4v9l-8 3-8-3V9Z" />
      <path d="M4 9l8 3 8-3M12 12v9" />
    </>
  ),
  products: (
    <>
      <path d="M4 5h16v4H4zM5 9v10h14V9" />
      <path d="M9 13h6" />
    </>
  ),
  reports: (
    <>
      <path d="M4 20h16" />
      <path d="M7 16V9M12 16V4M17 16v-5" />
    </>
  ),
  exceptions: (
    <>
      <path d="M12 3l9 17H3L12 3Z" />
      <path d="M12 9v5M12 17h.01" />
    </>
  ),
  notifications: (
    <>
      <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
      <path d="M10 20h4" />
    </>
  ),
  audit: (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  trace: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="12" r="2" />
      <path d="M6 8v8M8 6h4a3 3 0 0 1 3 3v1M8 18h4a3 3 0 0 0 3-3v-1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M16.5 16.5L21 21" />
    </>
  ),
  assistant: (
    <>
      <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Z" />
      <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21h-4v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  imports: (
    <>
      <path d="M12 16V4M8 8l4-4 4 4" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </>
  ),
  logout: (
    <>
      <path d="M9 5H5v14h4" />
      <path d="M14 8l4 4-4 4M18 12H9" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  refresh: (
    <>
      <path d="M20 5v5h-5" />
      <path d="M4 19v-5h5" />
      <path d="M5.5 9a7 7 0 0 1 11.6-2.6L20 10M4 14l2.9 3.6A7 7 0 0 0 18.5 15" />
    </>
  ),
  chevron: <path d="M9 6l6 6-6 6" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  camera: (
    <>
      <path d="M4 8h3l2-2h6l2 2h3v11H4V8Z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  check: <path d="M4 12l5 5L20 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6M12 16.5h.01" />
    </>
  ),
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11M8 11l4 4 4-4" />
      <path d="M4 20h16" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  play: <path d="M7 5l12 7-12 7V5Z" />,
  package: (
    <>
      <path d="M4 8l8-4 8 4v8l-8 4-8-4V8Z" />
      <path d="M4 8l8 4 8-4M12 12v8" />
    </>
  ),
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  filter: <path d="M4 5h16l-6 7v6l-4 2v-8L4 5Z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5h.01" />
    </>
  ),
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  dot: <circle cx="12" cy="12" r="3" />,
  spinnerIcon: <path d="M12 3a9 9 0 1 0 9 9" />,
  trash: (
    <>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6.5 7l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-12" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      {label ? <span>{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
  flush = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={`card ${className}`}>
      {title || actions ? (
        <div className="card-head">
          <div>
            {title ? <h2>{title}</h2> : null}
            {subtitle ? <p className="card-subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className={flush ? 'card-body flush' : 'card-body'}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  icon,
  tone = 'neutral',
  to,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: IconName;
  tone?: Tone;
  to?: string;
}) {
  const body = (
    <>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {icon ? (
          <span className={`stat-icon tone-${tone}`}>
            <Icon name={icon} size={17} />
          </span>
        ) : null}
      </div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </>
  );
  if (to) {
    return (
      <Link to={to} className="stat stat-link">
        {body}
      </Link>
    );
  }
  return <div className="stat">{body}</div>;
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ key: string; label: string; count?: number }>;
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          className={`tab ${active === tab.key ? 'active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.count !== undefined ? <span className="tab-count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className = '',
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">
        {label}
        {required ? <span className="required"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  render?: (row: T, index: number) => ReactNode;
  className?: string;
  width?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyTitle = 'Nothing here yet',
  emptyMessage,
  loading = false,
  compact = false,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey?: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyMessage?: string;
  loading?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={`table-wrap ${compact ? 'compact' : ''}`}>
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} style={column.width ? { width: column.width } : undefined} className={column.className}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={columns.length} className="table-state">
                <Spinner label="Loading records…" />
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="table-state">
                <EmptyState title={emptyTitle} message={emptyMessage} />
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr
                key={rowKey ? rowKey(row, index) : String((row as { id?: string }).id ?? index)}
                className={onRowClick ? 'clickable' : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((column) => (
                  <td key={column.key} className={column.className}>
                    {column.render
                      ? column.render(row, index)
                      : String((row as Record<string, unknown>)[column.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyState({
  title,
  message,
  icon = 'inventory',
  action,
}: {
  title: string;
  message?: string;
  icon?: IconName;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <strong>{title}</strong>
      {message ? <p>{message}</p> : null}
      {action}
    </div>
  );
}

export function Dialog({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide = false,
  extraWide = false,
}: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  extraWide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`dialog ${extraWide ? 'dialog-xl' : wide ? 'dialog-lg' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Dialog'}
      >
        <div className="dialog-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close dialog">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

function formatValidationDetails(details: unknown): string[] | null {
  if (!Array.isArray(details)) return null;
  const lines = details
    .map((item) => {
      if (item && typeof item === 'object') {
        const record = item as { path?: unknown; message?: unknown };
        if (record.message) return `${record.path ? `${String(record.path)}: ` : ''}${String(record.message)}`;
      }
      return null;
    })
    .filter((line): line is string => Boolean(line));
  return lines.length ? lines : null;
}

export function ErrorNote({ error }: { error: ApiError | Error | string | null | undefined }) {
  if (!error) return null;
  if (typeof error === 'string') {
    return (
      <div className="alert alert-danger" role="alert">
        <Icon name="alert" size={17} />
        <div>
          <strong>{error}</strong>
        </div>
      </div>
    );
  }
  const apiError = error instanceof ApiError ? error : null;
  const validation = apiError ? formatValidationDetails(apiError.details) : null;
  return (
    <div className="alert alert-danger" role="alert">
      <Icon name="alert" size={17} />
      <div className="alert-body">
        <strong>{error.message}</strong>
        {apiError ? <code className="error-code">{apiError.code}</code> : null}
        {validation ? (
          <ul className="error-list">
            {validation.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : apiError && apiError.details ? (
          <details className="error-details">
            <summary>Error details</summary>
            <JsonView value={apiError.details} />
          </details>
        ) : null}
      </div>
    </div>
  );
}

export function JsonView({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  return <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>;
}

export function MetaList({ items }: { items: Array<{ label: ReactNode; value: ReactNode }> }) {
  return (
    <dl className="meta-list">
      {items.map((item, index) => (
        <div className="meta-row" key={typeof item.label === 'string' ? item.label : index}>
          <dt>{item.label}</dt>
          <dd>{item.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-subtle btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

export function InlineLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-link">
      {children}
      <Icon name="chevron" size={13} />
    </Link>
  );
}

export function ExternalNote({ text }: { text: string }) {
  return (
    <div className="alert alert-info">
      <Icon name="info" size={17} />
      <div>{text}</div>
    </div>
  );
}

export function ProgressSteps({ steps, current }: { steps: string[]; current: string }) {
  const index = steps.indexOf(current);
  return (
    <div className="progress-steps">
      {steps.map((step, position) => {
        const state = index < 0 ? 'idle' : position < index ? 'done' : position === index ? 'active' : 'idle';
        return (
          <div className={`progress-step ${state}`} key={step}>
            <span className="progress-dot">{position < index ? <Icon name="check" size={11} /> : position + 1}</span>
            <span>{titleCase(step)}</span>
          </div>
        );
      })}
    </div>
  );
}
