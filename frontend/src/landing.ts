import type { User } from './api';

const FIELD_ACCESS = ['picking.execute', 'putaway.execute', 'task.assign', 'user.manage', 'audit.read'];

const ROUTE_PERMISSIONS: Array<[string, string[]]> = [
  ['/', ['inventory.read']],
  ['/control-tower', ['control_tower.read']],
  ['/orders', ['inventory.read']],
  ['/scan', ['inventory.read']],
  ['/inbound', ['inbound.receive']],
  ['/putaway', FIELD_ACCESS],
  ['/putaway-history', FIELD_ACCESS],
  ['/picker', FIELD_ACCESS],
  ['/picker-history', FIELD_ACCESS],
  ['/employees', ['user.manage']],
  ['/transfers', ['inventory.read']],
  ['/returns', ['inventory.read']],
  ['/counts', ['inventory.read']],
  ['/adjustments', ['inventory.read']],
  ['/tasks', ['task.manage']],
  ['/inventory', ['inventory.read']],
  ['/boxes', ['inventory.read']],
  ['/products', ['inventory.read']],
  ['/reports', ['report.read']],
  ['/exceptions', ['inventory.read']],
  ['/notifications', ['inventory.read']],
  ['/audit', ['audit.read']],
  ['/trace', ['audit.read']],
  ['/search', ['inventory.read']],
  ['/assistant', ['ai.use']],
  ['/report-studio', ['settings.manage']],
  ['/settings', ['settings.manage']],
  ['/imports', ['import.manage']],
];

const OPEN_ROUTES = ['/guide', '/security'];

export const FIELD_ROLES = ['FIELD_OPERATOR', 'PICKER'];

export function isFieldRole(role: string | undefined | null): boolean {
  return Boolean(role && FIELD_ROLES.includes(role));
}

export function landingPath(user: User | null): string {
  if (!user) return '/login';
  // Field staff always start at the scanning workspace, even when the role
  // also carries inventory.read for lookups.
  if (isFieldRole(user.role)) {
    if (user.permissions.includes('picking.execute')) return '/picker';
    if (user.permissions.includes('putaway.execute')) return '/putaway';
    return '/security';
  }
  if (user.permissions.includes('inventory.read')) return '/';
  if (user.permissions.includes('picking.execute')) return '/picker';
  if (user.permissions.includes('putaway.execute')) return '/putaway';
  return '/security';
}

export function canOpenPath(user: User, from: string): boolean {
  const path = from.split('?')[0] ?? '/';
  if (path === '/login') return false;
  if (OPEN_ROUTES.includes(path)) return true;
  const match = ROUTE_PERMISSIONS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
  if (!match) return false;
  return match[1].some((code) => user.permissions.includes(code));
}

export function postLoginPath(user: User, from?: string | null): string {
  if (from && canOpenPath(user, from)) return from;
  return landingPath(user);
}
