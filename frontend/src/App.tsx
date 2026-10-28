import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth, RequirePermission } from './auth';
import { Layout } from './layout';
import { AdjustmentsPage } from './pages/AdjustmentsPage';
import { AssistantPage } from './pages/AssistantPage';
import { AuditPage } from './pages/AuditPage';
import { BoxesPage } from './pages/BoxesPage';
import { ControlTowerPage } from './pages/ControlTowerPage';
import { CountsPage } from './pages/CountsPage';
import { EmployeesPage } from './pages/EmployeesPage';
import { ExceptionsPage } from './pages/ExceptionsPage';
import { GuidePage } from './pages/GuidePage';
import { HomePage } from './pages/HomePage';
import { ImportsPage } from './pages/ImportsPage';
import { InboundPage } from './pages/InboundPage';
import { InventoryPage, ProductsPage } from './pages/InventoryPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { OrderDetailPage } from './pages/OrderDetailPage';
import { OrdersPage } from './pages/OrdersPage';
import { PickerHistoryPage } from './pages/PickerHistoryPage';
import { PickerPage } from './pages/PickerPage';
import { PutawayHistoryPage } from './pages/PutawayHistoryPage';
import { PutawayPage } from './pages/PutawayPage';
import { ReportsPage } from './pages/ReportsPage';
import { ReturnsPage } from './pages/ReturnsPage';
import { ScanPage } from './pages/ScanPage';
import { SearchPage } from './pages/SearchPage';
import { ReportStudioPage } from './pages/ReportStudioPage';
import { SecurityPage } from './pages/SecurityPage';
import { SettingsPage } from './pages/SettingsPage';
import { TasksPage } from './pages/TasksPage';
import { TracePage } from './pages/TracePage';
import { TransfersPage } from './pages/TransfersPage';

function Guarded({ permission, children }: { permission: string | string[]; children: React.ReactNode }) {
  return <RequirePermission permission={permission}>{children}</RequirePermission>;
}

const FIELD_ACCESS = ['picking.execute', 'putaway.execute', 'task.assign', 'user.manage', 'audit.read'];

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Guarded permission="inventory.read"><HomePage /></Guarded>} />
        <Route path="control-tower" element={<Guarded permission="control_tower.read"><ControlTowerPage /></Guarded>} />
        <Route path="orders" element={<Guarded permission="inventory.read"><OrdersPage /></Guarded>} />
        <Route path="orders/:id" element={<Guarded permission="inventory.read"><OrderDetailPage /></Guarded>} />
        <Route path="scan" element={<Guarded permission="inventory.read"><ScanPage /></Guarded>} />
        <Route path="scan/:code" element={<Guarded permission="inventory.read"><ScanPage /></Guarded>} />
        <Route path="inbound" element={<Guarded permission="inbound.receive"><InboundPage /></Guarded>} />
        <Route path="putaway" element={<Guarded permission={FIELD_ACCESS}><PutawayPage /></Guarded>} />
        <Route path="putaway-history" element={<Guarded permission={FIELD_ACCESS}><PutawayHistoryPage /></Guarded>} />
        <Route path="picker" element={<Guarded permission={FIELD_ACCESS}><PickerPage /></Guarded>} />
        <Route path="picker-history" element={<Guarded permission={FIELD_ACCESS}><PickerHistoryPage /></Guarded>} />
        <Route path="employees" element={<Guarded permission="user.manage"><EmployeesPage /></Guarded>} />
        <Route path="transfers" element={<Guarded permission="inventory.read"><TransfersPage /></Guarded>} />
        <Route path="returns" element={<Guarded permission="inventory.read"><ReturnsPage /></Guarded>} />
        <Route path="counts" element={<Guarded permission="inventory.read"><CountsPage /></Guarded>} />
        <Route path="adjustments" element={<Guarded permission="inventory.read"><AdjustmentsPage /></Guarded>} />
        <Route path="tasks" element={<Guarded permission="task.manage"><TasksPage /></Guarded>} />
        <Route path="inventory" element={<Guarded permission="inventory.read"><InventoryPage /></Guarded>} />
        <Route path="boxes" element={<Guarded permission="inventory.read"><BoxesPage /></Guarded>} />
        <Route path="products" element={<Guarded permission="inventory.read"><ProductsPage /></Guarded>} />
        <Route path="reports" element={<Guarded permission="report.read"><ReportsPage /></Guarded>} />
        <Route path="exceptions" element={<Guarded permission="inventory.read"><ExceptionsPage /></Guarded>} />
        <Route path="notifications" element={<Guarded permission="inventory.read"><NotificationsPage /></Guarded>} />
        <Route path="audit" element={<Guarded permission="audit.read"><AuditPage /></Guarded>} />
        <Route path="trace" element={<Guarded permission="audit.read"><TracePage /></Guarded>} />
        <Route path="search" element={<Guarded permission="inventory.read"><SearchPage /></Guarded>} />
        <Route path="assistant" element={<Guarded permission="ai.use"><AssistantPage /></Guarded>} />
        <Route path="guide" element={<GuidePage />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="report-studio" element={<Guarded permission="settings.manage"><ReportStudioPage /></Guarded>} />
        <Route path="settings" element={<Guarded permission="settings.manage"><SettingsPage /></Guarded>} />
        <Route path="imports" element={<Guarded permission="import.manage"><ImportsPage /></Guarded>} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
