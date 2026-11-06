// The website's forms, field by field. Anything not listed here is dropped, so a
// form can never write arbitrary data into the Tracker.

type Spec = { label: string; required?: string[]; fields: Record<string, "short" | "long" | "list" | "email" | "money" | "date" | "flag" | "number"> };

const PERSON = { name: "short", email: "email", phone: "short", address: "short" } as const;

export const FORMS: Record<string, Spec> = {
  contact: {
    label: "Contact message",
    required: ["name", "email", "message"],
    fields: { name: "short", email: "email", phone: "short", topic: "short", message: "long" },
  },
  "donation-question": {
    label: "Donation question",
    required: ["name", "email", "message"],
    fields: { name: "short", email: "email", phone: "short", message: "long" },
  },
  gift: {
    label: "Gift notice",
    required: ["name", "email"],
    fields: {
      ...PERSON, method: "short", amount: "money", expectedDate: "date", shares: "short", fundCompany: "short",
      recognitionName: "short", inHonorOf: "short", anonymous: "flag", whyIGave: "long",
    },
  },
  zeffy: {
    label: "Zeffy gift (started on the website)",
    required: ["name", "email", "amount"],
    fields: {
      ...PERSON, amount: "money", frequency: "short", via: "short",
      recognitionName: "short", inHonorOf: "short", anonymous: "flag", whyIGave: "long",
    },
  },
  pledge: {
    label: "Pledge",
    required: ["name", "email", "amount"],
    fields: {
      ...PERSON, amount: "money", installments: "number", frequency: "short",
      begin_monthly: "date", begin_quarterly: "date", begin_semiannually: "date", begin_annually: "date",
      payment: "list",
    },
  },
  inkind: {
    label: "In-kind offer",
    required: ["company", "name", "email", "offer"],
    fields: {
      company: "short", name: "short", email: "email", phone: "short", license: "short", proposedDates: "short",
      offer: "long", estimatedValue: "money", valueBasis: "short", donation: "short", workBy: "short",
      requests: "long", referredBy: "short",
    },
  },
  volunteer: {
    label: "Volunteer sign-up",
    required: ["name", "email"],
    fields: { ...PERSON, interests: "list", message: "long" },
  },
  updates: {
    label: "Updates list sign-up",
    required: ["email"],
    fields: { email: "email" },
  },
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(v: unknown, max: number): string {
  return String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

export type Parsed = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

// body: a JSON object from the website; arrays allowed for "list" fields.
export function parse(kind: string, body: Record<string, unknown>): Parsed {
  const spec = FORMS[kind];
  if (!spec) return { ok: false, error: "Unknown form." };
  const data: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(spec.fields)) {
    const raw = body[k];
    if (raw == null || raw === "") continue;
    switch (t) {
      case "long": data[k] = clean(raw, 10000); break; // "Why I gave": no practical limit
      case "list": data[k] = (Array.isArray(raw) ? raw : [raw]).map((x) => clean(x, 200)).filter(Boolean).slice(0, 20); break;
      case "flag": data[k] = raw === true || raw === "yes" || raw === "on" || raw === "true"; break;
      case "number": { const n = parseInt(clean(raw, 10), 10); if (Number.isFinite(n) && n > 0) data[k] = n; break; }
      case "money": {
        const n = Number(clean(raw, 40).replace(/[^0-9.]/g, ""));
        if (Number.isFinite(n) && n > 0) data[k] = Math.round(n * 100) / 100;
        else return { ok: false, error: "Please enter the amount as a number." };
        break;
      }
      case "email": {
        const e = clean(raw, 254).toLowerCase();
        if (!EMAIL.test(e)) return { ok: false, error: "Please check the email address." };
        data[k] = e; break;
      }
      default: data[k] = clean(raw, 500);
    }
  }
  for (const r of spec.required || []) {
    if (data[r] == null || data[r] === "") return { ok: false, error: `Please fill in ${r === "amount" ? "the amount" : r}.` };
  }
  return { ok: true, data };
}
