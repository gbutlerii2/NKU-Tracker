// /api/inbox — the team's view of website submissions (used by inbox.html).
//   GET  /api/inbox?status=New|Handled|All   newest first, up to 200
//   POST /api/inbox/:id  {"status":"Handled"|"New", "note"?: "..."}
// Callers send their Tracker sign-in as "Authorization: Bearer <Firebase ID token>".
// The same test as firestore.rules applies: signed in with the texted code, on
// an active account with Admin, or write access to Donors, or a bootstrap admin.
import type { Config, Context } from "@netlify/functions";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminAuth, firestore } from "./_lib/firebase.mts";
import { failure, json } from "./_lib/http.mts";

const BOOTSTRAP_ADMINS = ["gerry@gb2solutions.net", "gerandkar@gmail.com"]; // mirror of firestore.rules

async function caller(req: Request): Promise<{ email: string } | Response> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "");
  if (!m) return json(req, { ok: false, error: "Sign in to the Tracker first." }, 401);
  const db = firestore();
  let tok;
  const fa = adminAuth(); // outside the try: a missing server setting must not read as an expired sign-in
  try { tok = await fa.verifyIdToken(m[1], true); }
  catch { return json(req, { ok: false, error: "Your sign-in has expired. Sign in to the Tracker again." }, 401); }
  const email = String(tok.email || "").toLowerCase();
  if (!email || tok.firebase?.sign_in_second_factor !== "phone") {
    return json(req, { ok: false, error: "Finish signing in with your texted code first." }, 403);
  }
  if (BOOTSTRAP_ADMINS.includes(email)) return { email };
  const snap = await db.collection("users").doc(email).get();
  const u = snap.data();
  if (!u || u.active === false) return json(req, { ok: false, error: "Your account doesn't have access." }, 403);
  const p = u.perms;
  const allowed = p ? (p.admin === "write" || p.donors === "write") : (u.role === "Admin" || u.role === "Entry User");
  if (!allowed) return json(req, { ok: false, error: "You need Admin or Donors write access to see website submissions." }, 403);
  return { email };
}

const iso = (v: unknown) => (v instanceof Timestamp ? v.toDate().toISOString() : v ?? null);

export default async (req: Request, context: Context) => {
  try {
    const who = await caller(req);
    if (who instanceof Response) return who;
    const db = firestore();

    if (req.method === "GET") {
      const status = new URL(req.url).searchParams.get("status") || "New";
      let q = db.collection("inbox").orderBy("createdAt", "desc").limit(200);
      const snap = await q.get();
      const items = snap.docs
        .map((d) => {
          const x = d.data();
          return { id: d.id, ...x, createdAt: iso(x.createdAt), handledAt: iso(x.handledAt), source: undefined };
        })
        .filter((x: any) => status === "All" || (x.status || "New") === status);
      return json(req, { ok: true, items });
    }

    if (req.method === "POST") {
      const id = context.params.id;
      if (!id) return json(req, { ok: false, error: "Which submission?" }, 400);
      const body = await req.json().catch(() => ({}));
      const status = body.status === "New" ? "New" : "Handled";
      const ref = db.collection("inbox").doc(id);
      if (!(await ref.get()).exists) return json(req, { ok: false, error: "Not found." }, 404);
      await ref.update({
        status,
        handledBy: status === "Handled" ? who.email : FieldValue.delete(),
        handledAt: status === "Handled" ? FieldValue.serverTimestamp() : FieldValue.delete(),
        ...(typeof body.note === "string" ? { note: body.note.slice(0, 2000) } : {}),
      });
      return json(req, { ok: true });
    }
    return json(req, { ok: false, error: "Method not allowed." }, 405);
  } catch (err) {
    return failure(req, err);
  }
};

export const config: Config = { path: ["/api/inbox", "/api/inbox/:id"], method: ["GET", "POST"] };
