-- Picker & Putaway field operations: employee-scoped assignments, confirmed
-- operation history, and per-user permission overrides. Stock itself still moves
-- only through inventory_transactions via the authoritative postMovement engine.

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  effect TEXT NOT NULL CHECK (effect IN ('GRANT','DENY')),
  granted_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, permission_code)
);
CREATE INDEX IF NOT EXISTS ix_user_permissions_user ON user_permissions(user_id);

CREATE TABLE IF NOT EXISTS field_jobs (
  id TEXT PRIMARY KEY,
  job_no TEXT NOT NULL UNIQUE,
  job_type TEXT NOT NULL CHECK (job_type IN ('PUTAWAY','PICK')),
  status TEXT NOT NULL DEFAULT 'ASSIGNED' CHECK (status IN ('ASSIGNED','IN_PROGRESS','COMPLETED','CANCELLED')),
  employee_id TEXT NOT NULL REFERENCES users(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  box_id TEXT NOT NULL REFERENCES boxes(id),
  product_id TEXT REFERENCES products(id),
  source_location_id TEXT REFERENCES locations(id),
  destination_location_id TEXT NOT NULL REFERENCES locations(id),
  pick_mode TEXT NOT NULL DEFAULT 'BOX' CHECK (pick_mode IN ('BOX','UNITS')),
  pick_quantity INTEGER CHECK (pick_quantity IS NULL OR pick_quantity > 0),
  notes TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_field_jobs_employee ON field_jobs(employee_id, status, created_at);
CREATE INDEX IF NOT EXISTS ix_field_jobs_type ON field_jobs(job_type, status);
CREATE INDEX IF NOT EXISTS ix_field_jobs_box ON field_jobs(box_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_field_jobs_open_box
  ON field_jobs(box_id) WHERE status IN ('ASSIGNED','IN_PROGRESS');

CREATE TABLE IF NOT EXISTS field_operations (
  id TEXT PRIMARY KEY,
  operation_no TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE REFERENCES field_jobs(id),
  job_no TEXT NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('PUTAWAY','PICK')),
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED')),
  employee_id TEXT NOT NULL REFERENCES users(id),
  employee_code TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  box_id TEXT NOT NULL REFERENCES boxes(id),
  box_code TEXT NOT NULL,
  brand TEXT,
  product_id TEXT REFERENCES products(id),
  sku TEXT,
  source_location_id TEXT REFERENCES locations(id),
  source_location_code TEXT,
  destination_location_id TEXT REFERENCES locations(id),
  destination_location_code TEXT,
  pick_mode TEXT NOT NULL DEFAULT 'BOX' CHECK (pick_mode IN ('BOX','UNITS')),
  box_count_before INTEGER NOT NULL DEFAULT 0,
  box_count_after INTEGER NOT NULL DEFAULT 0,
  quantity_before INTEGER NOT NULL DEFAULT 0,
  quantity_moved INTEGER NOT NULL DEFAULT 0,
  quantity_after INTEGER NOT NULL DEFAULT 0,
  reference_no TEXT NOT NULL,
  txn_count INTEGER NOT NULL DEFAULT 0,
  txns_json TEXT,
  confirmed_by TEXT NOT NULL REFERENCES users(id),
  correlation_id TEXT,
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_field_operations_type ON field_operations(operation_type, confirmed_at);
CREATE INDEX IF NOT EXISTS ix_field_operations_employee ON field_operations(employee_id, confirmed_at);
CREATE INDEX IF NOT EXISTS ix_field_operations_box ON field_operations(box_code);
CREATE INDEX IF NOT EXISTS ix_field_operations_brand ON field_operations(brand);

CREATE TRIGGER IF NOT EXISTS trg_field_operations_no_update
BEFORE UPDATE ON field_operations
BEGIN
  SELECT RAISE(ABORT, 'field operations are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_field_operations_no_delete
BEFORE DELETE ON field_operations
BEGIN
  SELECT RAISE(ABORT, 'field operations are immutable');
END;
