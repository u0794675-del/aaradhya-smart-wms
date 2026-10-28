ALTER TABLE orders ADD COLUMN warehouse_id TEXT REFERENCES warehouses(id);
CREATE INDEX IF NOT EXISTS ix_orders_warehouse ON orders(warehouse_id, status);
