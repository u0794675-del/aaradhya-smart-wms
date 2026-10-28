export function entityLink(type: string | null | undefined, id: string | null | undefined): string | null {
  if (!type || !id) return null;
  const key = type.toUpperCase();
  switch (key) {
    case 'PRODUCT':
    case 'PRODUCTS':
      return `/inventory?product=${encodeURIComponent(id)}`;
    case 'BATCH':
    case 'BATCHES':
      return `/trace?type=BATCH&id=${encodeURIComponent(id)}`;
    case 'BOX':
    case 'BOXES':
      return `/boxes?box=${encodeURIComponent(id)}`;
    case 'ORDER':
    case 'ORDERS':
      return `/orders/${encodeURIComponent(id)}`;
    case 'RECEIPT':
    case 'RECEIPTS':
      return `/inbound?receipt=${encodeURIComponent(id)}`;
    case 'TRANSFER':
    case 'TRANSFERS':
      return `/transfers?transfer=${encodeURIComponent(id)}`;
    case 'RETURN':
    case 'RETURNS':
      return `/returns?return=${encodeURIComponent(id)}`;
    case 'TASK':
    case 'TASKS':
      return `/tasks?task=${encodeURIComponent(id)}`;
    case 'EXCEPTION':
    case 'EXCEPTIONS':
      return `/exceptions?id=${encodeURIComponent(id)}`;
    case 'CYCLE_COUNT':
    case 'COUNT':
      return `/counts?count=${encodeURIComponent(id)}`;
    case 'ADJUSTMENT':
      return `/adjustments?id=${encodeURIComponent(id)}`;
    case 'SHIPMENT':
    case 'SHIPMENTS':
      return `/orders?search=${encodeURIComponent(id)}`;
    case 'IMPORT_JOB':
      return '/imports';
    case 'SETTING':
      return '/settings';
    default:
      return null;
  }
}

export function entityLabel(type: string | null | undefined): string {
  if (!type) return 'Record';
  return type
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
