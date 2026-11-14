// /api/user-password: an admin sets a temporary password for another user.
//   POST {"email": "...", "password": "..."}
//
// Firebase only lets someone change another person's password through the
// Admin SDK, so this runs on the server. The caller sends their Tracker
// sign-in as "Authorization: Bearer <Firebase ID token>" and must be an admin
// who finished the texted-code step. The user is flagged to choose their own
// password at their next sign-in, and their other sessions are signed out.
import type { Config } from "@netlify/functions";
import { adminAuth, firestore } from "./_lib/firebase.mts";
import { failure, json } from "./_lib/http.mts";

const BOOTSTRAP_ADMINS = ["gerry@gb2solutions.net", "gerandkar@gmail.com"]; // mirror of firestore.rules

async function adminCaller(req: Request): Promise<string | Response> {
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
  if (BOOTSTRAP_ADMINS.includes(email)) return email;
  const u = (await firestore().collection("users").doc(email).get()).data();
  if (!u || u.active === false || (u.perms || {}).admin !== "write") {
    return json(req, { ok: false, error: "Only an admin can set another user's password." }, 403);
  }
  return email;
}

export default async (req: Request) => {
  try {
    const who = await adminCaller(req);
    if (who instanceof Response) return who;
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email) return json(req, { ok: false, error: "Which user?" }, 400);
    if (password.length < 6) return json(req, { ok: false, error: "Password needs at least six characters." }, 400);
    if (email === who) return json(req, { ok: false, error: "Change your own password from the sign-in screen instead." }, 400);

    const auth = adminAuth();
    // Only "no such user" means there's no login. Anything else (for example
    // the service account lacking Firebase Auth rights) is reported as itself.
    let user = null;
    try { user = await auth.getUserByEmail(email); }
    catch (e: any) {
      if (e?.code !== "auth/user-not-found") {
        console.error("[user-password] lookup failed", e?.code, e?.message);
        if (/permission|PERMISSION_DENIED|insufficient/i.test(String(e?.code) + String(e?.message))) {
          return json(req, { ok: false, error: "The server's Firebase key isn't allowed to manage logins. In Google Cloud → IAM, give the service account the \"Firebase Authentication Admin\" role." }, 500);
        }
        return json(req, { ok: false, error: "Couldn't look up " + email + ": " + (e?.message || e?.code || "unknown error") }, 500);
      }
    }

    // A person on the roster who never got a password login (for example one
    // added for Google sign-in who hasn't signed in) gets one now.
    let created = false;
    if (!user) {
      user = await auth.createUser({ email, password });
      created = true;
    } else {
      await auth.updateUser(user.uid, { password });
      await auth.revokeRefreshTokens(user.uid);
    }
    await firestore().collection("users").doc(email).set(
      { mustChangePassword: true, passwordSetBy: who, passwordSetAt: new Date().toISOString() },
      { merge: true },
    );
    return json(req, { ok: true, email, created });
  } catch (e) {
    return failure(req, e);
  }
};

export const config: Config = { path: "/api/user-password", method: ["POST"] };
