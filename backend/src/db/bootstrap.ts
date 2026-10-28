import type { DB } from './index.ts';
import { withTransaction } from './index.ts';
import { newId } from '../lib/ids.ts';
import { hashPassword, generatePassword } from '../lib/password.ts';
import { PERMISSIONS, ROLES } from '../lib/permissions.ts';
import { nowIso } from '../lib/time.ts';

export interface BootstrapOptions {
  password?: string;
  createUsers?: boolean;
}

export interface BootstrapResult {
  warehouseId: string;
  locations: Record<string, string>;
  pools: Record<string, string>;
  createdUsers: Array<{ email: string; role: string; password: string }>;
}

const LOCATIONS = [
  { code: 'STAGING-01', type: 'STAGING', zone: 'INBOUND' },
  { code: 'QC-01', type: 'QC', zone: 'QUALITY' },
  { code: 'QUAR-01', type: 'QUARANTINE', zone: 'QUALITY' },
  { code: 'PACK-01', type: 'PACK', zone: 'OUTBOUND' },
  { code: 'TRANSIT-01', type: 'TRANSIT', zone: 'OUTBOUND' },
  { code: 'RETURNS-01', type: 'RETURN', zone: 'RETURNS' },
  { code: 'DISPATCH-01', type: 'DISPATCH', zone: 'OUTBOUND' },
  { code: 'RACK-A01', type: 'RACK', zone: 'A', aisle: 'A', rack: '01', capacity_pieces: 50000 },
  { code: 'RACK-A02', type: 'RACK', zone: 'A', aisle: 'A', rack: '02', capacity_pieces: 50000 },
  { code: 'RACK-B01', type: 'RACK', zone: 'B', aisle: 'B', rack: '01', capacity_pieces: 50000 },
] as const;

const SETTINGS: Array<{ key: string; value: unknown; description: string }> = [
  { key: 'block_expired_picks', value: true, description: 'Block picking stock whose batch has expired' },
  { key: 'expiry_warning_days', value: 60, description: 'Days before expiry to raise a warning' },
  { key: 'adjustment_approval_threshold', value: 50, description: 'Unit quantity above which an adjustment needs approval' },
  { key: 'picking_require_scan', value: true, description: 'Require box/location scans for picking' },
  { key: 'putaway_require_location_scan', value: true, description: 'Validate putaway destination locations' },
  { key: 'reservation_expiry_hours', value: 72, description: 'Default reservation lifetime' },
  { key: 'transfer_requires_approval', value: true, description: 'Transfers must be approved before dispatch' },
  { key: 'cycle_count_approval_required', value: true, description: 'Count differences require approval before posting' },
  { key: 'low_stock_default', value: 20, description: 'Default low stock threshold when product has none' },
  { key: 'timezone', value: 'Asia/Kolkata', description: 'Display timezone for operators' },
  { key: 'company_name', value: 'Aaradhya Homeopathic Pvt. Ltd.', description: 'Company trading name' },
  { key: 'qc_required_default', value: true, description: 'Default QC requirement for new products' },
];

const USERS = [
  { code: 'EMP-0001', name: 'Aaradhya Administrator', email: 'admin@aaradhya.local', role: 'ADMIN' },
  { code: 'EMP-0002', name: 'Warehouse Manager', email: 'manager@aaradhya.local', role: 'MANAGER' },
  { code: 'EMP-0003', name: 'Warehouse Picker', email: 'picker@aaradhya.local', role: 'PICKER' },
  { code: 'EMP-0004', name: 'QC Inspector', email: 'qc@aaradhya.local', role: 'QC_OPERATOR' },
  { code: 'EMP-0005', name: 'Operations Auditor', email: 'auditor@aaradhya.local', role: 'AUDITOR' },
  { code: 'EMP-0006', name: 'Read-only Viewer', email: 'viewer@aaradhya.local', role: 'VIEWER' },
] as const;

