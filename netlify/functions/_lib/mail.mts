// Outgoing email for the Tracker (tax receipts and donation certificates),
// sent through Gmail's SMTP server with a Google App Password.
//
// Credentials live ONLY in Netlify environment variables on the nku-tracker
// project (scope: Functions), never in the repo or in Firestore:
//   GMAIL_USER          the Google account that sends, e.g. nku@rotaryknk.org
//   GMAIL_APP_PASSWORD  its 16-character App Password (spaces are fine)
// The From address is always GMAIL_USER (Gmail rewrites any other address);
// the display name, reply-to, subjects and messages come from Admin → Email.
import nodemailer from "nodemailer";

export class MailError extends Error {}

export type Attachment = { filename: string; content: Uint8Array; contentType: string };

export function mailAccount(): string {
  return String(Netlify.env.get("GMAIL_USER") || "").trim();
}

function transport() {
  const user = mailAccount();
  const pass = String(Netlify.env.get("GMAIL_APP_PASSWORD") || "").replace(/\s+/g, "");
  if (!user || !pass) {
    throw new MailError("Email isn't set up yet. Add GMAIL_USER and GMAIL_APP_PASSWORD in Netlify (Site configuration → Environment variables), then redeploy.");
  }
  return nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
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
  const t = transport();
  const user = mailAccount();
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
      throw new MailError("Gmail refused the sign-in. Check GMAIL_USER and GMAIL_APP_PASSWORD in Netlify (the App Password is 16 characters, and the account needs 2-Step Verification on).");
    }
    throw new MailError("Gmail didn't accept the message" + (err?.responseCode ? " (" + err.responseCode + ")" : "") + ". Try again in a minute.");
  }
}

export const isEmail = (s: string) => /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/.test(s);
