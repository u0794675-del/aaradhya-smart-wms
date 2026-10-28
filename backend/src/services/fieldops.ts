import type { DB } from '../db/index.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { documentNo, newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import type { AuthUser } from './auth.ts';
import { userPermissions } from './auth.ts';
import { recordAudit } from './audit.ts';
import { boxContents, moveBox, postMovement } from './inventory.ts';

export type FieldJobType = 'PUTAWAY' | 'PICK';
export type FieldJobStatus = 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

interface FieldJobRow {
  id: string;
  job_no: string;
  job_type: FieldJobType;
  status: FieldJobStatus;
  employee_id: string;
  warehouse_id: string;
  box_id: string;
  product_id: string | null;
  source_location_id: string | null;
  destination_location_id: string;
  pick_mode: 'BOX' | 'UNITS';
  pick_quantity: number | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  assigned_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

interface BalanceLine {
  id: string;
  warehouse_id: string;
  location_id: string;
  pool_id: string;
  product_id: string;
  batch_id: string | null;
  box_id: string | null;
  status: string;
  quantity: number;
  reserved_quantity: number;
  sku: string;
  brand: string | null;
  product_name: string;
}

export interface FieldJobFilters {
  jobType?: FieldJobType;
  status?: string;
  employeeId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

const SEE_ALL_PERMISSIONS = ['task.assign', 'user.manage', 'audit.read'];

function canSeeAll(actor: AuthUser): boolean {
  return SEE_ALL_PERMISSIONS.some((permission) => actor.permissions.includes(permission));
}

function allowedJobTypes(actor: AuthUser): FieldJobType[] {
  if (canSeeAll(actor)) return ['PICK', 'PUTAWAY'];
  const types: FieldJobType[] = [];
  if (actor.permissions.includes('picking.execute')) types.push('PICK');
  if (actor.permissions.includes('putaway.execute')) types.push('PUTAWAY');
  return types;
}

function jobPermission(jobType: FieldJobType): string {
  return jobType === 'PICK' ? 'picking.execute' : 'putaway.execute';
}

function loadJob(db: DB, idOrNo: string): FieldJobRow {
  const job = db.prepare('SELECT * FROM field_jobs WHERE id = ? OR job_no = ?').get(idOrNo, idOrNo.toUpperCase()) as
    | FieldJobRow
    | undefined;
  if (!job) throw notFound('Picker/Putaway job not found');
  return job;
}

function assertJobAccess(job: FieldJobRow, actor: AuthUser): void {
  if (canSeeAll(actor)) return;
  if (!actor.permissions.includes(jobPermission(job.job_type))) {
    throw forbidden(`The ${jobPermission(job.job_type)} permission is required for this ${job.job_type.toLowerCase()} job`);
  }
  if (job.employee_id !== actor.id) {
    throw forbidden('This job is assigned to another employee');
  }
}

function loadLocation(db: DB, selector: string) {
  const location = db.prepare('SELECT * FROM locations WHERE id = ? OR code = ?').get(selector, selector.toUpperCase()) as
    | Record<string, any>
    | undefined;
  if (!location) throw notFound(`No location matches scan '${selector}'`);
  return location;
}

function loadBox(db: DB, selector: string) {
  const box = db.prepare('SELECT * FROM boxes WHERE id = ? OR box_code = ?').get(selector, selector.toUpperCase()) as
    | Record<string, any>
    | undefined;
  if (!box) throw notFound(`No box matches scan '${selector}'`);
  return box;
}

function packingLocation(db: DB, warehouseId: string) {
  const location = db
    .prepare("SELECT * FROM locations WHERE warehouse_id = ? AND type = 'PACK' AND status = 'ACTIVE' ORDER BY code LIMIT 1")
    .get(warehouseId) as Record<string, any> | undefined;
  if (!location) throw conflict('PACK_LOCATION_MISSING', 'No active PACK location is configured for this warehouse');
  return location;
}

function availableBoxLines(db: DB, boxId: string, locationId?: string): BalanceLine[] {
  const conditions = ["ib.box_id = ?", "ib.status = 'AVAILABLE'", 'ib.quantity > 0'];
  const params: unknown[] = [boxId];
  if (locationId) {
    conditions.push('ib.location_id = ?');
    params.push(locationId);
  }
  return db
    .prepare(
      `SELECT ib.*, p.sku, p.name AS product_name, p.brand
         FROM inventory_balances ib
         JOIN products p ON p.id = ib.product_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.sku, ib.batch_id`,
    )
    .all(...params) as unknown as BalanceLine[];
}

function uniqueProducts(lines: BalanceLine[]) {
  const map = new Map<string, { productId: string; sku: string; name: string; brand: string | null }>();
  for (const line of lines) {
    if (!map.has(line.product_id)) {
      map.set(line.product_id, {
        productId: line.product_id,
        sku: line.sku,
        name: line.product_name,
        brand: line.brand ?? null,
      });
    }
  }
  return Array.from(map.values());
}

function brandSnapshot(db: DB, boxId: string, lines: BalanceLine[]): string | null {
  const brands = new Set(lines.map((line) => line.brand).filter((brand): brand is string => Boolean(brand)));
  if (brands.size === 1) return Array.from(brands)[0] ?? null;
  if (brands.size > 1) return 'Mixed brands';
  const source = db.prepare('SELECT source_brand FROM box_sources WHERE box_id = ?').get(boxId) as
    | { source_brand: string | null }
    | undefined;
  return source?.source_brand ?? null;
}

function locationMetrics(
  db: DB,
  locationId: string,
  productIds: string[],
): { boxes: number; quantity: number } {
  const ids = Array.from(new Set(productIds));
  if (!ids.length) return { boxes: 0, quantity: 0 };
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT box_id) AS boxes,
              COALESCE(SUM(quantity - reserved_quantity), 0) AS quantity
         FROM inventory_balances
        WHERE location_id = ? AND status = 'AVAILABLE' AND box_id IS NOT NULL AND quantity > 0
          AND product_id IN (${ids.map(() => '?').join(',')})`,
    )
    .get(locationId, ...ids) as { boxes: number; quantity: number };
  return { boxes: Number(row.boxes), quantity: Number(row.quantity) };
}

function employeeAvailability(db: DB, employeeId: string, jobType: FieldJobType) {
  const employee = db
    .prepare('SELECT id, employee_code, name, role_code, is_active FROM users WHERE id = ?')
    .get(employeeId) as { id: string; employee_code: string; name: string; role_code: string; is_active: number } | undefined;
  if (!employee) throw notFound('Employee not found');
  if (employee.is_active !== 1) throw conflict('EMPLOYEE_INACTIVE', 'The employee account is inactive');
  const required = jobType === 'PICK' ? 'picking.execute' : 'putaway.execute';
  if (!userPermissions(db, employee.role_code, employee.id).includes(required)) {
    throw conflict('EMPLOYEE_NOT_PERMITTED', `This employee does not have the ${required} permission`, {
      employeeId,
      required,
    });
  }
  return employee;
}

export function listFieldEmployees(db: DB, filters: { search?: string } = {}) {
  const conditions = ["u.is_active = 1", "u.role_code IN ('FIELD_OPERATOR','PICKER')"];
  const params: unknown[] = [];
  if (filters.search) {
    conditions.push('(u.name LIKE ? OR u.employee_code LIKE ? OR u.email LIKE ?)');
    const term = `%${filters.search.trim()}%`;
    params.push(term, term, term);
  }
  return db
    .prepare(
      `SELECT u.id, u.employee_code, u.name, u.email, u.role_code, u.is_active,
              (SELECT COUNT(*) FROM field_jobs j
                WHERE j.employee_id = u.id AND j.status IN ('ASSIGNED','IN_PROGRESS')) AS open_jobs,
              (SELECT COUNT(*) FROM field_operations o WHERE o.employee_id = u.id) AS completed_operations
         FROM users u
        WHERE ${conditions.join(' AND ')}
        ORDER BY u.employee_code`,
    )
    .all(...params);
}

export function createFieldJob(
  db: DB,
  input: {
    jobType: FieldJobType;
    boxId: string;
    employeeId: string;
    destinationLocationId?: string;
    productId?: string | null;
    pickMode?: 'BOX' | 'UNITS';
    pickQuantity?: number | null;
    notes?: string | null;
  },
  actor: AuthUser,
): FieldJobRow {
  if (!actor.permissions.includes('task.assign')) {
    throw forbidden('Only an administrator or manager can assign picker/putaway jobs');
  }
  const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(input.boxId) as Record<string, any> | undefined;
  if (!box) throw notFound('Box not found');
  if (['RETIRED', 'DAMAGED'].includes(String(box.status))) {
    throw conflict('BOX_NOT_USABLE', `Box ${box.box_code} is ${box.status}`);
  }
  if (!box.location_id || !box.pool_id) throw conflict('BOX_NOT_POSITIONED', 'Box must have a location and pool');
  if (!box.warehouse_id) throw conflict('BOX_WAREHOUSE_MISSING', 'Box has no warehouse');

  const employee = employeeAvailability(db, input.employeeId, input.jobType);
  const openJob = db
    .prepare("SELECT job_no FROM field_jobs WHERE box_id = ? AND status IN ('ASSIGNED','IN_PROGRESS')")
    .get(box.id) as { job_no: string } | undefined;
  if (openJob) {
    throw conflict('BOX_JOB_OPEN', `Box ${box.box_code} already has an open job ${openJob.job_no}`);
  }

  const lines = availableBoxLines(db, String(box.id));
  if (!lines.length) throw conflict('BOX_EMPTY', 'The box has no available stock to move');
  const products = uniqueProducts(lines);

  let destination: Record<string, any>;
  let pickMode: 'BOX' | 'UNITS' = 'BOX';
  let pickQuantity: number | null = null;
  let productId: string | null = null;

  if (input.jobType === 'PUTAWAY') {
    if (!input.destinationLocationId) throw badRequest('DESTINATION_REQUIRED', 'A putaway destination is required');
    destination = loadLocation(db, input.destinationLocationId);
    if (destination.type !== 'RACK') throw badRequest('INVALID_PUTAWAY_LOCATION', 'Putaway destinations must be RACK locations');
    if (destination.status !== 'ACTIVE') throw conflict('LOCATION_BLOCKED', `Destination ${destination.code} is not active`);
    if (destination.warehouse_id !== box.warehouse_id) {
      throw conflict('WAREHOUSE_MISMATCH', 'Destination is in another warehouse');
    }
    if (destination.id === box.location_id) {
      throw badRequest('NO_OP_MOVEMENT', 'Box is already at the selected destination');
    }
  } else {
    destination = packingLocation(db, String(box.warehouse_id));
    pickMode = input.pickMode ?? 'BOX';
    if (pickMode === 'BOX' && lines.some((line) => Number(line.reserved_quantity) > 0)) {
      throw conflict(
        'BOX_HAS_RESERVATIONS',
        'This box contains reserved stock; release the reservation or pick it through the order workflow',
      );
    }
    if (pickMode === 'UNITS') {
      if (!input.productId) throw badRequest('PICK_PRODUCT_REQUIRED', 'Partial-unit picking requires a product');
      if (!Number.isInteger(input.pickQuantity) || Number(input.pickQuantity) <= 0) {
        throw badRequest('INVALID_QUANTITY', 'Pick quantity must be a positive whole number');
      }
      pickQuantity = Number(input.pickQuantity);
      const productLines = lines.filter((line) => line.product_id === input.productId);
      if (!productLines.length) {
        throw conflict('PRODUCT_NOT_IN_BOX', 'The selected product is not present in this box');
      }
      const available = productLines.reduce(
        (sum, line) => sum + Number(line.quantity) - Number(line.reserved_quantity),
        0,
      );
      if (available < pickQuantity) {
        throw conflict('INSUFFICIENT_BOX_STOCK', `Only ${available} unreserved units are available in the box`, {
          available,
          requested: pickQuantity,
        });
      }
      productId = input.productId;
    } else if (input.productId) {
      if (!products.some((product) => product.productId === input.productId)) {
        throw conflict('PRODUCT_NOT_IN_BOX', 'The selected product is not present in this box');
      }
      productId = input.productId;
    } else {
      productId = products.length === 1 ? products[0]?.productId ?? null : null;
    }
  }

  const id = newId();
  const now = nowIso();
  const jobNo = documentNo(db, 'FIELD_JOB', 'JOB', 6);
  db.prepare(
    `INSERT INTO field_jobs
      (id, job_no, job_type, status, employee_id, warehouse_id, box_id, product_id,
       source_location_id, destination_location_id, pick_mode, pick_quantity, notes,
       created_by, created_at, assigned_at)
     VALUES (?, ?, ?, 'ASSIGNED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    jobNo,
    input.jobType,
    employee.id,
    box.warehouse_id,
    box.id,
    productId,
    box.location_id,
    destination.id,
    pickMode,
    pickQuantity,
    input.notes ?? null,
    actor.id,
    now,
    now,
  );
  recordAudit(db, {
    eventType: 'FIELD_JOB_CREATED',
    entityType: 'FIELD_JOB',
    entityId: id,
    after: {
      jobNo,
      jobType: input.jobType,
      employeeId: employee.id,
      employeeCode: employee.employee_code,
      boxId: box.id,
      boxCode: box.box_code,
      sourceLocationId: box.location_id,
      destinationLocationId: destination.id,
      pickMode,
      pickQuantity,
    },
    actor: { userId: actor.id, role: actor.role },
  });
  return loadJob(db, id);
}

export function listFieldJobs(db: DB, actor: AuthUser, filters: FieldJobFilters) {
  const conditions = ['1=1'];
  const params: unknown[] = [];
  if (!canSeeAll(actor)) {
    conditions.push('j.employee_id = ?');
    params.push(actor.id);
    const types = allowedJobTypes(actor);
    if (filters.jobType) {
      if (!types.includes(filters.jobType)) {
        throw forbidden(`The ${jobPermission(filters.jobType)} permission is required to view these jobs`);
      }
    } else if (types.length < 2) {
      if (!types.length) throw forbidden('No picker or putaway permission is assigned to this account');
      conditions.push(`j.job_type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
  } else if (filters.employeeId) {
    conditions.push('j.employee_id = ?');
    params.push(filters.employeeId);
  }
  if (filters.jobType) {
    conditions.push('j.job_type = ?');
    params.push(filters.jobType);
  }
  if (filters.status) {
    const statuses = filters.status
      .split(',')
      .map((status) => status.trim())
      .filter(Boolean);
    if (statuses.length) {
      conditions.push(`j.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
  }
  if (filters.search) {
    const term = `%${filters.search.trim()}%`;
    conditions.push('(j.job_no LIKE ? OR b.box_code LIKE ? OR u.name LIKE ? OR u.employee_code LIKE ?)');
    params.push(term, term, term, term);
  }
  const limit = Math.min(filters.limit ?? 100, 300);
  const offset = filters.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT j.*, u.name AS employee_name, u.employee_code,
              b.box_code, b.status AS box_status,
              sl.code AS source_location_code, dl.code AS destination_location_code,
              p.sku, p.name AS product_name, p.brand,
              (SELECT COUNT(*) FROM inventory_balances ib
                WHERE ib.box_id = j.box_id AND ib.status = 'AVAILABLE' AND ib.quantity > 0) AS box_line_count,
              (SELECT COALESCE(SUM(ib.quantity - ib.reserved_quantity), 0) FROM inventory_balances ib
                WHERE ib.box_id = j.box_id AND ib.status = 'AVAILABLE' AND ib.quantity > 0) AS box_available_quantity
         FROM field_jobs j
         JOIN users u ON u.id = j.employee_id
         JOIN boxes b ON b.id = j.box_id
         LEFT JOIN locations sl ON sl.id = j.source_location_id
         JOIN locations dl ON dl.id = j.destination_location_id
         LEFT JOIN products p ON p.id = j.product_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY CASE j.status
                   WHEN 'IN_PROGRESS' THEN 0 WHEN 'ASSIGNED' THEN 1
                   WHEN 'COMPLETED' THEN 2 ELSE 3 END,
                 j.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<Record<string, any>>;
  const total = db
    .prepare(
      `SELECT COUNT(*) AS n FROM field_jobs j
         JOIN users u ON u.id = j.employee_id
         JOIN boxes b ON b.id = j.box_id
        WHERE ${conditions.join(' AND ')}`,
    )
    .get(...params) as { n: number };
  return { rows, total: Number(total.n), limit, offset };
}

export function getFieldJob(db: DB, idOrNo: string, actor: AuthUser) {
  const job = loadJob(db, idOrNo);
  assertJobAccess(job, actor);
  const row = db
    .prepare(
      `SELECT j.*, u.name AS employee_name, u.employee_code, u.email AS employee_email,
              b.box_code, b.status AS box_status, b.box_type,
              sl.code AS source_location_code, sl.zone AS source_zone,
              dl.code AS destination_location_code, dl.zone AS destination_zone,
              p.sku, p.name AS product_name, p.brand,
              c.name AS created_by_name
         FROM field_jobs j
         JOIN users u ON u.id = j.employee_id
         JOIN boxes b ON b.id = j.box_id
         LEFT JOIN locations sl ON sl.id = j.source_location_id
         JOIN locations dl ON dl.id = j.destination_location_id
         LEFT JOIN products p ON p.id = j.product_id
         LEFT JOIN users c ON c.id = j.created_by
        WHERE j.id = ?`,
    )
    .get(job.id) as Record<string, any>;
  const operation = db.prepare('SELECT * FROM field_operations WHERE job_id = ?').get(job.id) as
    | Record<string, any>
    | undefined;
  return {
    job: row,
    contents: boxContents(db, job.box_id),
    availableContents: availableBoxLines(db, job.box_id),
    operation: operation ?? null,
  };
}

export function startFieldJob(db: DB, idOrNo: string, actor: AuthUser) {
  const job = loadJob(db, idOrNo);
  assertJobAccess(job, actor);
  if (job.status === 'COMPLETED') throw conflict('JOB_ALREADY_COMPLETED', 'This job is already completed');
  if (job.status === 'CANCELLED') throw conflict('JOB_CANCELLED', 'This job was cancelled');
  if (job.status === 'IN_PROGRESS') return getFieldJob(db, job.id, actor);
  const now = nowIso();
  db.prepare("UPDATE field_jobs SET status = 'IN_PROGRESS', started_at = ? WHERE id = ? AND status = 'ASSIGNED'").run(
    now,
    job.id,
  );
  recordAudit(db, {
    eventType: 'FIELD_JOB_STARTED',
    entityType: 'FIELD_JOB',
    entityId: job.id,
    before: { status: job.status },
    after: { status: 'IN_PROGRESS', jobNo: job.job_no },
    actor: { userId: actor.id, role: actor.role },
  });
  return getFieldJob(db, job.id, actor);
}

export function cancelFieldJob(db: DB, idOrNo: string, reason: string, actor: AuthUser) {
  if (!actor.permissions.includes('task.assign')) {
    throw forbidden('Only an administrator or manager can cancel a job');
  }
  const job = loadJob(db, idOrNo);
  if (job.status === 'COMPLETED') throw conflict('JOB_ALREADY_COMPLETED', 'Completed jobs cannot be cancelled');
  if (job.status === 'CANCELLED') return getFieldJob(db, job.id, actor);
  if (!reason.trim()) throw badRequest('REASON_REQUIRED', 'A cancellation reason is required');
  db.prepare("UPDATE field_jobs SET status = 'CANCELLED', cancelled_at = ? WHERE id = ?").run(nowIso(), job.id);
  recordAudit(db, {
    eventType: 'FIELD_JOB_CANCELLED',
    entityType: 'FIELD_JOB',
    entityId: job.id,
    before: { status: job.status },
    after: { status: 'CANCELLED', jobNo: job.job_no },
    reason: reason.trim(),
    actor: { userId: actor.id, role: actor.role },
  });
  return getFieldJob(db, job.id, actor);
}

function assertOpenJob(job: FieldJobRow): void {
  if (job.status === 'COMPLETED') throw conflict('JOB_ALREADY_COMPLETED', 'This job is already completed');
  if (job.status === 'CANCELLED') throw conflict('JOB_CANCELLED', 'This job was cancelled');
}

function writeOperation(
  db: DB,
  job: FieldJobRow,
  actor: AuthUser,
  correlationId: string | null,
  values: {
    employeeCode: string;
    employeeName: string;
    boxCode: string;
    brand: string | null;
    productId: string | null;
    sku: string | null;
    sourceLocationId: string;
    sourceLocationCode: string;
    destinationLocationId: string;
    destinationLocationCode: string;
    pickMode: 'BOX' | 'UNITS';
    boxCountBefore: number;
    boxCountAfter: number;
    quantityBefore: number;
    quantityMoved: number;
    quantityAfter: number;
    transactions: string[];
  },
): Record<string, any> {
  const id = newId();
  const now = nowIso();
  const operationNo = documentNo(db, 'FIELD_OP', 'FOP', 6);
  db.prepare(
    `INSERT INTO field_operations
      (id, operation_no, job_id, job_no, operation_type, status, employee_id, employee_code, employee_name,
       box_id, box_code, brand, product_id, sku, source_location_id, source_location_code,
       destination_location_id, destination_location_code, pick_mode, box_count_before, box_count_after,
       quantity_before, quantity_moved, quantity_after, reference_no, txn_count, txns_json,
       confirmed_by, correlation_id, confirmed_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    operationNo,
    job.id,
    job.job_no,
    job.job_type,
    job.employee_id,
    values.employeeCode,
    values.employeeName,
    job.box_id,
    values.boxCode,
    values.brand,
    values.productId,
    values.sku,
    values.sourceLocationId,
    values.sourceLocationCode,
    values.destinationLocationId,
    values.destinationLocationCode,
    values.pickMode,
    values.boxCountBefore,
    values.boxCountAfter,
    values.quantityBefore,
    values.quantityMoved,
    values.quantityAfter,
    job.job_no,
    values.transactions.length,
    JSON.stringify(values.transactions),
    actor.id,
    correlationId,
    now,
    now,
  );
  return db.prepare('SELECT * FROM field_operations WHERE id = ?').get(id) as Record<string, any>;
}

export function confirmPutaway(
  db: DB,
  idOrNo: string,
  input: { boxCode: string; destinationCode: string; notes?: string | null },
  actor: AuthUser,
  correlationId?: string | null,
) {
  const job = loadJob(db, idOrNo);
  if (job.job_type !== 'PUTAWAY') throw conflict('WRONG_JOB_TYPE', 'This is not a putaway job');
  assertJobAccess(job, actor);
  assertOpenJob(job);

  const box = loadBox(db, input.boxCode);
  if (box.id !== job.box_id) {
    throw conflict('WRONG_BOX_SCANNED', `Scanned box ${box.box_code} is not the assigned box`, {
      expectedBoxId: job.box_id,
      scannedBoxId: box.id,
    });
  }
  const destination = loadLocation(db, input.destinationCode);
  if (destination.id !== job.destination_location_id) {
    throw conflict('WRONG_LOCATION_SCANNED', `Scanned location ${destination.code} is not the assigned putaway destination`, {
      expectedLocationId: job.destination_location_id,
      scannedLocationId: destination.id,
    });
  }
  if (!job.source_location_id) throw conflict('JOB_SOURCE_MISSING', 'This job has no recorded source location');
  if (box.location_id !== job.source_location_id) {
    throw conflict('BOX_LOCATION_CHANGED', 'The box is no longer at the source location recorded when the job was assigned', {
      expectedLocationId: job.source_location_id,
      currentLocationId: box.location_id,
    });
  }
  const source = loadLocation(db, job.source_location_id);
  const lines = availableBoxLines(db, job.box_id, job.source_location_id);
  if (!lines.length) throw conflict('BOX_EMPTY', 'The box has no available stock left to put away');
  const products = uniqueProducts(lines);
  const productIds = products.map((product) => product.productId);
  const before = locationMetrics(db, source.id, productIds);

  const moved = moveBox(db, {
    boxId: job.box_id,
    toLocationId: destination.id,
    user: actor,
    correlationId: correlationId ?? null,
    reason: `Putaway job ${job.job_no}`,
    referenceType: 'FIELD_JOB',
    referenceId: job.id,
    referenceNo: job.job_no,
    metadata: { jobId: job.id, jobNo: job.job_no, jobType: 'PUTAWAY', employeeId: job.employee_id },
  });

  const after = locationMetrics(db, source.id, productIds);
  const employee = db.prepare('SELECT employee_code, name FROM users WHERE id = ?').get(job.employee_id) as {
    employee_code: string;
    name: string;
  };
  const single = products.length === 1 ? products[0] : null;
  const brand = brandSnapshot(db, job.box_id, lines);
  const operation = writeOperation(db, job, actor, correlationId ?? null, {
    employeeCode: employee.employee_code,
    employeeName: employee.name,
    boxCode: box.box_code,
    brand,
    productId: single?.productId ?? null,
    sku: single?.sku ?? null,
    sourceLocationId: source.id,
    sourceLocationCode: source.code,
    destinationLocationId: destination.id,
    destinationLocationCode: destination.code,
    pickMode: 'BOX',
    boxCountBefore: before.boxes,
    boxCountAfter: after.boxes,
    quantityBefore: before.quantity,
    quantityMoved: moved.quantity,
    quantityAfter: after.quantity,
    transactions: moved.transactions,
  });

  const now = nowIso();
  db.prepare(
    "UPDATE field_jobs SET status = 'COMPLETED', completed_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?",
  ).run(now, now, job.id);
  recordAudit(db, {
    eventType: 'FIELD_PUTAWAY_CONFIRMED',
    entityType: 'FIELD_JOB',
    entityId: job.id,
    before: { status: job.status, boxLocationId: box.location_id },
    after: {
      status: 'COMPLETED',
      jobNo: job.job_no,
      operationNo: operation.operation_no,
      boxCode: box.box_code,
      fromLocationId: source.id,
      toLocationId: destination.id,
      quantity: moved.quantity,
      transactions: moved.transactions,
    },
    reason: input.notes?.trim() || 'Confirmed putaway scan',
    actor: { userId: actor.id, role: actor.role, correlationId: correlationId ?? null },
    refs: { jobId: job.id, boxId: job.box_id, operationId: operation.id },
  });
  return { operation, job: getFieldJob(db, job.id, actor).job };
}

export function confirmPick(
  db: DB,
  idOrNo: string,
  input: { locationCode: string; boxCode: string; notes?: string | null },
  actor: AuthUser,
  correlationId?: string | null,
) {
  const job = loadJob(db, idOrNo);
  if (job.job_type !== 'PICK') throw conflict('WRONG_JOB_TYPE', 'This is not a picking job');
  assertJobAccess(job, actor);
  assertOpenJob(job);

  if (!job.source_location_id) throw conflict('JOB_SOURCE_MISSING', 'This job has no recorded source location');
  const source = loadLocation(db, input.locationCode);
  if (source.id !== job.source_location_id) {
    throw conflict('WRONG_LOCATION_SCANNED', `Scanned location ${source.code} is not this job's picking location`, {
      expectedLocationId: job.source_location_id,
      scannedLocationId: source.id,
    });
  }
  const box = loadBox(db, input.boxCode);
  if (box.id !== job.box_id) {
    throw conflict('WRONG_BOX_SCANNED', `Scanned box ${box.box_code} is not the assigned box`, {
      expectedBoxId: job.box_id,
      scannedBoxId: box.id,
    });
  }
  if (box.location_id !== source.id) {
    throw conflict('BOX_LOCATION_CHANGED', `Box ${box.box_code} is recorded at a different location`, {
      scannedLocationId: source.id,
      currentLocationId: box.location_id,
    });
  }
  const destination = loadLocation(db, job.destination_location_id);
  if (destination.type !== 'PACK') throw conflict('INVALID_PICK_DESTINATION', 'Picked stock must move to a PACK location');
  if (destination.status !== 'ACTIVE') throw conflict('LOCATION_BLOCKED', `Destination ${destination.code} is not active`);

  const lines = availableBoxLines(db, job.box_id, source.id);
  if (!lines.length) throw conflict('BOX_EMPTY', 'The box has no available stock left to pick');

  const transactions: string[] = [];
  let quantityMoved = 0;
  let productIds: string[] = [];

  if (job.pick_mode === 'UNITS') {
    if (!job.product_id) throw conflict('PICK_PRODUCT_MISSING', 'This partial pick has no product');
    const productLines = lines.filter((line) => line.product_id === job.product_id);
    if (!productLines.length) throw conflict('PRODUCT_NOT_IN_BOX', 'The product is no longer in this box');
    const available = productLines.reduce(
      (sum, line) => sum + Number(line.quantity) - Number(line.reserved_quantity),
      0,
    );
    const need = Number(job.pick_quantity);
    if (available < need) {
      throw conflict('INSUFFICIENT_BOX_STOCK', `Only ${available} unreserved units remain in the box`, {
        available,
        requested: need,
      });
    }
    let remaining = need;
    for (const line of productLines) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(line.quantity) - Number(line.reserved_quantity));
      if (take <= 0) continue;
      const movement = postMovement(db, {
        movementType: 'PICK',
        productId: line.product_id,
        quantity: take,
        from: {
          warehouseId: line.warehouse_id,
          locationId: source.id,
          poolId: line.pool_id,
          status: 'AVAILABLE',
          boxId: line.box_id,
          batchId: line.batch_id,
        },
        to: {
          warehouseId: line.warehouse_id,
          locationId: destination.id,
          poolId: line.pool_id,
          status: 'PICKED',
          boxId: null,
          batchId: line.batch_id,
        },
        referenceType: 'FIELD_JOB',
        referenceId: job.id,
        referenceNo: job.job_no,
        reason: `Picking job ${job.job_no}`,
        user: actor,
        correlationId: correlationId ?? null,
        metadata: {
          jobId: job.id,
          jobNo: job.job_no,
          jobType: 'PICK',
          mode: 'UNITS',
          boxCode: box.box_code,
          employeeId: job.employee_id,
        },
      });
      transactions.push(movement.txnId);
      quantityMoved += take;
      remaining -= take;
    }
    if (remaining > 0) {
      throw conflict('INSUFFICIENT_BOX_STOCK', 'The box did not contain the full confirmed pick quantity');
    }
    productIds = [job.product_id];
  } else {
    const reserved = lines.filter((line) => Number(line.reserved_quantity) > 0);
    if (reserved.length) {
      throw conflict('BOX_HAS_RESERVATIONS', 'This box contains reserved stock; release the reservation or pick it through the order workflow');
    }
    for (const line of lines) {
      const take = Number(line.quantity);
      const movement = postMovement(db, {
        movementType: 'PICK',
        productId: line.product_id,
        quantity: take,
        from: {
          warehouseId: line.warehouse_id,
          locationId: source.id,
          poolId: line.pool_id,
          status: 'AVAILABLE',
          boxId: line.box_id,
          batchId: line.batch_id,
        },
        to: {
          warehouseId: line.warehouse_id,
          locationId: destination.id,
          poolId: line.pool_id,
          status: 'PICKED',
          boxId: null,
          batchId: line.batch_id,
        },
        referenceType: 'FIELD_JOB',
        referenceId: job.id,
        referenceNo: job.job_no,
        reason: `Picking job ${job.job_no}`,
        user: actor,
        correlationId: correlationId ?? null,
        metadata: {
          jobId: job.id,
          jobNo: job.job_no,
          jobType: 'PICK',
          mode: 'BOX',
          boxCode: box.box_code,
          employeeId: job.employee_id,
        },
      });
      transactions.push(movement.txnId);
      quantityMoved += take;
    }
    productIds = uniqueProducts(lines).map((product) => product.productId);
    const remainingBoxStock = db
      .prepare("SELECT COALESCE(SUM(quantity), 0) AS qty FROM inventory_balances WHERE box_id = ?")
      .get(job.box_id) as { qty: number };
    if (Number(remainingBoxStock.qty) === 0) {
      db.prepare('UPDATE boxes SET location_id = ? WHERE id = ?').run(destination.id, job.box_id);
    }
  }

  const after = locationMetrics(db, source.id, productIds);
  const products = uniqueProducts(lines);
  const single = products.length === 1 ? products[0] : null;
  const employee = db.prepare('SELECT employee_code, name FROM users WHERE id = ?').get(job.employee_id) as {
    employee_code: string;
    name: string;
  };
  const operation = writeOperation(db, job, actor, correlationId ?? null, {
    employeeCode: employee.employee_code,
    employeeName: employee.name,
    boxCode: box.box_code,
    brand: brandSnapshot(db, job.box_id, lines),
    productId: job.product_id ?? single?.productId ?? null,
    sku: job.product_id
      ? products.find((product) => product.productId === job.product_id)?.sku ?? null
      : single?.sku ?? null,
    sourceLocationId: source.id,
    sourceLocationCode: source.code,
    destinationLocationId: destination.id,
    destinationLocationCode: destination.code,
    pickMode: job.pick_mode,
    boxCountBefore: after.boxes + (job.pick_mode === 'BOX' ? 1 : 0),
    boxCountAfter: after.boxes,
    quantityBefore: after.quantity + quantityMoved,
    quantityMoved,
    quantityAfter: after.quantity,
    transactions,
  });

  const now = nowIso();
  db.prepare(
    "UPDATE field_jobs SET status = 'COMPLETED', completed_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?",
  ).run(now, now, job.id);
  recordAudit(db, {
    eventType: 'FIELD_PICK_CONFIRMED',
    entityType: 'FIELD_JOB',
    entityId: job.id,
    before: { status: job.status, boxLocationId: box.location_id },
    after: {
      status: 'COMPLETED',
      jobNo: job.job_no,
      operationNo: operation.operation_no,
      boxCode: box.box_code,
      fromLocationId: source.id,
      toLocationId: destination.id,
      quantity: quantityMoved,
      transactions,
    },
    reason: input.notes?.trim() || 'Confirmed picking scan',
    actor: { userId: actor.id, role: actor.role, correlationId: correlationId ?? null },
    refs: { jobId: job.id, boxId: job.box_id, operationId: operation.id },
  });
  return { operation, job: getFieldJob(db, job.id, actor).job };
}

