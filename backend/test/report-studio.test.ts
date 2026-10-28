import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHarness,
  expectedStatus,
  idem,
  TEST_PASSWORD,
  type ApiClient,
  type Harness,
} from './helpers.ts';
import { createProduct, createVendor, getMeta, loc, pool, receiveStock } from './flows.ts';
import { base32Decode, base32Encode, hotp, totpStep } from '../src/lib/totp.ts';
import { resetOtpRateLimitsForTests } from '../src/services/report-security.ts';
import { layoutTable, PDF_CONTENT_WIDTH } from '../src/services/report-render.ts';
import type { EmailMessage, EmailSender } from '../src/services/email.ts';

class CapturingSender implements EmailSender {
  readonly name = 'TEST';
  configured = true;
  messages: EmailMessage[] = [];

  isConfigured(): boolean {
    return this.configured;
  }

  fromAddress(): string | null {
    return 'warehouse@test.local';
  }

  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
  }

  lastCode(): string {
    const message = this.messages.at(-1);
    const match = message ? /verification code is (\d{6})/.exec(message.text) : null;
    assert.ok(match, 'email should contain a 6-digit code');
    return match[1];
  }
}

const LOGO_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// PDFKit writes glyph runs as hex inside TJ arrays; decode them to assert on real content.
function pdfText(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  const runs: string[] = [];
  for (const array of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    let text = '';
    for (const token of array[1].matchAll(/<([0-9A-Fa-f]+)>|\(((?:\\.|[^)])*)\)/g)) {
      if (token[1]) text += Buffer.from(token[1], 'hex').toString('latin1');
      else if (token[2]) text += token[2].replace(/\\([()\\])/g, '$1');
    }
    if (text) runs.push(text);
  }
  return runs.join('\n');
}

let harness: Harness;
let sender: CapturingSender;
let admin: ApiClient;
let auditor: ApiClient;
let picker: ApiClient;
let viewer: ApiClient;
let productSku: string;
let adminUserId: string;

before(async () => {
  sender = new CapturingSender();
  harness = await createHarness({ emailSender: sender });
  admin = await harness.client('admin@aaradhya.local');
  auditor = await harness.client('auditor@aaradhya.local');
  picker = await harness.client('picker@aaradhya.local');
  viewer = await harness.client('viewer@aaradhya.local');
  const me = await admin.get('/api/auth/me');
  adminUserId = me.body.data.user.id;

  const meta = await getMeta(admin);
  const vendorId = await createVendor(admin, 'Report Studio Supplier');
  const product = await createProduct(admin, { name: 'Report Studio Syrup' });
  productSku = product.sku;
  await receiveStock(admin, {
    productId: product.id,
    quantity: 6,
    vendorId,
    poolId: pool(meta, 'B2B'),
    stagingLocationId: loc(meta, 'STAGING-01'),
    qc: { accepted: 6 },
    putaway: { locationId: loc(meta, 'RACK-A01') },
  });
});

after(async () => {
  await harness.close();
});

test('wide PDF tables are scaled into the printable width', () => {
  const widths = [62, 110, 56, 36, 44, 48, 46, 54, 38, 66];
  const layout = layoutTable(widths.map((width, index) => ({ key: `c${index}`, header: `Column ${index}`, width })));
  const total = layout.columns.reduce((sum, column) => sum + column.width, 0);
  assert.ok(
    total <= PDF_CONTENT_WIDTH + 0.001,
    `table columns must fit the page: ${total.toFixed(2)} > ${PDF_CONTENT_WIDTH.toFixed(2)}`,
  );
  assert.equal(layout.columns.length, widths.length);
  assert.ok(layout.columns.every((column) => column.width >= 20), 'no column may collapse');
  assert.ok(layout.headerFontSize <= 7, 'dense tables use the compact header size');
});

