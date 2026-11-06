// Shared HTTP helpers for the website API: CORS for the NKU website's origins,
// JSON responses, and error mapping.
import { NotConfigured } from "./firebase.mts";

// The website is served from a different origin than the Tracker, so the
// browser needs CORS. Extra origins can be added with API_ALLOWED_ORIGINS
// (comma-separated) without a code change.
const DEFAULT_ORIGINS = [
  "https://www.northkitsapunited.com",
  "https://northkitsapunited.com",
  "https://northkitsapunitednew.netlify.app",
  "http://localhost:4321",
];
// Deploy previews and branch deploys of the website project.
const PREVIEW = /^https:\/\/[a-z0-9-]+--northkitsapunitednew\.netlify\.app$/;

function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const extra = (Netlify.env.get("API_ALLOWED_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (DEFAULT_ORIGINS.includes(origin) || extra.includes(origin) || PREVIEW.test(origin)) return origin;
  return null;
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = allowedOrigin(req.headers.get("origin"));
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(req), ...extra },
  });
}

export function preflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function failure(req: Request, err: unknown): Response {
  if (err instanceof NotConfigured) {
    console.error("[api] not configured:", err.message);
    return json(req, { ok: false, error: "The Tracker API isn't configured yet." }, 503);
  }
  console.error("[api] error:", err);
  return json(req, { ok: false, error: "Something went wrong. Please try again." }, 500);
}