export interface FieldHistoryFilters {
  type?: FieldJobType;
  employeeId?: string;
  employee?: string;
  brand?: string;
  box?: string;
  location?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

function historyWhere(actor: AuthUser, filters: FieldHistoryFilters) {
  const conditions = ['1=1'];
  const params: unknown[] = [];
  if (!canSeeAll(actor)) {
    conditions.push('employee_id = ?');
    params.push(actor.id);
    const types = allowedJobTypes(actor);
    if (filters.type) {
      if (!types.includes(filters.type)) {
        throw forbidden(`The ${jobPermission(filters.type)} permission is required for this history`);
      }
    } else if (types.length < 2) {
      if (!types.length) throw forbidden('No picker or putaway permission is assigned to this account');
      conditions.push(`operation_type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
  } else if (filters.employeeId) {
    conditions.push('employee_id = ?');
    params.push(filters.employeeId);
  }
  if (filters.type) {
    conditions.push('operation_type = ?');
    params.push(filters.type);
  }
  if (filters.employee) {
    const term = `%${filters.employee.trim()}%`;
    conditions.push('(employee_name LIKE ? OR employee_code LIKE ?)');
    params.push(term, term);
  }
  if (filters.brand) {
    conditions.push('brand LIKE ?');
    params.push(`%${filters.brand.trim()}%`);
  }
  if (filters.box) {
    conditions.push('box_code LIKE ?');
    params.push(`%${filters.box.trim()}%`);
  }
  if (filters.location) {
    const term = `%${filters.location.trim()}%`;
    conditions.push('(source_location_code LIKE ? OR destination_location_code LIKE ?)');
    params.push(term, term);
  }
  if (filters.from) {
    conditions.push('confirmed_at >= ?');
    params.push(filters.from.length === 10 ? `${filters.from}T00:00:00.000Z` : filters.from);
  }
  if (filters.to) {
    conditions.push('confirmed_at <= ?');
    params.push(filters.to.length === 10 ? `${filters.to}T23:59:59.999Z` : filters.to);
  }
  return { clause: conditions.join(' AND '), params };
}

export function listFieldHistory(db: DB, actor: AuthUser, filters: FieldHistoryFilters) {
  const { clause, params } = historyWhere(actor, filters);
  const limit = Math.min(filters.limit ?? 100, 500);
  const offset = filters.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT * FROM field_operations
        WHERE ${clause}
        ORDER BY confirmed_at DESC, operation_no DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<Record<string, any>>;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM field_operations WHERE ${clause}`).get(...params) as { n: number };
  const summary = db
    .prepare(
      `SELECT employee_id, employee_code, employee_name,
              COUNT(*) AS operations,
              SUM(CASE WHEN operation_type = 'PUTAWAY' THEN 1 ELSE 0 END) AS putaway_operations,
              SUM(CASE WHEN operation_type = 'PICK' THEN 1 ELSE 0 END) AS pick_operations,
              COALESCE(SUM(quantity_moved), 0) AS quantity_moved
         FROM field_operations
        WHERE ${clause}
        GROUP BY employee_id, employee_code, employee_name
        ORDER BY quantity_moved DESC, employee_code`,
    )
    .all(...params) as Array<Record<string, any>>;
  return { rows, total: Number(total.n), limit, offset, summary };
}
