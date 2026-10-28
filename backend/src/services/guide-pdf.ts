import PDFDocument from 'pdfkit';
import type { GuideContent } from '../content/guide.ts';
import type { ReportBranding } from '../services/report-security.ts';
import { logoBuffer, tint } from './report-render.ts';

const INK = '#0F172A';
const MUTED = '#475569';
const LINE = '#E2E8F0';

export async function renderGuidePdf(
  guide: GuideContent,
  branding: ReportBranding,
  generatedBy: string,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 42,
    bufferPages: true,
    compress: false,
    info: {
      Title: `${guide.title} - ${branding.companyName}`,
      Author: branding.companyName,
      Subject: 'Warehouse user guide (Hinglish)',
      Creator: 'Aaradhya Smart WMS',
      CreationDate: new Date(),
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const margin = 42;
  const width = doc.page.width - margin * 2;
  const logo = logoBuffer(branding);

  function watermark(): void {
    const text = branding.watermarkText?.trim();
    if (!text) return;
    doc.save();
    doc.rotate(-32, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.font('Helvetica-Bold').fontSize(58).fillColor(branding.primaryColor).opacity(branding.watermarkOpacity);
    doc.text(text.toUpperCase(), 0, doc.page.height / 2 - 40, {
      width: doc.page.width,
      align: 'center',
      lineBreak: false,
    });
    doc.restore();
    doc.opacity(1).fillColor(INK);
  }

  function compactHeader(): void {
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5);
    doc.text(branding.companyName, margin, 28, { width: width - 140, lineBreak: false, ellipsis: true });
    doc.fillColor(MUTED).font('Helvetica').fontSize(8);
    doc.text(guide.title, margin + width - 180, 29, { width: 180, align: 'right', lineBreak: false });
    doc.moveTo(margin, 44).lineTo(margin + width, 44).lineWidth(0.7).strokeColor(branding.primaryColor).stroke();
    doc.y = 54;
  }

  doc.on('pageAdded', () => {
    watermark();
    compactHeader();
  });

  // Cover
  doc.save();
  doc.rect(0, 0, doc.page.width, 250).fill(branding.primaryColor);
  doc.restore();
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(15);
  doc.text(branding.companyName, margin, 46, { width: width - (logo ? 130 : 0), lineBreak: false, ellipsis: true });
  if (branding.tagline) {
    doc.font('Helvetica').fontSize(8.5).fillColor(tint(branding.primaryColor, 0.75));
    doc.text(branding.tagline, margin, 68, { width: width - (logo ? 130 : 0), lineBreak: false });
  }
  if (logo) {
    try {
      doc.image(logo, margin + width - 116, 34, { fit: [116, 52], align: 'right', valign: 'center' });
    } catch {
      // logo is optional
    }
  }
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(29);
  doc.text(guide.title, margin, 120, { width });
  doc.font('Helvetica').fontSize(11).fillColor(tint(branding.primaryColor, 0.82));
  doc.text(guide.subtitle, margin, 160, { width });
  doc.fontSize(8.5).fillColor(tint(branding.primaryColor, 0.7));
  doc.text(`Version ${guide.version}  |  Updated ${guide.updatedAt}  |  Prepared for ${generatedBy}`, margin, 205, {
    width,
    lineBreak: false,
  });

  doc.y = 282;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13);
  doc.text('Is guide ko kaise use karein', margin, doc.y);
  doc.moveDown(0.35);
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED);
  doc.text(guide.intro, margin, doc.y, { width, align: 'justify', lineGap: 2.5 });

  doc.moveDown(1);
  const rulesTop = doc.y;
  doc.save();
  doc.roundedRect(margin, rulesTop, width, 154, 5).fill(tint(branding.primaryColor, 0.92));
  doc.restore();
  doc.fillColor(branding.primaryColor).font('Helvetica-Bold').fontSize(11);
  doc.text('Golden rules - sabhi users ke liye', margin + 14, rulesTop + 12, { width: width - 28 });
  doc.font('Helvetica').fontSize(8.8).fillColor(INK);
  let ruleY = rulesTop + 34;
  for (const rule of guide.goldenRules) {
    doc.text(`- ${rule}`, margin + 16, ruleY, { width: width - 32, lineGap: 1.5 });
    ruleY = doc.y + 3;
  }
  doc.y = Math.max(doc.y, rulesTop + 160) + 12;

  // Roles
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11.5);
  doc.text('Roles aur unka focus', margin, doc.y);
  doc.moveDown(0.4);
  for (const role of guide.roles) {
    if (doc.y + 26 > doc.page.height - 60) doc.addPage();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.8);
    doc.text(`${role.name} (${role.code})`, margin, doc.y, { width });
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5);
    doc.text(role.focus, margin + 10, doc.y + 1, { width: width - 10 });
    doc.moveDown(0.45);
  }

  // Contents
  doc.addPage();
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(18);
  doc.text('Contents', margin, doc.y);
  doc.moveDown(0.6);
  guide.sections.forEach((section, index) => {
    doc.fillColor(INK).font('Helvetica').fontSize(10);
    doc.text(section.title, margin + 4, doc.y, { width: width - 8 });
    if (index < guide.sections.length - 1) {
      doc.moveTo(margin + 4, doc.y + 2).lineTo(margin + width - 4, doc.y + 2).lineWidth(0.3).strokeColor(LINE).stroke();
    }
    doc.moveDown(0.55);
  });

  // Sections
  doc.addPage();
  for (const section of guide.sections) {
    if (doc.y + 90 > doc.page.height - 70) doc.addPage();
    doc.save();
    doc.rect(margin, doc.y + 2, 4, 18).fill(branding.accentColor);
    doc.restore();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(13);
    doc.text(section.title, margin + 12, doc.y, { width: width - 12 });
    doc.moveDown(0.25);
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5);
    doc.text(section.who.toUpperCase(), margin + 12, doc.y, { width: width - 12, characterSpacing: 0.6 });
    doc.moveDown(0.35);
    doc.fillColor(INK).font('Helvetica-Oblique').fontSize(9.2);
    doc.text(section.summary, margin + 12, doc.y, { width: width - 12, lineGap: 2 });
    doc.moveDown(0.7);

    for (const [index, step] of section.steps.entries()) {
      if (doc.y + 42 > doc.page.height - 60) doc.addPage();
      doc.fillColor(branding.primaryColor).font('Helvetica-Bold').fontSize(9);
      doc.text(`${index + 1}. ${step.title}`, margin + 12, doc.y, { width: width - 12 });
      doc.moveDown(0.15);
      doc.fillColor(MUTED).font('Helvetica').fontSize(8.8);
      doc.text(step.detail, margin + 26, doc.y, { width: width - 26, lineGap: 1.6 });
      doc.moveDown(0.45);
    }

    if (section.tips.length) {
      doc.moveDown(0.3);
      const top = doc.y;
      doc.save();
      doc.roundedRect(margin + 12, top, width - 12, 18 + section.tips.length * 14, 4).fill(tint(branding.accentColor, 0.88));
      doc.restore();
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.4);
      doc.text('Dhyan rakhein', margin + 22, top + 6, { width: width - 32 });
      doc.font('Helvetica').fontSize(8.2).fillColor(MUTED);
      let tipY = top + 20;
      for (const tip of section.tips) {
        doc.text(`- ${tip}`, margin + 24, tipY, { width: width - 44, lineGap: 1.2 });
        tipY = doc.y + 2;
      }
      doc.y = Math.max(tipY, top + 26);
      doc.moveDown(0.5);
    }

    if (section.links.length) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.8);
      doc.text(`Open: ${section.links.map((link) => `${link.label} (${link.to})`).join('   |   ')}`, margin + 12, doc.y, {
        width: width - 12,
        lineGap: 1,
      });
      doc.moveDown(0.6);
    }
    doc.moveTo(margin, doc.y).lineTo(margin + width, doc.y).lineWidth(0.4).strokeColor(LINE).stroke();
    doc.moveDown(0.9);
  }

  // Checklist
  if (doc.y + 140 > doc.page.height - 70) doc.addPage();
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14);
  doc.text('Daily checklist', margin, doc.y);
  doc.moveDown(0.5);
  for (const item of guide.checklist) {
    doc.fillColor(INK).font('Helvetica').fontSize(9);
    doc.text(`[  ]  ${item}`, margin + 8, doc.y, { width: width - 8 });
    doc.moveDown(0.4);
  }

  doc.moveDown(1);
  if (doc.y + 160 > doc.page.height - 70) doc.addPage();
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14);
  doc.text('Glossary', margin, doc.y);
  doc.moveDown(0.5);
  for (const entry of guide.glossary) {
    if (doc.y + 28 > doc.page.height - 60) doc.addPage();
    const rowY = doc.y;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.6);
    doc.text(entry.term, margin, rowY, { width: 110, continued: false });
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.6);
    doc.text(entry.meaning, margin + 115, rowY, { width: width - 115 });
    doc.y = Math.max(doc.y, rowY + 14);
    doc.moveDown(0.35);
  }

  doc.moveDown(1.2);
  doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8);
  doc.text(
    `Yeh guide ${branding.companyName} ke internal warehouse use ke liye hai. Version ${guide.version} - ${guide.updatedAt}.`,
    margin,
    doc.y,
    { width, align: 'center' },
  );

  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    const page = doc.page;
    const previousBottom = page.margins.bottom;
    page.margins.bottom = 0;
    doc.moveTo(margin, page.height - 30).lineTo(page.width - margin, page.height - 30);
    doc.lineWidth(0.4).strokeColor(LINE).stroke();
    doc.fillColor(MUTED).font('Helvetica').fontSize(6.8);
    doc.text(branding.footerNote ?? branding.companyName, margin, page.height - 24, {
      width: width - 100,
      lineBreak: false,
      ellipsis: true,
    });
    doc.text(`Page ${index + 1} of ${range.count}`, page.width - margin - 90, page.height - 24, {
      width: 90,
      align: 'right',
      lineBreak: false,
    });
    page.margins.bottom = previousBottom;
  }

  doc.end();
  return finished;
}
