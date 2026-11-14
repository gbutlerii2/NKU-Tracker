// Firebase Admin for the website API. The Admin SDK bypasses firestore.rules,
// so every function here decides for itself what it may read or write.
//
// Credentials come from two environment variables on the nku-tracker Netlify
// project (scope: Functions). Netlify caps all env vars at ~4 KB combined, so
// the whole service-account JSON is NOT stored — only these two fields:
//   FIREBASE_CLIENT_EMAIL  the service account's client_email
//   FIREBASE_PRIVATE_KEY   its private_key (PEM, "\n" escapes are fine)
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";

const PROJECT_ID = "northkitsapunited";

let db: Firestore | null = null;

export class NotConfigured extends Error {}

export function firestore(): Firestore {
  if (db) return db;
  const clientEmail = Netlify.env.get("FIREBASE_CLIENT_EMAIL");
  const rawKey = Netlify.env.get("FIREBASE_PRIVATE_KEY");
  if (!clientEmail || !rawKey) {
    throw new NotConfigured("FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY are not set on nku-tracker");
  }
  const privateKey = rawKey.replace(/\\n/g, "\n");
  const app = getApps()[0] ?? initializeApp({ credential: cert({ projectId: PROJECT_ID, clientEmail, privateKey }), projectId: PROJECT_ID });
  db = getFirestore(app);
  return db;
}

// Firebase Auth for verifying Tracker sign-ins and managing logins. getAuth()
// needs the app initialized first, which firestore() does.
export function adminAuth(): Auth {
  firestore();
  return getAuth();
}
