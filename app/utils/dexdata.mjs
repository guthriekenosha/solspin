// utils/dexdata.mjs
// Hardened token metrics fetcher: supports Birdeye public API, optional API key,
// sanitizes bad bases (e.g., docs domain), checks content-type before JSON,
// and NEVER throws — returns neutral values if remote calls fail.

import fetch from "node-fetch"; // keeper also polyfills fetch globally, but this keeps direct usage here

function isAbsoluteHttp(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}
function looksJson(res) {
  const ct = res.headers.get("content-type") || "";
  return ct.toLowerCase().includes("application/json");
}
function sanitizeBase(base) {
  const b = (base || "").trim();
  if (!isAbsoluteHttp(b)) return null;
  // Common mistake: using docs domain instead of API domain
  if (/^https?:\/\/docs\.birdeye\.so\/?$/i.test(b)) return "https://public-api.birdeye.so";
  return b.replace(/\/+$/, "");
}
async function safeJson(res) {
  if (!res) return null;
  if (!looksJson(res)) return null;
  try { return await res.json(); } catch { return null; }
}

/**
 * Returns { priceUsd: number|null, fdvUsd: number, source: string, base?: string, note?: string }
 * - Never throws
 * - If apiBase (or env DEX_API_BASE) is missing/invalid, returns neutral values
 */
export async function fetchTokenMetrics(tokenMint, apiBase = process.env.DEX_API_BASE) {
  const root = sanitizeBase(apiBase);
  if (!root) {
    return { priceUsd: null, fdvUsd: 0, source: "default", base: null, note: "DEX_API_BASE not set/invalid" };
  }

  const headers = { accept: "application/json" };
  if (process.env.BIRDEYE_API_KEY) headers["X-API-KEY"] = process.env.BIRDEYE_API_KEY;

  let priceUsd = null;
  let fdvUsd = 0;

  // --- Price endpoint (Birdeye): /defi/price?address=<mint>
  try {
    const pr = await fetch(`${root}/defi/price?address=${encodeURIComponent(tokenMint)}`, { headers });
    const pj = await safeJson(pr);
    const v = pj?.data?.value;
    if (Number.isFinite(v) && v > 0) priceUsd = v;
  } catch {}

  // --- Market cap / FDV endpoint (Birdeye): try market_cap first
  try {
    const mr = await fetch(`${root}/defi/market_cap?address=${encodeURIComponent(tokenMint)}`, { headers });
    const mj = await safeJson(mr);
    const cap = mj?.data?.market_cap ?? mj?.data?.fdv;
    if (Number.isFinite(cap) && cap >= 0) fdvUsd = cap;
  } catch {}

  // --- Fallback: token_overview often includes fdv/marketCap
  if (!Number.isFinite(fdvUsd) || fdvUsd <= 0) {
    try {
      const tr = await fetch(`${root}/defi/token_overview?address=${encodeURIComponent(tokenMint)}`, { headers });
      const tj = await safeJson(tr);
      const cap = tj?.data?.fdv ?? tj?.data?.market_cap ?? tj?.data?.marketCap;
      if (Number.isFinite(cap) && cap >= 0) fdvUsd = cap;
    } catch {}
  }

  if (!Number.isFinite(fdvUsd) || fdvUsd < 0) fdvUsd = 0;
  return { priceUsd, fdvUsd, source: "dexapi", base: root };
}