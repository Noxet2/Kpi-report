import axios from "axios";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import { createWriteStream } from "fs";
import { unlink } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";

const POSTHOG_BASE = "https://eu.posthog.com";
const POSTHOG_PROJECT_ID = "86171";
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASSWORD = process.env.GMAIL_PASSWORD;
const REPORT_RECIPIENT = process.env.REPORT_RECIPIENT;

// ─── PostHog ────────────────────────────────────────────────────────────────

async function query(sql) {
  const res = await axios.post(
    `${POSTHOG_BASE}/api/projects/${POSTHOG_PROJECT_ID}/query/`,
    { query: { kind: "HogQLQuery", query: sql } },
    { headers: { Authorization: `Bearer ${POSTHOG_API_KEY}` } }
  );
  return res.data.results;
}

async function fetchKPIs() {
  const [traffic, signups, content, paymentCard, live, bookings] = await Promise.all([
    query(`
      SELECT count() AS pageviews, count(DISTINCT distinct_id) AS unique_visitors
      FROM events
      WHERE event = '$pageview'
        AND timestamp >= now() - INTERVAL 7 DAY
    `),
    query(`
      SELECT count()
      FROM events
      WHERE event = 'server_platform_signup_success'
        AND timestamp >= now() - INTERVAL 7 DAY
    `),
    query(`
      SELECT count()
      FROM events
      WHERE event = 'cottage_created'
        AND timestamp >= now() - INTERVAL 7 DAY
    `),
    query(`
      SELECT count()
      FROM events
      WHERE event = 'admin_billing_payment_method_added_success'
        AND timestamp >= now() - INTERVAL 7 DAY
    `),
    query(`
      SELECT count()
      FROM events
      WHERE event = 'server_cottage_live_status_changed'
        AND timestamp >= now() - INTERVAL 7 DAY
    `),
    query(`
      SELECT count()
      FROM events
      WHERE event = 'booking_payment_success'
        AND timestamp >= now() - INTERVAL 7 DAY
    `),
  ]);

  return {
    pageviews:      Number(traffic[0]?.[0]  ?? 0),
    uniqueVisitors: Number(traffic[0]?.[1]  ?? 0),
    registrations:  Number(signups[0]?.[0]  ?? 0),
    contentCreated: Number(content[0]?.[0]  ?? 0),
    paymentCardAdded: Number(paymentCard[0]?.[0] ?? 0),
    wentLive:       Number(live[0]?.[0]     ?? 0),
    bookings:       Number(bookings[0]?.[0] ?? 0),
  };
}

// ─── PDF ────────────────────────────────────────────────────────────────────

function formatDate(date) {
  return date.toLocaleDateString("sv-SE"); // YYYY-MM-DD
}

