import axios from "axios";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import { createWriteStream } from "fs";
import { unlink } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";

const POSTHOG_BASE       = "https://eu.posthog.com";
const POSTHOG_PROJECT_ID = "86171";
const POSTHOG_API_KEY    = process.env.POSTHOG_API_KEY;
const GMAIL_USER         = process.env.GMAIL_USER;
const GMAIL_PASSWORD     = process.env.GMAIL_PASSWORD;
const REPORT_RECIPIENT   = process.env.REPORT_RECIPIENT;

const LIGHTDASH_BASE    = "https://bi-cottage.jaype.tools";
const LIGHTDASH_TOKEN   = process.env.LIGHTDASH_TOKEN;
const LIGHTDASH_PROJECT = "75a3e11e-e80f-4fb6-b8d2-918c1be75104";

// ─── Veckogränser (föregående kalender-vecka, mån–sön) ───────────────────────

function getWeekBounds() {
  const now    = new Date();
  const dow    = now.getUTCDay() || 7; // mån=1 … sön=7 (UTC)

  // Allt beräknas i UTC för att matcha PostHogs timestamp-lagring
  const thisMon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (dow - 1)));
  const lastMon = new Date(thisMon.getTime() - 7 * 86400000);
  const prevMon = new Date(lastMon.getTime() - 7 * 86400000);
  const lastSun = new Date(thisMon.getTime() - 86400000);
  const prevSun = new Date(lastMon.getTime() - 86400000);

  const fmt = (d) => d.toISOString().slice(0, 10);

  return {
    curr: { start: lastMon, end: lastSun, startStr: fmt(lastMon), endStr: fmt(thisMon) },
    prev: { start: prevMon, end: prevSun, startStr: fmt(prevMon), endStr: fmt(lastMon) },
  };
}

// ─── PostHog ────────────────────────────────────────────────────────────────

async function query(sql) {
  const res = await axios.post(
    `${POSTHOG_BASE}/api/projects/${POSTHOG_PROJECT_ID}/query/`,
    { query: { kind: "HogQLQuery", query: sql } },
    { headers: { Authorization: `Bearer ${POSTHOG_API_KEY}` } }
  );
  return res.data.results;
}

function weekQuery(event, startStr, endStr) {
  return query(`
    SELECT count()
    FROM events
    WHERE event = '${event}'
      AND timestamp >= '${startStr}'
      AND timestamp < '${endStr}'
  `);
}

async function fetchKPIs() {
  const wb = getWeekBounds();
  const [
    trafficCurr,  trafficPrev,
    signupsCurr,  signupsPrev,
    verifiedCurr, verifiedPrev,
    cottageCurr,  cottagePrev,
    paymentCurr,  paymentPrev,
    liveCurr,     livePrev,
    bookingsCurr, bookingsPrev,
  ] = await Promise.all([
    query(`
      SELECT count() AS pageviews, count(DISTINCT distinct_id) AS unique_visitors
      FROM events WHERE event = '$pageview'
        AND timestamp >= '${wb.curr.startStr}' AND timestamp < '${wb.curr.endStr}'
    `),
    query(`
      SELECT count() AS pageviews, count(DISTINCT distinct_id) AS unique_visitors
      FROM events WHERE event = '$pageview'
        AND timestamp >= '${wb.prev.startStr}' AND timestamp < '${wb.prev.endStr}'
    `),
    weekQuery("server_platform_signup_success",             wb.curr.startStr, wb.curr.endStr),
    weekQuery("server_platform_signup_success",             wb.prev.startStr, wb.prev.endStr),
    weekQuery("email_verification_completed",               wb.curr.startStr, wb.curr.endStr),
    weekQuery("email_verification_completed",               wb.prev.startStr, wb.prev.endStr),
    weekQuery("server_setup_setup_step_completed_1",        wb.curr.startStr, wb.curr.endStr),
    weekQuery("server_setup_setup_step_completed_1",        wb.prev.startStr, wb.prev.endStr),
    query(`
      SELECT count(DISTINCT JSONExtractString(properties, '$group_0'))
      FROM events
      WHERE event = 'admin_billing_payment_method_added_success'
        AND timestamp >= '${wb.curr.startStr}' AND timestamp < '${wb.curr.endStr}'
    `),
    query(`
      SELECT count(DISTINCT JSONExtractString(properties, '$group_0'))
      FROM events
      WHERE event = 'admin_billing_payment_method_added_success'
        AND timestamp >= '${wb.prev.startStr}' AND timestamp < '${wb.prev.endStr}'
    `),
    query(`
      SELECT count(DISTINCT JSONExtractString(properties, 'cottage_id'))
      FROM events
      WHERE event = 'server_cottage_live_status_changed'
        AND JSONExtractString(properties, 'action') = 'went_live'
        AND timestamp >= '${wb.curr.startStr}' AND timestamp < '${wb.curr.endStr}'
    `),
    query(`
      SELECT count(DISTINCT JSONExtractString(properties, 'cottage_id'))
      FROM events
      WHERE event = 'server_cottage_live_status_changed'
        AND JSONExtractString(properties, 'action') = 'went_live'
        AND timestamp >= '${wb.prev.startStr}' AND timestamp < '${wb.prev.endStr}'
    `),
    weekQuery("booking_payment_success",                    wb.curr.startStr, wb.curr.endStr),
    weekQuery("booking_payment_success",                    wb.prev.startStr, wb.prev.endStr),
  ]);

  const signC = Number(signupsCurr[0]?.[0]  ?? 0);
  const signP = Number(signupsPrev[0]?.[0]  ?? 0);
  const verC  = Number(verifiedCurr[0]?.[0] ?? 0);
  const verP  = Number(verifiedPrev[0]?.[0] ?? 0);

  const curr = {
    pageviews:        Number(trafficCurr[0]?.[0]  ?? 0),
    uniqueVisitors:   Number(trafficCurr[0]?.[1]  ?? 0),
    registrations:    signC,
    emailVerified:    verC,
    emailUnverified:  Math.max(0, signC - verC),
    cottageCreated:   Number(cottageCurr[0]?.[0]  ?? 0),
    paymentCardAdded: Number(paymentCurr[0]?.[0]  ?? 0),
    wentLive:         Number(liveCurr[0]?.[0]     ?? 0),
    bookings:         Number(bookingsCurr[0]?.[0] ?? 0),
  };

  const prev = {
    pageviews:        Number(trafficPrev[0]?.[0]  ?? 0),
    uniqueVisitors:   Number(trafficPrev[0]?.[1]  ?? 0),
    registrations:    signP,
    emailVerified:    verP,
    emailUnverified:  Math.max(0, signP - verP),
    cottageCreated:   Number(cottagePrev[0]?.[0]  ?? 0),
    paymentCardAdded: Number(paymentPrev[0]?.[0]  ?? 0),
    wentLive:         Number(livePrev[0]?.[0]     ?? 0),
    bookings:         Number(bookingsPrev[0]?.[0] ?? 0),
  };

  return { curr, prev };
}

