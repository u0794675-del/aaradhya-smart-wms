import { Link } from 'react-router-dom';
import { Icon, PageHeader } from '../ui';

export function NotFoundPage() {
  return (
    <div className="page">
      <PageHeader eyebrow="404" title="Page not found" subtitle="This workspace route does not exist or is not available to your role." />
      <div className="empty-state standalone">
        <span className="empty-icon">
          <Icon name="search" size={28} />
        </span>
        <strong>We could not find that page</strong>
        <p>Check the address, or continue from the control tower or global search.</p>
        <div className="toolbar center">
          <Link className="btn btn-primary" to="/">
            <Icon name="dashboard" size={15} /> Control Tower
          </Link>
          <Link className="btn btn-subtle" to="/search">
            <Icon name="search" size={15} /> Global search
          </Link>
        </div>
      </div>
    </div>
  );
}
