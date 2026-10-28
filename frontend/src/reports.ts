export type ReportTemplate = 'EXECUTIVE' | 'CLASSIC' | 'MINIMAL';
export type ReportFormat = 'PDF' | 'XLSX' | 'CSV';
export type ReportType = 'STOCK_SUMMARY' | 'MOVEMENTS' | 'EXPIRY';
export type OtpChannel = 'TOTP' | 'EMAIL';

export interface SecurityStatus {
  totp: { started: boolean; enrolled: boolean; confirmedAt: string | null };
  email: { configured: boolean; from: string | null };
  policy: { reportOtpRequired: boolean };
  branding: { template: ReportTemplate; companyName: string };
}

export interface ReportBranding {
  companyName: string;
  tagline: string | null;
  addressLine: string | null;
  contactLine: string | null;
  logoDataUrl: string | null;
  logoMime: 'image/png' | 'image/jpeg' | null;
  watermarkText: string | null;
  watermarkOpacity: number;
  footerNote: string | null;
  template: ReportTemplate;
  primaryColor: string;
  accentColor: string;
  updatedAt: string | null;
}

export const TEMPLATE_META: Record<ReportTemplate, { label: string; description: string }> = {
  EXECUTIVE: {
    label: 'Executive',
    description: 'Colour header band, KPI cards and a bold watermark. Best for management reviews.',
  },
  CLASSIC: {
    label: 'Classic',
    description: 'Centred letterhead with a formal rule and quiet footer. Best for audits and files.',
  },
  MINIMAL: {
    label: 'Minimal',
    description: 'Compact left-aligned header with maximum table space. Best for long operational lists.',
  },
};

export const FORMAT_META: Record<ReportFormat, { label: string; description: string; extension: string }> = {
  PDF: { label: 'PDF', description: 'Branded, print-ready document with page numbers.', extension: 'pdf' },
  XLSX: { label: 'Excel', description: 'Styled workbook with filters and frozen headers.', extension: 'xlsx' },
  CSV: { label: 'CSV', description: 'Raw values for BI tools and reconciliations.', extension: 'csv' },
};

export const REPORT_LABEL: Record<ReportType, string> = {
  STOCK_SUMMARY: 'Stock summary',
  MOVEMENTS: 'Movement ledger',
  EXPIRY: 'Expiry exposure',
};

export interface ReportParams {
  search?: string;
  category?: string;
  from?: string;
  to?: string;
}
