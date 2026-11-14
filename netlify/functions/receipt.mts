// /api/receipt: emails a donation's tax receipt to the donor.
//   POST {"txId": "..."}  sends the receipt for that donation and stamps it
//                         (receiptSentAt / receiptSentTo / receiptSentBy)
//   POST {"test": true}   admins only: sends a sample receipt to the caller
//
// Callers send their Tracker sign-in as "Authorization: Bearer <Firebase ID
// token>". The receipt, with its amount, is built here on the server, so the
// person sending it (Donations workspace) never sees the dollar figure.
// Settings (email service, API key, From, subject, message) live in the
// admin-only Firestore doc private/email, edited in Admin → Email.
import type { Config } from "@netlify/functions";
import { getAuth } from "firebase-admin/auth";
import { firestore } from "./_lib/firebase.mts";
import { failure, json } from "./_lib/http.mts";

const BOOTSTRAP_ADMINS = ["gerry@gb2solutions.net", "gerandkar@gmail.com"]; // mirror of firestore.rules

type Who = { email: string; admin: boolean; canSend: boolean };

async function caller(req: Request): Promise<Who | Response> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "");
  if (!m) return json(req, { ok: false, error: "Sign in to the Tracker first." }, 401);
  let tok;
  try { tok = await getAuth().verifyIdToken(m[1], true); }
  catch { return json(req, { ok: false, error: "Your sign-in has expired. Sign in to the Tracker again." }, 401); }
  const email = String(tok.email || "").toLowerCase();
  if (!email || tok.firebase?.sign_in_second_factor !== "phone") {
    return json(req, { ok: false, error: "Finish signing in with your texted code first." }, 403);
  }
  if (BOOTSTRAP_ADMINS.includes(email)) return { email, admin: true, canSend: true };
  const u = (await firestore().collection("users").doc(email).get()).data();
  if (!u || u.active === false) return json(req, { ok: false, error: "Your account doesn't have access." }, 403);
  const p = u.perms || {};
  const admin = p.admin === "write";
  return { email, admin, canSend: admin || p.wsdonations === "write" || p.wsdonations === "edit" || p.transactions === "write" };
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const cash = (n: number) => "$" + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const isStatus = (v: unknown, name: string) => {
  const n = (x: unknown) => { const s = String(x ?? "").trim().toLowerCase(); return s === "completed" ? "received" : s; };
  return n(v) === n(name);
};

type Receipt = { no: string; name: string; contact: string; address: string; date: string; desc: string; method: string; amount: number; pledge: boolean };

// Mirrors receiptItem / receiptStatement in the app (deploy/source/app.html).
function buildReceipt(id: string, t: any, money: any, d: any): Receipt {
  const pledge = isStatus(t.status, "Pledged");
  const plan = money?.plan;
  const amount = pledge && plan && Number(plan.total) > 0 ? Number(plan.total) : Number(money?.amount) || 0;
  const org = /organization|foundation|trust|business/i.test(String(d?.type || ""));
  return {
    no: "NKU-" + id.toUpperCase(),
    name: d?.name || "Donor",
    contact: org && d?.contactOnCert ? String(d.contactName || "").trim() : "",
    address: String(d?.address || "").trim(),
    date: String((pledge ? t.date : (t.completedAt || t.date)) || "").slice(0, 10) || "—",
    desc: (t.pledgeId ? "Pledge payment" : (pledge || plan ? "Pledge" : "Donation")) + (t.grantName || t.title ? " — " + (t.grantName || t.title) : ""),
    method: t.method || "",
    amount,
    pledge,
  };
}

function statement(b: Receipt): string {
  if (b.pledge) return "This acknowledges a pledge. It is not a receipt for a tax-deductible payment; a receipt is issued as each payment is received.";
  const noncash = /in-kind|stock/i.test(b.method || "");
  return "No goods or services were provided in exchange for this contribution." + (noncash ? " For a non-cash gift the value shown is as recorded; it is not an appraisal." : "");
}