async function fetchLandingPages() {
  const wb = getWeekBounds();
  return query(`
    SELECT properties.$pathname AS path, count() AS cnt
    FROM events
    WHERE event = '$pageview'
      AND timestamp >= '${wb.curr.startStr}' AND timestamp < '${wb.curr.endStr}'
    GROUP BY path
    ORDER BY cnt DESC
    LIMIT 8
  `);
}

// ─── Lightdash ───────────────────────────────────────────────────────────────

async function lightdashExplore(exploreName, body) {
  const res = await axios.post(
    `${LIGHTDASH_BASE}/api/v1/projects/${LIGHTDASH_PROJECT}/explores/${exploreName}/runQuery`,
    body,
    { headers: { Authorization: `ApiKey ${LIGHTDASH_TOKEN}` } }
  );
  return res.data.results?.rows ?? [];
}

// Hämtar registreringar (totalt/verifierade/ej verifierade) från Lightdash per vecka.
// Lightdash-veckor börjar på söndag; PostHog-veckor börjar på måndag — vi skiftar -1 dag.
async function fetchLightdashRegistrations() {
  const rows = await lightdashExplore("dim_users", {
    exploreName: "dim_users",
    dimensions: ["dim_users_is_email_verified", "dim_users_created_at_week"],
    metrics: ["dim_users_total_users"],
    filters: {},
    sorts: [{ fieldId: "dim_users_created_at_week", descending: false }],
    limit: 500,
    tableCalculations: [], additionalMetrics: [], customDimensions: [],
  });

  const byWeek = {};
  for (const row of rows) {
    const week = String(row.dim_users_created_at_week?.value?.raw ?? "").slice(0, 10);
    const isVerified = row.dim_users_is_email_verified?.value?.raw === true;
    const count = Number(row.dim_users_total_users?.value?.raw ?? 0);
    if (!week) continue;
    if (!byWeek[week]) byWeek[week] = { verified: 0, unverified: 0 };
    if (isVerified) byWeek[week].verified += count;
    else byWeek[week].unverified += count;
  }

  const get = (key) => ({
    total:      (byWeek[key]?.verified ?? 0) + (byWeek[key]?.unverified ?? 0),
    verified:   byWeek[key]?.verified   ?? 0,
    unverified: byWeek[key]?.unverified ?? 0,
  });

  // Hitta avslutade veckor dynamiskt — oberoende av veckodag-konvention i Lightdash.
  // En vecka anses avslutad om minst 7 dagar gått sedan den börjad.
  const todayMs  = Date.now();
  const allKeys  = Object.keys(byWeek).sort(); // kronologisk ordning
  const doneKeys = allKeys.filter(k => (todayMs - new Date(k).getTime()) >= 7 * 24 * 60 * 60 * 1000);

  // Ta de 7 senaste avslutade veckorna (padda med null om färre finns)
  const histKeys = doneKeys.slice(-7);
  while (histKeys.length < 7) histKeys.unshift(null);

  return {
    curr: get(histKeys[6]), // senaste avslutade vecka
    prev: get(histKeys[5]), // veckan dessförinnan
    history: {
      registrations:   histKeys.map(k => k ? get(k).total    : 0),
      emailVerified:   histKeys.map(k => k ? get(k).verified  : 0),
      emailUnverified: histKeys.map(k => k ? get(k).unverified : 0),
    },
  };
}

// Hämtar 8 veckors historik (kalender-veckor) för linjediagram
async function fetchHistory() {
  const weeklyQuery = (event) => query(`
    SELECT toMonday(timestamp) AS week, count() AS cnt
    FROM events
    WHERE event = '${event}'
      AND timestamp >= now() - INTERVAL 56 DAY
    GROUP BY week
    ORDER BY week
  `);

  const [trafficRows, signupRows, verifiedRows, cottageRows, paymentRows, liveRows, bookingRows] = await Promise.all([
    query(`
      SELECT toMonday(timestamp) AS week,
             count()                 AS pv,
             count(DISTINCT distinct_id) AS uv
      FROM events WHERE event = '$pageview'
        AND timestamp >= now() - INTERVAL 56 DAY
      GROUP BY week ORDER BY week
    `),
    weeklyQuery("server_platform_signup_success"),
    weeklyQuery("email_verification_completed"),
    weeklyQuery("server_setup_setup_step_completed_1"),
    query(`
      SELECT toMonday(timestamp) AS week, count(DISTINCT JSONExtractString(properties, '$group_0')) AS cnt
      FROM events
      WHERE event = 'admin_billing_payment_method_added_success'
        AND timestamp >= now() - INTERVAL 56 DAY
      GROUP BY week ORDER BY week
    `),
    query(`
      SELECT toMonday(timestamp) AS week, count(DISTINCT JSONExtractString(properties, 'cottage_id')) AS cnt
      FROM events
      WHERE event = 'server_cottage_live_status_changed'
        AND JSONExtractString(properties, 'action') = 'went_live'
        AND timestamp >= now() - INTERVAL 56 DAY
      GROUP BY week ORDER BY week
    `),
    weeklyQuery("booking_payment_success"),
  ]);

  // Generera 7 avslutade måndagar bakåt i UTC (matchar PostHogs toMonday)
  const now    = new Date();
  const dow    = now.getUTCDay() || 7;
  const thisMon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (dow - 1)));

  const weekStarts = [];
  for (let i = 7; i >= 1; i--) {
    weekStarts.push(new Date(thisMon.getTime() - i * 7 * 86400000));
  }

  const dKey  = (d) => d.toISOString().slice(0, 10);  // UTC-datum (matchar PostHog)
  const toKey = (v)  => String(v).slice(0, 10);

  const fillSeries = (rows, vi = 1) => {
    const map = {};
    for (const r of rows) map[toKey(r[0])] = Number(r[vi] ?? 0);
    return weekStarts.map(d => map[dKey(d)] ?? 0);
  };

  const regs     = fillSeries(signupRows);
  const verified = fillSeries(verifiedRows);
  return {
    weekStarts,
    pageviews:       fillSeries(trafficRows, 1),
    uniqueVisitors:  fillSeries(trafficRows, 2),
    registrations:   regs,
    emailVerified:   verified,
    emailUnverified: regs.map((r, i) => Math.max(0, r - verified[i])),
    cottageCreated:  fillSeries(cottageRows),
    paymentCard:     fillSeries(paymentRows),
    wentLive:        fillSeries(liveRows),
    bookings:        fillSeries(bookingRows),
  };
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

