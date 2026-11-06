// POST /api/submit/:kind — the North Kitsap United website's forms land here.
// Each submission becomes one document in the Firestore `inbox` collection,
// where the team reviews it (inbox.html) before anything is entered as a donor,
// donation, pledge or worker record.
import type { Config, Context } from "@netlify/functions";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "./_lib/firebase.mts";
import { FORMS, parse } from "./_lib/forms.mts";
import { failure, json, preflight } from "./_lib/http.mts";

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return preflight(req);
  const kind = context.params.kind;
  if (!FORMS[kind]) return json(req, { ok: false, error: "Unknown form." }, 404);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
  } catch {
    return json(req, { ok: false, error: "That submission couldn't be read." }, 400);
  }

  // Spam trap: a hidden "website" field people never see. Bots fill it in;
  // answer as if it worked so they learn nothing.
  if (String(body.website ?? "").trim() !== "") return json(req, { ok: true, message: "Thank you." });

  const parsed = parse(kind, body);
  if (!parsed.ok) return json(req, { ok: false, error: (parsed as { error: string }).error }, 422);

  try {
    const db = firestore();
    const ref = await db.collection("inbox").add({
      kind,
      kindLabel: FORMS[kind].label,
      status: "New",
      data: parsed.data,
      name: parsed.data.name ?? parsed.data.company ?? "",
      email: parsed.data.email ?? "",
      createdAt: FieldValue.serverTimestamp(),
      source: { origin: req.headers.get("origin") || "", page: String(body.page ?? "").slice(0, 300), ip: context.ip || "" },
    });

    const out: Record<string, unknown> = {
      ok: true,
      id: ref.id,
      message: "Thank you. Your message has been sent to the North Kitsap United team, and we’ll get back to you soon.",
    };
    if (kind === "zeffy") {
      // Where the website sends the donor next. Set on nku-tracker so the links
      // can change without rebuilding the website.
      const url = parsed.data.via === "eft" ? Netlify.env.get("ZEFFY_EFT_URL") : Netlify.env.get("ZEFFY_CARD_URL");
      out.redirect = url || null;
      out.message = url ? "Thank you. Taking you to Zeffy to finish your gift…" : "Thank you. We have your details; the Zeffy payment page isn’t linked yet.";
    }
    return json(req, out);
  } catch (err) {
    return failure(req, err);
  }
};

export const config: Config = {
  path: "/api/submit/:kind",
  method: ["POST", "OPTIONS"],
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