function generatePDF(kpis, filePath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const stream = createWriteStream(filePath);
    doc.pipe(stream);

    const now = new Date();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const periodLabel = `${formatDate(weekAgo)} - ${formatDate(now)}`;

    const BRAND   = "#1a56db";
    const DARK    = "#111827";
    const GRAY    = "#6b7280";
    const LIGHT   = "#f3f4f6";
    const WHITE   = "#ffffff";
    const pageW   = doc.page.width - 100; // usable width

    // Header bar
    doc.rect(0, 0, doc.page.width, 90).fill(BRAND);
    doc.fillColor(WHITE)
       .fontSize(24).font("Helvetica-Bold")
       .text("Cottage-Booking.com", 50, 22);
    doc.fontSize(11).font("Helvetica")
       .text(`Weekly KPI Report  |  ${periodLabel}`, 50, 54);

    doc.moveDown(3);

    // Section title helper
    const sectionTitle = (title) => {
      doc.moveDown(0.5);
      doc.fillColor(BRAND).fontSize(13).font("Helvetica-Bold").text(title);
      doc.moveDown(0.3);
      doc.moveTo(50, doc.y).lineTo(50 + pageW, doc.y).strokeColor(BRAND).lineWidth(1).stroke();
      doc.moveDown(0.5);
    };

    // KPI row helper
    const kpiRow = (label, value, description, isShaded) => {
      const rowH = 36;
      const y = doc.y;
      if (isShaded) doc.rect(50, y, pageW, rowH).fill(LIGHT);
      doc.fillColor(DARK).fontSize(11).font("Helvetica-Bold")
         .text(label, 60, y + 10, { width: 230 });
      doc.fillColor(BRAND).fontSize(18).font("Helvetica-Bold")
         .text(String(value), 290, y + 6, { width: 100, align: "right" });
      doc.fillColor(GRAY).fontSize(9).font("Helvetica")
         .text(description, 400, y + 12, { width: pageW - 355 });
      doc.y = y + rowH + 4;
    };

    // ── Traffic ──
    sectionTitle("Website Traffic");
    kpiRow("Page Views",       kpis.pageviews,      "Total pages loaded",            false);
    kpiRow("Unique Visitors",  kpis.uniqueVisitors, "Distinct users on the site",    true);

    doc.moveDown(0.5);

    // ── Registrations ──
    sectionTitle("Registrations");
    kpiRow("New Sign-ups",     kpis.registrations,  "Accounts successfully created", false);

    doc.moveDown(0.5);

    // ── Content ──
    sectionTitle("Content Creation");
    kpiRow("Cottages Created", kpis.contentCreated, "New property listings added",   false);

    doc.moveDown(0.5);

    // ── Activation ──
    sectionTitle("Activation");
    kpiRow("Payment Card Added", kpis.paymentCardAdded, "Hosts who added billing info", false);
    kpiRow("Went Live",          kpis.wentLive,         "Properties published live",    true);

    doc.moveDown(0.5);

    // ── Bookings ──
    sectionTitle("Bookings");
    kpiRow("Successful Bookings", kpis.bookings, "Payments completed by guests",   false);

    // Footer
    const footerY = doc.page.height - 50;
    doc.moveTo(50, footerY - 10).lineTo(50 + pageW, footerY - 10)
       .strokeColor(LIGHT).lineWidth(1).stroke();
    doc.fillColor(GRAY).fontSize(8).font("Helvetica")
       .text(
         `Generated automatically on ${formatDate(now)}  |  Data source: PostHog  |  cottage-booking.com`,
         50, footerY, { width: pageW, align: "center" }
       );

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

// ─── Email ───────────────────────────────────────────────────────────────────

async function sendEmail(kpis, pdfPath) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_PASSWORD },
  });

  const now = new Date();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1a56db;padding:24px 32px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:22px">Cottage-Booking.com</h1>
        <p style="color:#bfdbfe;margin:6px 0 0;font-size:13px">
          Weekly KPI Report &mdash; ${weekAgo.toLocaleDateString("sv-SE")} to ${now.toLocaleDateString("sv-SE")}
        </p>
      </div>
      <div style="background:#f9fafb;padding:24px 32px;border:1px solid #e5e7eb;border-top:none">
        <table style="width:100%;border-collapse:collapse">
          <tr style="background:#1a56db;color:#fff">
            <th style="padding:10px 14px;text-align:left;font-size:12px">KPI</th>
            <th style="padding:10px 14px;text-align:right;font-size:12px">This Week</th>
          </tr>
          <tr style="background:#fff">
            <td style="padding:12px 14px;font-size:14px">Page Views</td>
            <td style="padding:12px 14px;text-align:right;font-size:18px;font-weight:bold;color:#1a56db">${kpis.pageviews}</td>
          </tr>
          <tr style="background:#f3f4f6">
            <td style="padding:12px 14px;font-size:14px">Unique Visitors</td>
            <td style="padding:12px 14px;text-align:right;font-size:18px;font-weight:bold;color:#1a56db">${kpis.uniqueVisitors}</td>
          </tr>
          <tr style="background:#fff">
            <td style="padding:12px 14px;font-size:14px">New Registrations</td>
            <td style="padding:12px 14px;text-align:right;font-size:18px;font-weight:bold;color:#1a56db">${kpis.registrations}</td>
          </tr>
          <tr style="background:#f3f4f6">
            <td style="padding:12px 14px;font-size:14px">Cottages Created</td>
            <td style="padding:12px 14px;text-align:right;font-size:18px;font-weight:bold;color:#1a56db">${kpis.contentCreated}</td>
          </tr>
          <tr style="background:#fff">
            <td style="padding:12px 14px;font-size:14px">Payment Card Added</td>
            <td style="padding:12px 14px;text-align:right;font-size:18px;font-weight:bold;color:#1a56db">${kpis.paymentCardAdded}</td>
          </tr>
          <tr style="background:#f3f4f6">
            <td style="padding:12px 14px;font-size:14px">Went Live</td>
            <td style="padding:12px 14px;text-align:right;font-size:18px;font-weight:bold;color:#1a56db">${kpis.wentLive}</td>
          </tr>
          <tr style="background:#fff">
            <td style="padding:12px 14px;font-size:14px;font-weight:bold">Successful Bookings</td>
            <td style="padding:12px 14px;text-align:right;font-size:22px;font-weight:bold;color:#1a56db">${kpis.bookings}</td>
          </tr>
        </table>
      </div>
      <div style="background:#e5e7eb;padding:12px 32px;border-radius:0 0 8px 8px;text-align:center">
        <p style="color:#6b7280;font-size:11px;margin:0">
          Full report attached as PDF &mdash; cottage-booking.com
        </p>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: `"Cottage-Booking KPI" <${GMAIL_USER}>`,
    to: REPORT_RECIPIENT,
    subject: `Weekly KPI Report — ${now.toLocaleDateString("sv-SE")}`,
    html,
    attachments: [{ filename: "kpi-report.pdf", path: pdfPath }],
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

const pdfPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "kpi-report.pdf"
);

console.log("Fetching KPIs from PostHog...");
const kpis = await fetchKPIs();
console.log("KPIs:", kpis);

console.log("Generating PDF...");
await generatePDF(kpis, pdfPath);

console.log("Sending email...");
await sendEmail(kpis, pdfPath);

await unlink(pdfPath);
console.log("Done. Report sent to", REPORT_RECIPIENT);
