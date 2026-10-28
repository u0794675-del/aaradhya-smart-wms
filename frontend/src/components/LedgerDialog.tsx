import { useState } from 'react';
import { api, formatDateTime, idempotencyKey, queryString, titleCase } from '../api';
import { useApi } from '../hooks';
import { useToast } from '../toast';
import { Dialog, ErrorNote, Field, Icon, Spinner, StatusPill } from '../ui';

interface LedgerRow {
  id: string;
  txn_no: string;
  movement_type: string;
  quantity: number;
  sku: string;
  product_name: string;
  user_name: string | null;
  role_code: string;
  from_location: string | null;
  to_location: string | null;
  from_box: string | null;
  to_box: string | null;
  batch_no: string | null;
  from_status: string | null;
  to_status: string | null;
  reference_type: string | null;
  reference_no: string | null;
  reason: string | null;
  created_at: string;
  reversal_of: string | null;
  correlation_id: string | null;
}

interface LedgerResponse {
  rows: LedgerRow[];
  total: number;
}

const REVERSIBLE = new Set(['PICK', 'DISPATCH', 'TRANSFER_DISPATCH', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'RECEIPT', 'QC_ACCEPT', 'PUTAWAY']);

function routeOf(row: LedgerRow) {
  const side = (location: string | null, box: string | null, status: string | null) => {
    if (!location) return null;
    const parts = [location];
    if (box) parts.push(box);
    if (status && status !== 'AVAILABLE') parts.push(titleCase(status));
    return parts.join(' · ');
  };
  const from = side(row.from_location, row.from_box, row.from_status);
  const to = side(row.to_location, row.to_box, row.to_status);
  if (!from) return to ? `→ ${to}` : 'External';
  if (!to) return `${from} → out`;
  return `${from} → ${to}`;
}

export function LedgerDialog({
  open,
  onClose,
  title = 'Inventory ledger',
  subtitle,
  productId,
  boxId,
  referenceId,
  canReverse = false,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  productId?: string;
  boxId?: string;
  referenceId?: string;
  canReverse?: boolean;
  onChanged?: () => void;
}) {
  const query = open
    ? queryString({ productId, boxId, referenceId, limit: 300 })
    : '';
  const ledger = useApi<LedgerResponse>(open ? `/inventory/ledger${query}` : null);
  const toast = useToast();
  const [reversing, setReversing] = useState<LedgerRow | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const rows = ledger.data?.rows ?? [];

  async function submitReversal() {
    if (!reversing) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/inventory/transactions/${reversing.id}/reverse`,
        { reason: reason.trim() },
        idempotencyKey(),
      );
      toast.notify(`Reversal posted for ${reversing.txn_no}`, 'success');
      setReversing(null);
      setReason('');
      ledger.reload();
      onChanged?.();
    } catch (reasonError) {
      setError(reasonError instanceof Error ? reasonError : new Error('Reversal failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle ? `${subtitle} · ${rows.length} of ${ledger.data?.total ?? 0} movements loaded` : `${rows.length} of ${ledger.data?.total ?? 0} movements loaded`}
      extraWide
      footer={
        <>
          <span className="muted small">Append-only ledger · posted transactions cannot be edited</span>
          <button type="button" className="btn btn-subtle" onClick={onClose}>Close</button>
        </>
      }
    >
      <ErrorNote error={ledger.error ?? error} />

      {reversing ? (
        <div className="inline-form-panel">
          <div className="inline-form-head">
            <div>
              <strong>Reverse {reversing.txn_no}</strong>
              <span className="muted small">
                {titleCase(reversing.movement_type)} · {reversing.quantity} × {reversing.sku}
              </span>
            </div>
            <button type="button" className="icon-btn" onClick={() => setReversing(null)} aria-label="Cancel reversal">
              <Icon name="close" size={16} />
            </button>
          </div>
          <p className="muted small">
            A linked reversal movement will be posted. The original transaction stays immutable and both entries remain on the ledger.
          </p>
          <div className="inline-form-row">
            <Field label="Reason" required>
              <input
                className="input"
                value={reason}
                minLength={5}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why is this movement being reversed?"
                autoFocus
              />
            </Field>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || reason.trim().length < 5}
              onClick={() => void submitReversal()}
            >
              {busy ? 'Posting…' : 'Post reversal'}
            </button>
          </div>
        </div>
      ) : null}

      {ledger.loading && !ledger.data ? (
        <div className="center-pad"><Spinner label="Loading ledger…" /></div>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <strong>No movements recorded</strong>
          <p>Stock movements for this record will appear here once posted.</p>
        </div>
      ) : (
        <div className="table-wrap compact ledger-table">
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Transaction</th>
                <th>Movement</th>
                <th className="num">Qty</th>
                <th>Route</th>
                <th>Batch / box</th>
                <th>Reference</th>
                <th>User</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="nowrap">
                    <div>{formatDateTime(row.created_at)}</div>
                    <div className="muted tiny">{row.correlation_id ? row.correlation_id.slice(0, 8) : '—'}</div>
                  </td>
                  <td>
                    <code className="code">{row.txn_no}</code>
                    {row.reversal_of ? <div className="tiny muted">reversal</div> : null}
                  </td>
                  <td><StatusPill value={row.movement_type} dot={false} /></td>
                  <td className="num">{row.quantity}</td>
                  <td>
                    <div className="route-cell">{routeOf(row)}</div>
                    <div className="muted tiny">{row.sku}</div>
                  </td>
                  <td>
                    <div>{row.batch_no ?? '—'}</div>
                    <div className="muted tiny">{row.from_box ?? row.to_box ?? '—'}</div>
                  </td>
                  <td>
                    <div>{row.reference_no ?? row.reference_type ?? '—'}</div>
                    <div className="muted tiny clamp-1">{row.reason ?? ''}</div>
                  </td>
                  <td>
                    <div>{row.user_name ?? 'System'}</div>
                    <div className="muted tiny">{titleCase(row.role_code)}</div>
                  </td>
                  <td>
                    {canReverse && !row.reversal_of && !rows.some((entry) => entry.reversal_of === row.id) && REVERSIBLE.has(row.movement_type) ? (
                      <button
                        type="button"
                        className="btn btn-subtle btn-xs"
                        onClick={() => {
                          setReversing(row);
                          setReason('');
                          setError(null);
                        }}
                      >
                        Reverse
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}
