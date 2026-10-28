export const nowIso = (): string => new Date().toISOString();

export const todayIso = (): string => nowIso().slice(0, 10);

export function addHours(hours: number, from = new Date()): string {
  return new Date(from.getTime() + hours * 3600_000).toISOString();
}

export function addDays(days: number, from = new Date()): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString();
}

export function isPast(dateIso: string | null | undefined): boolean {
  if (!dateIso) return false;
  return new Date(dateIso).getTime() < Date.now();
}

export function isExpired(expiryDate: string | null | undefined): boolean {
  if (!expiryDate) return false;
  return expiryDate.slice(0, 10) < todayIso();
}

export function expiresWithinDays(expiryDate: string | null | undefined, days: number): boolean {
  if (!expiryDate) return false;
  const limit = addDays(days).slice(0, 10);
  return expiryDate.slice(0, 10) <= limit;
}
