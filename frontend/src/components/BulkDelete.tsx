import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAction } from '../hooks';
import { useToast } from '../toast';
import { Dialog, ErrorNote, Field, Icon, StatusPill } from '../ui';

export interface BulkDeleteResponse {
  deleted: string[];
  skipped: Array<{ id: string; reason: string }>;
}

export function useBulkSelection() {
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  const selectMany = (ids: string[]) => setSelected([...new Set(ids)]);
  const clear = () => setSelected([]);
  return { selected, toggle, selectMany, clear };
}

export function BulkBar({
  count,
  onClear,
  onDelete,
  noun = 'record',
}: {
  count: number;
  onClear: () => void;
  onDelete: () => void;
  noun?: string;
}) {
  if (count === 0) return null;
  return (
    <div className="toolbar bulk-bar">
      <strong>
        {count} {count === 1 ? noun : `${noun}s`} selected
      </strong>
      <span className="bulk-bar-thin">Records with stock, movements or import history are skipped and reported.</span>
      <span className="toolbar-spacer" />
      <button type="button" className="btn btn-subtle btn-sm" onClick={onClear}>
        Clear selection
      </button>
      <button type="button" className="btn btn-danger btn-sm" onClick={onDelete}>
        <Icon name="trash" size={15} /> Delete selected
      </button>
    </div>
  );
}

export function BulkDeleteDialog({
  open,
  entityLabel,
  endpoint,
  ids,
  onClose,
  onCompleted,
}: {
  open: boolean;
  entityLabel: string;
  endpoint: string;
  ids: string[];
  onClose: () => void;
  onCompleted: (result: BulkDeleteResponse) => void;
}) {
  const action = useAction();
  const toast = useToast();
  const [reason, setReason] = useState('Bulk delete from register');
  const [result, setResult] = useState<BulkDeleteResponse | null>(null);

  useEffect(() => {
    if (open) {
      setResult(null);
      setReason('Bulk delete from register');
      action.setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    const response = await action.run(() => api.post<BulkDeleteResponse>(endpoint, { ids, reason }));
    if (!response) return;
    setResult(response);
    if (response.deleted.length > 0) {
      toast.notify(
        `${response.deleted.length} ${entityLabel.toLowerCase()}${response.deleted.length === 1 ? '' : 's'} deleted`,
        response.skipped.length > 0 ? 'warning' : 'success',
      );
      onCompleted(response);
    } else {
      toast.notify(`Nothing deleted — ${response.skipped.length} skipped`, 'warning');
    }
  };

  return (
    <Dialog
      open={open}
      title={result ? 'Bulk delete result' : `Delete ${ids.length} ${entityLabel.toLowerCase()}${ids.length === 1 ? '' : 's'}`}
      subtitle={
        result
          ? 'The table has been refreshed. Review any skipped records below.'
          : 'This permanently removes master records that have no stock, movements or provenance links.'
      }
      onClose={onClose}
      footer={
        result ? (
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-subtle" onClick={onClose} disabled={action.running}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={submit}
              disabled={action.running || reason.trim().length < 3}
            >
              <Icon name="trash" size={15} /> {action.running ? 'Deleting…' : `Delete ${ids.length}`}
            </button>
          </>
        )
      }
    >
      {result ? (
        <div className="stack">
          <div className="bulk-result-row">
            <StatusPill value={`${result.deleted.length} deleted`} tone="success" dot={false} />
            <StatusPill
              value={`${result.skipped.length} skipped`}
              tone={result.skipped.length ? 'warning' : 'neutral'}
              dot={false}
            />
          </div>
          {result.skipped.length > 0 ? (
            <ul className="bulk-skip-list">
              {result.skipped.map((entry) => (
                <li key={entry.id}>
                  <code className="code">{entry.id.slice(0, 8)}</code> — {entry.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="stack">
          <p className="muted-note">
            Only records with no stock balances, no inventory movements and no provenance or order links can be deleted.
            Anything still in use is skipped with a reason, so history is never rewritten.
          </p>
          <Field label="Reason (audited)">
            <input
              className="input"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why are these records being removed?"
            />
          </Field>
          <ErrorNote error={action.error} />
        </div>
      )}
    </Dialog>
  );
}
