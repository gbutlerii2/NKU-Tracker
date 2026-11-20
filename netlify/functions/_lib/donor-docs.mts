// Tax receipts and donation certificates, built on the server for email:
// an HTML version for the message body and a printable PDF attachment.
// The wording and layout mirror the printouts in the app
// (receiptItem / receiptStatement / printReceipts / printEventCerts in
// deploy/source/app.html), so an emailed copy matches a printed one.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type PDFImage } from "pdf-lib";

export const ORG = {
  name: "Kingston-North Kitsap Rotary Foundation",
  street: "PO Box 832",
  city: "Kingston, WA 98346",
  ein: "20-2960627",
};
const LOGO_URL = "https://rotaryknk.org/images/nku/NKU-800x378.png";
const CERT_MESSAGE = "Your generosity builds more than a structure. It funds the phases, the crews and the work that will serve North Kitsap for generations. On behalf of every family this project will reach, thank you.";

export type Receipt = {
  no: string; name: string; contact: string; address: string; date: string; desc: string;
  method: string; amount: number; goods: number; pledge: boolean; note: string;
};
export type Certificate = {
  name: string; contact: string; method: string; amount: number; pledge: boolean; note: string;
};

// ---- shared wording (mirrors the app) --------------------------------------
export const cash = (n: number) => "$" + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = (n: number) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
export const today = () => new Date().toISOString().slice(0, 10);

export function receiptStatement(b: Receipt): string {
  if (b.pledge) return "This acknowledges a pledge. It is not a receipt for a tax-deductible payment; a receipt is issued as each payment is received.";
  const noncash = /in-kind|stock/i.test(b.method || "");
  if (b.goods > 0) {
    return "In exchange for this contribution the donor received goods or services with an estimated fair market value of " + cash(b.goods)
      + ". The amount deductible for federal income tax purposes is limited to the contribution less that value: " + cash(Math.max(0, b.amount - b.goods)) + ".";
  }
  return "No goods or services were provided in exchange for this contribution." + (noncash ? " For a non-cash gift the value shown is as recorded; it is not an appraisal." : "");
}
const certMethodWord = (m: string) => {
  m = String(m || "").trim();
  if (!m || /^(check|cheque|cash|credit card|card|ach)$/i.test(m)) return "";
  return m.replace(/-/g, " ").split(/\s+/).map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
};
export const certLead = (m: string, pl: boolean) => { const w = certMethodWord(m); return "in recognition of your generous " + (w ? w + " " : "") + (pl ? "pledge" : "contribution") + " to the"; };
const certKick = (c: Certificate) => (c.pledge ? "Certificate of Pledge" : "Certificate of Appreciation");
const FOOTER = `Please keep this receipt for your tax records. ${ORG.name} is a 501(c)(3) tax-exempt organization, EIN ${ORG.ein}.`;

// ---- email HTML ------------------------------------------------------------
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const G = "#1b4127", G8 = "#14301d", L = "#a9c5b1";

