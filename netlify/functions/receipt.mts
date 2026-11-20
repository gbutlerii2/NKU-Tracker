// /api/receipt: emails a donation's tax receipt or donation certificate.
//   POST {"txId", "kind": "receipt"|"certificate", "to"?: [emails],
//         "amount"?, "goods"?, "pledgeLine"?: bool}
//        Sends the document for that donation (HTML in the message plus a
//        printable PDF) and stamps the donation: receiptSentAt / receiptSentTo
//        / receiptSentBy, or certSentAt / certSentTo / certSentBy.
//        "to" defaults to the donor's email on file. "amount" (an override
//        shown in the app's preview) is honored only for admins and full-site
//        Donations editors with $$ access; "goods" only for full-site editors.
//   POST {"test": true, "kind"?}  admins only: sends a sample to the caller
//   POST {"status": true}         admins only: is Gmail set up, and as whom
//   POST {"setMail": {"user", "password"}}  admins only: checks the Gmail
//        sign-in and saves it server-side (secrets/mail); never returned
//   POST {"clearMail": true}      admins only: removes the saved sign-in
//
// Callers send their Tracker sign-in as "Authorization: Bearer <Firebase ID
// token>". The document, with its amount, is built here on the server, so a
// Donations workspace user without $$ access never sees the dollar figure.
// Sending needs Edit-level access: admin, full-site Donations "write", or the
// Donations workspace at "Enter and edit".
// Mail goes out through Gmail SMTP (see _lib/mail.mts for where the sign-in lives).
// Wording (From name, reply-to, subjects, messages) lives in the admin-only
// Firestore doc private/email, edited in Admin → Email.
import type { Config } from "@netlify/functions";
import { adminAuth, firestore } from "./_lib/firebase.mts";
import { failure, json } from "./_lib/http.mts";
import { MailError, clearMailCreds, isEmail, mailCreds, saveMailCreds, sendMail, verifyMailCreds } from "./_lib/mail.mts";
import { type Certificate, type Receipt, certificateHtml, certificatePdf, receiptHtml, receiptPdf, today } from "./_lib/donor-docs.mts";

const BOOTSTRAP_ADMINS = ["gerry@gb2solutions.net", "gerandkar@gmail.com"]; // mirror of firestore.rules
const MAX_TO = 10;

type Who = { email: string; admin: boolean; canSend: boolean; fullSite: boolean; money: boolean };

async function caller(req: Request): Promise<Who | Response> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "");
  if (!m) return json(req, { ok: false, error: "Sign in to the Tracker first." }, 401);
  let tok;
  const fa = adminAuth(); // outside the try: a missing server setting must not read as an expired sign-in
  try { tok = await fa.verifyIdToken(m[1], true); }
  catch { return json(req, { ok: false, error: "Your sign-in has expired. Sign in to the Tracker again." }, 401); }
  const email = String(tok.email || "").toLowerCase();
  if (!email || tok.firebase?.sign_in_second_factor !== "phone") {
    return json(req, { ok: false, error: "Finish signing in with your texted code first." }, 403);
  }
  if (BOOTSTRAP_ADMINS.includes(email)) return { email, admin: true, canSend: true, fullSite: true, money: true };
  const u = (await firestore().collection("users").doc(email).get()).data();
  if (!u || u.active === false) return json(req, { ok: false, error: "Your account doesn't have access." }, 403);
  const p = u.perms || {};
  const admin = p.admin === "write";
  const fullSite = admin || p.transactions === "write";
  return { email, admin, fullSite, money: admin || p.money === true, canSend: fullSite || p.wsdonations === "edit" };
}

const isStatus = (v: unknown, name: string) => {
  const n = (x: unknown) => { const s = String(x ?? "").trim().toLowerCase(); return s === "completed" ? "received" : s; };
  return n(v) === n(name);
};
const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; };
const isOrg = (d: any) => /organi[sz]ation|foundation|business|company|corporat|trust|government|faith|church|civic|club|school|estate/.test(String(d?.type || "").trim().toLowerCase());
const whole = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const when = (x: any) => String(x?.completedAt || x?.date || "");

type Tx = { id: string; t: any; amount: number; plan: any };