test('reports export as branded PDF, Excel and CSV with permission-aware columns', async () => {
  const pdf = await admin.binary('POST', '/api/reports/export', {
    reportType: 'STOCK_SUMMARY',
    format: 'PDF',
    template: 'EXECUTIVE',
  });
  assert.equal(pdf.status, 200, pdf.body.toString('utf8').slice(0, 400));
  assert.match(String(pdf.headers.get('content-type')), /application\/pdf/);
  assert.match(String(pdf.headers.get('content-disposition')), /stock-summary-\d{4}-\d{2}-\d{2}\.pdf/);
  assert.equal(pdf.body.subarray(0, 5).toString('latin1'), '%PDF-');
  const pdfBody = pdfText(pdf.body);
  assert.ok(pdf.body.length > 2000, 'PDF should contain rendered pages');
  assert.ok(pdfBody.includes('Stock summary'), 'PDF should contain the report title');
  assert.ok(pdfBody.includes(productSku), 'PDF should contain real product data');

  const excel = await admin.binary('POST', '/api/reports/export', {
    reportType: 'STOCK_SUMMARY',
    format: 'XLSX',
    template: 'CLASSIC',
  });
  assert.equal(excel.status, 200, excel.body.toString('utf8').slice(0, 400));
  assert.match(String(excel.headers.get('content-type')), /spreadsheetml/);
  assert.match(String(excel.headers.get('content-disposition')), /\.xlsx/);
  assert.equal(excel.body.subarray(0, 2).toString('latin1'), 'PK');

  const csv = await admin.binary('POST', '/api/reports/export', {
    reportType: 'STOCK_SUMMARY',
    format: 'CSV',
    params: { search: 'Report Studio' },
  });
  assert.equal(csv.status, 200, csv.body.toString('utf8').slice(0, 400));
  assert.match(String(csv.headers.get('content-type')), /text\/csv/);
  const csvText = csv.body.toString('utf8');
  assert.match(csvText, /^SKU,Product/m);
  assert.ok(csvText.includes(productSku));
  assert.ok(csvText.includes('Stock value'), 'admin can see cost value');

  const auditorCsv = await auditor.binary('POST', '/api/reports/export', {
    reportType: 'STOCK_SUMMARY',
    format: 'CSV',
    params: { search: 'Report Studio' },
  });
  assert.equal(auditorCsv.status, 200);
  const auditorText = auditorCsv.body.toString('utf8');
  assert.ok(auditorText.includes(productSku));
  assert.equal(auditorText.includes('Stock value'), false, 'cost column must be hidden without permission');

  const movements = await admin.binary('POST', '/api/reports/export', {
    reportType: 'MOVEMENTS',
    format: 'PDF',
  });
  assert.equal(movements.status, 200, movements.body.toString('utf8').slice(0, 400));
  assert.equal(movements.body.subarray(0, 5).toString('latin1'), '%PDF-');

  const expiry = await admin.binary('POST', '/api/reports/export', {
    reportType: 'EXPIRY',
    format: 'XLSX',
  });
  assert.equal(expiry.status, 200, expiry.body.toString('utf8').slice(0, 400));
  assert.equal(expiry.body.subarray(0, 2).toString('latin1'), 'PK');

  const denied = await viewer.post('/api/reports/export', { reportType: 'STOCK_SUMMARY', format: 'PDF' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'FORBIDDEN');
});

test('report branding validates, persists and appears in generated PDFs', async () => {
  const initial = await admin.get('/api/report-branding');
  expectedStatus(initial, 200, 'get branding');
  assert.equal(initial.body.data.branding.template, 'EXECUTIVE');

  const updated = await admin.patch('/api/report-branding', {
    companyName: 'Aaradhya Homeopathic Pvt. Ltd. (Brand Test)',
    tagline: 'B2B distribution and warehouse operations',
    addressLine: 'Plot 12, Industrial Area, Nashik',
    contactLine: 'warehouse@aaradhya.local',
    logoDataUrl: LOGO_PNG,
    watermarkText: 'CONFIDENTIAL TEST',
    watermarkOpacity: 0.1,
    footerNote: 'Internal document - do not circulate',
    template: 'MINIMAL',
    primaryColor: '#123456',
    accentColor: '#ABCDEF',
  });
  expectedStatus(updated, 200, 'update branding');
  assert.equal(updated.body.data.branding.template, 'MINIMAL');
  assert.equal(updated.body.data.branding.logoMime, 'image/png');
  assert.equal(updated.body.data.branding.watermarkText, 'CONFIDENTIAL TEST');

  const fetched = await admin.get('/api/report-branding');
  assert.equal(fetched.body.data.branding.companyName, 'Aaradhya Homeopathic Pvt. Ltd. (Brand Test)');

  const settings = await admin.get('/api/settings');
  const company = settings.body.data.rows.find((row: any) => row.key === 'company_name');
  assert.equal(company.value, 'Aaradhya Homeopathic Pvt. Ltd. (Brand Test)');

  const pdf = await admin.binary('POST', '/api/reports/export', {
    reportType: 'STOCK_SUMMARY',
    format: 'PDF',
    template: 'EXECUTIVE',
  });
  assert.equal(pdf.status, 200, pdf.body.toString('utf8').slice(0, 400));
  const brandedPdf = pdfText(pdf.body);
  assert.ok(brandedPdf.includes('Brand Test'), 'company name should be printed in the PDF');
  assert.ok(brandedPdf.includes('CONFIDENTIAL TEST'), 'watermark should be drawn on the PDF');

  const invalidLogo = await admin.patch('/api/report-branding', {
    companyName: 'Aaradhya Homeopathic Pvt. Ltd. (Brand Test)',
    logoDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    watermarkOpacity: 0.1,
    template: 'MINIMAL',
    primaryColor: '#123456',
    accentColor: '#ABCDEF',
  });
  assert.equal(invalidLogo.status, 400);
  assert.equal(invalidLogo.body.error.code, 'LOGO_INVALID');

  const pickerDenied = await picker.patch('/api/report-branding', {
    companyName: 'Hijack',
    watermarkOpacity: 0.1,
    template: 'MINIMAL',
    primaryColor: '#123456',
    accentColor: '#ABCDEF',
  });
  assert.equal(pickerDenied.status, 403);

  const audit = await admin.get('/api/audit?eventType=REPORT_BRANDING_UPDATED&entityId=default');
  expectedStatus(audit, 200, 'branding audit');
  assert.equal(audit.body.data.rows.length, 1);
  const serialized = JSON.stringify(audit.body.data.rows[0]);
  assert.ok(serialized.includes('"logo"'));
  assert.equal(serialized.includes('data:image'), false, 'audit must not embed the raw logo data URL');
});

test('mandatory report OTP is enforced and email codes are single-use and hashed', async () => {
  const enable = await admin.patch('/api/settings/report_otp_required', { value: true });
  expectedStatus(enable, 200, 'enable report OTP');

  const noCode = await admin.post('/api/reports/export', { reportType: 'STOCK_SUMMARY', format: 'PDF' });
  assert.equal(noCode.status, 403);
  assert.equal(noCode.body.error.code, 'OTP_REQUIRED');

  const legacyCsv = await admin.get('/api/reports/stock-summary.csv');
  assert.equal(legacyCsv.status, 403);
  assert.equal(legacyCsv.body.error.code, 'OTP_REQUIRED');

  const sent = await admin.post('/api/reports/otp/email', {});
  expectedStatus(sent, 200, 'send email otp');
  assert.equal(sent.body.data.sent, true);
  assert.match(sent.body.data.sentTo, /^ad\*+@/);
  assert.equal(sender.messages.length, 1);
  assert.equal(sender.messages[0].to, 'admin@aaradhya.local');
  const code = sender.lastCode();

  const stored = harness.db
    .prepare('SELECT id, code_hash FROM report_otp_challenges WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(adminUserId) as { id: string; code_hash: string };
  assert.equal(stored.code_hash.length, 64);
  assert.equal(stored.code_hash.includes(code), false, 'the plaintext code must never be stored');
  assert.equal(JSON.stringify(stored).includes(`"${code}"`), false);

  const wrongCode = code === '000000' ? '111111' : '000000';
  const rejected = await admin.post('/api/reports/export', {
    reportType: 'STOCK_SUMMARY',
    format: 'PDF',
    otp: { channel: 'EMAIL', code: wrongCode },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'OTP_INVALID');
  assert.equal(rejected.body.error.details.remainingAttempts, 4);

  const allowed = await admin.binary('POST', '/api/reports/export', {
    reportType: 'STOCK_SUMMARY',
    format: 'PDF',
    otp: { channel: 'EMAIL', code },
  });
  assert.equal(allowed.status, 200, allowed.body.toString('utf8').slice(0, 400));
  assert.equal(allowed.body.subarray(0, 5).toString('latin1'), '%PDF-');

  const replayed = await admin.post('/api/reports/export', {
    reportType: 'STOCK_SUMMARY',
    format: 'CSV',
    otp: { channel: 'EMAIL', code },
  });
  assert.equal(replayed.status, 400);
  assert.equal(replayed.body.error.code, 'OTP_EXPIRED');

  const audit = await admin.get('/api/audit?eventType=REPORT_GENERATED');
  expectedStatus(audit, 200, 'report audit');
  const generated = audit.body.data.rows.filter((row: any) => row.refs?.otpChannel === 'EMAIL');
  assert.ok(generated.length >= 1, 'export should be audited with the OTP channel');

  const second = await admin.post('/api/reports/otp/email', {});
  expectedStatus(second, 200, 'second email otp');
  const third = await admin.post('/api/reports/otp/email', {});
  expectedStatus(third, 200, 'third email otp');
  const fourth = await admin.post('/api/reports/otp/email', {});
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.error.code, 'OTP_RATE_LIMITED');
});

test('authenticator enrollment works, codes cannot be replayed and disable requires the password', async () => {
  resetOtpRateLimitsForTests();
  const start = await admin.post('/api/security/totp/start', {});
  expectedStatus(start, 200, 'start totp');
  const secret = start.body.data.secret as string;
  assert.match(start.body.data.qrDataUrl, /^data:image\/png;base64,/);
  assert.match(start.body.data.otpauthUri, /^otpauth:\/\/totp\//);

  const storedSecret = harness.db.prepare('SELECT secret_encrypted FROM user_totp WHERE user_id = ?').get(adminUserId) as {
    secret_encrypted: string;
  };
  assert.match(storedSecret.secret_encrypted, /^v1:/);
  assert.equal(storedSecret.secret_encrypted.includes(secret), false, 'TOTP secret must be encrypted at rest');

  const step = totpStep();
  const code = hotp(base32Decode(secret), step);
  const confirm = await admin.post('/api/security/totp/confirm', { code });
  expectedStatus(confirm, 200, 'confirm totp');
  assert.equal(confirm.body.data.enrolled, true);

  const status = await admin.get('/api/security/status');
  assert.equal(status.body.data.totp.enrolled, true);
  assert.equal(status.body.data.policy.reportOtpRequired, true);

  const nextCode = hotp(base32Decode(secret), step + 1);
  const exported = await admin.binary('POST', '/api/reports/export', {
    reportType: 'EXPIRY',
    format: 'CSV',
    otp: { channel: 'TOTP', code: nextCode },
  });
  assert.equal(exported.status, 200, exported.body.toString('utf8').slice(0, 400));

  const replay = await admin.post('/api/reports/export', {
    reportType: 'EXPIRY',
    format: 'CSV',
    otp: { channel: 'TOTP', code: nextCode },
  });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error.code, 'OTP_REPLAYED');

  resetOtpRateLimitsForTests();
  const wrong = nextCode === '000000' ? '111111' : '000000';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await admin.post('/api/reports/export', {
      reportType: 'EXPIRY',
      format: 'CSV',
      otp: { channel: 'TOTP', code: wrong },
    });
    assert.equal(response.status, 400, `attempt ${attempt + 1} should be rejected`);
    assert.equal(response.body.error.code, 'OTP_INVALID');
  }
  const limited = await admin.post('/api/reports/export', {
    reportType: 'EXPIRY',
    format: 'CSV',
    otp: { channel: 'TOTP', code: wrong },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'OTP_RATE_LIMITED');
  resetOtpRateLimitsForTests();

  const wrongPassword = await admin.post('/api/security/totp/disable', { password: 'not-the-password' });
  assert.equal(wrongPassword.status, 400);
  assert.equal(wrongPassword.body.error.code, 'PASSWORD_INVALID');

  const disabled = await admin.post('/api/security/totp/disable', { password: TEST_PASSWORD });
  expectedStatus(disabled, 200, 'disable totp');

  const afterDisable = await admin.post('/api/reports/export', {
    reportType: 'EXPIRY',
    format: 'CSV',
    otp: { channel: 'TOTP', code: hotp(base32Decode(secret), step + 2) },
  });
  assert.equal(afterDisable.status, 409);
  assert.equal(afterDisable.body.error.code, 'TOTP_NOT_ENROLLED');

  const disablePolicy = await admin.patch('/api/settings/report_otp_required', { value: false });
  expectedStatus(disablePolicy, 200, 'disable report OTP');
});

test('the Hinglish guide is served in-app and as a branded PDF', async () => {
  const guide = await admin.get('/api/guide');
  expectedStatus(guide, 200, 'guide content');
  assert.equal(guide.body.data.guide.title, 'Warehouse User Guide');
  assert.ok(guide.body.data.guide.sections.length >= 16);
  assert.ok(guide.body.data.guide.sections[0].steps.length > 0);
  assert.ok(guide.body.data.guide.goldenRules.length >= 5);

  const pdf = await admin.binary('GET', '/api/guide.pdf');
  assert.equal(pdf.status, 200, pdf.body.toString('utf8').slice(0, 400));
  assert.equal(pdf.body.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(pdf.body.length > 5000, 'guide PDF should contain multiple pages');
  assert.ok(pdf.body.toString('latin1').includes('Warehouse User Guide'));

  const viewerGuide = await viewer.get('/api/guide');
  expectedStatus(viewerGuide, 200, 'viewer guide');
  const viewerPdf = await viewer.binary('GET', '/api/guide.pdf');
  assert.equal(viewerPdf.status, 200);

  const audit = await admin.get('/api/audit?eventType=GUIDE_EXPORTED');
  expectedStatus(audit, 200, 'guide audit');
  assert.ok(audit.body.data.rows.length >= 2);
});

test('TOTP generation matches the RFC 6238 SHA-1 vectors', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(hotp(base32Decode(secret), Math.floor(seconds / 30), 8), expected, `step at ${seconds}s`);
  }
});
