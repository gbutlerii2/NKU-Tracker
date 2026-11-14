// NKU Tracker — Firebase wiring: auth (Google + email/password), Firestore live
// listeners with offline cache, and a diff-based writer. Exposes window.NKFB.
//
// Money is stored apart from the records. Every amount lives in a per-record
// `secure/v` subcollection document, read by ONE collection-group listener and
// denied outright by the security rules for view-only roles — so those numbers
// never reach the device rather than being hidden in the UI. A role change
// re-subscribes, so an upgraded user gets the amounts without signing out.
//
// Permissions are operations: one per section (none / view / write) plus
// "money" (View $$). Roles are named bundles of operations, stored in
// meta/roles. A user holds any number of roles plus extra operations; the
// effective set is the highest level from any of them. That effective set is
// written to users/{email}.perms, which is what the security rules read.

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, reauthenticateWithPopup,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, updatePassword, signOut as fbSignOut,
  multiFactor, getMultiFactorResolver, PhoneAuthProvider, PhoneMultiFactorGenerator,
  RecaptchaVerifier, sendEmailVerification
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { setDoc,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, collectionGroup, doc, onSnapshot, deleteDoc, writeBatch, getDocs, getDoc, updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDLzPhwze_rqAl3J26biwEfm3Dwu44fuL4",
  authDomain: "northkitsapunited.firebaseapp.com",
  databaseURL: "https://northkitsapunited-default-rtdb.firebaseio.com",
  projectId: "northkitsapunited",
  storageBucket: "northkitsapunited.firebasestorage.app",
  messagingSenderId: "415688046474",
  appId: "1:415688046474:web:8ad467527214d35e4c3a73"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

const COLLECTIONS = ["donors", "transactions", "events", "phases", "workers", "tasks", "docs"];
const META = ["schema", "lists", "reminders", "contacts", "roles"];

// Fields the security rules keep off a view-only device.
const MONEY = {
  donors: { proposed: 0 },
  transactions: { amount: 0, plan: null },
  events: { attendees: [] },
  phases: { budget: 0 },
  workers: { rate: 0 },
  tasks: { cost: 0, costRows: [] }
};
const SECURE_DOC = "v";

// Accounts that are Admin the moment they first sign in, before any roster
// exists. Mirror this list in firestore.rules -> bootstrapAdmin().
const BOOTSTRAP_ADMINS = ["gerry@gb2solutions.net", "gerandkar@gmail.com"];

/* ---------------------------------------------------------- permissions -- */
// Mirror of the app's OPS / DEFAULT_ROLES. Keep the three in step with
// firestore.rules.
const SECTION_OPS = ["overview", "donors", "transactions", "events", "phases", "workers", "tasks", "admin", "reports", "documents", "calendar", "wsdonors", "wsdonations", "wsgrants"];
// Entry workspaces: the only access a non-admin has. The full tracker (every
// other section) is for admins alone, so permsFor turns those off for anyone
// without Admin, whatever their roles say.
const WS_OPS = ["wsdonors", "wsdonations", "wsgrants"];
// "edit" (Enter and edit) is only used by the Donors and Donations workspaces.
const RANK = { none: 0, view: 1, write: 2, edit: 3 };
const emptyPerms = () => { const p = { money: false }; SECTION_OPS.forEach((k) => { p[k] = "none"; }); return p; };
const allPerms = (lvl, money) => { const p = { money: !!money }; SECTION_OPS.forEach((k) => { p[k] = lvl; }); return p; };
const DEFAULT_ROLES = [
  { id: "admin", name: "Admin", locked: true, perms: allPerms("write", true) },
  { id: "general", name: "General", perms: Object.assign(emptyPerms(), { overview: "view", reports: "view", documents: "view", calendar: "view" }) },
  { id: "viewonly", name: "View Only", perms: Object.assign(allPerms("view", false), { admin: "none" }) }
];
const DEFAULT_ROLE_NAMES = ["General"];

// Old single-role accounts, translated once into roles + extra operations.
function legacyToRoles(role) {
  if (role === "Admin") return { roles: ["General", "Admin"], ops: {} };
  if (role === "View Only Full") return { roles: ["General", "View Only"], ops: { money: true } };
  if (role === "View Only Limited") return { roles: ["General", "View Only"], ops: {} };
  if (role === "Entry User") return { roles: ["General"], ops: { donors: "write", transactions: "write", events: "write", documents: "write", money: true } };
  return { roles: DEFAULT_ROLE_NAMES.slice(), ops: {} };
}
function permsFor(u, roles) {
  const out = emptyPerms();
  const defs = (roles && roles.length) ? roles : DEFAULT_ROLES;
  const merge = (p) => {
    if (!p) return;
    SECTION_OPS.forEach((k) => { if ((RANK[p[k]] || 0) > RANK[out[k]]) out[k] = p[k]; });
    if (p.money === true) out.money = true;
  };
  (u.roles || []).forEach((n) => {
    const r = defs.find((x) => x.name === n);
    // Admin is always everything, whatever an old roles doc says.
    if (n === "Admin") merge(allPerms("write", true)); else if (r) merge(r.perms);
  });
  merge(u.ops || {});
  if (out.admin === "view") out.admin = "write";
  if (out.admin !== "write") {
    SECTION_OPS.forEach((k) => { if (WS_OPS.indexOf(k) < 0) out[k] = "none"; });
    WS_OPS.forEach((k) => { if (out[k] === "view") out[k] = "write"; });
  }
  return out;
}
const canon = (p) => p ? JSON.stringify(SECTION_OPS.map((k) => p[k] || "none").concat([p.money === true])) : "";
const rolesOf = (d) => Array.isArray(d.roles) ? { roles: d.roles, ops: d.ops || {} } : legacyToRoles(d.role);

const key = (e) => String(e || "").trim().toLowerCase();
const secureRef = (col, id) => doc(db, col, id, "secure", SECURE_DOC);

function splitRecord(col, rec) {
  const money = {}, open = {};
  const spec = MONEY[col] || {};
  Object.keys(rec).forEach((k) => {
    if (k === "id") return;
    if (k in spec) money[k] = rec[k];
    else open[k] = rec[k];
  });
  Object.keys(spec).forEach((k) => { if (!(k in money)) money[k] = spec[k]; });
  return { open, money };
}
const zeroMoney = (col) => JSON.parse(JSON.stringify(MONEY[col] || {}));

/* ---------------------------------------------------------------- auth ---- */

let profileUnsub = null;
let stampedLogin = false;
let reemit = null;
// A text code is asked for at sign-in; the session then lasts this long on the device.
const DEVICE_DAYS = 30;

function watchAuth(cb) {
  onAuthStateChanged(auth, async (user) => {
    if (profileUnsub) { profileUnsub(); profileUnsub = null; }
    stampedLogin = false;
    if (!user) { cb(null); return; }
    const email = key(user.email);
    const boot = BOOTSTRAP_ADMINS.indexOf(email) >= 0;
    const ref = doc(db, "users", email);
    // Live profile: an admin changing your role takes effect without a reload.
    profileUnsub = onSnapshot(ref, async (snap) => {
      const viaPassword = (user.providerData || []).some((x) => x.providerId === "password")
        && !(user.providerData || []).some((x) => x.providerId === "google.com");
      const emit = async (ra, stored, name, active, mustChange, noProfile, phone) => {
        reemit = () => emit(ra, stored, name, active, mustChange, noProfile, phone);
        let tr = null; try { tr = await user.getIdTokenResult(); } catch (e) {}
        const enrolled = multiFactor(user).enrolledFactors || [];
        const roles = boot && ra.roles.indexOf("Admin") < 0 ? ra.roles.concat(["Admin"]) : ra.roles;
        const perms = boot ? allPerms("write", true) : (stored || permsFor({ roles, ops: ra.ops }, store.roles));
        cb({
          uid: user.uid, email, name, roles, ops: ra.ops || {}, perms, active,
          role: roles.join(" + "), seesMoney: perms.money === true,
          photo: user.photoURL || "",
          viaGoogle: (user.providerData || []).some((x) => x.providerId === "google.com"),
          hasPassword: (user.providerData || []).some((x) => x.providerId === "password"),
          mustChangePassword: !!mustChange && viaPassword,
          noProfile: !!noProfile && !boot, phone: phone || "",
          emailVerified: !!user.emailVerified,
          mfaEnrolled: enrolled.length > 0,
          mfaPhone: enrolled.length ? (enrolled[0].phoneNumber || "") : "",
          secondFactor: tr ? (tr.signInSecondFactor || "") : "",
          sessionExpired: !!(tr && tr.authTime && (Date.now() - Date.parse(tr.authTime)) > DEVICE_DAYS * 86400000)
        });
      };
      if (!snap.exists()) {
        const ra = { roles: DEFAULT_ROLE_NAMES.slice(), ops: {} };
        // Invitation only: an address an admin hasn't added gets no profile.
        if (!boot) { emit(ra, null, user.displayName || email, true, false, true); return; }
        const seedProfile = {
          name: user.displayName || email.split("@")[0],
          email, roles: ra.roles, active: true,
          provider: (user.providerData[0] || {}).providerId || "password",
          createdAt: new Date().toISOString(),
          lastLogin: new Date().toISOString()
        };
        try { await writeBatch(db).set(ref, seedProfile).commit(); } catch (e) { /* rules may forbid */ }
        emit(ra, null, seedProfile.name, true);
        return;
      }
      const p = snap.data();
      // Stamp this sign-in once per session so Admin can see who was last in.
      if (!stampedLogin) {
        stampedLogin = true;
        try { writeBatch(db).set(ref, { lastLogin: new Date().toISOString() }, { merge: true }).commit(); } catch (e) { /* rules may forbid */ }
      }
      const ra = rolesOf(p);
      // Stored perms are what the rules enforce; a legacy account without them
      // is shown what its old role allowed until an admin signs in and migrates.
      emit(ra, p.perms && Array.isArray(p.roles) ? p.perms : null, p.name || user.displayName || email, p.active !== false, p.mustChangePassword === true, false, p.phone || "");
    }, () => {
      emit({ roles: DEFAULT_ROLE_NAMES.slice(), ops: {} }, null, user.displayName || email, true);
    });
  });
}

const friendly = (e) => ({
  "auth/invalid-credential": "That email and password don't match an account.",
  "auth/wrong-password": "That email and password don't match an account.",
  "auth/user-not-found": "No account for that email. Ask an NKU admin to add you.",
  "auth/invalid-email": "That doesn't look like an email address.",
  "auth/weak-password": "Password needs at least six characters.",
  "auth/email-already-in-use": "There's already an account for that email — sign in instead.",
  "auth/popup-closed-by-user": "Google window closed before finishing.",
  "auth/popup-blocked": "Your browser blocked the Google window. Allow pop-ups and retry.",
  "auth/user-mismatch": "That's a different Google account.",
  "auth/invalid-verification-code": "That code doesn't match. Check the text and try again.",
  "auth/code-expired": "That code has expired. Send a new one.",
  "auth/invalid-phone-number": "That doesn't look like a mobile number.",
  "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
  "auth/quota-exceeded": "Text message limit reached for today. Try again later.",
  "auth/requires-recent-login": "For security, sign out and sign back in, then try again.",
  "auth/unverified-email": "Verify your email address first.",
  "auth/second-factor-already-in-use": "That number is already set up on this account.",
  "auth/unauthorized-domain": "This domain isn't on the Firebase authorized list yet.",
  "auth/operation-not-allowed": "That sign-in method isn't enabled in the Firebase console yet.",
  "auth/network-request-failed": "No connection to Firebase."
}[e && e.code] || (e && e.message) || "Sign-in failed.");

/* ------------------------------------------------------------ live data ---- */

const store = {
  open: { donors: [], transactions: [], events: [], phases: [], workers: [], tasks: [], docs: [] },
  secure: { donors: {}, transactions: {}, events: {}, phases: {}, workers: {}, tasks: {}, docs: {} },
  schema: null, lists: null, reminders: null, contacts: null, roles: null, users: []
};
let dataUnsubs = [];
let seen = new Set();
let online = true;
let moneyDenied = false;
// A Grants workspace user without View $$ is refused the collection-group
// listener, but the rules let them read the amount of each grant award one
// document at a time. These listeners fill those amounts in.
let grantMoney = false;
const grantUnsubs = new Map();
let emitNow = null;
const isGrant = (r) => String((r && r.method) || "").trim().toLowerCase() === "grant award";
function syncGrantWatch() {
  const want = new Set(grantMoney && moneyDenied ? store.open.transactions.filter(isGrant).map((r) => r.id) : []);
  grantUnsubs.forEach((u, id) => { if (!want.has(id)) { try { u(); } catch (e) {} grantUnsubs.delete(id); delete store.secure.transactions[id]; } });
  want.forEach((id) => {
    if (grantUnsubs.has(id)) return;
    grantUnsubs.set(id, onSnapshot(secureRef("transactions", id), (snap) => {
      if (snap.exists()) store.secure.transactions[id] = snap.data(); else delete store.secure.transactions[id];
      if (emitNow) emitNow("grant-money");
    }, () => {}));
  });
}
function watchGrantMoney(on) { grantMoney = !!on; syncGrantWatch(); }
// A collection the rules refuse to read is left OUT of the composed snapshot
// rather than reported as empty, so the app keeps whatever it holds locally
// instead of watching new records vanish a moment after they are created.
let deniedCols = new Set();

function composed() {
  const out = {};
  COLLECTIONS.forEach((c) => {
    if (deniedCols.has(c)) return;
    out[c] = store.open[c].map((r) => Object.assign({}, r, store.secure[c][r.id] || zeroMoney(c)));
  });
  return out;
}

function subscribe(onChange) {
  unsubscribe();
  seen = new Set();
  moneyDenied = false;
  deniedCols = new Set();
  const total = COLLECTIONS.length + META.length + 2; // + users + secure group
  const emit = (name) => {
    seen.add(name);
    onChange({
      data: composed(),
      schema: store.schema, lists: store.lists,
      reminders: store.reminders, contacts: store.contacts,
      roles: store.roles, users: store.users,
      firstLoadComplete: seen.size >= total,
      deniedCols: Array.from(deniedCols),
      moneyDenied, online
    });
  };
  emitNow = (name) => { if (seen.size >= total) emit(name); };

  COLLECTIONS.forEach((name) => {
    dataUnsubs.push(onSnapshot(collection(db, name), { includeMetadataChanges: true }, (snap) => {
      online = !snap.metadata.fromCache;
      store.open[name] = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
      if (name === "transactions") syncGrantWatch();
      emit(name);
    }, (err) => {
      console.warn("[NKFB]", name, err.code);
      if (err.code === "permission-denied") deniedCols.add(name);
      emit(name);
    }));
  });

  // One listener for every amount in the database. A view-only role gets
  // permission-denied here and the numbers simply never arrive.
  dataUnsubs.push(onSnapshot(collectionGroup(db, "secure"), (snap) => {
    COLLECTIONS.forEach((c) => { store.secure[c] = {}; });
    snap.docs.forEach((d) => {
      const parent = d.ref.parent.parent;
      if (!parent) return;
      const col = parent.parent.id, id = parent.id;
      if (store.secure[col]) store.secure[col][id] = d.data();
    });
    moneyDenied = false;
    emit("secure");
  }, (err) => {
    if (err.code === "permission-denied") moneyDenied = true;
    else console.warn("[NKFB] secure", err.code);
    COLLECTIONS.forEach((c) => { store.secure[c] = {}; });
    grantUnsubs.forEach((u) => { try { u(); } catch (e) {} }); grantUnsubs.clear();
    syncGrantWatch();
    emit("secure");
  }));

  META.forEach((name) => {
    dataUnsubs.push(onSnapshot(doc(db, "meta", name), (snap) => {
      if (snap.exists() && typeof snap.data().json === "string") {
        try { store[name] = JSON.parse(snap.data().json); } catch (e) { /* keep last good */ }
      } else { store[name] = null; }
      emit("meta:" + name);
    }, (err) => { console.warn("[NKFB] meta", name, err.code); emit("meta:" + name); }));
  });

  dataUnsubs.push(onSnapshot(collection(db, "users"), (snap) => {
    store.users = snap.docs.map((d) => {
      const x = d.data(), ra = rolesOf(x);
      return {
        name: x.name || d.id, email: x.email || d.id, phone: x.phone || "",
        lastLogin: x.lastLogin || "", createdAt: x.createdAt || "",
        mustChangePassword: x.mustChangePassword === true,
        roles: ra.roles, ops: ra.ops, active: x.active !== false,
        // What the rules currently see — migrate() rewrites it when stale.
        storedPerms: Array.isArray(x.roles) ? canon(x.perms) : ""
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    emit("users");
  }, (err) => { console.warn("[NKFB] users", err.code); emit("users"); }));
}

function unsubscribe() {
  dataUnsubs.forEach((u) => { try { u(); } catch (e) {} }); dataUnsubs = [];
  grantUnsubs.forEach((u) => { try { u(); } catch (e) {} }); grantUnsubs.clear();
  emitNow = null;
}

/* ------------------------------------------------------------- writing ---- */
// The app mutates plain React state. After each mutation we diff the new state
// against the last snapshot we pushed and write only what actually changed —
// record fields and money fields diffed separately, so editing a donor's phone
// number doesn't touch the protected document.

let last = null;
let writing = null;

function snapshotOf(s) {
  const o = { open: {}, money: {}, users: {} };
  COLLECTIONS.forEach((c) => {
    o.open[c] = {}; o.money[c] = {};
    (s.data[c] || []).forEach((r) => {
      const { open, money } = splitRecord(c, r);
      o.open[c][r.id] = JSON.stringify(open);
      o.money[c][r.id] = JSON.stringify(money);
    });
  });
  META.forEach((m) => { o[m] = JSON.stringify(s[m] == null ? null : s[m]); });
  (s.users || []).forEach((u) => { if (key(u.email)) o.users[key(u.email)] = JSON.stringify(userDoc(u, s.roles)); });
  return o;
}

function userDoc(u, roles) {
  const e = key(u.email);
  const r = { roles: (u.roles && u.roles.length) ? u.roles.slice() : DEFAULT_ROLE_NAMES.slice(), ops: u.ops || {} };
  return { name: u.name || e, email: e, phone: u.phone || "", roles: r.roles, ops: r.ops, perms: permsFor(r, roles), active: u.active !== false };
}

function markPushed(s) { last = snapshotOf(s); }

// Run once by an admin after the first load: seeds meta/roles and rewrites any
// account whose stored perms are missing or no longer match its roles.
async function migrate(s) {
  const batch = writeBatch(db);
  let n = 0;
  if (store.roles == null) { batch.set(doc(db, "meta", "roles"), { json: JSON.stringify(s.roles || DEFAULT_ROLES) }); n++; }
  (s.users || []).forEach((u) => {
    const d = userDoc(u, s.roles);
    if (u.storedPerms !== canon(d.perms)) { batch.set(doc(db, "users", d.email), d, { merge: true }); n++; }
  });
  if (n) await batch.commit();
  return n;
}

async function push(s, opts) {
  const canWriteMoney = !(opts && opts.moneyDenied);
  const next = snapshotOf(s);
  if (!last) { last = next; return { writes: 0 }; }
  const batch = writeBatch(db);
  let n = 0;

  COLLECTIONS.forEach((c) => {
    const ao = last.open[c] || {}, bo = next.open[c] || {};
    const am = last.money[c] || {}, bm = next.money[c] || {};
    Object.keys(bo).forEach((id) => {
      if (ao[id] !== bo[id]) { batch.set(doc(db, c, id), JSON.parse(bo[id])); n++; }
      // Never overwrite protected amounts from a device that was denied them.
      if (canWriteMoney && am[id] !== bm[id]) { batch.set(secureRef(c, id), JSON.parse(bm[id])); n++; }
    });
    Object.keys(ao).forEach((id) => {
      if (!(id in bo)) { batch.delete(doc(db, c, id)); batch.delete(secureRef(c, id)); n += 2; }
    });
  });

  META.forEach((m) => {
    if (last[m] !== next[m] && next[m] !== "null") { batch.set(doc(db, "meta", m), { json: next[m] }); n++; }
  });

  Object.keys(next.users).forEach((e) => {
    if (last.users[e] !== next.users[e]) {
      batch.set(doc(db, "users", e), JSON.parse(next.users[e]), { merge: true });
      n++;
    }
  });
  Object.keys(last.users).forEach((e) => {
    if (!(e in next.users)) { batch.delete(doc(db, "users", e)); n++; }
  });

  last = next;
  if (!n) return { writes: 0 };
  if (writing) { try { await writing; } catch (e) {} }
  writing = batch.commit();
  await writing;
  writing = null;
  return { writes: n };
}

/* ------------------------------------------------- workspace writes ---- */
// The entry workspaces write one record at a time instead of the diff push.
// A workspace user may only touch the records the rules allow them, and the
// diff push sends everything that changed in one all-or-nothing batch, so one
// unrelated change (a field list, a reminder) would sink their donation too.

function noteSaved(c, rec) {
  if (!last || !last.open[c]) return;
  const { open, money } = splitRecord(c, rec);
  last.open[c][rec.id] = JSON.stringify(open);
  last.money[c][rec.id] = JSON.stringify(money);
}

// Creates new records. withMoney writes their amounts too (rules allow a
// workspace user to create an amount document, never to read or change one).
async function createRecords(list, withMoney) {
  const batch = writeBatch(db);
  list.forEach(({ col, rec }) => {
    const { open, money } = splitRecord(col, rec);
    batch.set(doc(db, col, rec.id), open);
    if (withMoney && MONEY[col]) batch.set(secureRef(col, rec.id), money);
  });
  await batch.commit();
  list.forEach(({ col, rec }) => noteSaved(col, rec));
}

// Changes some fields of one record (rec is the full record after the change).
async function patchRecord(col, rec, fields) {
  const open = {}, money = {}, spec = MONEY[col] || {};
  Object.keys(fields).forEach((k) => { if (k in spec) money[k] = fields[k]; else open[k] = fields[k]; });
  const batch = writeBatch(db);
  if (Object.keys(open).length) batch.update(doc(db, col, rec.id), open);
  if (Object.keys(money).length) batch.set(secureRef(col, rec.id), money, { merge: true });
  await batch.commit();
  noteSaved(col, rec);
}

// Email settings for receipts: admin-only, outside meta so other users can't
// read the API key.
async function getEmailConfig() {
  const snap = await getDoc(doc(db, "private", "email"));
  return snap.exists() ? snap.data() : null;
}
async function saveEmailConfig(cfg) {
  await setDoc(doc(db, "private", "email"), cfg);
}

/* ---------------------------------------------------------------- seed ---- */

async function isEmpty() {
  for (const c of COLLECTIONS) {
    const snap = await getDocs(collection(db, c));
    if (!snap.empty) return false;
  }
  return true;
}

// Firestore caps a batch at 500 writes; the sample set runs well past that.
async function seed(payload) {
  let batch = writeBatch(db), n = 0, total = 0;
  const flush = async () => { if (n) { await batch.commit(); batch = writeBatch(db); n = 0; } };
  for (const c of COLLECTIONS) {
    for (const r of (payload.data[c] || [])) {
      const { open, money } = splitRecord(c, r);
      batch.set(doc(db, c, r.id), open);
      batch.set(secureRef(c, r.id), money);
      n += 2; total += 2;
      if (n >= 400) await flush();
    }
  }
  for (const m of META) {
    if (payload[m] != null) { batch.set(doc(db, "meta", m), { json: JSON.stringify(payload[m]) }); n++; total++; }
    if (n >= 400) await flush();
  }
  for (const u of (payload.users || [])) {
    const e = key(u.email); if (!e) continue;
    const ra = Array.isArray(u.roles) ? { roles: u.roles, ops: u.ops || {} } : legacyToRoles(u.role);
    batch.set(doc(db, "users", e), userDoc(Object.assign({}, u, ra), payload.roles), { merge: true });
    n++; total++;
    if (n >= 400) await flush();
  }
  await flush();
  return total;
}

/* ------------------------------------------------------------ storage ---- */
// Event fliers. The app downscales before handing the blob over, so what
// lands in the bucket is a web-sized image; the path it chooses is
// fliers/<eventId>/<stamp>.jpg so a delete can find the old one again.
const storage = getStorage(app);

async function uploadFile(path, blob, contentType) {
  const r = storageRef(storage, path);
  await uploadBytes(r, blob, contentType ? { contentType } : undefined);
  return await getDownloadURL(r);
}

async function deleteFile(path) {
  if (!path) return;
  try { await deleteObject(storageRef(storage, path)); }
  catch (e) { if (String(e && e.code) !== "storage/object-not-found") throw e; }
}

/* ------------------------------------------------------- add account ---- */
// An admin creating a login for someone else. Creating a password account
// signs that account in, so it runs on a throwaway second app instance and the
// admin's own session is never touched.
async function createAccount(email, password) {
  const app2 = initializeApp(firebaseConfig, "add-" + Date.now());
  try {
    const a2 = getAuth(app2);
    await createUserWithEmailAndPassword(a2, key(email), password);
    await fbSignOut(a2);
    // Flag the profile so the first sign-in asks for a password of their own.
    try { await setDoc(doc(db, "users", key(email)), { email: key(email), mustChangePassword: true }, { merge: true }); } catch (e) {}
    return { created: true };
  } catch (e) {
    if (e && e.code === "auth/email-already-in-use") return { created: false, exists: true };
    throw new Error(friendly(e));
  } finally {
    try { await deleteApp(app2); } catch (e) {}
  }
}

/* --------------------------------------------------- change password ---- */
async function changePassword(pw) {
  const u = auth.currentUser;
  if (!u) throw new Error("Not signed in.");
  try { await updatePassword(u, pw); }
  catch (e) {
    if (e && e.code === "auth/requires-recent-login") throw new Error("For security, sign out and sign back in with the temporary password, then try again.");
    throw new Error(friendly(e));
  }
  try { await setDoc(doc(db, "users", key(u.email)), { mustChangePassword: false, passwordSetAt: new Date().toISOString() }, { merge: true }); } catch (e) {}
}

/* ----------------------------------------------- text-message codes ---- */
let verifier = null;
function captcha() {
  if (!verifier) verifier = new RecaptchaVerifier(auth, "nkt-recaptcha", { size: "invisible" });
  return verifier;
}
function resetCaptcha() { try { verifier && verifier.clear(); } catch (e) {} verifier = null; }
const e164 = (p) => {
  const s = String(p || "").trim(), d = s.replace(/[^0-9]/g, "");
  if (s.startsWith("+")) return "+" + d;
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return "+" + d;
};
async function sendCode(opts) {
  try { return await new PhoneAuthProvider(auth).verifyPhoneNumber(opts, captcha()); }
  catch (e) { resetCaptcha(); throw new Error(friendly(e)); }
}
// Password or Google first; an enrolled account then needs the texted code to finish.
async function signInEmail(e, p) {
  try { await signInWithEmailAndPassword(auth, key(e), p); return { mfa: false }; }
  catch (x) { return mfaStep(x); }
}
async function signInGoogle() {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); return { mfa: false }; }
  catch (x) { return mfaStep(x); }
}
async function mfaStep(x) {
  {
    if (!x || x.code !== "auth/multi-factor-auth-required") throw new Error(friendly(x));
    const resolver = getMultiFactorResolver(auth, x);
    const hint = resolver.hints.find((h) => h.factorId === PhoneMultiFactorGenerator.FACTOR_ID) || resolver.hints[0];
    const send = () => sendCode({ multiFactorHint: hint, session: resolver.session });
    let vid = await send();
    return {
      mfa: true, phone: hint.phoneNumber || "your phone",
      resend: async () => { vid = await send(); },
      finish: async (code) => {
        try { await resolver.resolveSignIn(PhoneMultiFactorGenerator.assertion(PhoneAuthProvider.credential(vid, String(code).trim()))); }
        catch (y) { throw new Error(friendly(y)); }
      }
    };
  }
}
async function startEnroll(phone) {
  const u = auth.currentUser; if (!u) throw new Error("Not signed in.");
  let session;
  try { session = await multiFactor(u).getSession(); } catch (e) { throw new Error(friendly(e)); }
  return await sendCode({ phoneNumber: e164(phone), session });
}
async function finishEnroll(vid, code) {
  const u = auth.currentUser; if (!u) throw new Error("Not signed in.");
  try { await multiFactor(u).enroll(PhoneMultiFactorGenerator.assertion(PhoneAuthProvider.credential(vid, String(code).trim())), "Mobile"); }
  catch (e) { throw new Error(friendly(e)); }
  try { await u.getIdToken(true); } catch (e) {}
  if (reemit) await reemit();
}
async function sendVerify() {
  const u = auth.currentUser; if (!u) throw new Error("Not signed in.");
  try { await sendEmailVerification(u); } catch (e) { throw new Error(friendly(e)); }
}
async function refreshUser() {
  const u = auth.currentUser; if (!u) return;
  try { await u.reload(); await u.getIdToken(true); } catch (e) {}
  if (reemit) await reemit();
}
// Screen lock: checks the password on a throwaway app instance so the live
// session is untouched. An enrolled account answers "code required", which
// only happens after the password matched.
async function verifyPassword(pw) {
  const u = auth.currentUser; if (!u) throw new Error("Not signed in.");
  const app2 = initializeApp(firebaseConfig, "lock-" + Date.now());
  try {
    const a2 = getAuth(app2);
    await signInWithEmailAndPassword(a2, key(u.email), pw);
    await fbSignOut(a2);
  } catch (e) {
    if (!(e && e.code === "auth/multi-factor-auth-required")) throw new Error(friendly(e));
  } finally { try { await deleteApp(app2); } catch (e) {} }
}

// Google accounts unlock by confirming the same Google account. An enrolled
// account answers "code required", which only happens for the right account.
async function verifyGoogle() {
  const u = auth.currentUser; if (!u) throw new Error("Not signed in.");
  try { await reauthenticateWithPopup(u, new GoogleAuthProvider()); }
  catch (e) {
    if (e && e.code === "auth/user-mismatch") throw new Error("That's a different Google account. Choose " + u.email + ".");
    if (!(e && e.code === "auth/multi-factor-auth-required")) throw new Error(friendly(e));
  }
}

/* ---------------------------------------------------------------- api ---- */

window.NKFB = {
  ready: true, BOOTSTRAP_ADMINS, DEFAULT_ROLES, SECTION_OPS, permsFor, legacyToRoles,
  projectId: firebaseConfig.projectId,
  watchAuth,
  signInEmail, signInGoogle, verifyGoogle, startEnroll, finishEnroll, sendVerify, refreshUser, verifyPassword,
  resetPassword: (e) => sendPasswordResetEmail(auth, key(e)).catch((x) => { throw new Error(friendly(x)); }),
  signOut: () => { unsubscribe(); last = null; return fbSignOut(auth); },
  subscribe, unsubscribe, push, markPushed, migrate, isEmpty, seed,
  WS_OPS, watchGrantMoney, createRecords, patchRecord, getEmailConfig, saveEmailConfig,
  uploadFile, deleteFile, createAccount, changePassword, DEVICE_DAYS,
  // Used by inbox.html to call the website API (/api/inbox) as the signed-in user.
  idToken: () => (auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null))
};
window.dispatchEvent(new Event("nkfb-ready"));
