import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { titleCase } from './api';
import { useAuth } from './auth';
import { useApi } from './hooks';
import { isFieldRole } from './landing';
import { Icon } from './ui';

type IconName = Parameters<typeof Icon>[0]['name'];

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  permissions: string[];
  any?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    label: 'Operations',
    items: [
      { to: '/', label: 'My Inventory', icon: 'inventory', permissions: ['inventory.read'] },
      { to: '/control-tower', label: 'Control Tower', icon: 'dashboard', permissions: ['control_tower.read'] },
      { to: '/orders', label: 'Orders', icon: 'orders', permissions: ['inventory.read'] },
      { to: '/scan', label: 'Scan Station', icon: 'scan', permissions: ['inventory.read'] },
      { to: '/inbound', label: 'Inbound & QC', icon: 'inbound', permissions: ['inbound.receive'] },
      { to: '/transfers', label: 'Transfers', icon: 'transfer', permissions: ['inventory.read'] },
      { to: '/returns', label: 'Returns', icon: 'returns', permissions: ['inventory.read'] },
      { to: '/counts', label: 'Cycle Counts', icon: 'counts', permissions: ['inventory.read'] },
      { to: '/adjustments', label: 'Adjustments', icon: 'adjust', permissions: ['inventory.read'] },
      { to: '/tasks', label: 'Tasks', icon: 'tasks', permissions: ['task.manage'] },
    ],
  },
  {
    label: 'Field Operations',
    items: [
      {
        to: '/picker',
        label: 'Picking',
        icon: 'orders',
        permissions: ['picking.execute', 'task.assign', 'user.manage', 'audit.read'],
        any: true,
      },
      {
        to: '/putaway',
        label: 'Putaway',
        icon: 'inbound',
        permissions: ['putaway.execute', 'task.assign', 'user.manage', 'audit.read'],
        any: true,
      },
      {
        to: '/picker-history',
        label: 'Picker History',
        icon: 'audit',
        permissions: ['picking.execute', 'task.assign', 'user.manage', 'audit.read'],
        any: true,
      },
      {
        to: '/putaway-history',
        label: 'Putaway History',
        icon: 'audit',
        permissions: ['putaway.execute', 'task.assign', 'user.manage', 'audit.read'],
        any: true,
      },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { to: '/inventory', label: 'Inventory', icon: 'inventory', permissions: ['inventory.read'] },
      { to: '/boxes', label: 'Boxes', icon: 'boxes', permissions: ['inventory.read'] },
      { to: '/products', label: 'Product Master', icon: 'products', permissions: ['inventory.read'] },
      { to: '/reports', label: 'Reports', icon: 'reports', permissions: ['report.read'] },
      { to: '/exceptions', label: 'Exceptions', icon: 'exceptions', permissions: ['inventory.read'] },
      { to: '/notifications', label: 'Notifications', icon: 'notifications', permissions: ['inventory.read'] },
    ],
  },
  {
    label: 'Control',
    items: [
      { to: '/audit', label: 'Audit Trail', icon: 'audit', permissions: ['audit.read'] },
      { to: '/trace', label: 'Genealogy', icon: 'trace', permissions: ['audit.read'] },
      { to: '/search', label: 'Global Search', icon: 'search', permissions: ['inventory.read'] },
      { to: '/assistant', label: 'Ops Assistant', icon: 'assistant', permissions: ['ai.use'] },
      { to: '/guide', label: 'User Guide', icon: 'info', permissions: [] },
      { to: '/security', label: 'My Security', icon: 'lock', permissions: [] },
    ],
  },
  {
    label: 'Administration',
    items: [
      { to: '/employees', label: 'Employees', icon: 'user', permissions: ['user.manage'] },
      { to: '/report-studio', label: 'Report Studio', icon: 'reports', permissions: ['settings.manage'] },
      { to: '/settings', label: 'Settings', icon: 'settings', permissions: ['settings.manage'] },
      { to: '/imports', label: 'Data Imports', icon: 'imports', permissions: ['import.manage'] },
    ],
  },
];

interface NotificationList {
  counts: Record<string, number>;
}

// Field staff only get the scanning workspace; everything else stays hidden
// even when the role carries extra read permissions.
const FIELD_PATHS = new Set(['/picker', '/picker-history', '/putaway', '/putaway-history']);

