// Outgoing email for the Tracker (tax receipts and donation certificates),
// sent through Gmail's SMTP server with a Google App Password.
//
// Credentials, never in the repo:
//   1. Entered by an admin in Admin → Email. The function saves them to the
//      Firestore doc secrets/mail with the Admin SDK. firestore.rules give
//      clients no access to secrets/ at all, and no function ever returns
//      the password, so it can't be read back from any browser.
//   2. Otherwise the Netlify env vars GMAIL_USER / GMAIL_APP_PASSWORD.
// The From address is always the Gmail account (Gmail rewrites any other);
// the display name, reply-to, subjects and messages come from Admin → Email.
import nodemailer from "nodemailer";
import { firestore } from "./firebase.mts";

export class MailError extends Error {}

export type Attachment = { filename: string; content: Uint8Array; contentType: string };

const SECRET = () => firestore().collection("secrets").doc("mail");

export type MailCreds = { user: string; pass: string; source: "app" | "netlify" | "" };

export async function mailCreds(): Promise<MailCreds> {
  const d = (await SECRET().get()).data() || {};
  const au = String(d.user || "").trim(), ap = String(d.appPassword || "").replace(/\s+/g, "");
  if (au && ap) return { user: au, pass: ap, source: "app" };
  const eu = String(Netlify.env.get("GMAIL_USER") || "").trim(), ep = String(Netlify.env.get("GMAIL_APP_PASSWORD") || "").replace(/\s+/g, "");
  if (eu && ep) return { user: eu, pass: ep, source: "netlify" };
  return { user: au || eu, pass: "", source: "" };
}

// Admins only (the caller checks). Write-only: nothing ever reads it back out.
export async function saveMailCreds(user: string, pass: string, by: string): Promise<void> {
  await SECRET().set({ user, appPassword: pass, updatedBy: by, updatedAt: new Date().toISOString() });
}
export async function clearMailCreds(): Promise<void> { await SECRET().delete(); }

// Signs in to Gmail without sending anything, so a wrong password shows up
// when it is saved rather than on the first receipt.
export async function verifyMailCreds(user: string, pass: string): Promise<void> {
  try { await nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } }).verify(); }
  catch (err: any) {
    console.error("[mail] verify", err?.code, err?.responseCode);
    if (err?.code === "EAUTH" || err?.responseCode === 535) throw new MailError("Gmail refused that account and App Password. Check both (the App Password is 16 letters, and the account needs 2-Step Verification on). Nothing was saved.");
    throw new MailError("Couldn't reach Gmail to check the sign-in. Try again in a minute. Nothing was saved.");
  }
}

async function transport() {
  const c = await mailCreds();
  if (!c.pass) throw new MailError("Email isn't set up yet. An admin can add the Gmail account and App Password in Admin → Email.");
  return { t: nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: c.user, pass: c.pass } }), user: c.user };
}

export async function sendMail(opts: {
  to: string[];
  subject: string;
  html: string;
  text?: string;
  fromName?: string;
  replyTo?: string;
  attachments?: Attachment[];
}): Promise<void> {
  const { t, user } = await transport();
  const name = String(opts.fromName || "").replace(/["<>\r\n]/g, "").trim();
  try {
    await t.sendMail({
      from: name ? { name, address: user } : user,
      to: opts.to,
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      subject: opts.subject,
      html: opts.html,
      ...(opts.text ? { text: opts.text } : {}),
      attachments: (opts.attachments || []).map((a) => ({ filename: a.filename, content: Buffer.from(a.content), contentType: a.contentType })),
    });
  } catch (err: any) {
    console.error("[mail] gmail", err?.code, err?.responseCode, String(err?.response || err?.message || err).slice(0, 300));
    if (err?.code === "EAUTH" || err?.responseCode === 535) {
      throw new MailError("Gmail refused the sign-in. An admin can re-enter the Gmail account and App Password in Admin → Email.");
    }
    throw new MailError("Gmail didn't accept the message" + (err?.responseCode ? " (" + err.responseCode + ")" : "") + ". Try again in a minute.");
  }
}

export const isEmail = (s: string) => /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/.test(s);
