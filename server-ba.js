// server-ba.js (ESM)
// Node 18+ required (for global fetch)

import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- App
const app = express();
app.set("trust proxy", true); // important for correct https URLs behind proxies (e.g., Render)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Helpful default route
app.get("/", (req, res) => res.redirect("/ba.html"));

const BASE = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";

// --- OAuth helper (client_credentials)
async function getAccessToken() {
  const creds = `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`;
  const auth = Buffer.from(creds).toString("base64");
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`OAuth failed: ${r.status} ${text}`);
  const j = JSON.parse(text);
  return j.access_token;
}

// --- Tiny REST helper
async function pp(method, path, body) {
  const token = await getAccessToken();
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`PayPal ${method} ${path} ${r.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// ------------------------------
// BA v1: Step A — Create Agreement Token (buyer approval)
// ------------------------------
app.post("/api/ba/create-token", async (req, res) => {
  try {
    // Compute https://host from proxy headers if present (Render, etc.)
    const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https");
    const host = req.headers.host;
    const baseUrl = `${proto}://${host}`;

    // Reuse the same page for return/cancel
    const returnUrl =
      req.body.returnUrl || `${baseUrl}/ba.html?approved=1`;
    const cancelUrl =
      req.body.cancelUrl || `${baseUrl}/ba.html?canceled=1`;

    const payload = {
      description: "Consent for future charges (BA)",
      payer: { payment_method: "PAYPAL" },
      plan: {
        type: "MERCHANT_INITIATED_BILLING", // or MERCHANT_INITIATED_BILLING_SINGLE_AGREEMENT
        merchant_preferences: {
          return_url: returnUrl,
          cancel_url: cancelUrl
          // Optional extras: notify_url, accepted_pymt_type, skip_shipping_address, etc.
        }
      }
      // Do not send shipping_address unless required to avoid validation issues.
    };

    const tokenRes = await pp(
      "POST",
      "/v1/billing-agreements/agreement-tokens",
      payload
    );
    const approve = (tokenRes.links || []).find((l) => l.rel === "approval_url");
    res.json({
      id: tokenRes.token_id || tokenRes.id,
      approve_url: approve?.href,
      raw: tokenRes,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------
// BA v1: Step B — Create the Billing Agreement (after approval)
// ------------------------------
app.post("/api/ba/create-agreement", async (req, res) => {
  try {
    const { token_id } = req.body;
    if (!token_id) return res.status(400).json({ error: "token_id required" });

    const agr = await pp(
      "POST",
      "/v1/billing-agreements/agreements",
      { token_id }
    );
    // Agreement id is often B-... or I-...
    res.json({ agreement_id: agr.id, state: agr.state, raw: agr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------
// BA v1 + Orders v2: Step C — Charge later using the BA ID
// ------------------------------
app.post("/api/ba/charge", async (req, res) => {
  try {
    const { agreement_id, amount = "10.00", currency = "USD" } = req.body;
    if (!agreement_id)
      return res.status(400).json({ error: "agreement_id required" });

    // Create the order with BA token as payment source
    const order = await pp("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      payment_source: {
        token: { id: agreement_id , type : "BILLING_AGREEMENT" },
      },
      purchase_units: [
        { amount: { currency_code: currency, value: amount } },
      ],
    });
  res.json({ order_id: order.id, capture });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Minimal config endpoint for the client
app.get("/api/config", (_req, res) => {
  res.json({ clientId: process.env.PAYPAL_CLIENT_ID, base: BASE });
});

app.listen(process.env.PORT || 5174, () => {
  console.log("BA v1 server at http://localhost:" + (process.env.PORT || 5174));
});
