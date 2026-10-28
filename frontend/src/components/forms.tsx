import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '../auth';
import { useApi, useDebouncedValue, useAction } from '../hooks';
import { Dialog, ErrorNote, Field, Spinner } from '../ui';

export interface ProductOption {
  id: string;
  sku: string;
  name: string;
  base_uom: string;
  is_batch_tracked: number;
  is_expiry_tracked: number;
  status: string;
}

interface ProductList {
  rows: ProductOption[];
  total: number;
}

export function useProductOptions(search = '', status = 'ACTIVE') {
  const debounced = useDebouncedValue(search, 250);
  const params = new URLSearchParams({ limit: '200' });
  if (status) params.set('status', status);
  if (debounced.trim()) params.set('search', debounced.trim());
  const path = `/products?${params.toString()}`;
  const state = useApi<ProductList>(path);
  return { ...state, products: state.data?.rows ?? [] };
}

export function ProductSelect({
  value,
  onChange,
  products,
  placeholder = 'Select a product',
  disabled = false,
  includeInactive = false,
  required = false,
}: {
  value: string;
  onChange: (value: string) => void;
  products?: ProductOption[];
  placeholder?: string;
  disabled?: boolean;
  includeInactive?: boolean;
  required?: boolean;
}) {
  const fallback = useProductOptions('', includeInactive ? '' : 'ACTIVE');
  const list = products ?? fallback.products;
  return (
    <select
      className="input"
      value={value}
      disabled={disabled}
      required={required}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{placeholder}</option>
      {list.map((product) => (
        <option key={product.id} value={product.id}>
          {product.sku} · {product.name}
          {product.is_batch_tracked === 1 ? ' · batch' : ''}
        </option>
      ))}
    </select>
  );
}

export function LocationSelect({
  value,
  onChange,
  types,
  placeholder = 'Select a location',
  disabled = false,
  required = false,
  activeOnly = true,
  includeEmpty = false,
}: {
  value: string;
  onChange: (value: string) => void;
  types?: string[];
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  activeOnly?: boolean;
  includeEmpty?: boolean;
}) {
  const { meta } = useAuth();
  const locations = useMemo(() => {
    const list = meta?.locations ?? [];
    return list.filter(
      (location) =>
        (!types || types.includes(location.type)) &&
        (!activeOnly || location.status === 'ACTIVE' || location.status === 'EMPTY'),
    );
  }, [meta, types, activeOnly]);
  return (
    <select
      className="input"
      value={value}
      disabled={disabled}
      required={required}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{placeholder}</option>
      {includeEmpty ? <option value="">None</option> : null}
      {locations.map((location) => (
        <option key={location.id} value={location.id}>
          {location.code} · {location.type}
          {location.zone ? ` · ${location.zone}` : ''}
        </option>
      ))}
    </select>
  );
}

export function PoolSelect({
  value,
  onChange,
  placeholder = 'Select a stock pool',
  disabled = false,
  required = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
}) {
  const { meta } = useAuth();
  return (
    <select
      className="input"
      value={value}
      disabled={disabled}
      required={required}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{placeholder}</option>
      {(meta?.pools ?? []).map((pool) => (
        <option key={pool.id} value={pool.id}>
          {pool.code} · {pool.name}
        </option>
      ))}
    </select>
  );
}

export interface BatchOption {
  id: string;
  batch_no: string;
  expiry_date: string | null;
}

export function BatchSelect({
  productId,
  value,
  onChange,
  required = false,
  disabled = false,
  placeholder = 'Select a batch',
}: {
  productId: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const state = useApi<{ batches: BatchOption[] }>(productId ? `/products/${productId}` : null);
  const batches = state.data?.batches ?? [];
  if (state.loading) return <div className="compact-loader"><Spinner label="Loading batches…" /></div>;
  return (
    <select
      className="input"
      value={value}
      disabled={disabled || !productId}
      required={required}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{placeholder}</option>
      {batches.map((batch) => (
        <option key={batch.id} value={batch.id}>
          {batch.batch_no}
          {batch.expiry_date ? ` · exp ${batch.expiry_date}` : ' · no expiry'}
        </option>
      ))}
    </select>
  );
}

export function ReasonDialog({
  open,
  title,
  label = 'Reason',
  hint,
  placeholder = 'Explain why this action is being taken',
  confirmLabel = 'Confirm',
  danger = false,
  minLength = 3,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  label?: string;
  hint?: ReactNode;
  placeholder?: string;
  confirmLabel?: string;
  danger?: boolean;
  minLength?: number;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<unknown> | unknown;
}) {
  const [reason, setReason] = useState('');
  const action = useAction();

  useEffect(() => {
    if (open) {
      setReason('');
      action.setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < minLength) return;
    const result = await action.run(() => Promise.resolve(onConfirm(trimmed)));
    if (result !== undefined) onClose();
  };

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <div className="form-actions">
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => void submit()}
            disabled={action.running || reason.trim().length < minLength}
          >
            {action.running ? 'Working…' : confirmLabel}
          </button>
        </div>
      }
    >
      <div className="stack">
        <ErrorNote error={action.error} />
        <Field label={label} hint={hint} required>
          <textarea
            className="input textarea"
            rows={4}
            value={reason}
            placeholder={placeholder}
            onChange={(event) => setReason(event.target.value)}
            autoFocus
          />
        </Field>
        <p className="muted small">This action is recorded in the immutable audit trail with your user, role and timestamp.</p>
      </div>
    </Dialog>
  );
}