async function loadTx(db: FirebaseFirestore.Firestore, id: string): Promise<Tx | null> {
  const ref = db.collection("transactions").doc(id);
  const [ts, ms] = await Promise.all([ref.get(), ref.collection("secure").doc("v").get()]);
  if (!ts.exists) return null;
  const t = ts.data()!, m = ms.data() || {};
  return { id, t, amount: Number(m.amount ?? t.amount) || 0, plan: m.plan ?? t.plan ?? null };
}
async function payments(db: FirebaseFirestore.Firestore, pledgeId: string): Promise<Tx[]> {
  const qs = await db.collection("transactions").where("pledgeId", "==", pledgeId).get();
  const all = await Promise.all(qs.docs.map((d) => loadTx(db, d.id)));
  return all.filter((x): x is Tx => !!x && isStatus(x.t.status, "Received"));
}

// Mirrors certDefault / certPledgeLine / receiptItem in the app.
async function describe(db: FirebaseFirestore.Firestore, x: Tx, d: any) {
  const t = x.t, pl = isStatus(t.status, "Pledged");
  const def = pl ? x.amount : (x.plan ? (await payments(db, x.id)).reduce((n, p) => n + p.amount, 0) : x.amount);
  let note = "";
  if (t.pledgeId && isStatus(t.status, "Received")) {
    const p = await loadTx(db, String(t.pledgeId));
    if (p) {
      const pays = await payments(db, p.id);
      const total = p.plan && Number(p.plan.total) ? Number(p.plan.total) : p.amount + pays.reduce((n, q) => n + q.amount, 0);
      const k = when(t);
      const rec = pays.filter((q) => q.id === x.id || when(q.t) <= k).reduce((n, q) => n + q.amount, 0);
      if (total > 0) note = whole(rec) + " received of " + whole(total) + " total pledged";
    }
  }
  return {
    pledge: pl, def, note,
    name: d?.name || "Donor",
    contact: isOrg(d) && d?.contactOnCert ? String(d.contactName || "").trim() : "",
    address: String(d?.address || "").trim(),
    date: String((pl ? t.date : (t.completedAt || t.date)) || "").slice(0, 10) || "—",
    desc: (t.pledgeId ? "Pledge payment" : (pl || x.plan ? "Pledge" : "Donation")) + (t.grantName || t.title ? " — " + (t.grantName || t.title) : ""),
    method: String(t.method || ""),
  };
}

function fromName(cfg: any): string {
  if (cfg.fromName) return String(cfg.fromName);
  const m = /^(.*)<[^>]+>\s*$/.exec(String(cfg.from || ""));
  return (m ? m[1] : "").trim().replace(/^"|"$/g, "") || "North Kitsap United";
}
const fill = (s: unknown, name: string) => String(s || "").replace(/\{name\}/g, name);
const RECEIPT_SUBJECT = "Your donation receipt from North Kitsap United";
const CERT_SUBJECT = "A certificate of appreciation from North Kitsap United";
const CERT_MESSAGE = "Dear {name},\n\nThank you for your generous gift to North Kitsap United. Please accept the attached certificate with our gratitude.\n\nWith appreciation,\nNorth Kitsap United";

async function deliver(cfg: any, kind: "receipt" | "certificate", to: string[], r: Receipt, c: Certificate, prefix = "") {
  const common = { to, fromName: fromName(cfg), replyTo: isEmail(String(cfg.replyTo || "").trim()) ? String(cfg.replyTo).trim() : undefined };
  const safeName = r.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "Donor";
  if (kind === "certificate") {
    await sendMail({ ...common, subject: prefix + fill(cfg.certSubject || CERT_SUBJECT, c.name),
      html: certificateHtml(c, fill(cfg.certMessage || CERT_MESSAGE, c.name)),
      attachments: [{ filename: (c.pledge ? "Pledge-Certificate-" : "Donation-Certificate-") + safeName + ".pdf", content: await certificatePdf([c]), contentType: "application/pdf" }] });
  } else {
    await sendMail({ ...common, subject: prefix + fill(cfg.subject || RECEIPT_SUBJECT, r.name),
      html: receiptHtml(r, fill(cfg.message, r.name)),
      attachments: [{ filename: (r.pledge ? "Pledge-Receipt-" : "Donation-Receipt-") + r.no + ".pdf", content: await receiptPdf([r]), contentType: "application/pdf" }] });
  }
}

