import axios from "axios";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import { createWriteStream, writeFileSync, unlinkSync } from "fs";
import { unlink } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import { Chart, registerables } from "chart.js";
Chart.register(...registerables);

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

function weekQuery(event, intervalStart, intervalEnd) {
  return query(`
    SELECT count()
    FROM events
    WHERE event = '${event}'
      AND timestamp >= now() - INTERVAL ${intervalStart} DAY
      AND timestamp < now() - INTERVAL ${intervalEnd} DAY
  `);
}

async function fetchKPIs() {
  const [
    trafficCurr, trafficPrev,
    signupsCurr, signupsPrev,
    contentCurr, contentPrev,
    paymentCurr, paymentPrev,
    liveCurr,    livePrev,
    bookingsCurr, bookingsPrev,
  ] = await Promise.all([
    query(`
      SELECT count() AS pageviews, count(DISTINCT distinct_id) AS unique_visitors
      FROM events WHERE event = '$pageview'
        AND timestamp >= now() - INTERVAL 7 DAY
    `),
    query(`
      SELECT count() AS pageviews, count(DISTINCT distinct_id) AS unique_visitors
      FROM events WHERE event = '$pageview'
        AND timestamp >= now() - INTERVAL 14 DAY
        AND timestamp < now() - INTERVAL 7 DAY
    `),
    weekQuery("server_platform_signup_success", 7,  0),
    weekQuery("server_platform_signup_success", 14, 7),
    weekQuery("cottage_created", 7,  0),
    weekQuery("cottage_created", 14, 7),
    weekQuery("admin_billing_payment_method_added_success", 7,  0),
    weekQuery("admin_billing_payment_method_added_success", 14, 7),
    weekQuery("server_cottage_live_status_changed", 7,  0),
    weekQuery("server_cottage_live_status_changed", 14, 7),
    weekQuery("booking_payment_success", 7,  0),
    weekQuery("booking_payment_success", 14, 7),
  ]);

  const curr = {
    pageviews:        Number(trafficCurr[0]?.[0]  ?? 0),
    uniqueVisitors:   Number(trafficCurr[0]?.[1]  ?? 0),
    registrations:    Number(signupsCurr[0]?.[0]  ?? 0),
    contentCreated:   Number(contentCurr[0]?.[0]  ?? 0),
    paymentCardAdded: Number(paymentCurr[0]?.[0]  ?? 0),
    wentLive:         Number(liveCurr[0]?.[0]     ?? 0),
    bookings:         Number(bookingsCurr[0]?.[0] ?? 0),
  };

  const prev = {
    pageviews:        Number(trafficPrev[0]?.[0]  ?? 0),
    uniqueVisitors:   Number(trafficPrev[0]?.[1]  ?? 0),
    registrations:    Number(signupsPrev[0]?.[0]  ?? 0),
    contentCreated:   Number(contentPrev[0]?.[0]  ?? 0),
    paymentCardAdded: Number(paymentPrev[0]?.[0]  ?? 0),
    wentLive:         Number(livePrev[0]?.[0]     ?? 0),
    bookings:         Number(bookingsPrev[0]?.[0] ?? 0),
  };

  return { curr, prev };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(date) {
  return date.toLocaleDateString("sv-SE");
}

function delta(curr, prev) {
  if (prev === 0) return curr > 0 ? { pct: null, up: true } : { pct: null, up: null };
  const pct = Math.round(((curr - prev) / prev) * 100);
  return { pct, up: pct >= 0 };
}

function trendLabel(curr, prev) {
  const { pct, up } = delta(curr, prev);
  if (up === null) return { text: "No data", color: "#9ca3af" };
  if (pct === null) return { text: up ? "New" : "-", color: "#9ca3af" };
  const arrow = up ? "+" : "";
  return {
    text: `${arrow}${pct}% vs last week`,
    color: up ? "#16a34a" : "#dc2626",
  };
}

// ─── Charts ──────────────────────────────────────────────────────────────────

const chartCanvas = new ChartJSNodeCanvas({ width: 480, height: 300, backgroundColour: "white" });

function renderChart(label, currVal, prevVal) {
  return chartCanvas.renderToBuffer({
    type: "bar",
    data: {
      labels: ["This Week", "Last Week"],
      datasets: [{
        data: [currVal, prevVal],
        backgroundColor: ["#1a56db", "#93c5fd"],
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: label,
          font: { size: 16, weight: "bold", family: "Arial" },
          color: "#0f172a",
          padding: { bottom: 10 },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { font: { size: 11 }, color: "#64748b" },
          grid: { color: "#e2e8f0" },
        },
        x: {
          ticks: { font: { size: 12 }, color: "#374151" },
          grid: { display: false },
        },
      },
    },
  });
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

async function generatePDF({ curr, prev }, filePath) {
  // Pre-render all chart images and write to temp PNG files
  const chartDefs = [
    { label: "Page Views",          curr: curr.pageviews,        prev: prev.pageviews },
    { label: "Unique Visitors",     curr: curr.uniqueVisitors,   prev: prev.uniqueVisitors },
    { label: "New Sign-ups",        curr: curr.registrations,    prev: prev.registrations },
    { label: "Cottages Created",    curr: curr.contentCreated,   prev: prev.contentCreated },
    { label: "Payment Card Added",  curr: curr.paymentCardAdded, prev: prev.paymentCardAdded },
    { label: "Went Live",           curr: curr.wentLive,         prev: prev.wentLive },
    { label: "Successful Bookings", curr: curr.bookings,         prev: prev.bookings },
  ];

  const dir = path.dirname(fileURLToPath(import.meta.url));
  const chartPaths = await Promise.all(chartDefs.map(async (def, i) => {
    const buf = await renderChart(def.label, def.curr, def.prev);
    const p = path.join(dir, `chart-${i}.png`);
    writeFileSync(p, buf);
    return p;
  }));

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 0, size: "A4" });
    const stream = createWriteStream(filePath);
    doc.pipe(stream);

    const now         = new Date();
    const weekAgo     = new Date(now - 7  * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000);

    const PW    = doc.page.width;
    const BLUE  = "#1a56db";
    const DARK  = "#0f172a";
    const MID   = "#64748b";
    const LITE  = "#f8fafc";
    const LINE  = "#e2e8f0";
    const WHITE = "#ffffff";
    const L     = 48;
    const R     = PW - 48;
    const CW    = R - L;

    // ── PAGE 1: KPI Table ────────────────────────────────────────────────────

    // Header
    doc.rect(0, 0, PW, 100).fill(BLUE);
    doc.rect(0, 100, PW, 4).fill("#1e40af");
    doc.fillColor(WHITE).font("Helvetica-Bold").fontSize(22)
       .text("Cottage-Booking.com", L, 26);
    doc.font("Helvetica").fontSize(11).fillColor("#bfdbfe")
       .text(`Weekly KPI Report  \u2022  ${formatDate(weekAgo)} \u2013 ${formatDate(now)}`, L, 56);
    doc.fontSize(9).fillColor("#93c5fd")
       .text(`Previous week: ${formatDate(twoWeeksAgo)} \u2013 ${formatDate(weekAgo)}`, L, 76);

    // Column headers
    const COL = { label: L + 8, curr: 310, prev: 390, trend: 456 };
    let y = 124;

    doc.rect(L, y, CW, 24).fill("#f1f5f9");
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MID);
    doc.text("METRIC",    COL.label, y + 8);
    doc.text("THIS WEEK", COL.curr,  y + 8, { width: 70, align: "right" });
    doc.text("LAST WEEK", COL.prev,  y + 8, { width: 70, align: "right" });
    doc.text("CHANGE",    COL.trend, y + 8, { width: CW - (COL.trend - L) - 8, align: "right" });
    y += 24;

    const ROW_H = 42;
    let shade = false;

    const kpiRow = (section, label, currVal, prevVal) => {
      if (section) {
        y += 6;
        doc.rect(L, y, CW, 20).fill(BLUE);
        doc.font("Helvetica-Bold").fontSize(8).fillColor(WHITE)
           .text(section.toUpperCase(), COL.label, y + 6);
        y += 20;
        shade = false;
      }

      if (shade) doc.rect(L, y, CW, ROW_H).fill(LITE);
      shade = !shade;

      const { text: tText, color: tColor } = trendLabel(currVal, prevVal);

      doc.font("Helvetica").fontSize(11).fillColor(DARK)
         .text(label, COL.label, y + 14, { width: 200 });
      doc.font("Helvetica-Bold").fontSize(16).fillColor(BLUE)
         .text(currVal.toLocaleString(), COL.curr, y + 12, { width: 70, align: "right" });
      doc.font("Helvetica").fontSize(11).fillColor(MID)
         .text(prevVal.toLocaleString(), COL.prev, y + 14, { width: 70, align: "right" });
      doc.font("Helvetica-Bold").fontSize(10).fillColor(tColor)
         .text(tText, COL.trend, y + 14, { width: CW - (COL.trend - L) - 8, align: "right" });
      doc.moveTo(L, y + ROW_H).lineTo(R, y + ROW_H).strokeColor(LINE).lineWidth(0.5).stroke();
      y += ROW_H;
    };

    kpiRow("Website Traffic", "Page Views",          curr.pageviews,        prev.pageviews);
    kpiRow(null,              "Unique Visitors",      curr.uniqueVisitors,   prev.uniqueVisitors);
    kpiRow("Registrations",   "New Sign-ups",         curr.registrations,    prev.registrations);
    kpiRow("Content",         "Cottages Created",     curr.contentCreated,   prev.contentCreated);
    kpiRow("Activation",      "Payment Card Added",   curr.paymentCardAdded, prev.paymentCardAdded);
    kpiRow(null,              "Went Live",             curr.wentLive,         prev.wentLive);
    kpiRow("Bookings",        "Successful Bookings",  curr.bookings,         prev.bookings);

    // Summary box
    y += 16;
    doc.rect(L, y, CW, 52).fill("#eff6ff").stroke(LINE);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(BLUE)
       .text("WEEK SUMMARY", L + 12, y + 10);

    const summaryItems = [
      { label: "Traffic",      val: curr.pageviews },
      { label: "Sign-ups",     val: curr.registrations },
      { label: "New Listings", val: curr.contentCreated },
      { label: "Bookings",     val: curr.bookings },
    ];
    const colW = CW / summaryItems.length;
    summaryItems.forEach((item, i) => {
      const sx = L + i * colW;
      doc.font("Helvetica-Bold").fontSize(18).fillColor(BLUE)
         .text(item.val.toLocaleString(), sx, y + 22, { width: colW, align: "center" });
      doc.font("Helvetica").fontSize(8).fillColor(MID)
         .text(item.label, sx, y + 41, { width: colW, align: "center" });
    });

    // Footer page 1
    const footerY1 = doc.page.height - 36;
    doc.rect(0, footerY1 - 4, PW, 40).fill("#f1f5f9");
    doc.font("Helvetica").fontSize(8).fillColor(MID)
       .text(
         `Generated ${formatDate(now)}  \u2022  Data: PostHog  \u2022  cottage-booking.com`,
         L, footerY1 + 4, { width: CW, align: "center" }
       );

    // ── PAGE 2: Charts ───────────────────────────────────────────────────────

    doc.addPage();

    // Header
    doc.rect(0, 0, PW, 100).fill(BLUE);
    doc.rect(0, 100, PW, 4).fill("#1e40af");
    doc.fillColor(WHITE).font("Helvetica-Bold").fontSize(22)
       .text("Cottage-Booking.com", L, 26);
    doc.font("Helvetica").fontSize(11).fillColor("#bfdbfe")
       .text(`Weekly KPI Report  \u2022  Charts  \u2022  ${formatDate(weekAgo)} \u2013 ${formatDate(now)}`, L, 56);

    // 2-column chart grid
    const chartW = (CW - 16) / 2;
    const chartH = Math.round(chartW * (300 / 480));
    const rowH   = chartH + 16;
    let cy = 116;

    chartPaths.forEach((p, i) => {
      const col  = i % 2;
      if (col === 0 && i !== 0) cy += rowH;
      const cx = (i === chartPaths.length - 1 && chartPaths.length % 2 !== 0)
        ? L + (CW - chartW) / 2
        : L + col * (chartW + 16);
      doc.image(p, cx, cy, { width: chartW, height: chartH });
    });

    // Footer page 2
    const footerY2 = doc.page.height - 36;
    doc.rect(0, footerY2 - 4, PW, 40).fill("#f1f5f9");
    doc.font("Helvetica").fontSize(8).fillColor(MID)
       .text(
         `Generated ${formatDate(now)}  \u2022  Data: PostHog  \u2022  cottage-booking.com`,
         L, footerY2 + 4, { width: CW, align: "center" }
       );

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  // Clean up temp chart files
  chartPaths.forEach(p => unlinkSync(p));
}