function num(n) {
  return n.toLocaleString("sv-SE");
}

function avg8(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;  // float, avrundas vid visning
}

function isoWeekNumber(date) {
  const d      = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// ─── Linjediagram ────────────────────────────────────────────────────────────

function drawLineChart(doc, x, y, w, h, label, values, weekStarts, dec = 1) {
  const BLUE  = "#1a56db";
  const AMBER = "#f59e0b";
  const DARK  = "#111827";
  const MID   = "#9CA3AF";
  const LINE  = "#F3F4F6";

  const titleH      = 18;
  const xAxisH      = 22;
  const yAxisW      = 26;
  const rightMargin = 34; // plats för avg-etikett utanför plotlinjen
  const plotX  = x + yAxisW;
  const plotY  = y + titleH;
  const plotW  = w - yAxisW - rightMargin;
  const plotH  = h - titleH - xAxisH;
  const n      = values.length;
  const maxVal = Math.max(...values, 1);

  // Rubrik
  doc.font("Helvetica-Bold").fontSize(8).fillColor(DARK)
     .text(label, x, y + 4, { width: w, align: "center" });

  // Dynamisk gridN: vid små heltalsvärden undviks dubbletter på y-axeln
  const gridN = maxVal <= 4 ? Math.ceil(maxVal) : 4;
  for (let i = 0; i <= gridN; i++) {
    const gy  = plotY + (plotH / gridN) * i;
    const val = Math.round(maxVal * (gridN - i) / gridN);
    doc.moveTo(plotX, gy).lineTo(plotX + plotW, gy)
       .strokeColor(LINE).lineWidth(0.5).stroke();
    doc.font("Helvetica").fontSize(5.5).fillColor(MID)
       .text(num(val), x, gy - 3.5, { width: yAxisW - 5, align: "right" });
  }

  // Punktkoordinater
  const pts = values.map((v, i) => ({
    px: plotX + (i / (n - 1)) * plotW,
    py: plotY + plotH - (v / maxVal) * plotH,
    v,
  }));

  // Lätt fyllning under linjen
  doc.save();
  doc.moveTo(pts[0].px, plotY + plotH);
  pts.forEach(p => doc.lineTo(p.px, p.py));
  doc.lineTo(pts[n - 1].px, plotY + plotH);
  doc.closePath();
  doc.fillColor("#EFF6FF").fill();
  doc.restore();

  // Datalinje
  doc.moveTo(pts[0].px, pts[0].py);
  for (let i = 1; i < n; i++) doc.lineTo(pts[i].px, pts[i].py);
  doc.strokeColor(BLUE).lineWidth(1.5).stroke();

  // Punkter + värdesetiketter för små-skaliga diagram
  pts.forEach((p, i) => {
    const isLast = i === n - 1;
    doc.circle(p.px, p.py, 2.5).fillColor(isLast ? BLUE : "#FFFFFF").fill();
    doc.circle(p.px, p.py, 2.5).strokeColor(BLUE).lineWidth(1.2).stroke();
    // Visa värdet ovanför punkten när skalan är liten (undviker onödig text på stora diagram)
    if (maxVal <= 5 && values[i] > 0) {
      const vLabel = values[i].toLocaleString("sv-SE", { maximumFractionDigits: 0 });
      doc.font("Helvetica-Bold").fontSize(5).fillColor(BLUE)
         .text(vLabel, p.px - 8, p.py - 9, { width: 16, align: "center" });
    }
  });

  // Snittlinje (streckad, amber)
  const avg  = values.reduce((a, b) => a + b, 0) / n;
  const avgY = plotY + plotH - (avg / maxVal) * plotH;
  doc.moveTo(plotX, avgY).lineTo(plotX + plotW, avgY)
     .strokeColor(AMBER).lineWidth(1).dash(4, { space: 3 }).stroke();
  doc.undash();

  // Snitt-etikett till höger utanför plotlinjen
  const avgLabel = avg.toLocaleString("sv-SE", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  doc.font("Helvetica-Bold").fontSize(5.5).fillColor(AMBER)
     .text(avgLabel, plotX + plotW + 3, avgY - 3.5, { width: rightMargin - 5 });

  // X-axel veckonummer
  pts.forEach((p, i) => {
    const wn = isoWeekNumber(weekStarts[i]);
    doc.font("Helvetica").fontSize(5.5).fillColor(MID)
       .text(`V.${wn}`, p.px - 8, plotY + plotH + 5, { width: 16, align: "center" });
  });

  // Liten legend längst ner
  const legY = plotY + plotH + 14;
  const midX = x + w / 2;

  doc.moveTo(midX - 42, legY + 2.5).lineTo(midX - 30, legY + 2.5)
     .strokeColor(BLUE).lineWidth(1.5).stroke();
  doc.font("Helvetica").fontSize(5.5).fillColor(MID)
     .text("Veckovärde", midX - 28, legY - 0.5);

  doc.moveTo(midX + 8, legY + 2.5).lineTo(midX + 20, legY + 2.5)
     .strokeColor(AMBER).lineWidth(1).dash(4, { space: 2 }).stroke();
  doc.undash();
  doc.font("Helvetica").fontSize(5.5).fillColor(MID)
     .text("Snitt/vecka", midX + 22, legY - 0.5);
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

function generatePDF({ curr, prev, history }, filePath) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 0, size: "A4" });
    const stream = createWriteStream(filePath);
    doc.pipe(stream);

    const wb          = getWeekBounds();
    const now         = new Date();
    const weekAgo     = wb.curr.start;   // föregående måndag
    const weekEnd     = wb.curr.end;     // föregående söndag
    const twoWeeksAgo = wb.prev.start;   // måndagen veckan dessförinnan

    const PW    = doc.page.width;
    const PH    = doc.page.height;
    const L     = 40;
    const R     = PW - 40;
    const CW    = R - L;

    const DARK   = "#111827";
    const BLUE   = "#1a56db";
    const MID    = "#6B7280";
    const MUTED  = "#9CA3AF";
    const LITE   = "#F9FAFB";
    const BORDER = "#E5E7EB";
    const WHITE  = "#FFFFFF";
    const GREEN  = "#15803D";
    const RED    = "#DC2626";
    const GBG    = "#DCFCE7";
    const RBG    = "#FEE2E2";

    // ── Hjälpfunktioner ────────────────────────────────────────────────────

    const badge = (bx, by, text, bgColor, fgColor) => {
      doc.roundedRect(bx, by, 52, 16, 8).fill(bgColor);
      doc.font("Helvetica-Bold").fontSize(7).fillColor(fgColor)
         .text(text, bx, by + 4.5, { width: 52, align: "center" });
    };

    const kpiCard = (d, cx, cy, cw, label, currVal, prevVal) => {
      const ch = 76;
      doc.roundedRect(cx + 1, cy + 1, cw, ch, 6).fill("#EDEDF0");
      doc.roundedRect(cx, cy, cw, ch, 6).fill(WHITE);
      doc.roundedRect(cx, cy, cw, ch, 6).stroke(BORDER).lineWidth(0.5);
      doc.rect(cx, cy, cw, 3).fill(BLUE);
      doc.roundedRect(cx, cy, cw, ch, 6).stroke(BORDER).lineWidth(0.5);

      doc.font("Helvetica").fontSize(8).fillColor(MID)
         .text(label, cx + 12, cy + 10, { width: cw - 70 });
      doc.font("Helvetica-Bold").fontSize(22).fillColor(DARK)
         .text(num(currVal), cx + 12, cy + 22);

      const { pct, up } = delta(currVal, prevVal);
      if (up !== null) {
        // Använd + / - (Helvetica stödjer inte unicode-pilar)
        const sign  = up ? "+" : "-";
        const bText = pct === null ? "Ny" : `${sign}${Math.abs(pct)}%`;
        badge(cx + cw - 62, cy + 8, bText, up ? GBG : RBG, up ? GREEN : RED);
      }

      // Förra veckan
      doc.font("Helvetica").fontSize(7).fillColor(MUTED)
         .text(`F\u00f6rra veckan: ${num(prevVal)}`, cx + 12, cy + ch - 24, { width: cw - 20 });
      // Snitt senaste 7 veckorna (1 decimal för små tal)
      if (d.avg != null) {
        const dec = d.dec ?? 0;
        const avgStr = d.avg.toLocaleString("sv-SE", { minimumFractionDigits: dec, maximumFractionDigits: dec });
        doc.font("Helvetica").fontSize(7).fillColor(MUTED)
           .text(`Snitt: ${avgStr}`, cx + 12, cy + ch - 13, { width: cw - 20 });
      }
    };

    const sectionBand = (title, sy) => {
      doc.rect(L, sy, CW, 22).fill(LITE);
      doc.moveTo(L, sy).lineTo(R, sy).strokeColor(BORDER).lineWidth(0.5).stroke();
      doc.font("Helvetica-Bold").fontSize(7).fillColor(MUTED)
         .text(title.toUpperCase(), L + 10, sy + 7.5, { characterSpacing: 0.9 });
      return sy + 22;
    };

    const cardRow = (ry, defs) => {
      const n     = defs.length;
      const gap   = 12;
      const cardW = (CW - gap * (n - 1)) / n;
      defs.forEach((d, i) => kpiCard(d, L + i * (cardW + gap), ry, cardW, d.label, d.curr, d.prev));
      return ry + 76 + 10;
    };

    // ── Sida 1: KPI-kort ────────────────────────────────────────────────────

    doc.rect(0, 0, PW, 88).fill(DARK);
    doc.rect(0, 88, PW, 3).fill(BLUE);

    doc.font("Helvetica-Bold").fontSize(20).fillColor(WHITE).text("Cottage-Booking.com", L, 22);
    doc.font("Helvetica").fontSize(10).fillColor(MUTED).text("Veckorapport KPI", L, 48);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(WHITE)
       .text(`${formatDate(weekAgo)} \u2013 ${formatDate(weekEnd)}`, L, 22, { width: CW, align: "right" });
    doc.font("Helvetica").fontSize(8).fillColor(MUTED)
       .text(`F\u00f6reg. vecka: ${formatDate(twoWeeksAgo)} \u2013 ${formatDate(weekAgo)}`, L, 38, { width: CW, align: "right" });

    let y = 101;

    y = sectionBand("Webbtrafik", y);
    y = cardRow(y + 8, [
      { label: "Sidvisningar",        curr: curr.pageviews,      prev: prev.pageviews,      avg: avg8(history.pageviews),      dec: 0 },
      { label: "Unika bes\u00f6kare", curr: curr.uniqueVisitors, prev: prev.uniqueVisitors, avg: avg8(history.uniqueVisitors), dec: 0 },
    ]);

    y += 4; y = sectionBand("Registrering", y);
    y = cardRow(y + 8, [
      { label: "Totalt",         curr: curr.registrations,   prev: prev.registrations,   avg: avg8(history.registrations),   dec: 0 },
      { label: "Verifierade",    curr: curr.emailVerified,   prev: prev.emailVerified,   avg: avg8(history.emailVerified),   dec: 1 },
      { label: "Ej verifierade", curr: curr.emailUnverified, prev: prev.emailUnverified, avg: avg8(history.emailUnverified), dec: 1 },
    ]);

    y += 4; y = sectionBand("Aktivering", y);
    y = cardRow(y + 8, [
      { label: "P\u00e5b\u00f6rjad Set up", curr: curr.cottageCreated,   prev: prev.cottageCreated,   avg: avg8(history.cottageCreated), dec: 1 },
      { label: "Betalkort tillagt",         curr: curr.paymentCardAdded, prev: prev.paymentCardAdded, avg: avg8(history.paymentCard),    dec: 1 },
    ]);

    y += 4; y = sectionBand("Status", y);
    y = cardRow(y + 8, [
      { label: "Live",              curr: curr.wentLive, prev: prev.wentLive, avg: avg8(history.wentLive), dec: 1 },
      { label: "Lyckade bokningar", curr: curr.bookings, prev: prev.bookings, avg: avg8(history.bookings), dec: 1 },
    ]);

    // Veckosummering
    const sumY = y + 10;
    doc.roundedRect(L, sumY, CW, 68, 8).fill(BLUE);
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor("rgba(255,255,255,0.55)")
       .text("VECKOSUMMERING", L + 16, sumY + 10, { characterSpacing: 0.8 });

    [
      { label: "Sidvisningar",  val: curr.pageviews       },
      { label: "Registrerade",  val: curr.registrations   },
      { label: "Betalkort",     val: curr.paymentCardAdded },
      { label: "Bokningar",     val: curr.bookings        },
    ].forEach((item, i) => {
      const sx = L + i * (CW / 4);
      doc.font("Helvetica-Bold").fontSize(20).fillColor(WHITE)
         .text(num(item.val), sx, sumY + 24, { width: CW / 4, align: "center" });
      doc.font("Helvetica").fontSize(7.5).fillColor("rgba(255,255,255,0.6)")
         .text(item.label, sx, sumY + 48, { width: CW / 4, align: "center" });
    });

    // Footer sida 1
    doc.rect(0, PH - 32, PW, 32).fill(LITE);
    doc.moveTo(0, PH - 32).lineTo(PW, PH - 32).strokeColor(BORDER).lineWidth(0.5).stroke();
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
       .text(`Genererad ${formatDate(now)}  \u2022  K\u00e4lla: PostHog  \u2022  cottage-booking.com`,
             L, PH - 21, { width: CW, align: "center" });

    // ── Sida 2: Linjediagram ─────────────────────────────────────────────────

    doc.addPage();

    doc.rect(0, 0, PW, 88).fill(DARK);
    doc.rect(0, 88, PW, 3).fill(BLUE);
    doc.font("Helvetica-Bold").fontSize(20).fillColor(WHITE).text("Cottage-Booking.com", L, 22);
    doc.font("Helvetica").fontSize(10).fillColor(MUTED).text("Veckorapport KPI \u2013 Trender (8 veckor)", L, 48);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(WHITE)
       .text(`${formatDate(weekAgo)} \u2013 ${formatDate(weekEnd)}`, L, 22, { width: CW, align: "right" });

    let cy = 101;
    cy = sectionBand("Veckovisa trender \u2013 faktiskt v\u00e4rde \u2014 och genomsnitt per vecka", cy);
    cy += 8;

    const chartDefs = [
      { label: "Sidvisningar",           values: history.pageviews,      dec: 0 },
      { label: "Unika bes\u00f6kare",        values: history.uniqueVisitors, dec: 0 },
      { label: "Nya registreringar",     values: history.registrations,  dec: 1 },
      { label: "P\u00e5b\u00f6rjad Set up",      values: history.cottageCreated, dec: 1 },
      { label: "Betalkort tillagt",      values: history.paymentCard,    dec: 1 },
      { label: "Live",                   values: history.wentLive,       dec: 1 },
      { label: "Lyckade bokningar",      values: history.bookings,       dec: 1 },
    ];

    const chartW = (CW - 16) / 2;
    const chartH = 148;
    const rowH   = chartH + 14;
    let chartY   = cy;

    chartDefs.forEach((def, i) => {
      const col = i % 2;
      if (col === 0 && i !== 0) chartY += rowH;
      // Sista diagrammet alltid vänster kolumn (ingen centrering)
      const cx2 = L + col * (chartW + 16);

      doc.roundedRect(cx2 + 1, chartY + 1, chartW, chartH, 6).fill("#EDEDF0");
      doc.roundedRect(cx2, chartY, chartW, chartH, 6).fill(WHITE);
      doc.roundedRect(cx2, chartY, chartW, chartH, 6).stroke(BORDER).lineWidth(0.5);

      drawLineChart(doc, cx2, chartY, chartW, chartH, def.label, def.values, history.weekStarts, def.dec);
    });

    // ── Noterings-ruta – höger kolumn, sista raden ───────────────────────────
    const notesCx = L + chartW + 16;
    const notesCy = chartY;

    doc.roundedRect(notesCx + 1, notesCy + 1, chartW, chartH, 6).fill("#EDEDF0");
    doc.roundedRect(notesCx, notesCy, chartW, chartH, 6).fill(WHITE);
    doc.roundedRect(notesCx, notesCy, chartW, chartH, 6).stroke(BORDER).lineWidth(0.5);

    // Header-stripe
    doc.roundedRect(notesCx, notesCy, chartW, 26, 6).fill(BLUE);
    doc.rect(notesCx, notesCy + 14, chartW, 12).fill(BLUE);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(WHITE)
       .text("NOTERINGAR", notesCx + 12, notesCy + 9, { characterSpacing: 0.6 });

    // Dynamiska noteringar baserade på riktiga siffror
    const verifyRate = curr.registrations > 0 ? Math.round((curr.emailVerified / curr.registrations) * 100) : 0;
    const prevVerifyRate = prev.registrations > 0 ? Math.round((prev.emailVerified / prev.registrations) * 100) : 0;
    const setupRate = curr.emailVerified > 0 ? Math.round((curr.cottageCreated / curr.emailVerified) * 100) : 0;
    const notesData = [
      {
        title: `Verifieringsgrad: ${verifyRate}%`,
        body: verifyRate >= prevVerifyRate
          ? `${curr.emailVerified} av ${curr.registrations} nya anv\u00e4ndare verifierade sin e-post (${verifyRate}%). ${curr.emailUnverified > 0 ? `${curr.emailUnverified} har \u00e4nnu inte verifierat \u2013 \u00f6verv\u00e4g p\u00e5minnelse-mail.` : "Alla verifierade!"}`
          : `Verifieringsgraden sjunkit fr\u00e5n ${prevVerifyRate}% till ${verifyRate}%. ${curr.emailUnverified} ov\u00e4rifierade anv\u00e4ndare \u2013 kontrollera om verifieringsmail levereras korrekt.`,
      },
      {
        title: `Set up-tratt: ${setupRate}% p\u00e5b\u00f6rjar`,
        body: curr.cottageCreated === 0
          ? `Ingen verifierad anv\u00e4ndare p\u00e5b\u00f6rjade sin stuge-setup denna vecka. F\u00f6reg\u00e5ende vecka: ${prev.cottageCreated}. Unders\u00f6k om onboarding-fl\u00f6det efter verifiering \u00e4r tydligt.`
          : `${curr.cottageCreated} av ${curr.emailVerified} verifierade anv\u00e4ndare (${setupRate}%) p\u00e5b\u00f6rjade sin setup. ${curr.paymentCardAdded} av dessa lade till betalkort.`,
      },
      {
        title: curr.bookings > 0 ? `${curr.bookings} lyckade bokningar` : "Inga bokningar denna vecka",
        body: curr.bookings === 0
          ? `Plattformen har \u00e4nnu ${curr.wentLive} aktiv${curr.wentLive === 1 ? "" : "a"} stuga${curr.wentLive === 1 ? "" : "or"} live. N\u00e4r fler v\u00e4rdar aktiverar betalkort och publicerar kommer bokningar.`
          : `${curr.bookings} lyckade bokningar. ${curr.wentLive} stugor \u00e4r live. Konv. live->bokning: ${curr.wentLive > 0 ? Math.round((curr.bookings / curr.wentLive) * 100) : 0}%.`,
      },
    ];

    let ny = notesCy + 34;
    notesData.forEach((note) => {
      doc.rect(notesCx + 12, ny + 1, 3, 3).fill(BLUE);
      doc.font("Helvetica-Bold").fontSize(7).fillColor(DARK)
         .text(note.title, notesCx + 20, ny, { width: chartW - 32 });
      ny += 11;
      doc.font("Helvetica").fontSize(6.5).fillColor(MID)
         .text(note.body, notesCx + 20, ny, { width: chartW - 32 });
      ny += doc.heightOfString(note.body, { width: chartW - 32, fontSize: 6.5 }) + 10;
    });

    // Footer sida 2
    doc.rect(0, PH - 32, PW, 32).fill(LITE);
    doc.moveTo(0, PH - 32).lineTo(PW, PH - 32).strokeColor(BORDER).lineWidth(0.5).stroke();
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
       .text(`Genererad ${formatDate(now)}  \u2022  K\u00e4lla: PostHog  \u2022  cottage-booking.com`,
             L, PH - 21, { width: CW, align: "center" });

    // ── SIDA 3: Konverteringstratt ───────────────────────────────────────────

    doc.addPage();

    // Header
    doc.rect(0, 0, PW, 88).fill(DARK);
    doc.rect(0, 88, PW, 3).fill(BLUE);
    doc.font("Helvetica-Bold").fontSize(20).fillColor(WHITE).text("Cottage-Booking.com", L, 22);
    doc.font("Helvetica").fontSize(10).fillColor(MUTED)
       .text("Veckorapport KPI \u2013 Konverteringstratt (8 veckors total)", L, 48);

    // Datumspan för 8 veckorna
    const funnelFrom = history.weekStarts[0];
    const funnelTo   = new Date(history.weekStarts[history.weekStarts.length - 1]);
    funnelTo.setDate(funnelTo.getDate() + 6);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(WHITE)
       .text(`${formatDate(funnelFrom)} \u2013 ${formatDate(funnelTo)}`, L, 22, { width: CW, align: "right" });

    // 8-veckors summor
    const hSum = (arr) => arr.reduce((a, b) => a + b, 0);

    // Trattsteg baserade på 8 veckors total
    const funnelSteps = [
      { label: "Sidvisningar",         value: hSum(history.pageviews),       prev: null                             },
      { label: "Unika bes\u00f6kare",       value: hSum(history.uniqueVisitors),  prev: hSum(history.pageviews)          },
      { label: "Nya registreringar",   value: hSum(history.registrations),   prev: hSum(history.uniqueVisitors)     },
      { label: "Verifierade",          value: hSum(history.emailVerified),   prev: hSum(history.registrations)      },
      { label: "P\u00e5b\u00f6rjad Set up",     value: hSum(history.cottageCreated),  prev: hSum(history.emailVerified)      },
      { label: "Betalkort tillagt",    value: hSum(history.paymentCard),     prev: hSum(history.cottageCreated)     },
      { label: "Live",                 value: hSum(history.wentLive),        prev: hSum(history.paymentCard)        },
      { label: "Lyckade bokningar",    value: hSum(history.bookings),        prev: hSum(history.wentLive)           },
    ];

    // Färgpalett ljus → mörk blå (8 steg)
    const F = [
      { bg: "#EFF6FF", text: "#1E3A8A", sub: "#3B82F6" },
      { bg: "#DBEAFE", text: "#1E3A8A", sub: "#2563EB" },
      { bg: "#BFDBFE", text: "#1E3A8A", sub: "#1D4ED8" },
      { bg: "#93C5FD", text: "#1E3A8A", sub: "#1D4ED8" },
      { bg: "#60A5FA", text: "#1E3A8A", sub: "#1D4ED8" },
      { bg: "#3B82F6", text: "#FFFFFF", sub: "#DBEAFE" },
      { bg: "#1D4ED8", text: "#FFFFFF", sub: "#BFDBFE" },
      { bg: "#1E3A8A", text: "#FFFFFF", sub: "#93C5FD" },
    ];

    const fStartY  = 118;
    const fEndY    = PH - 80;
    const fStepH   = (fEndY - fStartY) / funnelSteps.length;
    const fMaxW    = CW - 60;  // 455pt – smalare än sidan
    const fMinW    = 130;
    const fCenterX = L + CW / 2;
    const fN       = funnelSteps.length;

    funnelSteps.forEach((step, i) => {
      const topW = fMaxW - (fMaxW - fMinW) * (i / (fN - 1));
      const botW = i < fN - 1
        ? fMaxW - (fMaxW - fMinW) * ((i + 1) / (fN - 1))
        : fMinW;

      const sy   = fStartY + i * fStepH;
      const topX = fCenterX - topW / 2;
      const botX = fCenterX - botW / 2;
      const col  = F[i];
      const midY = sy + fStepH / 2;

      // Trapetsform
      doc.moveTo(topX, sy)
         .lineTo(topX + topW, sy)
         .lineTo(botX + botW, sy + fStepH)
         .lineTo(botX, sy + fStepH)
         .closePath()
         .fill(col.bg);

      // Vit separator (ej första)
      if (i > 0) {
        doc.moveTo(topX, sy).lineTo(topX + topW, sy)
           .strokeColor("#FFFFFF").lineWidth(2).stroke();
      }

      // Stegnummer (litet, övre vänster)
      doc.font("Helvetica-Bold").fontSize(7).fillColor(col.sub)
         .text(`${i + 1}`, topX + 10, sy + 7);

      // Textblock centrerat i trapetsen
      const textW = Math.max(botW - 24, 120);
      const textX = fCenterX - textW / 2;

      // Konverteringstext
      const convText = step.prev === null
        ? "Toppen av tratten"
        : step.prev > 0
          ? `${Math.round((step.value / step.prev) * 100)}% av f\u00f6reg\u00e5ende steg`
          : "Inga data";

      // Vertikal centrering (label + siffra + konv ≈ 47pt)
      const blockY = midY - 23;

      doc.font("Helvetica-Bold").fontSize(9).fillColor(col.text)
         .text(step.label, textX, blockY, { width: textW, align: "center" });
      doc.font("Helvetica-Bold").fontSize(26).fillColor(col.text)
         .text(num(step.value), textX, blockY + 13, { width: textW, align: "center" });
      doc.font("Helvetica").fontSize(8).fillColor(col.sub)
         .text(convText, textX, blockY + 43, { width: textW, align: "center" });

      // Konverteringsprocent på höger sida (hur många % av föregående steg nådde hit)
      const midW      = (topW + botW) / 2;
      const rightX    = fCenterX + midW / 2 + 8;
      const rightSpace = (L + CW) - rightX - 2;

      if (step.prev !== null && step.prev > 0 && rightSpace > 30) {
        const convPct = Math.round((step.value / step.prev) * 100);
        doc.font("Helvetica-Bold").fontSize(14).fillColor(DARK)
           .text(`${convPct}%`, rightX, midY - 11, { width: rightSpace });
        doc.font("Helvetica").fontSize(6.5).fillColor(MID)
           .text("av f\u00f6reg. steg", rightX, midY + 7, { width: rightSpace });
      }
    });

    // Footer sida 3
    doc.rect(0, PH - 32, PW, 32).fill(LITE);
    doc.moveTo(0, PH - 32).lineTo(PW, PH - 32).strokeColor(BORDER).lineWidth(0.5).stroke();
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
       .text(`Genererad ${formatDate(now)}  \u2022  K\u00e4lla: PostHog  \u2022  cottage-booking.com`,
             L, PH - 21, { width: CW, align: "center" });

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

// ─── E-post ──────────────────────────────────────────────────────────────────

function trendBadgeHtml(currVal, prevVal) {
  const { pct, up } = delta(currVal, prevVal);
  if (up === null) return `<span style="color:#9CA3AF">\u2013</span>`;
  const arrow = up ? "\u2191" : "\u2193";
  if (pct === null) return `<span style="background:#DCFCE7;color:#15803D;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700">${arrow} Ny</span>`;
  const bg = up ? "#DCFCE7" : "#FEE2E2";
  const fg = up ? "#15803D" : "#DC2626";
  return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700">${arrow} ${Math.abs(pct)}%</span>`;
}

async function sendEmail({ curr, prev }, pdfPath, landingPages = []) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_PASSWORD },
  });

  const now     = new Date();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const kpiCard = (label, currVal, prevVal) => `
    <td style="width:50%;padding:0">
      <div style="background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:16px 18px;margin:4px">
        <div style="font-size:10px;font-weight:600;color:#9CA3AF;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em">${label}</div>
        <div style="font-size:26px;font-weight:700;color:#111827;margin-bottom:8px;letter-spacing:-0.5px">${num(currVal)}</div>
        <div>${trendBadgeHtml(currVal, prevVal)}</div>
        <div style="font-size:10px;color:#9CA3AF;margin-top:6px">F\u00f6rra veckan: ${num(prevVal)}</div>
      </div>
    </td>`;

  const kpiCardHalf = (label, currVal, prevVal) => `
    <td style="width:50%;padding:0">
      <div style="background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:16px 18px;margin:4px">
        <div style="font-size:10px;font-weight:600;color:#9CA3AF;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em">${label}</div>
        <div style="font-size:26px;font-weight:700;color:#111827;margin-bottom:8px;letter-spacing:-0.5px">${num(currVal)}</div>
        <div>${trendBadgeHtml(currVal, prevVal)}</div>
        <div style="font-size:10px;color:#9CA3AF;margin-top:6px">F\u00f6rra veckan: ${num(prevVal)}</div>
      </div>
    </td>
    <td style="width:50%;padding:0"></td>`;

  const section = (title) => `
    <tr><td colspan="2" style="padding:18px 4px 6px">
      <div style="font-size:10px;font-weight:700;color:#9CA3AF;letter-spacing:.09em;text-transform:uppercase;border-bottom:1px solid #F3F4F6;padding-bottom:6px">${title}</div>
    </td></tr>`;

  const html = `
<!DOCTYPE html>
<html lang="sv">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<div style="max-width:620px;margin:32px auto;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10)">

  <div style="background:#111827;padding:32px 32px 28px">
    <div style="font-size:20px;font-weight:700;color:#fff;letter-spacing:-.3px">Cottage-Booking.com</div>
    <div style="font-size:12px;color:#6B7280;margin-top:6px">Veckorapport KPI</div>
    <div style="font-size:13px;color:#9CA3AF;margin-top:4px">${weekAgo.toLocaleDateString("sv-SE")} &ndash; ${now.toLocaleDateString("sv-SE")}</div>
  </div>
  <div style="height:3px;background:#1a56db"></div>

  <div style="background:#1a56db;padding:18px 32px">
    <table style="width:100%;border-collapse:collapse">
      <tr>
        ${[
          { label: "Sidvisningar",  val: curr.pageviews        },
          { label: "Registrerade",  val: curr.registrations    },
          { label: "Betalkort",     val: curr.paymentCardAdded },
          { label: "Bokningar",     val: curr.bookings         },
        ].map(item => `
          <td style="text-align:center;width:25%">
            <div style="font-size:22px;font-weight:700;color:#fff">${num(item.val)}</div>
            <div style="font-size:10px;color:rgba(255,255,255,.6);margin-top:3px">${item.label}</div>
          </td>`).join("")}
      </tr>
    </table>
  </div>

  <div style="background:#F9FAFB;padding:20px 28px 24px">
    <table style="width:100%;border-collapse:collapse">
      ${section("Webbtrafik")}
      <tr>
        ${kpiCard("Sidvisningar", curr.pageviews, prev.pageviews)}
        ${kpiCard("Unika bes&ouml;kare", curr.uniqueVisitors, prev.uniqueVisitors)}
      </tr>
      ${section("Registrering")}
      <tr>
        ${kpiCard("Totalt", curr.registrations, prev.registrations)}
        ${kpiCard("Verifierade", curr.emailVerified, prev.emailVerified)}
      </tr>
      <tr>
        ${kpiCard("Ej verifierade", curr.emailUnverified, prev.emailUnverified)}
      </tr>
      ${section("Aktivering")}
      <tr>
        ${kpiCard("P\u00e5b\u00f6rjad Set up", curr.cottageCreated, prev.cottageCreated)}
        ${kpiCard("Betalkort tillagt", curr.paymentCardAdded, prev.paymentCardAdded)}
      </tr>
      ${section("Status")}
      <tr>
        ${kpiCard("Live", curr.wentLive, prev.wentLive)}
        ${kpiCard("Lyckade bokningar", curr.bookings, prev.bookings)}
      </tr>
    </table>
  </div>

  ${landingPages.length > 0 ? `
  <div style="background:#fff;border-top:1px solid #E5E7EB;padding:20px 28px 24px">
    <div style="font-size:10px;font-weight:700;color:#9CA3AF;letter-spacing:.09em;text-transform:uppercase;border-bottom:1px solid #F3F4F6;padding-bottom:6px;margin-bottom:12px">Mest bes&ouml;kta sidor (7 dagar)</div>
    <table style="width:100%;border-collapse:collapse">
      ${landingPages.map(([path, cnt], i) => `
        <tr>
          <td style="padding:5px 0;font-size:11px;color:#374151;font-family:monospace">${path}</td>
          <td style="padding:5px 0;text-align:right;font-size:11px;font-weight:700;color:#1a56db;white-space:nowrap">${Number(cnt).toLocaleString("sv-SE")}</td>
          <td style="padding:5px 0 5px 10px;width:120px">
            <div style="height:6px;border-radius:3px;background:#EFF6FF">
              <div style="height:6px;border-radius:3px;background:#1a56db;width:${Math.round((Number(cnt)/Number(landingPages[0][1]))*100)}%"></div>
            </div>
          </td>
        </tr>`).join("")}
    </table>
  </div>` : ""}

  <div style="background:#F3F4F6;border-top:1px solid #E5E7EB;padding:14px 32px;text-align:center">
    <p style="color:#9CA3AF;font-size:10px;margin:0">
      Fullst&auml;ndig rapport med trenddiagram bilagd som PDF &nbsp;&middot;&nbsp; cottage-booking.com
    </p>
  </div>

</div>
</body>
</html>`;

  await transporter.sendMail({
    from: `"Cottage-Booking KPI" <${GMAIL_USER}>`,
    to: REPORT_RECIPIENT,
    subject: `Veckorapport KPI \u2014 ${now.toLocaleDateString("sv-SE")}`,
    html,
    attachments: [{ filename: "kpi-rapport.pdf", path: pdfPath }],
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

const pdfPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "kpi-rapport.pdf"
);

console.log("H\u00e4mtar KPI-data fr\u00e5n PostHog och Lightdash...");
const [kpis, history, landingPages, ldRegs] = await Promise.all([
  fetchKPIs(), fetchHistory(), fetchLandingPages(), fetchLightdashRegistrations()
]);

// Ers\u00e4tt registreringsdata med korrekt data fr\u00e5n Lightdash (databas-k\u00e4llan)
kpis.curr.registrations   = ldRegs.curr.total;
kpis.curr.emailVerified   = ldRegs.curr.verified;
kpis.curr.emailUnverified = ldRegs.curr.unverified;
kpis.prev.registrations   = ldRegs.prev.total;
kpis.prev.emailVerified   = ldRegs.prev.verified;
kpis.prev.emailUnverified = ldRegs.prev.unverified;
history.registrations     = ldRegs.history.registrations;
history.emailVerified     = ldRegs.history.emailVerified;
history.emailUnverified   = ldRegs.history.emailUnverified;

console.log("Denna vecka:", kpis.curr);
console.log("F\u00f6rra veckan:", kpis.prev);

console.log("Genererar PDF...");
await generatePDF({ ...kpis, history }, pdfPath);

if (GMAIL_PASSWORD) {
  console.log("Skickar e-post...");
  await sendEmail(kpis, pdfPath, landingPages);
  await unlink(pdfPath);
  console.log("Klart. Rapport skickad till", REPORT_RECIPIENT);
} else {
  console.log("GMAIL_PASSWORD saknas — PDF sparad lokalt:", pdfPath);
}