export default async (req: Request) => {
  try {
    if (req.method !== "POST") return json(req, { ok: false, error: "Method not allowed." }, 405);
    const who = await caller(req);
    if (who instanceof Response) return who;
    const db = firestore();
    const body = await req.json().catch(() => ({}));
    const kind: "receipt" | "certificate" = body.kind === "certificate" ? "certificate" : "receipt";

    if (body.status || body.setMail || body.clearMail) {
      if (!who.admin) return json(req, { ok: false, error: "Admins only." }, 403);
      if (body.setMail) {
        const user = String(body.setMail.user || "").trim().toLowerCase();
        const pass = String(body.setMail.password || "").replace(/\s+/g, "");
        if (!isEmail(user)) return json(req, { ok: false, error: "Enter the Gmail address that sends." }, 400);
        if (!/^[A-Za-z0-9]{16}$/.test(pass)) return json(req, { ok: false, error: "A Google App Password is 16 letters (spaces don't matter)." }, 400);
        await verifyMailCreds(user, pass);
        await saveMailCreds(user, pass, who.email);
      }
      if (body.clearMail) await clearMailCreds();
      const c = await mailCreds(); // the password itself never leaves the server
      return json(req, { ok: true, configured: !!c.pass, account: c.user, source: c.source });
    }

    const cfg = (await db.collection("private").doc("email").get()).data() || {};

    if (body.test) {
      if (!who.admin) return json(req, { ok: false, error: "Only admins can send a sample." }, 403);
      const r: Receipt = { no: "NKU-SAMPLE", name: "Sample Donor", contact: "", address: "123 Main St\nKingston, WA 98346", date: today(), desc: "Donation — Sample", method: "Check", amount: 100, goods: 0, pledge: false, note: "" };
      const c: Certificate = { name: "Sample Donor", contact: "", method: "Check", amount: 100, pledge: false, note: "" };
      await deliver(cfg, kind, [who.email], r, c, "[Sample] ");
      return json(req, { ok: true, to: [who.email] });
    }

    if (!who.canSend) return json(req, { ok: false, error: "Emailing receipts and certificates needs Edit access to Donations." }, 403);
    const id = String(body.txId || "");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return json(req, { ok: false, error: "Which donation?" }, 400);
    const x = await loadTx(db, id);
    if (!x) return json(req, { ok: false, error: "That donation wasn't found." }, 404);
    const t = x.t;
    if (String(t.method || "").trim().toLowerCase() === "grant award") return json(req, { ok: false, error: "Grant awards don't get donation receipts or certificates." }, 400);
    if (!(isStatus(t.status, "Received") || isStatus(t.status, "Pledged"))) return json(req, { ok: false, error: "Only received or pledged donations get a receipt or certificate." }, 400);
    const d = t.donorId ? (await db.collection("donors").doc(String(t.donorId)).get()).data() : null;

    // Recipients: the list sent by the app, or the donor's email on file.
    const asked: string[] = Array.isArray(body.to) ? body.to : (typeof body.to === "string" ? body.to.split(/[,;\s]+/) : []);
    let to = asked.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean);
    if (!to.length && d?.email) to = [String(d.email).trim().toLowerCase()];
    to = Array.from(new Set(to));
    const bad = to.filter((s) => !isEmail(s));
    if (bad.length) return json(req, { ok: false, error: "Not a valid email address: " + bad.join(", ") }, 400);
    if (!to.length) return json(req, { ok: false, error: (d?.name || "This donor") + " has no email address on file. Enter one to send to." }, 400);
    if (to.length > MAX_TO) return json(req, { ok: false, error: "Send to at most " + MAX_TO + " addresses at a time." }, 400);

    const info = await describe(db, x, d);
    const override = body.amount != null && body.amount !== "" && who.money && (who.admin || who.fullSite);
    const amount = override ? Math.max(0, num(body.amount)) : info.def;
    const goods = who.fullSite && !info.pledge ? Math.max(0, num(body.goods)) : 0;
    const note = body.pledgeLine === false ? "" : info.note;
    const r: Receipt = { no: "NKU-" + id.toUpperCase(), name: info.name, contact: info.contact, address: info.address, date: info.date, desc: info.desc, method: info.method, amount, goods, pledge: info.pledge, note };
    const c: Certificate = { name: info.name, contact: info.contact, method: info.method, amount, pledge: info.pledge, note };
    await deliver(cfg, kind, to, r, c);

    const sentAt = new Date().toISOString(), sentTo = to.join(", ");
    await db.collection("transactions").doc(id).update(kind === "certificate"
      ? { certSentAt: sentAt, certSentTo: sentTo, certSentBy: who.email }
      : { receiptSentAt: sentAt, receiptSentTo: sentTo, receiptSentBy: who.email });
    return json(req, { ok: true, to, sentAt, kind });
  } catch (err) {
    if (err instanceof MailError) return json(req, { ok: false, error: err.message }, 400);
    return failure(req, err);
  }
};

export const config: Config = { path: "/api/receipt", method: ["POST"] };