// ─── Email ───────────────────────────────────────────────────────────────────

function trendBadge(curr, prev) {
  const { pct, up } = delta(curr, prev);
  if (up === null) return `<span style="color:#9ca3af;font-size:11px">\u2013</span>`;
  if (pct === null) return `<span style="color:#16a34a;font-size:11px">New</span>`;
  const arrow = up ? "&#9650;" : "&#9660;";
  const color = up ? "#16a34a" : "#dc2626";
  return `<span style="color:${color};font-size:11px">${arrow} ${Math.abs(pct)}%</span>`;
}

async function sendEmail({ curr, prev }, pdfPath) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_PASSWORD },
  });

  const now     = new Date();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const row = (label, currVal, prevVal, shade) => `
    <tr style="background:${shade ? "#f8fafc" : "#fff"}">
      <td style="padding:12px 16px;font-size:13px;color:#374151">${label}</td>
      <td style="padding:12px 16px;text-align:right;font-size:18px;font-weight:bold;color:#1a56db">${currVal.toLocaleString()}</td>
      <td style="padding:12px 16px;text-align:right;font-size:13px;color:#6b7280">${prevVal.toLocaleString()}</td>
      <td style="padding:12px 16px;text-align:right">${trendBadge(currVal, prevVal)}</td>
    </tr>`;

  const section = (title) => `
    <tr style="background:#1a56db">
      <td colspan="4" style="padding:8px 16px;font-size:11px;font-weight:bold;color:#bfdbfe;letter-spacing:0.05em">${title.toUpperCase()}</td>
    </tr>`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
      <div style="background:#1a56db;padding:28px 32px">
        <h1 style="color:#fff;margin:0;font-size:22px;font-weight:bold">Cottage-Booking.com</h1>
        <p style="color:#bfdbfe;margin:6px 0 0;font-size:13px">
          Weekly KPI Report &mdash; ${weekAgo.toLocaleDateString("sv-SE")} to ${now.toLocaleDateString("sv-SE")}
        </p>
      </div>
      <div style="padding:24px 32px">
        <table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">
          <tr style="background:#f1f5f9">
            <th style="padding:10px 16px;text-align:left;font-size:11px;color:#64748b;font-weight:600">METRIC</th>
            <th style="padding:10px 16px;text-align:right;font-size:11px;color:#64748b;font-weight:600">THIS WEEK</th>
            <th style="padding:10px 16px;text-align:right;font-size:11px;color:#64748b;font-weight:600">LAST WEEK</th>
            <th style="padding:10px 16px;text-align:right;font-size:11px;color:#64748b;font-weight:600">CHANGE</th>
          </tr>
          ${section("Website Traffic")}
          ${row("Page Views",          curr.pageviews,        prev.pageviews,        false)}
          ${row("Unique Visitors",     curr.uniqueVisitors,   prev.uniqueVisitors,   true)}
          ${section("Registrations")}
          ${row("New Sign-ups",        curr.registrations,    prev.registrations,    false)}
          ${section("Content")}
          ${row("Cottages Created",    curr.contentCreated,   prev.contentCreated,   false)}
          ${section("Activation")}
          ${row("Payment Card Added",  curr.paymentCardAdded, prev.paymentCardAdded, false)}
          ${row("Went Live",           curr.wentLive,         prev.wentLive,         true)}
          ${section("Bookings")}
          ${row("Successful Bookings", curr.bookings,         prev.bookings,         false)}
        </table>
      </div>
      <div style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e5e7eb;text-align:center">
        <p style="color:#94a3b8;font-size:11px;margin:0">Full report attached as PDF &mdash; cottage-booking.com</p>
      </div>
    </div>`;

  await transporter.sendMail({
    from: `"Cottage-Booking KPI" <${GMAIL_USER}>`,
    to: REPORT_RECIPIENT,
    subject: `Weekly KPI Report \u2014 ${now.toLocaleDateString("sv-SE")}`,
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
console.log("This week:", kpis.curr);
console.log("Last week:", kpis.prev);

console.log("Generating PDF...");
await generatePDF(kpis, pdfPath);

console.log("Sending email...");
await sendEmail(kpis, pdfPath);

await unlink(pdfPath);
console.log("Done. Report sent to", REPORT_RECIPIENT);