export function Layout() {
  const { user, meta, can, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const fieldUser = isFieldRole(user?.role);
  const notifications = useApi<NotificationList>(can('inventory.read') && !fieldUser ? '/notifications?limit=200' : null);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (fieldUser && location.pathname === '/') navigate('/picker', { replace: true });
  }, [fieldUser, location.pathname, navigate]);

  useEffect(() => {
    if (!can('inventory.read') || fieldUser) return;
    const timer = window.setInterval(() => notifications.reload(), 90_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [can, fieldUser]);

  const groups = useMemo(
    () =>
      NAV.map((group) => ({
        ...group,
        items: group.items.filter((item) => {
          if (fieldUser && !FIELD_PATHS.has(item.to)) return false;
          return item.any
            ? item.permissions.some((permission) => can(permission))
            : item.permissions.every((permission) => can(permission));
        }),
      })).filter((group) => group.items.length > 0),
    [can, fieldUser],
  );

  const pageTitle = useMemo(() => {
    const flat = NAV.flatMap((group) => group.items);
    if (location.pathname === '/') return 'My Inventory';
    const match = flat
      .filter((item) => item.to !== '/')
      .find((item) => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`));
    if (match) return match.label;
    if (location.pathname.startsWith('/orders/')) return 'Order Detail';
    if (location.pathname.startsWith('/shipments/')) return 'Shipment';
    return 'Workspace';
  }, [location.pathname]);

  const openNotifications = notifications.data?.counts.OPEN ?? 0;
  const company =
    (meta?.settings.find((setting) => setting.key === 'company_name')?.value as string | undefined) ??
    'Aaradhya Homeopathic';

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-mark">A</span>
          <div>
            <strong>AARADHYA</strong>
            <span>SMART WMS</span>
          </div>
        </div>
        <div className="warehouse-chip">
          <Icon name="inventory" size={15} />
          <span>{meta?.warehouse.code ?? 'WH1'} · {meta?.warehouse.name ?? 'Main Warehouse'}</span>
        </div>
        <nav className="nav">
          {groups.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-label">{group.label}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                  onClick={() => setSidebarOpen(false)}
                >
                  <Icon name={item.icon} size={18} />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <NavLink to="/guide" className="sidebar-guide">
            <Icon name="info" size={15} /> New here? Open the Hinglish guide
          </NavLink>
          <div className="company">{company}</div>
          <div className="company-sub">Warehouse operations · Asia/Kolkata</div>
        </div>
      </aside>

      {sidebarOpen ? <button type="button" className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} /> : null}

      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="icon-btn menu-toggle"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation"
            >
              <Icon name="menu" size={20} />
            </button>
            <div className="topbar-title">
              <span>Workspace</span>
              <strong>{pageTitle}</strong>
            </div>
          </div>

          {fieldUser ? <div className="toolbar-spacer" /> : (
          <form
            className="global-search"
            onSubmit={(event) => {
              event.preventDefault();
              const query = search.trim();
              if (query.length < 2) return;
              navigate(`/search?q=${encodeURIComponent(query)}`);
              searchRef.current?.blur();
            }}
          >
            <Icon name="search" size={17} />
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search SKU, order, box, batch…"
              aria-label="Global search"
            />
            <kbd>↵</kbd>
          </form>
          )}

          <div className="topbar-right">
            {can('inventory.read') && !fieldUser ? (
              <button
                type="button"
                className="icon-btn bell"
                aria-label={`Notifications${openNotifications ? ` (${openNotifications} open)` : ''}`}
                onClick={() => navigate('/notifications')}
              >
                <Icon name="notifications" size={19} />
                {openNotifications > 0 ? <span className="bell-count">{openNotifications > 99 ? '99+' : openNotifications}</span> : null}
              </button>
            ) : null}
            <div className="user-chip" title={`${user?.name ?? ''} · ${titleCase(user?.role)}`}>
              <span className="avatar">{user?.name?.slice(0, 1).toUpperCase() ?? 'U'}</span>
              <div className="user-meta">
                <strong>{user?.name}</strong>
                <span>{titleCase(user?.role)}</span>
              </div>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="Sign out"
              title="Sign out"
              onClick={() => {
                void logout().then(() => navigate('/login', { replace: true }));
              }}
            >
              <Icon name="logout" size={19} />
            </button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
