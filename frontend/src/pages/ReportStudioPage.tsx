import { useEffect, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDateTime } from '../api';
import { useAuth } from '../auth';
import { useApi, useAction } from '../hooks';
import { useToast } from '../toast';
import { Card, ErrorNote, Field, Icon, PageHeader, Spinner, StatusPill } from '../ui';
import {
  TEMPLATE_META,
  type ReportBranding,
  type SecurityStatus,
  type ReportTemplate,
} from '../reports';

interface BrandingForm {
  companyName: string;
  tagline: string;
  addressLine: string;
  contactLine: string;
  logoDataUrl: string | null;
  watermarkText: string;
  watermarkOpacity: number;
  footerNote: string;
  template: ReportTemplate;
  primaryColor: string;
  accentColor: string;
  updatedAt: string | null;
}

function toForm(branding: ReportBranding): BrandingForm {
  return {
    companyName: branding.companyName,
    tagline: branding.tagline ?? '',
    addressLine: branding.addressLine ?? '',
    contactLine: branding.contactLine ?? '',
    logoDataUrl: branding.logoDataUrl,
    watermarkText: branding.watermarkText ?? '',
    watermarkOpacity: branding.watermarkOpacity,
    footerNote: branding.footerNote ?? '',
    template: branding.template,
    primaryColor: branding.primaryColor,
    accentColor: branding.accentColor,
    updatedAt: branding.updatedAt,
  };
}

