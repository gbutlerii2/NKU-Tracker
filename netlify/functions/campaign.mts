// GET /api/public/campaign — the three campaign figures and progress bar the
// website's Home page shows (Overview section), computed the same way as the
// Tracker's own Overview:
//   received        transactions marked Received (or Completed)
//   pledged         transactions marked Pledged
//   estimatedCost   sum of every task's estimated cost; phase budgets if no task is costed
// The bar fills received then pledged, each as a share of the estimated cost,
// clipped at the end of the bar. Only these totals leave the Tracker — never a
// donor, a single gift or any other record.
import type { Config } from "@netlify/functions";
import { firestore } from "./_lib/firebase.mts";
import { failure, json, preflight } from "./_lib/http.mts";

const norm = (s: unknown) => {
  const x = String(s ?? "").trim().toLowerCase();
  return x === "completed" ? "received" : x;
};
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

export default async (req: Request) => {
  if (req.method === "OPTIONS") return preflight(req);
  try {
    const db = firestore();
    const [tx, secure, tasks, phases] = await Promise.all([
      db.collection("transactions").get(),
      db.collectionGroup("secure").get(),
      db.collection("tasks").select().get(),
      db.collection("phases").select().get(),
    ]);

    // Amounts live in <collection>/<id>/secure/v.
    const money: Record<string, Record<string, Record<string, unknown>>> = {};
    secure.forEach((d) => {
      const parent = d.ref.parent.parent;
      if (!parent) return;
      const col = parent.parent.id;
      (money[col] ||= {})[parent.id] = d.data();
    });

    let received = 0, pledged = 0;
    tx.forEach((d) => {
      const st = norm(d.get("status"));
      const amt = num(money.transactions?.[d.id]?.amount);
      if (st === "received") received += amt;
      else if (st === "pledged") pledged += amt;
    });

    let taskTotal = 0;
    tasks.forEach((d) => { taskTotal += num(money.tasks?.[d.id]?.cost); });
    let budget = 0;
    phases.forEach((d) => { budget += num(money.phases?.[d.id]?.budget); });
    const estimatedCost = taskTotal > 0 ? taskTotal : budget;

    const pct = (v: number) => (estimatedCost > 0 ? Math.round((v / estimatedCost) * 10000) / 100 : 0);
    const receivedPct = Math.min(100, pct(received));
    const pledgedPct = Math.min(100 - receivedPct, pct(pledged));

    return json(req, {
      ok: true,
      received, pledged, estimatedCost,
      bar: { receivedPct, pledgedPct },
      asOf: new Date().toISOString(),
      dashboardUrl: "https://nku-tracker.com",
    }, 200, {
      // Browsers keep it a minute; Netlify's CDN for five, so a busy Home page
      // doesn't read the whole Tracker on every visit.
      "Cache-Control": "public, max-age=60",
      "Netlify-CDN-Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      "Netlify-Vary": "header=Origin",
    });
  } catch (err) {
    return failure(req, err);
  }
};

export const config: Config = { path: "/api/public/campaign", method: ["GET", "OPTIONS"] };