function wrapEmail(message: string, inner: string, attachNote: string): string {
  const msg = message ? `<div style="white-space:pre-wrap;margin:0 0 22px">${esc(message)}</div>` : "";
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f2ec;font-family:Arial,Helvetica,sans-serif;color:#201e1d">
<div style="max-width:660px;margin:0 auto;padding:24px 16px">
${msg}${inner}
<div style="margin-top:14px;font-size:12px;color:#6b675e;text-align:center">${esc(attachNote)}</div>
</div></body></html>`;
}

export function receiptHtml(b: Receipt, message: string): string {
  const td = `style="padding:10px;border-bottom:1px solid ${L};vertical-align:top"`;
  const th = `style="text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#fff;background:${G};padding:7px 10px;font-weight:600"`;
  const inner = `<div style="background:#fff;padding:28px 28px 22px;border-top:4px solid ${G};font-size:14px;line-height:1.5">
<table width="100%" style="border-collapse:collapse"><tr>
<td><img src="${LOGO_URL}" alt="North Kitsap United" width="150" style="display:block;height:auto"></td>
<td style="text-align:right;font-size:12px;line-height:1.55;color:#4a473f"><b style="color:#201e1d">${esc(ORG.name)}</b><br>${esc(ORG.street)}<br>${esc(ORG.city)}<br>EIN ${esc(ORG.ein)}</td>
</tr></table>
<div style="font-size:24px;font-weight:800;color:${G8};margin-top:22px">${b.pledge ? "Pledge Receipt" : "Donation Receipt"}</div>
<div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:${G}">${b.pledge ? "Acknowledgment of a pledge" : "Official receipt for income tax purposes"}</div>
<table width="100%" style="border-collapse:collapse;margin-top:16px"><tr>
<td style="border:1px solid ${L};padding:8px 12px"><div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#6b675e">Receipt no.</div><b>${esc(b.no)}</b></td>
<td style="border:1px solid ${L};padding:8px 12px"><div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#6b675e">Date issued</div><b>${esc(today())}</b></td>
</tr></table>
<div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#6b675e;margin-top:20px">Received from</div>
<div style="font-size:18px;font-weight:800">${esc(b.name)}</div>
${b.contact ? `<div style="color:#4a473f">${esc(b.contact)}</div>` : ""}${b.address ? `<div style="color:#4a473f">${esc(b.address).replace(/\n/g, "<br>")}</div>` : ""}
<table width="100%" style="border-collapse:collapse;margin-top:20px">
<tr><th ${th}>${b.pledge ? "Date pledged" : "Date received"}</th><th ${th}>Description</th><th ${th}>Method</th><th ${th} align="right">Amount</th></tr>
<tr><td ${td}>${esc(b.date)}</td><td ${td}>${esc(b.desc)}</td><td ${td}>${esc(b.method || "—")}</td><td ${td} align="right">${esc(cash(b.amount))}</td></tr>
<tr><td colspan="3" style="padding:10px;font-weight:800;border-bottom:2px solid ${G}">${b.pledge ? "Total pledged" : "Total received"}</td><td align="right" style="padding:10px;font-weight:800;border-bottom:2px solid ${G}">${esc(cash(b.amount))}</td></tr>
</table>
${b.note ? `<div style="margin-top:10px;color:#4a473f">${esc(b.note)}</div>` : ""}
<div style="margin-top:18px;padding:12px 14px;background:#f6f2e7;border-left:3px solid ${G}">${esc(receiptStatement(b))}</div>
<div style="margin-top:16px">Thank you for your generous support of North Kitsap United.</div>
<div style="margin-top:20px;padding-top:10px;border-top:1px solid ${L};font-size:11px;color:#6b675e;text-align:center">${esc(FOOTER)}</div>
</div>`;
  return wrapEmail(message, inner, "A printable copy (PDF) is attached.");
}

export function certificateHtml(c: Certificate, message: string): string {
  const inner = `<div style="background:#fffdf7;border:3px solid ${G};padding:10px">
<div style="border:1px solid ${L};padding:30px 28px 26px;text-align:center;font-size:14px;line-height:1.5">
<img src="${LOGO_URL}" alt="North Kitsap United" width="170" style="display:inline-block;height:auto">
<div style="font-size:12px;font-weight:800;letter-spacing:.3em;text-transform:uppercase;color:${G};margin-top:18px">${esc(certKick(c))}</div>
<div style="width:64px;height:2px;background:#2e6b3e;margin:14px auto 18px"></div>
<div style="color:#4a473f">Presented with gratitude to</div>
<div style="font-size:32px;font-weight:800;line-height:1.15;color:${G8};margin:10px 0 6px">${esc(c.name)}</div>
${c.contact ? `<div style="font-size:16px;font-weight:600;color:#4a473f;margin-bottom:8px">${esc(c.contact)}</div>` : ""}
<div style="color:#4a473f">${esc(certLead(c.method, c.pledge))}<br>${esc(ORG.name)} (EIN ${esc(ORG.ein)})</div>
<div style="font-size:28px;font-weight:800;margin:10px 0 4px">${esc(whole(c.amount))}</div>
${c.pledge ? `<div style="display:inline-block;font-size:11px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:${G};border:1px solid ${G};padding:3px 14px">Pledge</div>` : ""}
${c.note ? `<div style="font-size:13px;color:#4a473f;margin-top:4px">${esc(c.note)}</div>` : ""}
<div style="max-width:470px;margin:18px auto 0;color:#3a4a3d">${esc(CERT_MESSAGE)}</div>
<table width="100%" style="border-collapse:collapse;margin-top:34px"><tr>
<td style="width:50%;padding:0 14px 0 0"><div style="border-top:1px solid #4a473f;padding-top:5px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#6b675e;text-align:left">Kingston Rotary</div></td>
<td style="width:50%;padding:0 0 0 14px"><div style="border-top:1px solid #4a473f;padding-top:5px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#6b675e;text-align:left">NKU Board Member</div></td>
</tr></table>
</div></div>`;
  return wrapEmail(message, inner, "A printable copy (PDF) of your certificate is attached.");
}

// ---- PDF -------------------------------------------------------------------
const hex = (h: string) => { const n = parseInt(h.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
const C = { g7: hex(G), g8: hex(G8), g5: hex("#2e6b3e"), g3: hex(L), ink: hex("#201e1d"), mid: hex("#4a473f"), soft: hex("#6b675e"), white: rgb(1, 1, 1), cream: hex("#fffdf7"), note: hex("#f6f2e7"), body: hex("#3a4a3d") };

// The standard PDF fonts only cover Windows-1252; swap anything else.
const WIN = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const safe = (s: string) => Array.from(String(s ?? "")).map((ch) => {
  const c = ch.charCodeAt(0);
  if (ch === "\t") return " ";
  return (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WIN.has(ch) ? ch : "?";
}).join("");

let logoBytes: Uint8Array | null = null;
async function logo(doc: PDFDocument): Promise<PDFImage | null> {
  try {
    if (!logoBytes) {
      const r = await fetch(LOGO_URL, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return null;
      logoBytes = new Uint8Array(await r.arrayBuffer());
    }
    return await doc.embedPng(logoBytes);
  } catch { return null; }
}

function wrap(text: string, font: PDFFont, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of safe(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? line + " " + word : word;
      if (font.widthOfTextAtSize(next, size) <= maxW || !line) line = next;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

// Draws text with letter spacing (pdf-lib has none built in).
function tracked(page: PDFPage, text: string, o: { x?: number; cx?: number; y: number; size: number; font: PDFFont; color: any; track: number }) {
  const s = safe(text);
  const w = Array.from(s).reduce((n, ch) => n + o.font.widthOfTextAtSize(ch, o.size) + o.track, 0) - o.track;
  let x = o.cx != null ? o.cx - w / 2 : (o.x || 0);
  for (const ch of Array.from(s)) { page.drawText(ch, { x, y: o.y, size: o.size, font: o.font, color: o.color }); x += o.font.widthOfTextAtSize(ch, o.size) + o.track; }
}
const centered = (page: PDFPage, text: string, cx: number, y: number, size: number, font: PDFFont, color: any) => {
  const s = safe(text); page.drawText(s, { x: cx - font.widthOfTextAtSize(s, size) / 2, y, size, font, color });
};
const right = (page: PDFPage, text: string, rx: number, y: number, size: number, font: PDFFont, color: any) => {
  const s = safe(text); page.drawText(s, { x: rx - font.widthOfTextAtSize(s, size), y, size, font, color });
};
const fit = (text: string, font: PDFFont, size: number, maxW: number, min: number) => {
  let s = size; while (s > min && font.widthOfTextAtSize(safe(text), s) > maxW) s -= 1; return s;
};

export async function receiptPdf(list: Receipt[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(list.length === 1 ? (list[0].pledge ? "Pledge Receipt " : "Donation Receipt ") + list[0].no : "Donation Receipts");
  doc.setAuthor(ORG.name);
  const [reg, bold] = await Promise.all([doc.embedFont(StandardFonts.Helvetica), doc.embedFont(StandardFonts.HelveticaBold)]);
  const img = await logo(doc);
  const issued = today();
  for (const b of list) {
    const page = doc.addPage([612, 792]);
    const L0 = 54, R0 = 558, W = R0 - L0;
    let y = 742;
    if (img) { const w = 130, h = w * img.height / img.width; page.drawImage(img, { x: L0, y: y - h, width: w, height: h }); }
    else page.drawText("North Kitsap United", { x: L0, y: y - 24, size: 18, font: bold, color: C.g8 });
    right(page, ORG.name, R0, y - 10, 10.5, bold, C.ink);
    right(page, ORG.street, R0, y - 24, 10, reg, C.mid);
    right(page, ORG.city, R0, y - 38, 10, reg, C.mid);
    right(page, "EIN " + ORG.ein, R0, y - 52, 10, reg, C.mid);
    y -= 70;
    page.drawRectangle({ x: L0, y: y - 3, width: W, height: 3, color: C.g7 });
    y -= 36;
    page.drawText(b.pledge ? "Pledge Receipt" : "Donation Receipt", { x: L0, y, size: 24, font: bold, color: C.g8 });
    y -= 16;
    tracked(page, (b.pledge ? "Acknowledgment of a pledge" : "Official receipt for income tax purposes").toUpperCase(), { x: L0, y, size: 8.5, font: reg, color: C.g7, track: 1.2 });
    y -= 14;
    const boxH = 34, half = W / 2;
    [["RECEIPT NO.", b.no], ["DATE ISSUED", issued]].forEach(([lab, val], i) => {
      const x = L0 + i * half;
      page.drawRectangle({ x, y: y - boxH, width: half, height: boxH, borderColor: C.g3, borderWidth: 1 });
      tracked(page, lab, { x: x + 10, y: y - 12, size: 7.5, font: reg, color: C.soft, track: 0.9 });
      page.drawText(safe(val), { x: x + 10, y: y - 26, size: 11, font: bold, color: C.ink });
    });
    y -= boxH + 26;
    tracked(page, "RECEIVED FROM", { x: L0, y, size: 7.5, font: reg, color: C.soft, track: 0.9 });
    y -= 18;
    page.drawText(safe(b.name), { x: L0, y, size: fit(b.name, bold, 15, W, 10), font: bold, color: C.ink });
    for (const ln of [b.contact, ...String(b.address || "").split("\n")].map((s) => String(s || "").trim()).filter(Boolean)) {
      y -= 14; page.drawText(safe(ln), { x: L0, y, size: 10.5, font: reg, color: C.mid });
    }
    y -= 24;
    // Line-item table
    const cols = [L0, L0 + 92, L0 + 330, R0];
    page.drawRectangle({ x: L0, y: y - 20, width: W, height: 20, color: C.g7 });
    [b.pledge ? "DATE PLEDGED" : "DATE RECEIVED", "DESCRIPTION", "PAYMENT METHOD"].forEach((h, i) => tracked(page, h, { x: cols[i] + 8, y: y - 13.5, size: 7.5, font: bold, color: C.white, track: 0.7 }));
    right(page, "AMOUNT", R0 - 8, y - 13.5, 7.5, bold, C.white);
    y -= 20;
    const desc = wrap(b.desc, reg, 10.5, cols[2] - cols[1] - 14);
    const meth = wrap(b.method || "—", reg, 10.5, cols[3] - cols[2] - 90);
    const rows = Math.max(desc.length, meth.length);
    const top = y - 16;
    page.drawText(safe(b.date), { x: cols[0] + 8, y: top, size: 10.5, font: reg, color: C.ink });
    desc.forEach((l, i) => page.drawText(l, { x: cols[1] + 8, y: top - i * 13, size: 10.5, font: reg, color: C.ink }));
    meth.forEach((l, i) => page.drawText(l, { x: cols[2] + 8, y: top - i * 13, size: 10.5, font: reg, color: C.ink }));
    right(page, cash(b.amount), R0 - 8, top, 10.5, reg, C.ink);
    y = top - (rows - 1) * 13 - 10;
    page.drawLine({ start: { x: L0, y }, end: { x: R0, y }, thickness: 1, color: C.g3 });
    y -= 20;
    page.drawText(b.pledge ? "Total pledged" : "Total received", { x: L0 + 8, y, size: 12.5, font: bold, color: C.ink });
    right(page, cash(b.amount), R0 - 8, y, 12.5, bold, C.ink);
    y -= 10;
    page.drawRectangle({ x: L0, y: y - 2, width: W, height: 2, color: C.g7 });
    y -= 18;
    if (b.note) { page.drawText(safe(b.note), { x: L0, y, size: 10.5, font: reg, color: C.mid }); y -= 18; }
    // Statement box
    const st = wrap(receiptStatement(b), reg, 10.5, W - 32);
    const stH = st.length * 14 + 18;
    page.drawRectangle({ x: L0, y: y - stH, width: W, height: stH, color: C.note });
    page.drawRectangle({ x: L0, y: y - stH, width: 3, height: stH, color: C.g7 });
    st.forEach((l, i) => page.drawText(l, { x: L0 + 16, y: y - 20 - i * 14, size: 10.5, font: reg, color: C.ink }));
    y -= stH + 24;
    page.drawText("Thank you for your generous support of North Kitsap United.", { x: L0, y, size: 11, font: reg, color: C.ink });
    // Signature lines and footer sit at the bottom of the page.
    const sy = 128, sw = (W - 50) / 2;
    [["AUTHORIZED SIGNATURE", L0], ["DATE", L0 + sw + 50]].forEach(([lab, x]) => {
      page.drawLine({ start: { x: x as number, y: sy }, end: { x: (x as number) + sw, y: sy }, thickness: 0.8, color: C.mid });
      tracked(page, lab as string, { x: x as number, y: sy - 13, size: 7.5, font: reg, color: C.soft, track: 0.9 });
    });
    page.drawLine({ start: { x: L0, y: 84 }, end: { x: R0, y: 84 }, thickness: 0.8, color: C.g3 });
    wrap(FOOTER, reg, 8.5, W).forEach((l, i) => centered(page, l, 306, 70 - i * 11, 8.5, reg, C.soft));
  }
  return doc.save();
}

export async function certificatePdf(list: Certificate[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(list.length === 1 ? certKick(list[0]) + " - " + safe(list[0].name) : "Donation Certificates");
  doc.setAuthor(ORG.name);
  const [reg, bold] = await Promise.all([doc.embedFont(StandardFonts.Helvetica), doc.embedFont(StandardFonts.HelveticaBold)]);
  const img = await logo(doc);
  for (const c of list) {
    const page = doc.addPage([792, 612]);
    const cx = 396;
    page.drawRectangle({ x: 0, y: 0, width: 792, height: 612, color: C.cream });
    page.drawRectangle({ x: 32, y: 32, width: 728, height: 548, borderColor: C.g7, borderWidth: 3 });
    page.drawRectangle({ x: 44, y: 44, width: 704, height: 524, borderColor: C.g3, borderWidth: 1 });
    let y = 528;
    if (img) { const w = 160, h = w * img.height / img.width; page.drawImage(img, { x: cx - w / 2, y: y - h, width: w, height: h }); y -= h; }
    else { centered(page, "North Kitsap United", cx, y - 26, 22, bold, C.g8); y -= 40; }
    y -= 24;
    tracked(page, certKick(c).toUpperCase(), { cx, y, size: 12, font: bold, color: C.g7, track: 3.6 });
    y -= 14;
    page.drawRectangle({ x: cx - 32, y, width: 64, height: 2, color: C.g5 });
    y -= 24;
    centered(page, "Presented with gratitude to", cx, y, 13, reg, C.mid);
    y -= 40;
    centered(page, c.name, cx, y, fit(c.name, bold, 38, 600, 18), bold, C.g8);
    if (c.contact) { y -= 22; centered(page, c.contact, cx, y, 14, bold, C.mid); }
    y -= 26;
    centered(page, certLead(c.method, c.pledge), cx, y, 12.5, reg, C.mid);
    y -= 16;
    centered(page, `${ORG.name} (EIN ${ORG.ein})`, cx, y, 12.5, reg, C.mid);
    y -= 34;
    centered(page, whole(c.amount), cx, y, 28, bold, C.ink);
    if (c.pledge) {
      y -= 24;
      const lab = "PLEDGE", w = Array.from(lab).reduce((n, ch) => n + bold.widthOfTextAtSize(ch, 9.5) + 2.2, 0) + 26;
      page.drawRectangle({ x: cx - w / 2, y: y - 5, width: w, height: 17, borderColor: C.g7, borderWidth: 1 });
      tracked(page, lab, { cx, y, size: 9.5, font: bold, color: C.g7, track: 2.2 });
    }
    if (c.note) { y -= 20; centered(page, c.note, cx, y, 11.5, reg, C.mid); }
    y -= 30;
    wrap(CERT_MESSAGE, reg, 11.5, 440).forEach((l, i) => centered(page, l, cx, y - i * 16, 11.5, reg, C.body));
    const sy = 104;
    [["KINGSTON ROTARY", 110], ["NKU BOARD MEMBER", 422]].forEach(([lab, x]) => {
      page.drawLine({ start: { x: x as number, y: sy }, end: { x: (x as number) + 260, y: sy }, thickness: 0.8, color: C.mid });
      tracked(page, lab as string, { x: x as number, y: sy - 13, size: 8, font: reg, color: C.soft, track: 1 });
    });
  }
  return doc.save();
}
