export const PERMISSIONS = [
  { code: 'inventory.read', category: 'Inventory', description: 'View stock balances, boxes and ledger' },
  { code: 'inventory.move', category: 'Inventory', description: 'Execute validated stock movements' },
  { code: 'inventory.adjust', category: 'Inventory', description: 'Request or post stock adjustments' },
  { code: 'inventory.adjust.approve', category: 'Inventory', description: 'Approve stock adjustments' },
  { code: 'box.manage', category: 'Inventory', description: 'Create and manage boxes and mixed-box contents' },
  { code: 'product.manage', category: 'Master Data', description: 'Create and edit products, SKUs and barcodes' },
  { code: 'product.cost.read', category: 'Master Data', description: 'View commercial cost data' },
  { code: 'inbound.receive', category: 'Inbound', description: 'Receive goods against purchase orders' },
  { code: 'inbound.approve', category: 'Inbound', description: 'Approve purchase orders and receipt discrepancies' },
  { code: 'qc.inspect', category: 'Inbound', description: 'Record quality control inspections' },
  { code: 'putaway.execute', category: 'Warehouse', description: 'Put away accepted stock' },
  { code: 'picking.execute', category: 'Fulfilment', description: 'Pick and verify order lines' },
  { code: 'packing.execute', category: 'Fulfilment', description: 'Pack and verify packages' },
  { code: 'dispatch.execute', category: 'Fulfilment', description: 'Confirm dispatch and handover' },
  { code: 'order.manage', category: 'Fulfilment', description: 'Create and manage orders and allocations' },
  { code: 'order.cancel', category: 'Fulfilment', description: 'Cancel orders and release reservations' },
  { code: 'transfer.request', category: 'Transfers', description: 'Request stock transfers' },
  { code: 'transfer.approve', category: 'Transfers', description: 'Approve stock transfers' },
  { code: 'transfer.execute', category: 'Transfers', description: 'Dispatch and receive stock transfers' },
  { code: 'cycle_count.manage', category: 'Inventory', description: 'Create and count cycle count sessions' },
  { code: 'cycle_count.approve', category: 'Inventory', description: 'Approve and post cycle count adjustments' },
  { code: 'return.inspect', category: 'Fulfilment', description: 'Inspect returns and set disposition' },
  { code: 'task.manage', category: 'Workforce', description: 'Create, accept and complete staff tasks' },
  { code: 'task.assign', category: 'Workforce', description: 'Assign and reassign staff tasks' },
  { code: 'exception.manage', category: 'Control', description: 'Raise, investigate and resolve exceptions' },
  { code: 'audit.read', category: 'Control', description: 'View audit trail and item genealogy' },
  { code: 'report.read', category: 'Reporting', description: 'View operational reports' },
  { code: 'report.export', category: 'Reporting', description: 'Export reports to CSV' },
  { code: 'control_tower.read', category: 'Control', description: 'View the operations control tower' },
  { code: 'user.manage', category: 'Administration', description: 'Create and manage users' },
  { code: 'role.manage', category: 'Administration', description: 'Manage role permissions' },
  { code: 'settings.manage', category: 'Administration', description: 'Change system settings' },
  { code: 'import.manage', category: 'Administration', description: 'Run controlled data imports' },
  { code: 'ai.use', category: 'AI', description: 'Use the grounded operations assistant' },
  { code: 'maintenance.manage', category: 'Workforce', description: 'Manage equipment and maintenance' },
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number]['code'];

export const ROLES: Record<string, { name: string; permissions: PermissionCode[] | '*' }> = {
  ADMIN: { name: 'System Administrator', permissions: '*' },
  MANAGER: {
    name: 'Warehouse Manager',
    permissions: [
      'inventory.read', 'inventory.move', 'inventory.adjust', 'inventory.adjust.approve',
      'box.manage', 'product.manage', 'product.cost.read', 'inbound.receive', 'inbound.approve',
      'qc.inspect', 'putaway.execute', 'picking.execute', 'packing.execute', 'dispatch.execute',
      'order.manage', 'order.cancel', 'transfer.request', 'transfer.approve', 'transfer.execute',
      'cycle_count.manage', 'cycle_count.approve', 'return.inspect', 'task.manage', 'task.assign',
      'exception.manage', 'audit.read', 'report.read', 'report.export', 'control_tower.read',
      'import.manage', 'ai.use', 'maintenance.manage',
    ],
  },
  QC_OPERATOR: {
    name: 'QC Operator',
    permissions: [
      'inventory.read', 'inbound.receive', 'qc.inspect', 'putaway.execute',
      'task.manage', 'exception.manage', 'report.read',
    ],
  },
  PICKER: {
    name: 'Warehouse Picker',
    permissions: [
      'inventory.read', 'picking.execute', 'packing.execute', 'putaway.execute',
      'task.manage', 'exception.manage',
    ],
  },
  FIELD_OPERATOR: {
    name: 'Picker / Putaway Operator',
    permissions: ['picking.execute', 'putaway.execute'],
  },
  AUDITOR: {
    name: 'Auditor',
    permissions: [
      'inventory.read', 'audit.read', 'report.read', 'report.export', 'control_tower.read',
    ],
  },
  VIEWER: {
    name: 'Read-only Viewer',
    permissions: ['inventory.read', 'report.read', 'control_tower.read'],
  },
};

export function roleHasPermission(role: string, permission: string): boolean {
  const definition = ROLES[role];
  if (!definition) return false;
  if (definition.permissions === '*') return true;
  return definition.permissions.includes(permission as PermissionCode);
}