export function ReportStudioPage() {
  const { refreshMeta } = useAuth();
  const toast = useToast();
  const brandingState = useApi<{ branding: ReportBranding }>('/report-branding');
  const security = useApi<SecurityStatus>('/security/status');
  const saveAction = useAction();
  const policyAction = useAction();
  const testAction = useAction();
  const [form, setForm] = useState<BrandingForm | null>(null);

  useEffect(() => {
    if (brandingState.data) setForm(toForm(brandingState.data.branding));
  }, [brandingState.data]);

  const update = <K extends keyof BrandingForm>(key: K, value: BrandingForm[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  };

  const onLogo = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      toast.notify('Logo must be a PNG or JPEG image.', 'danger');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.notify('Logo must be smaller than 2 MB.', 'danger');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => update('logoDataUrl', String(reader.result));
    reader.onerror = () => toast.notify('The logo could not be read. Try another file.', 'danger');
    reader.readAsDataURL(file);
  };

  const save = async () => {
    if (!form) return;
    const result = await saveAction.run(() =>
      api.patch<{ branding: ReportBranding }>('/report-branding', {
        companyName: form.companyName,
        tagline: form.tagline || null,
        addressLine: form.addressLine || null,
        contactLine: form.contactLine || null,
        logoDataUrl: form.logoDataUrl,
        watermarkText: form.watermarkText || null,
        watermarkOpacity: form.watermarkOpacity,
        footerNote: form.footerNote || null,
        template: form.template,
        primaryColor: form.primaryColor,
        accentColor: form.accentColor,
      }),
    );
    if (result) {
      toast.notify('Report branding saved. New exports will use it.', 'success');
      await refreshMeta();
      brandingState.reload();
      security.reload();
    }
  };

  const togglePolicy = async (next: boolean) => {
    const result = await policyAction.run(() =>
      api.patch('/settings/report_otp_required', { value: next }),
    );
    if (result !== undefined) {
      toast.notify(next ? 'Report OTP is now mandatory.' : 'Report OTP is now optional.', 'success');
      await refreshMeta();
      security.reload();
    }
  };

  const sendTest = async () => {
    const result = await testAction.run(() => api.post<{ sentTo: string }>('/security/test-email'));
    if (result) toast.notify(`Test email sent to ${result.sentTo}.`, 'success');
  };

  const required = security.data?.policy.reportOtpRequired ?? false;
  const totpReady = security.data?.totp.enrolled ?? false;
  const emailReady = security.data?.email.configured ?? false;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Administration"
        title="Report Studio"
        subtitle="Design the letterhead, watermark and palette used by every PDF and Excel export. Company name is shared with the rest of the workspace and every change is audited."
        actions={
          <div className="toolbar">
            <Link className="btn btn-subtle" to="/security">
              <Icon name="lock" size={16} /> My security
            </Link>
            <button type="button" className="btn btn-subtle" onClick={() => brandingState.reload()}>
              <Icon name="refresh" size={16} /> Refresh
            </button>
          </div>
        }
      />

      <ErrorNote error={brandingState.error} />
      {!form && brandingState.loading ? <Spinner label="Loading report branding…" /> : null}

      {form ? (
        <div className="report-studio-grid">
          <div className="stack">
            <Card title="Document identity" subtitle="Printed on the first page of every export.">
              <div className="form-grid two">
                <Field label="Company name" required className="span-2" hint="Also updates the company name shown in the sidebar.">
                  <input
                    className="input"
                    maxLength={200}
                    value={form.companyName}
                    onChange={(event) => update('companyName', event.target.value)}
                  />
                </Field>
                <Field label="Tagline" className="span-2">
                  <input
                    className="input"
                    maxLength={150}
                    placeholder="B2B warehouse operations"
                    value={form.tagline}
                    onChange={(event) => update('tagline', event.target.value)}
                  />
                </Field>
                <Field label="Address line">
                  <input
                    className="input"
                    maxLength={300}
                    placeholder="Plot, street, city"
                    value={form.addressLine}
                    onChange={(event) => update('addressLine', event.target.value)}
                  />
                </Field>
                <Field label="Contact line">
                  <input
                    className="input"
                    maxLength={200}
                    placeholder="Phone or email"
                    value={form.contactLine}
                    onChange={(event) => update('contactLine', event.target.value)}
                  />
                </Field>
                <Field label="Footer note" className="span-2">
                  <input
                    className="input"
                    maxLength={220}
                    placeholder="Confidential - internal warehouse document"
                    value={form.footerNote}
                    onChange={(event) => update('footerNote', event.target.value)}
                  />
                </Field>
              </div>
            </Card>

            <Card title="Logo and watermark" subtitle="The logo is stored once and stamped on PDF and Excel exports.">
              <div className="logo-drop">
                <div className="logo-thumb">
                  {form.logoDataUrl ? (
                    <img src={form.logoDataUrl} alt="Company logo preview" />
                  ) : (
                    <Icon name="reports" size={26} />
                  )}
                </div>
                <div className="stack" style={{ gap: 6 }}>
                  <label className="btn btn-subtle btn-sm">
                    <Icon name="download" size={14} /> Choose logo
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      onChange={onLogo}
                      style={{ display: 'none' }}
                    />
                  </label>
                  <span className="muted tiny">PNG or JPEG, maximum 2 MB. SVG files are rejected by the backend.</span>
                  {form.logoDataUrl ? (
                    <button type="button" className="btn btn-subtle btn-sm" onClick={() => update('logoDataUrl', null)}>
                      <Icon name="close" size={14} /> Remove logo
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="form-grid two" style={{ marginTop: 16 }}>
                <Field label="Watermark text" hint="Leave blank to print no watermark. Maximum 60 characters.">
                  <input
                    className="input"
                    maxLength={60}
                    placeholder="CONFIDENTIAL"
                    value={form.watermarkText}
                    onChange={(event) => update('watermarkText', event.target.value)}
                  />
                </Field>
                <Field label="Watermark opacity" hint="Applied diagonally across every page.">
                  <div className="opacity-row">
                    <input
                      type="range"
                      min={0.02}
                      max={0.5}
                      step={0.01}
                      value={form.watermarkOpacity}
                      onChange={(event) => update('watermarkOpacity', Number(event.target.value))}
                    />
                    <code className="code">{Math.round(form.watermarkOpacity * 100)}%</code>
                  </div>
                </Field>
              </div>
            </Card>

            <Card title="Template and palette" subtitle="Templates change the header treatment, spacing and footer of the rendered document.">
              <div className="template-grid">
                {(Object.keys(TEMPLATE_META) as ReportTemplate[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={`template-card ${form.template === key ? 'active' : ''}`}
                    onClick={() => update('template', key)}
                  >
                    <span
                      className={`template-swatch swatch-${key.toLowerCase()}`}
                      style={{
                        background:
                          key === 'EXECUTIVE'
                            ? `linear-gradient(120deg, ${form.primaryColor}, ${form.accentColor})`
                            : key === 'CLASSIC'
                              ? `linear-gradient(${form.primaryColor}, ${form.primaryColor}) top / 100% 6px no-repeat, var(--panel-soft)`
                              : `linear-gradient(90deg, ${form.primaryColor} 0 6px, transparent 6px)`,
                      }}
                    />
                    <strong>{TEMPLATE_META[key].label}</strong>
                    <span className="muted tiny">{TEMPLATE_META[key].description}</span>
                  </button>
                ))}
              </div>
              <div className="form-grid two" style={{ marginTop: 16 }}>
                <Field label="Primary colour" hint="Header band, table headings and watermark.">
                  <div className="color-field">
                    <input
                      type="color"
                      className="color-input"
                      value={form.primaryColor}
                      onChange={(event) => update('primaryColor', event.target.value)}
                    />
                    <code className="code">{form.primaryColor.toUpperCase()}</code>
                  </div>
                </Field>
                <Field label="Accent colour" hint="Executive band highlight and stat accents.">
                  <div className="color-field">
                    <input
                      type="color"
                      className="color-input"
                      value={form.accentColor}
                      onChange={(event) => update('accentColor', event.target.value)}
                    />
                    <code className="code">{form.accentColor.toUpperCase()}</code>
                  </div>
                </Field>
              </div>
            </Card>

            <div className="toolbar">
              <button
                type="button"
                className="btn btn-primary"
                disabled={saveAction.running || !form.companyName.trim()}
                onClick={() => void save()}
              >
                {saveAction.running ? 'Saving…' : 'Save branding'}
              </button>
              <span className="muted tiny">
                {form.updatedAt ? `Last saved ${formatDateTime(form.updatedAt)}` : 'Not saved yet'}
              </span>
            </div>
            <ErrorNote error={saveAction.error} />

            <Card
              title="Report download security"
              subtitle="Controls whether PDF, Excel and CSV exports need a fresh one-time code."
            >
              <div className="policy-row">
                <div>
                  <strong>Require OTP for every report download</strong>
                  <p className="muted small">
                    When enabled, the export dialog asks for an authenticator or email code before the file is built.
                    The legacy CSV endpoint is blocked as well.
                  </p>
                  <div className="toolbar" style={{ marginTop: 10 }}>
                    <StatusPill
                      value={required ? 'Mandatory' : 'Optional'}
                      tone={required ? 'success' : 'neutral'}
                      dot={false}
                    />
                    <StatusPill
                      value={totpReady ? 'Authenticator enrolled' : 'Authenticator not set up'}
                      tone={totpReady ? 'success' : 'warning'}
                      dot={false}
                    />
                    <StatusPill
                      value={emailReady ? 'Email sender ready' : 'Email sender not configured'}
                      tone={emailReady ? 'success' : 'warning'}
                      dot={false}
                    />
                  </div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={required}
                    disabled={policyAction.running || !security.data}
                    onChange={(event) => void togglePolicy(event.target.checked)}
                  />
                  <span className="switch-track" aria-hidden="true" />
                </label>
              </div>

              <p className="muted tiny" style={{ marginTop: 10 }}>
                Enabling requires your account to have a confirmed authenticator, or a working SMTP sender, so nobody
                locks themselves out. Email codes use the SMTP settings configured on the server (SMTP_HOST, SMTP_USER,
                SMTP_PASS); without SMTP the email option is unavailable. Every policy change is audited.
              </p>

              <div className="toolbar" style={{ marginTop: 12 }}>
                <Link className="btn btn-subtle btn-sm" to="/security">
                  <Icon name="lock" size={14} /> Open my security
                </Link>
                <button
                  type="button"
                  className="btn btn-subtle btn-sm"
                  disabled={testAction.running || !emailReady}
                  onClick={() => void sendTest()}
                >
                  <Icon name="notifications" size={14} /> {testAction.running ? 'Sending…' : 'Send test email'}
                </button>
              </div>
              <ErrorNote error={policyAction.error ?? testAction.error} />
            </Card>
          </div>

          <div className="stack studio-preview">
            <Card title="Live preview" subtitle="Approximate print layout with your current values.">
              <ReportPreview form={form} />
            </Card>
            <Card title="What gets recorded">
              <ul className="audit-points">
                <li>Branding changes store the acting user, time and before/after values.</li>
                <li>Logo bytes are never written to the audit trail; only type and size.</li>
                <li>Each export is logged with the report, filters, format, template and OTP channel.</li>
                <li>One-time codes and authenticator secrets are never logged or stored in plain text.</li>
              </ul>
            </Card>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReportPreview({ form }: { form: BrandingForm }) {
  const watermark = form.watermarkText.trim();
  const template = form.template.toLowerCase();
  return (
    <div className={`preview-sheet preview-${template}`}>
      {form.template === 'EXECUTIVE' ? (
        <div
          className="preview-brand"
          style={{ background: `linear-gradient(120deg, ${form.primaryColor}, ${form.accentColor})` }}
        >
          <span className="preview-logo">
            {form.logoDataUrl ? <img src={form.logoDataUrl} alt="" /> : form.companyName.charAt(0).toUpperCase()}
          </span>
          <div className="preview-brand-copy">
            <strong>{form.companyName || 'Company name'}</strong>
            {form.tagline ? <span>{form.tagline}</span> : null}
          </div>
        </div>
      ) : form.template === 'CLASSIC' ? (
        <div className="preview-classic-head" style={{ borderTopColor: form.primaryColor }}>
          {form.logoDataUrl ? (
            <span className="preview-logo classic">
              <img src={form.logoDataUrl} alt="" />
            </span>
          ) : null}
          <strong>{form.companyName || 'Company name'}</strong>
          {form.tagline ? <span className="muted tiny">{form.tagline}</span> : null}
          <span className="preview-rule" style={{ background: form.accentColor }} />
        </div>
      ) : (
        <div className="preview-minimal-head" style={{ borderLeftColor: form.primaryColor }}>
          <strong>{form.companyName || 'Company name'}</strong>
          {form.tagline ? <span className="muted tiny">{form.tagline}</span> : null}
        </div>
      )}

      <div className="preview-body">
        {watermark ? (
          <span
            className="preview-watermark"
            style={{ color: form.primaryColor, opacity: form.watermarkOpacity }}
          >
            {watermark}
          </span>
        ) : null}
        <div className="preview-title">Stock summary</div>
        <div className="muted tiny">As of today · Generated by your workspace</div>
        <div className="preview-stat-row">
          {['On hand', 'Available', 'Expiring'].map((label) => (
            <span className="preview-stat" key={label}>
              <span>{label}</span>
              <strong>—</strong>
            </span>
          ))}
        </div>
        <div className="preview-lines" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <span key={index} style={{ width: `${94 - index * 7}%` }} />
          ))}
        </div>
        <div className="preview-foot">
          {form.footerNote || form.companyName || 'Footer note'}
          {form.contactLine ? ` · ${form.contactLine}` : ''}
        </div>
      </div>
    </div>
  );
}
