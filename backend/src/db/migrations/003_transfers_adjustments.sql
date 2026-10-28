ALTER TABLE transfers ADD COLUMN from_location_id TEXT REFERENCES locations(id);

CREATE TABLE IF NOT EXISTS adjustment_requests (
  id TEXT PRIMARY KEY,
  adjustment_no TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL REFERENCES products(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  pool_id TEXT NOT NULL REFERENCES stock_pools(id),
  batch_id TEXT REFERENCES batches(id),
  box_id TEXT REFERENCES boxes(id),
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING_APPROVAL','POSTED','REJECTED','CANCELLED')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  decision_reason TEXT,
  transaction_id TEXT REFERENCES inventory_transactions(id)
);
CREATE INDEX IF NOT EXISTS ix_adjustments_status ON adjustment_requests(status, requested_at);

ALTER TABLE cycle_count_lines ADD COLUMN pool_id TEXT REFERENCES stock_pools(id);
DROP INDEX IF EXISTS ux_count_lines_dimensions;
CREATE UNIQUE INDEX ux_count_lines_dimensions
  ON cycle_count_lines(count_id, product_id, COALESCE(batch_id, ''), COALESCE(box_id, ''), location_id, COALESCE(pool_id, ''));
