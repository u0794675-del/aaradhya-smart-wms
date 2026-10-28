-- AARADHYA SMART WMS :: core schema
-- All timestamps are stored as ISO-8601 UTC strings.

CREATE TABLE IF NOT EXISTS roles (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1))
);

CREATE TABLE IF NOT EXISTS permissions (
  code TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  category TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_code TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  employee_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role_code TEXT NOT NULL REFERENCES roles(code),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  code TEXT NOT NULL UNIQUE,
  zone TEXT,
  aisle TEXT,
  rack TEXT,
  shelf TEXT,
  bin TEXT,
  type TEXT NOT NULL CHECK (type IN ('RACK','STAGING','QC','PACK','TRANSIT','QUARANTINE','RETURN','DISPATCH')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','INACTIVE')),
  capacity_pieces INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_pools (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (code IN ('B2B','SHARED')),
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  parent_id TEXT REFERENCES products(id),
  name TEXT NOT NULL,
  brand TEXT,
  category TEXT,
  subcategory TEXT,
  product_type TEXT,
  description TEXT,
  base_uom TEXT NOT NULL CHECK (base_uom IN ('PIECE','STRIP','PACK','CARTON','BOX','CASE')),
  case_config_json TEXT,
  is_batch_tracked INTEGER NOT NULL DEFAULT 0 CHECK (is_batch_tracked IN (0, 1)),
  is_expiry_tracked INTEGER NOT NULL DEFAULT 0 CHECK (is_expiry_tracked IN (0, 1)),
  qc_required INTEGER NOT NULL DEFAULT 1 CHECK (qc_required IN (0, 1)),
  cost_price REAL,
  low_stock_threshold INTEGER,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_products_parent ON products(parent_id);
CREATE INDEX IF NOT EXISTS ix_products_status ON products(status);

CREATE TABLE IF NOT EXISTS product_barcodes (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  barcode TEXT NOT NULL UNIQUE,
  barcode_type TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (barcode_type IN ('EAN','CODE128','QR','INTERNAL')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_barcodes_product ON product_barcodes(product_id);

CREATE TABLE IF NOT EXISTS product_uom_conversions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  from_uom TEXT NOT NULL CHECK (from_uom IN ('PIECE','STRIP','PACK','CARTON','BOX','CASE')),
  to_uom TEXT NOT NULL CHECK (to_uom IN ('PIECE','STRIP','PACK','CARTON','BOX','CASE')),
  factor INTEGER NOT NULL CHECK (factor > 0),
  UNIQUE (product_id, from_uom, to_uom)
);

CREATE TABLE IF NOT EXISTS product_aliases (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  alias_sku TEXT NOT NULL UNIQUE,
  source TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_suppliers (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  vendor_id TEXT NOT NULL,
  vendor_sku TEXT,
  agreed_rate REAL,
  created_at TEXT NOT NULL,
  UNIQUE (product_id, vendor_id)
);

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  vendor_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  gstin TEXT,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  payment_terms TEXT,
  lead_time_days INTEGER,
  min_order_qty INTEGER,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','BLOCKED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  batch_no TEXT NOT NULL,
  mfg_date TEXT,
  expiry_date TEXT,
  vendor_id TEXT REFERENCES vendors(id),
  created_at TEXT NOT NULL,
  UNIQUE (product_id, batch_no)
);
CREATE INDEX IF NOT EXISTS ix_batches_expiry ON batches(expiry_date);

CREATE TABLE IF NOT EXISTS boxes (
  id TEXT PRIMARY KEY,
  box_code TEXT NOT NULL UNIQUE,
  box_type TEXT NOT NULL CHECK (box_type IN ('SINGLE','MIXED')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EMPTY','STAGING','DAMAGED','RETIRED')),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  location_id TEXT REFERENCES locations(id),
  pool_id TEXT REFERENCES stock_pools(id),
  parent_box_id TEXT REFERENCES boxes(id),
  reuse_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS ix_boxes_location ON boxes(location_id);
CREATE INDEX IF NOT EXISTS ix_boxes_status ON boxes(status);

-- Canonical inventory aggregate. Every quantity is in the product's base UOM.
-- reserved_quantity is stock promised to an order but still physically on hand.
CREATE TABLE IF NOT EXISTS inventory_balances (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  pool_id TEXT NOT NULL REFERENCES stock_pools(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  batch_id TEXT REFERENCES batches(id),
  box_id TEXT REFERENCES boxes(id),
  status TEXT NOT NULL CHECK (status IN ('AVAILABLE','RESERVED','PICKED','IN_TRANSIT','QC_PENDING','QUARANTINED','DAMAGED','REJECTED','EXPIRED','RETURN_PENDING','REWORK')),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reserved_quantity INTEGER NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0 AND reserved_quantity <= quantity),
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_balances_dimensions
  ON inventory_balances(
    warehouse_id, location_id, pool_id, product_id,
    COALESCE(batch_id, ''), COALESCE(box_id, ''), status
  );
CREATE INDEX IF NOT EXISTS ix_balances_product ON inventory_balances(product_id);
CREATE INDEX IF NOT EXISTS ix_balances_box ON inventory_balances(box_id);
CREATE INDEX IF NOT EXISTS ix_balances_location ON inventory_balances(location_id);
CREATE INDEX IF NOT EXISTS ix_balances_batch ON inventory_balances(batch_id);

-- Append-only inventory ledger. One row per posted movement.
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id TEXT PRIMARY KEY,
  txn_no TEXT NOT NULL UNIQUE,
  movement_type TEXT NOT NULL CHECK (movement_type IN (
    'RECEIPT','QC_ACCEPT','QC_REJECT','QC_QUARANTINE','PUTAWAY','BOX_TRANSFER','PICK','PICK_REVERSAL',
    'PACK','DISPATCH','TRANSFER_DISPATCH','TRANSFER_RECEIVE','TRANSFER_RETURN',
    'RESERVATION_RELEASE','RETURN_RECEIVE','RETURN_RESTOCK','RETURN_DISPOSE',
    'ADJUSTMENT_IN','ADJUSTMENT_OUT','DAMAGE','REWORK','QUARANTINE_RELEASE','MIGRATION'
  )),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  from_warehouse_id TEXT,
  from_location_id TEXT,
  from_pool_id TEXT,
  from_status TEXT,
  from_box_id TEXT,
  from_batch_id TEXT,
  to_warehouse_id TEXT,
  to_location_id TEXT,
  to_pool_id TEXT,
  to_status TEXT,
  to_box_id TEXT,
  to_batch_id TEXT,
  reference_type TEXT,
  reference_id TEXT,
  reference_no TEXT,
  reason TEXT,
  user_id TEXT NOT NULL,
  role_code TEXT NOT NULL,
  correlation_id TEXT,
  idempotency_key TEXT,
  reversal_of TEXT UNIQUE REFERENCES inventory_transactions(id),
  created_at TEXT NOT NULL,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_txn_product_date ON inventory_transactions(product_id, created_at);
CREATE INDEX IF NOT EXISTS ix_txn_reference ON inventory_transactions(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS ix_txn_box ON inventory_transactions(from_box_id, to_box_id);
CREATE INDEX IF NOT EXISTS ix_txn_created ON inventory_transactions(created_at);

CREATE TRIGGER IF NOT EXISTS trg_txn_no_update
BEFORE UPDATE ON inventory_transactions
BEGIN SELECT RAISE(ABORT, 'inventory_transactions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_txn_no_delete
BEFORE DELETE ON inventory_transactions
BEGIN SELECT RAISE(ABORT, 'inventory_transactions are immutable'); END;

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  reservation_no TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL,
  order_line_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  pool_id TEXT NOT NULL REFERENCES stock_pools(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  box_id TEXT REFERENCES boxes(id),
  batch_id TEXT REFERENCES batches(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity >= 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','PARTIALLY_CONSUMED','CONSUMED','RELEASED')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_reservations_line ON reservations(order_line_id, status);
CREATE INDEX IF NOT EXISTS ix_reservations_status ON reservations(status);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL CHECK (channel IN ('MANUAL','MARKETPLACE','B2B')),
  pool_code TEXT NOT NULL REFERENCES stock_pools(code),
  customer_name TEXT NOT NULL,
  customer_ref TEXT,
  external_order_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','CONFIRMED','ALLOCATED','PICKING','PICKED','PACKED','DISPATCHED','COMPLETED','CANCELLED','ON_HOLD')),
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  sla_due_at TEXT,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_external ON orders(external_order_id) WHERE external_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_lines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  box_id TEXT REFERENCES boxes(id),
  ordered_qty INTEGER NOT NULL CHECK (ordered_qty > 0),
  allocated_qty INTEGER NOT NULL DEFAULT 0 CHECK (allocated_qty >= 0),
  picked_qty INTEGER NOT NULL DEFAULT 0 CHECK (picked_qty >= 0),
  packed_qty INTEGER NOT NULL DEFAULT 0 CHECK (packed_qty >= 0),
  dispatched_qty INTEGER NOT NULL DEFAULT 0 CHECK (dispatched_qty >= 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ALLOCATED','PARTIALLY_PICKED','PICKED','PACKED','DISPATCHED','SHORT','CANCELLED')),
  UNIQUE (order_id, line_no)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  task_no TEXT NOT NULL UNIQUE,
  task_type TEXT NOT NULL CHECK (task_type IN ('PUTAWAY','PICKING','QC','PACKING','RETURN_INSPECTION','CYCLE_COUNT','TRANSFER','MAINTENANCE')),
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ASSIGNED','ACCEPTED','IN_PROGRESS','PARTIALLY_COMPLETED','COMPLETED','BLOCKED','ON_HOLD','CANCELLED','FAILED_VERIFICATION')),
  assigned_to TEXT REFERENCES users(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  entity_type TEXT,
  entity_id TEXT,
  description TEXT,
  due_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  blocked_reason TEXT
);
CREATE INDEX IF NOT EXISTS ix_tasks_status ON tasks(status, due_at);
CREATE INDEX IF NOT EXISTS ix_tasks_assignee ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS ix_tasks_entity ON tasks(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  po_no TEXT NOT NULL UNIQUE,
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  expected_date TEXT,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id TEXT PRIMARY KEY,
  po_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  ordered_qty INTEGER NOT NULL CHECK (ordered_qty > 0),
  received_qty INTEGER NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  unit_cost REAL,
  UNIQUE (po_id, line_no)
);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  receipt_no TEXT NOT NULL UNIQUE,
  po_id TEXT REFERENCES purchase_orders(id),
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  pool_id TEXT NOT NULL REFERENCES stock_pools(id),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','PENDING_QC','PARTIALLY_INSPECTED','COMPLETED','CANCELLED')),
  staging_location_id TEXT NOT NULL REFERENCES locations(id),
  received_by TEXT NOT NULL,
  received_at TEXT,
  vendor_invoice_ref TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipt_lines (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  po_line_id TEXT REFERENCES purchase_order_lines(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  batch_id TEXT REFERENCES batches(id),
  expected_qty INTEGER NOT NULL CHECK (expected_qty >= 0),
  received_qty INTEGER NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  accepted_qty INTEGER NOT NULL DEFAULT 0 CHECK (accepted_qty >= 0),
  rejected_qty INTEGER NOT NULL DEFAULT 0 CHECK (rejected_qty >= 0),
  quarantined_qty INTEGER NOT NULL DEFAULT 0 CHECK (quarantined_qty >= 0),
  putaway_qty INTEGER NOT NULL DEFAULT 0 CHECK (putaway_qty >= 0),
  qc_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (qc_status IN ('PENDING','PARTIALLY_ACCEPTED','ACCEPTED','REJECTED','QUARANTINED','REINSPECTION_REQUIRED')),
  UNIQUE (receipt_id, product_id, batch_id)
);

CREATE TABLE IF NOT EXISTS qc_inspections (
  id TEXT PRIMARY KEY,
  inspection_no TEXT NOT NULL UNIQUE,
  receipt_id TEXT NOT NULL REFERENCES receipts(id),
  receipt_line_id TEXT NOT NULL REFERENCES receipt_lines(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  inspected_qty INTEGER NOT NULL CHECK (inspected_qty > 0),
  accepted_qty INTEGER NOT NULL DEFAULT 0 CHECK (accepted_qty >= 0),
  rejected_qty INTEGER NOT NULL DEFAULT 0 CHECK (rejected_qty >= 0),
  quarantined_qty INTEGER NOT NULL DEFAULT 0 CHECK (quarantined_qty >= 0),
  result TEXT NOT NULL CHECK (result IN ('ACCEPTED','PARTIALLY_ACCEPTED','REJECTED','QUARANTINED','REINSPECTION_REQUIRED')),
  template_json TEXT,
  inspected_by TEXT NOT NULL,
  inspected_at TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  shipment_no TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES orders(id),
  carrier TEXT,
  tracking_no TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','DISPATCHED','DELIVERED','RTO')),
  package_count INTEGER NOT NULL DEFAULT 0,
  dispatched_by TEXT,
  dispatched_at TEXT,
  proof_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  package_no TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES orders(id),
  shipment_id TEXT REFERENCES shipments(id),
  status TEXT NOT NULL CHECK (status IN ('OPEN','PACKED','VERIFIED','DISPATCHED')),
  packed_by TEXT,
  packed_at TEXT,
  weight_grams INTEGER,
  dimensions TEXT,
  verified_by TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS package_lines (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  order_line_id TEXT NOT NULL REFERENCES order_lines(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  batch_id TEXT REFERENCES batches(id),
  box_id TEXT REFERENCES boxes(id)
);

CREATE TABLE IF NOT EXISTS packaging_materials (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  uom TEXT NOT NULL,
  quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  min_level INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS packaging_consumptions (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id),
  material_id TEXT NOT NULL REFERENCES packaging_materials(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  transfer_no TEXT NOT NULL UNIQUE,
  transfer_type TEXT NOT NULL CHECK (transfer_type IN ('POOL_TO_POOL','LOCATION_TO_LOCATION')),
  from_warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  to_warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  from_pool_id TEXT NOT NULL REFERENCES stock_pools(id),
  to_pool_id TEXT NOT NULL REFERENCES stock_pools(id),
  transit_location_id TEXT NOT NULL REFERENCES locations(id),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','DISPATCHED','IN_TRANSIT','PARTIALLY_RECEIVED','RECEIVED','COMPLETED','CANCELLED')),
  reason TEXT,
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  dispatched_at TEXT,
  received_at TEXT
);

CREATE TABLE IF NOT EXISTS transfer_lines (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  batch_id TEXT REFERENCES batches(id),
  box_id TEXT REFERENCES boxes(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  dispatched_qty INTEGER NOT NULL DEFAULT 0 CHECK (dispatched_qty >= 0),
  received_qty INTEGER NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  destination_location_id TEXT REFERENCES locations(id),
  UNIQUE (transfer_id, line_no)
);

CREATE TABLE IF NOT EXISTS returns (
  id TEXT PRIMARY KEY,
  return_no TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES orders(id),
  shipment_id TEXT REFERENCES shipments(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RECEIVED','INSPECTED','COMPLETED','CANCELLED')),
  received_by TEXT NOT NULL,
  received_at TEXT NOT NULL,
  inspected_by TEXT,
  inspected_at TEXT,
  disposition TEXT CHECK (disposition IN ('RESTOCK','DAMAGE','REJECT','REWORK','DISPOSE','PARTIAL','PENDING')),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS return_lines (
  id TEXT PRIMARY KEY,
  return_id TEXT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  order_line_id TEXT REFERENCES order_lines(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  batch_id TEXT REFERENCES batches(id),
  box_id TEXT REFERENCES boxes(id),
  expected_qty INTEGER NOT NULL DEFAULT 0 CHECK (expected_qty >= 0),
  received_qty INTEGER NOT NULL CHECK (received_qty > 0),
  inspected_qty INTEGER NOT NULL DEFAULT 0 CHECK (inspected_qty >= 0),
  restock_qty INTEGER NOT NULL DEFAULT 0 CHECK (restock_qty >= 0),
  damaged_qty INTEGER NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0),
  rejected_qty INTEGER NOT NULL DEFAULT 0 CHECK (rejected_qty >= 0),
  rework_qty INTEGER NOT NULL DEFAULT 0 CHECK (rework_qty >= 0),
  disposed_qty INTEGER NOT NULL DEFAULT 0 CHECK (disposed_qty >= 0)
);

CREATE TABLE IF NOT EXISTS cycle_counts (
  id TEXT PRIMARY KEY,
  count_no TEXT NOT NULL UNIQUE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  location_id TEXT REFERENCES locations(id),
  box_id TEXT REFERENCES boxes(id),
  count_type TEXT NOT NULL CHECK (count_type IN ('AD_HOC','SCHEDULED','BLIND','LOCATION','SKU','BOX','BATCH','FULL')),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','IN_PROGRESS','PENDING_APPROVAL','POSTED','CANCELLED','REJECTED')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  approved_by TEXT,
  approved_at TEXT,
  posted_at TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS cycle_count_lines (
  id TEXT PRIMARY KEY,
  count_id TEXT NOT NULL REFERENCES cycle_counts(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  batch_id TEXT REFERENCES batches(id),
  box_id TEXT REFERENCES boxes(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  system_qty INTEGER NOT NULL CHECK (system_qty >= 0),
  counted_qty INTEGER CHECK (counted_qty >= 0),
  difference INTEGER,
  reason TEXT,
  investigation_status TEXT NOT NULL DEFAULT 'NONE' CHECK (investigation_status IN ('NONE','OPEN','INVESTIGATING','RESOLVED')),
  adjustment_txn_id TEXT REFERENCES inventory_transactions(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_count_lines_dimensions
  ON cycle_count_lines(count_id, product_id, COALESCE(batch_id, ''), COALESCE(box_id, ''), location_id);

CREATE TABLE IF NOT EXISTS exceptions (
  id TEXT PRIMARY KEY,
  exception_no TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','INVESTIGATING','RESOLVED','CLOSED')),
  owner_user_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  description TEXT NOT NULL,
  resolution TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_exceptions_status ON exceptions(status, severity);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  actor_user_id TEXT,
  actor_role TEXT,
  correlation_id TEXT,
  transaction_id TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS','FAILURE')),
  refs_json TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_events(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_actor ON audit_events(actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_type ON audit_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_correlation ON audit_events(correlation_id);

CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events are immutable'); END;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  response_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (user_id, idem_key)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  description TEXT,
  updated_by TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  rule_code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  assigned_role TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  created_at TEXT NOT NULL,
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  resolved_at TEXT,
  dedupe_key TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_notifications_open_dedupe
  ON notifications(dedupe_key) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  import_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('UPLOADED','VALIDATED','IMPORTED','FAILED')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  valid_rows INTEGER NOT NULL DEFAULT 0,
  invalid_rows INTEGER NOT NULL DEFAULT 0,
  error_report_json TEXT,
  source_hash TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS ai_action_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  question TEXT NOT NULL,
  intent TEXT,
  sql_or_filter TEXT,
  answer TEXT,
  result_count INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS','FAILURE')),
  created_at TEXT NOT NULL
);

DROP VIEW IF EXISTS box_contents;
CREATE VIEW box_contents AS
SELECT
  ib.box_id,
  b.box_code,
  b.box_type,
  ib.product_id,
  p.sku,
  p.name AS product_name,
  ib.batch_id,
  bt.batch_no,
  bt.expiry_date,
  ib.status,
  ib.location_id,
  l.code AS location_code,
  SUM(ib.quantity) AS quantity,
  SUM(ib.reserved_quantity) AS reserved_quantity
FROM inventory_balances ib
JOIN boxes b ON b.id = ib.box_id
JOIN products p ON p.id = ib.product_id
JOIN locations l ON l.id = ib.location_id
LEFT JOIN batches bt ON bt.id = ib.batch_id
WHERE ib.box_id IS NOT NULL
GROUP BY ib.box_id, b.box_code, b.box_type, ib.product_id, p.sku, p.name,
         ib.batch_id, bt.batch_no, bt.expiry_date, ib.status, ib.location_id, l.code;