export function bootstrapSystem(db: DB, options: BootstrapOptions = {}): BootstrapResult {
  return withTransaction(db, () => {
    const now = nowIso();

    for (const [code, definition] of Object.entries(ROLES)) {
      db.prepare('INSERT INTO roles (code, name, is_system) VALUES (?, ?, 1) ON CONFLICT DO NOTHING').run(code, definition.name);
    }
    for (const permission of PERMISSIONS) {
      db.prepare('INSERT INTO permissions (code, description, category) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(
        permission.code,
        permission.description,
        permission.category,
      );
    }
    for (const [roleCode, definition] of Object.entries(ROLES)) {
      const codes = definition.permissions === '*' ? PERMISSIONS.map((p) => p.code) : definition.permissions;
      for (const permission of codes) {
        db.prepare('INSERT INTO role_permissions (role_code, permission_code) VALUES (?, ?) ON CONFLICT DO NOTHING').run(
          roleCode,
          permission,
        );
      }
    }

    let warehouseId = (
      db.prepare("SELECT id FROM warehouses WHERE code = 'WH1'").get() as { id: string } | undefined
    )?.id;
    if (!warehouseId) {
      warehouseId = newId();
      db.prepare(
        'INSERT INTO warehouses (id, code, name, address, timezone, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      ).run(warehouseId, 'WH1', 'Aaradhya Main Warehouse', null, 'Asia/Kolkata', now);
    }

    const locations: Record<string, string> = {};
    for (const location of LOCATIONS) {
      let row = db.prepare('SELECT id FROM locations WHERE code = ?').get(location.code) as { id: string } | undefined;
      if (!row) {
        const id = newId();
        db.prepare(
          `INSERT INTO locations (id, warehouse_id, code, zone, aisle, rack, shelf, bin, type, status, capacity_pieces, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'ACTIVE', ?, ?)`,
        ).run(
          id,
          warehouseId,
          location.code,
          location.zone ?? null,
          'aisle' in location ? location.aisle : null,
          'rack' in location ? location.rack : null,
          location.type,
          'capacity_pieces' in location ? location.capacity_pieces : null,
          now,
        );
        row = { id };
      }
      locations[location.code] = row.id;
    }

    const pools: Record<string, string> = {};
    for (const pool of [
      { code: 'B2B', name: 'B2B Wholesale Pool' },
      { code: 'SHARED', name: 'Shared / Unallocated Pool' },
    ]) {
      let row = db.prepare('SELECT id FROM stock_pools WHERE code = ?').get(pool.code) as { id: string } | undefined;
      if (!row) {
        const id = newId();
        db.prepare('INSERT INTO stock_pools (id, code, name, is_active) VALUES (?, ?, ?, 1)').run(
          id,
          pool.code,
          pool.name,
        );
        row = { id };
      }
      pools[pool.code] = row.id;
    }

    for (const setting of SETTINGS) {
      db.prepare('INSERT INTO settings (key, value_json, description) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(
        setting.key,
        JSON.stringify(setting.value),
        setting.description,
      );
    }

    for (const material of [
      { code: 'CARTON-S', name: 'Small carton', uom: 'PIECE' },
      { code: 'CARTON-M', name: 'Medium carton', uom: 'PIECE' },
      { code: 'POLY-BAG', name: 'Poly bag', uom: 'PIECE' },
      { code: 'TAPE', name: 'Packing tape', uom: 'ROLL' },
      { code: 'BUBBLE-WRAP', name: 'Bubble wrap', uom: 'ROLL' },
    ]) {
      db.prepare(
        'INSERT INTO packaging_materials (id, code, name, uom, quantity_on_hand, min_level, is_active) VALUES (?, ?, ?, ?, 0, 0, 1) ON CONFLICT DO NOTHING',
      ).run(newId(), material.code, material.name, material.uom);
    }

    const createdUsers: BootstrapResult['createdUsers'] = [];
    if (options.createUsers !== false) {
      for (const user of USERS) {
        const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(user.email);
        if (existing) continue;
        const password = options.password || generatePassword();
        db.prepare(
          `INSERT INTO users (id, employee_code, name, email, password_hash, role_code, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(newId(), user.code, user.name, user.email, hashPassword(password), user.role, now, now);
        createdUsers.push({ email: user.email, role: user.role, password });
      }
    }

    return { warehouseId, locations, pools, createdUsers };
  });
}
