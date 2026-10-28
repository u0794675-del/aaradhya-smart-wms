import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { queryString, titleCase } from '../api';
import { useApi } from '../hooks';
import { Card, EmptyState, ErrorNote, Icon, PageHeader, Spinner, StatusPill } from '../ui';
import { entityLink } from '../links';

interface SearchItem {
  id: string;
  number?: string;
  label?: string;
  status?: string;
  sku?: string;
  name?: string;
  base_uom?: string;
  expiry_date?: string;
  received_at?: string;
}

interface SearchGroup {
  type: string;
  items: SearchItem[];
}

interface SearchResult {
  query: string;
  groups: SearchGroup[];
}

const GROUP_LINKS: Record<string, string> = {
  PRODUCTS: 'PRODUCT',
  ORDERS: 'ORDER',
  BOXES: 'BOX',
  BATCHES: 'BATCH',
  RECEIPTS: 'RECEIPT',
  TRANSFERS: 'TRANSFER',
  RETURNS: 'RETURN',
  TASKS: 'TASK',
};

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);

  useEffect(() => {
    setDraft(q);
  }, [q]);

  const state = useApi<SearchResult>(q.trim() ? `/search${queryString({ q: q.trim() })}` : null);
  const groups = state.data?.groups ?? [];
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);

  const submit = (value: string) => {
    const next = new URLSearchParams(params);
    if (value.trim()) next.set('q', value.trim());
    else next.delete('q');
    setParams(next, { replace: true });
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Control"
        title="Global search"
        subtitle="Search products, orders, boxes, batches, receipts, transfers, returns and tasks from one index. Results link directly into their workspace."
      />

      <Card>
        <form
          className="search-hero"
          onSubmit={(event) => {
            event.preventDefault();
            submit(draft);
          }}
        >
          <Icon name="search" size={20} />
          <input
            className="input"
            autoFocus
            value={draft}
            maxLength={100}
            placeholder="SKU, product, order no, box code, batch no, receipt, transfer, return or task"
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>
            Search
          </button>
          {q ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setDraft('');
                submit('');
              }}
            >
              Clear
            </button>
          ) : null}
        </form>
        <p className="muted tiny">Exact identifiers match directly; names and SKUs match on partial text. Minimum two characters for meaningful results.</p>
      </Card>

      <ErrorNote error={state.error} />
      {state.loading ? <Spinner label="Searching records…" /> : null}

      {!q ? (
        <Card>
          <EmptyState
            icon="search"
            title="Start with an identifier"
            message="Try an order number such as ORD-…, a box code, a batch number, a SKU like AHP00001, or a customer name."
          />
        </Card>
      ) : state.data && groups.length === 0 && !state.loading ? (
        <Card>
          <EmptyState
            icon="search"
            title={`No records matched “${q}”`}
            message="Check the identifier, or search by a shorter fragment. Stock movements and audit events are searchable from the audit trail."
          />
        </Card>
      ) : null}

      {groups.length ? (
        <div className="search-groups">
          <p className="muted small">
            {total} result{total === 1 ? '' : 's'} across {groups.length} categor{groups.length === 1 ? 'y' : 'ies'}
          </p>
          {groups.map((group) => (
            <Card
              key={group.type}
              title={titleCase(group.type)}
              subtitle={`${group.items.length} match${group.items.length === 1 ? '' : 'es'}`}
              flush
            >
              <div className="search-result-list">
                {group.items.map((item) => {
                  const link = entityLink(GROUP_LINKS[group.type] ?? group.type, item.id);
                  const primary =
                    item.number ??
                    item.sku ??
                    item.label ??
                    item.name ??
                    item.id;
                  const secondary =
                    group.type === 'PRODUCTS'
                      ? item.name
                      : item.expiry_date
                        ? `Expires ${item.expiry_date}`
                        : item.received_at
                          ? `Received ${item.received_at.slice(0, 10)}`
                          : item.label ?? item.sku ?? item.base_uom ?? null;
                  const body = (
                    <>
                      <div className="search-result-main">
                        <strong>{primary}</strong>
                        {secondary && secondary !== primary ? <span className="muted small">{secondary}</span> : null}
                      </div>
                      <div className="search-result-meta">
                        {item.status ? <StatusPill value={item.status} /> : null}
                        {link ? <Icon name="chevron" size={15} /> : null}
                      </div>
                    </>
                  );
                  return link ? (
                    <Link className="search-result" key={item.id} to={link}>
                      {body}
                    </Link>
                  ) : (
                    <div className="search-result" key={item.id}>
                      {body}
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}
