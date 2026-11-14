import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, writeBatch, getDoc } from "firebase/firestore";
import fs from "fs";

const rules = fs.readFileSync(process.argv[2], "utf8");
const env = await initializeTestEnvironment({ projectId: "nku-test", firestore: { rules, host: "127.0.0.1", port: 8080 } });

const OPS = ["overview","donors","transactions","events","phases","workers","tasks","admin","reports","documents","calendar","wsdonors","wsdonations","wsgrants"];
const perms = (o) => { const p = { money: false }; OPS.forEach(k => p[k] = "none"); return Object.assign(p, o); };
const users = {
  "enter@x.org": perms({ wsdonors: "write", wsdonations: "write", money: true }),
  "edit@x.org": perms({ wsdonors: "edit", wsdonations: "edit", money: true }),
  "grants@x.org": perms({ wsgrants: "write" }),
  "admin@x.org": Object.assign(perms({}), Object.fromEntries(OPS.map(k => [k, "write"])), { money: true }),
};
await env.withSecurityRulesDisabled(async (c) => {
  const db = c.firestore();
  for (const [e, p] of Object.entries(users)) await setDoc(doc(db, "users", e), { active: true, roles: [], perms: p });
  await setDoc(doc(db, "donors", "d1"), { name: "Alice", type: "Individual" });
  await setDoc(doc(db, "transactions", "p1"), { donorId: "d1", status: "Pledged", method: "Check" });
  await setDoc(doc(db, "transactions", "p1", "secure", "v"), { amount: 5000, plan: null });
  await setDoc(doc(db, "transactions", "g1"), { donorId: "d1", status: "Potential", method: "Grant award" });
  await setDoc(doc(db, "transactions", "g1", "secure", "v"), { amount: 100, plan: null });
});
const as = (e) => env.authenticatedContext(e, { email: e, firebase: { sign_in_second_factor: "phone" } }).firestore();
let pass = 0, fail = 0;
const t = async (name, p, ok) => { try { await (ok ? assertSucceeds(p) : assertFails(p)); pass++; console.log("ok  ", name); } catch (e) { fail++; console.log("FAIL", name, e.message); } };

const enter = as("enter@x.org"), edit = as("edit@x.org"), grants = as("grants@x.org");
// Enter only
await t("enter: update donor refused", updateDoc(doc(enter, "donors", "d1"), { name: "A2" }), false);
await t("enter: create donor allowed", setDoc(doc(enter, "donors", "d2"), { name: "Bob" }), true);
await t("enter: thank-you allowed", updateDoc(doc(enter, "transactions", "p1"), { thankedAt: "2026-11-13", thankedBy: "x" }), true);
await t("enter: status change refused", updateDoc(doc(enter, "transactions", "p1"), { status: "Received" }), false);
await t("enter: pledge amount refused", setDoc(doc(enter, "transactions", "p1", "secure", "v"), { amount: 1 }, { merge: true }), false);
{ const b = writeBatch(enter); b.set(doc(enter, "transactions", "x1"), { donorId: "d1", status: "Received", method: "Check", pledgeId: "p1" }); b.set(doc(enter, "transactions", "x1", "secure", "v"), { amount: 1000, plan: null });
  await t("enter: create applied donation allowed", b.commit(), true); }
// Enter and edit
await t("edit: update donor allowed", updateDoc(doc(edit, "donors", "d1"), { name: "Alice B", email: "a@x.org" }), true);
await t("edit: delete donor refused", (async () => { const { deleteDoc } = await import("firebase/firestore"); return deleteDoc(doc(edit, "donors", "d1")); })(), false);
{ const b = writeBatch(edit); b.update(doc(edit, "transactions", "p1"), { donationKind: "One-time" }); b.set(doc(edit, "transactions", "p1", "secure", "v"), { amount: 4000, plan: { total: 5000, installments: [] } }, { merge: true });
  await t("edit: pledge balance patch allowed", b.commit(), true); }
await t("edit: change donation fields allowed", updateDoc(doc(edit, "transactions", "x1"), { status: "Received", title: "Gala", pledgeId: "" }), true);
await t("edit: grant award refused", updateDoc(doc(edit, "transactions", "g1"), { status: "Received" }), false);
await t("edit: grant amount refused", setDoc(doc(edit, "transactions", "g1", "secure", "v"), { amount: 1 }, { merge: true }), false);
await t("edit: turn into grant refused", updateDoc(doc(edit, "transactions", "x1"), { method: "Grant award" }), false);
await t("edit: delete donation refused", (async () => { const { deleteDoc } = await import("firebase/firestore"); return deleteDoc(doc(edit, "transactions", "x1")); })(), false);
await t("edit: read pledge amount (has $$)", getDoc(doc(edit, "transactions", "p1", "secure", "v")), true);
// Grants unchanged
await t("grants: update grant allowed", updateDoc(doc(grants, "transactions", "g1"), { status: "Pledged" }), true);
await t("grants: update donor refused", updateDoc(doc(grants, "donors", "d1"), { name: "Z" }), false);
await t("grants: update donation refused", updateDoc(doc(grants, "transactions", "p1"), { status: "Received" }), false);

console.log(`\n${pass} passed, ${fail} failed`);
await env.cleanup();
process.exit(fail ? 1 : 0);