function receiptHtml(b: Receipt, message: string): string {
  const G = "#1b4127", L = "#a9c5b1";
  const td = `style="padding:10px;border-bottom:1px solid ${L};vertical-align:top"`;
  const th = `style="text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#fff;background:${G};padding:7px 10px;font-weight:600"`;
  const msg = message ? `<div style="white-space:pre-wrap;margin:0 0 22px">${esc(message)}</div>` : "";
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f2ec;font-family:Arial,Helvetica,sans-serif;color:#201e1d">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">
${msg}
<div style="background:#fff;padding:28px 28px 22px;border-top:4px solid ${G};font-size:14px;line-height:1.5">
<table width="100%" style="border-collapse:collapse"><tr>
<td><img src="https://rotaryknk.org/images/nku/NKU-800x378.png" alt="North Kitsap United" width="150" style="display:block;height:auto"></td>
<td style="text-align:right;font-size:12px;line-height:1.55;color:#4a473f"><b style="color:#201e1d">Kingston-North Kitsap Rotary Foundation</b><br>PO Box 832<br>Kingston, WA 98346<br>EIN 20-2960627</td>
</tr></table>
<div style="font-size:24px;font-weight:800;color:#14301d;margin-top:22px">${b.pledge ? "Pledge Receipt" : "Donation Receipt"}</div>
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
<div style="margin-top:18px;padding:12px 14px;background:#f6f2e7;border-left:3px solid ${G}">${esc(statement(b))}</div>
<div style="margin-top:16px">Thank you for your generous support of North Kitsap United.</div>
<div style="margin-top:20px;padding-top:10px;border-top:1px solid ${L};font-size:11px;color:#6b675e;text-align:center">Please keep this receipt for your tax records. Kingston-North Kitsap Rotary Foundation is a 501(c)(3) tax-exempt organization, EIN 20-2960627.</div>
</div></div></body></html>`;
}

async function send(cfg: any, to: string, subject: string, html: string): Promise<void> {
  const key = String(cfg.apiKey || "").trim(), from = String(cfg.from || "").trim(), replyTo = String(cfg.replyTo || "").trim();
  if (!key || !from) throw new UserError("Receipt email isn't set up yet. An admin can add it in Admin → Email.");
  let r: Response;
  if (cfg.provider === "sendgrid") {
    const m = /^(.*)<([^>]+)>\s*$/.exec(from);
    const fromObj = m ? { email: m[2].trim(), name: m[1].trim().replace(/^"|"$/g, "") } : { email: from };
    r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: fromObj, ...(replyTo ? { reply_to: { email: replyTo } } : {}), subject, content: [{ type: "text/html", value: html }] }),
    });
  } else {
    r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
  }
  if (!r.ok) {
    const body = (await r.text().catch(() => "")).slice(0, 300);
    console.error("[receipt] provider", r.status, body);
    throw new UserError("The email service refused the message (" + r.status + "). Check Admin → Email.");
  }
}

class UserError extends Error {}

export default async (req: Request) => {
  try {
    if (req.method !== "POST") return json(req, { ok: false, error: "Method not allowed." }, 405);
    const who = await caller(req);
    if (who instanceof Response) return who;
    const db = firestore();
    const body = await req.json().catch(() => ({}));
    const cfg = (await db.collection("private").doc("email").get()).data() || {};
    const subject = String(cfg.subject || "Your donation receipt from North Kitsap United");

    if (body.test) {
      if (!who.admin) return json(req, { ok: false, error: "Only admins can send a sample." }, 403);
      const b: Receipt = { no: "NKU-SAMPLE", name: "Sample Donor", contact: "", address: "123 Main St\nKingston, WA 98346", date: today(), desc: "Donation — Sample", method: "Check", amount: 100, pledge: false };
      await send(cfg, who.email, "[Sample] " + subject, receiptHtml(b, String(cfg.message || "").replace(/\{name\}/g, b.name)));
      return json(req, { ok: true, to: who.email });
    }

    if (!who.canSend) return json(req, { ok: false, error: "You don't have access to send receipts." }, 403);
    const id = String(body.txId || "");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return json(req, { ok: false, error: "Which donation?" }, 400);
    const ref = db.collection("transactions").doc(id);
    const [ts, ms] = await Promise.all([ref.get(), ref.collection("secure").doc("v").get()]);
    if (!ts.exists) return json(req, { ok: false, error: "That donation wasn't found." }, 404);
    const t = ts.data()!;
    if (String(t.method || "").trim().toLowerCase() === "grant award") return json(req, { ok: false, error: "Grant awards don't get donation receipts." }, 400);
    if (!(isStatus(t.status, "Received") || isStatus(t.status, "Pledged"))) return json(req, { ok: false, error: "Only received or pledged donations get a receipt." }, 400);
    const d = t.donorId ? (await db.collection("donors").doc(String(t.donorId)).get()).data() : null;
    const to = String(d?.email || "").trim();
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json(req, { ok: false, error: (d?.name || "This donor") + " has no valid email address on file." }, 400);
    const b = buildReceipt(id, t, ms.data(), d);
    await send(cfg, to, subject, receiptHtml(b, String(cfg.message || "").replace(/\{name\}/g, b.name)));
    const sentAt = new Date().toISOString();
    await ref.update({ receiptSentAt: sentAt, receiptSentTo: to, receiptSentBy: who.email });
    return json(req, { ok: true, to, sentAt });
  } catch (err) {
    if (err instanceof UserError) return json(req, { ok: false, error: err.message }, 400);
    return failure(req, err);
  }
};

export const config: Config = { path: "/api/receipt", method: ["POST"] };
