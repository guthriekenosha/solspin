import dotenv from "dotenv";
import crypto from "crypto";
import { SystemProgram, Transaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
dotenv.config();

// Ensure fetch is available in Node < 18
if (typeof fetch === "undefined") {
    globalThis.fetch = (await import("node-fetch")).default;
}

import {
    getConn, getTreasury, getTokenBalanceForOwner,
    payUsdc, loadJson, saveJson
} from "./utils/solana.mjs";
import { fetchTokenMetrics } from "./utils/dexdata.mjs";

const TOKEN_MINT = process.env.TOKEN_MINT;
const TOKEN_TICKER = process.env.TOKEN_TICKER || "YOUR";
const USDC_MINT = process.env.USDC_MINT;
const REG_PATH = process.env.REGISTRY_PATH || "./state/registry.json";
const DRAWS_PATH = "./state/draws.json";

const MIN_BAL = Number(process.env.MIN_ELIGIBLE_BALANCE || "1");
const START_CAP = Number(process.env.RECURRING_START_CAP || "1000000");
const STOP_CAP = Number(process.env.RECURRING_STOP_CAP || "0");
const REC_MS = Number(process.env.RECURRING_INTERVAL_MS || 60 * 60 * 1000);
const WEIGHT_MODE = (process.env.WALLET_WEIGHT_MODE || "balance").toLowerCase(); // balance|equal

const DYN_TIER_AMT = Number(process.env.DYNAMIC_TIER_AMOUNT || "1000");
const DYN_TIER_CAP = Number(process.env.DYNAMIC_TIER_CAP || "5000000");

const API_PORT = Number(process.env.API_PORT || "0"); // 0 disables the API
const API_HOST = process.env.API_HOST || "127.0.0.1";

const PAYOUT_AS = (process.env.PAYOUT_AS || "USDC").toUpperCase(); // "USDC" or "SOL"
const SOL_PRICE_USD = Number(process.env.SOL_PRICE_USD || "150");  // fallback for USD -> SOL

function parseAmounts(s) {
    return (s || "")
        .split(",")
        .map(x => Number(String(x).trim()))
        .filter(n => Number.isFinite(n) && n > 0);
}

const BASE_AMOUNTS = parseAmounts(process.env.PRIZE_AMOUNTS || "500,200,100,50,10");

// Validate pubkeys early and normalize token mint usage
function isValidPubkey(s) {
  try { new PublicKey(String(s)); return true; } catch { return false; }
}
const SAFE_TOKEN_MINT = (TOKEN_MINT && isValidPubkey(TOKEN_MINT)) ? TOKEN_MINT : null;

// ---------- milestones ----------
const MILESTONES = [
    { cap: 100_000, once: [{ count: 5, amount: 100 }] },
    { cap: 500_000, once: [{ count: 5, amount: 200 }] },
    { cap: 1_000_000, once: [{ count: 2, amount: 500 }], startRecurring: true }
];

const now = () => Date.now();

function appendDraw(rec) {
    const draws = loadJson(DRAWS_PATH) || [];
    draws.push(rec);
    saveJson(DRAWS_PATH, draws);
}

function drawsState() {
    const draws = loadJson(DRAWS_PATH) || [];
    return {
        draws,
        paidCaps: new Set(draws.filter(d => d.kind === "milestone_batch_paid").map(d => d.cap)),
        recurringActive: (() => {
            const last = [...draws].reverse().find(d => d.kind === "recurring_activation");
            return last ? !!last.active : false;
        })(),
        lastRecurringTs: (() => {
            const last = [...draws].reverse().find(d => d.kind === "recurring_two_wheel");
            return last ? last.ts : 0;
        })(),
        tierAdded: draws.some(d => d.kind === "tier_added" && d.amount === DYN_TIER_AMT && d.cap === DYN_TIER_CAP)
    };
}

// ---------- SOL payout helpers ----------
function usdToSol(usd) {
    if (!Number.isFinite(usd) || usd <= 0) throw new Error("Invalid USD amount for SOL conversion");
    if (!(SOL_PRICE_USD > 0)) throw new Error("SOL_PRICE_USD must be > 0 for SOL payouts");
    return usd / SOL_PRICE_USD;
}

// Live SOL/USD price (tries multiple sources, falls back to SOL_PRICE_USD)
async function fetchSolPriceUsd() {
    // 1) Jupiter
    try {
        const r = await fetch("https://price.jup.ag/v6/price?ids=SOL", { headers: { accept: "application/json" } });
        if (r.ok) {
            const j = await r.json();
            const v = j?.data?.SOL?.price;
            if (Number.isFinite(v) && v > 0) return v;
        }
    } catch { }
    // 2) Birdeye (WSOL)
    try {
        const beHeaders = { accept: "application/json" };
        if (process.env.BIRDEYE_API_KEY) beHeaders["X-API-KEY"] = process.env.BIRDEYE_API_KEY;
        const r = await fetch("https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112", { headers: beHeaders });
        if (r.ok) {
            const j = await r.json();
            const v = j?.data?.value;
            if (Number.isFinite(v) && v > 0) return v;
        }
    } catch { }
    // 3) CoinGecko
    try {
        const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { headers: { accept: "application/json" } });
        if (r.ok) {
            const j = await r.json();
            const v = j?.solana?.usd;
            if (Number.isFinite(v) && v > 0) return v;
        }
    } catch { }
    // 4) Fallback
    return SOL_PRICE_USD;
}

async function paySol(conn, payer, toAddress, amountSol) {
    const toPubkey = new PublicKey(toAddress);
    const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
    if (!(lamports > 0)) throw new Error("Computed lamports is not positive");
    const { blockhash } = await conn.getLatestBlockhash();
    const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer: payer.publicKey
    }).add(SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey,
        lamports
    }));
    const sig = await conn.sendTransaction(tx, [payer], { skipPreflight: false });
    return sig;
}

// ---------- Treasury balance helpers & preflight ----------
async function getSolBalanceLamports(conn, pubkey) {
    try {
        return await conn.getBalance(pubkey, { commitment: "processed" });
    } catch {
        return 0;
    }
}

async function preflightPayout(conn, payer, amountUsd) {
    if (PAYOUT_AS === "SOL") {
        const solUsd = await fetchSolPriceUsd();
        const amountSol = amountUsd / solUsd;
        const lamportsNeeded = Math.ceil(amountSol * LAMPORTS_PER_SOL) + 5_000; // small fee buffer
        const haveLamports = await getSolBalanceLamports(conn, payer.publicKey);
        const ok = haveLamports >= lamportsNeeded;
        return { ok, kind: "SOL", solUsd, amountSol, haveLamports, lamportsNeeded };
    } else {
        // USDC SPL balance on treasury owner
        const owner = payer.publicKey.toBase58();
        const bal = await getTokenBalanceForOwner(conn, USDC_MINT, owner).catch(() => 0);
        const ok = bal >= amountUsd; // assumes helper returns human units
        return { ok, kind: "USDC", tokenBal: bal, tokenNeeded: amountUsd };
    }
}

// ---------- Vose Alias Method ----------
function buildAlias(weights) {
    const n = weights.length;
    const sum = weights.reduce((a, b) => a + b, 0);
    if (n === 0 || sum <= 0) return { prob: [], alias: [], sum: 0 };
    const scaled = weights.map(w => (w / sum) * n);
    const small = [], large = [];
    const prob = new Array(n).fill(0);
    const alias = new Array(n).fill(0);
    for (let i = 0; i < n; i++) (scaled[i] < 1 ? small : large).push(i);
    while (small.length && large.length) {
        const s = small.pop();
        const l = large.pop();
        prob[s] = scaled[s];
        alias[s] = l;
        scaled[l] = (scaled[l] + scaled[s]) - 1;
        (scaled[l] < 1 ? small : large).push(l);
    }
    while (large.length) prob[large.pop()] = 1;
    while (small.length) prob[small.pop()] = 1;
    return { prob, alias, sum };
}
function pickAlias(aliasTable, rngFloat) {
    const { prob, alias } = aliasTable;
    const n = prob.length;
    if (!n) return -1;
    const i = Math.min(n - 1, Math.floor(rngFloat() * n));
    const y = rngFloat();
    return (y < prob[i]) ? i : alias[i];
}

// ---------- Deterministic RNG (blockhash + bucket) ----------
async function deriveSeedRng() {
    try {
        const conn = getConn();
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
        const bucket = Math.floor(now() / REC_MS);
        const seedHex = crypto.createHash("sha256")
            .update(String(blockhash)).update(":")
            .update(String(lastValidBlockHeight)).update(":")
            .update(String(bucket))
            .digest("hex");
        // xorshift32
        let state = parseInt(seedHex.slice(0, 8), 16) || 0x9e3779b9;
        const rng = () => {
            state ^= state << 13; state >>>= 0;
            state ^= state >> 17; state >>>= 0;
            state ^= state << 5; state >>>= 0;
            return (state >>> 0) / 0x100000000;
        };
        return { seedHex, rng };
    } catch {
        // fallback LCG
        let state = (now() & 0xffffffff) ^ 0x85ebca6b;
        const rng = () => {
            state = (1664525 * state + 1013904223) >>> 0;
            return state / 0x100000000;
        };
        return { seedHex: "fallback", rng };
    }
}

async function getEligibleWeighted(conn, registry) {
  // Drop any invalid addresses up-front
  const cleaned = Array.isArray(registry) ? registry.filter(isValidPubkey) : [];
  if (!cleaned.length) return { addresses: [], weights: [] };

  // If no valid TOKEN_MINT configured, everyone is eligible (equal weights)
  if (!SAFE_TOKEN_MINT) {
    const addresses = cleaned;
    const weights = new Array(addresses.length).fill(1);
    return { addresses, weights };
  }

  // Otherwise gate by SPL token balance (safe per wallet)
  const balances = await Promise.all(
    cleaned.map(async (w) => {
      try {
        const b = await getTokenBalanceForOwner(conn, SAFE_TOKEN_MINT, w);
        return b >= MIN_BAL ? b : 0;
      } catch {
        return 0;
      }
    })
  );

  const addresses = cleaned.filter((_, i) => balances[i] > 0);
  let weights = balances.filter((b) => b > 0);
  if (WEIGHT_MODE === "equal") weights = new Array(addresses.length).fill(1);
  return { addresses, weights };
}

function pickWeighted(addresses, weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    let r = Math.random() * total;
    for (let i = 0; i < addresses.length; i++) {
        r -= weights[i];
        if (r <= 0) return addresses[i];
    }
    return addresses[addresses.length - 1];
}

function pickFromTiers(amounts, probs) {
    const n = amounts.length;
    const p = (Array.isArray(probs) && probs.length === n) ? probs : new Array(n).fill(1 / n);
    let r = Math.random();
    for (let i = 0; i < n; i++) {
        r -= p[i];
        if (r <= 0) return amounts[i];
    }
    return amounts[n - 1];
}

/** compute current amount tiers given current FDV (adds $1000 when cap reached) */
function currentTiers(fdvUsd, tierAddedFlag) {
    const withBonus = fdvUsd >= DYN_TIER_CAP;
    const amounts = withBonus
        ? (BASE_AMOUNTS.includes(DYN_TIER_AMT) ? [...BASE_AMOUNTS] : [...BASE_AMOUNTS, DYN_TIER_AMT])
        : [...BASE_AMOUNTS];

    if (withBonus && !tierAddedFlag) {
        appendDraw({ ts: now(), kind: "tier_added", cap: DYN_TIER_CAP, amount: DYN_TIER_AMT });
    }
    const probs = new Array(amounts.length).fill(1 / amounts.length);
    return { amounts, probs };
}

// ---------- milestone batches ----------
async function handleMilestones() {
    const { paidCaps } = drawsState();
    const conn = getConn();
    const payer = getTreasury();
    const registry = loadJson(REG_PATH) || [];
    const { fdvUsd } = await fetchTokenMetrics(TOKEN_MINT);
    console.log(`[FDV] ${fdvUsd.toLocaleString()}`);

    for (const m of MILESTONES) {
        if (paidCaps.has(m.cap)) continue;
        if (fdvUsd < m.cap) continue;

        const { addresses, weights } = await getEligibleWeighted(conn, registry);
        if (!addresses.length) { console.log(`⚠️ No eligible wallets at ${m.cap}`); continue; }

        for (const spec of (m.once || [])) {
            // sample without replacement
            const winners = [];
            const A = [...addresses], W = [...weights];
            while (winners.length < spec.count && A.length) {
                const w = pickWeighted(A, W);
                if (!w) break;
                const idx = A.indexOf(w);
                winners.push(w);
                A.splice(idx, 1); W.splice(idx, 1);
            }
            for (const w of winners) {
                let sig, logStr, recExtra = {};
                if (PAYOUT_AS === "SOL") {
                    const solUsd = await fetchSolPriceUsd();
                    const amountSol = spec.amount / solUsd;
                    sig = await paySol(conn, payer, w, amountSol);
                    recExtra = { payoutKind: "SOL", amountSol, solPriceUsd: solUsd };
                    logStr = `got ${amountSol.toFixed(6)} SOL (@ $${solUsd.toFixed(2)}/SOL ≈ $${spec.amount})`;
                } else {
                    sig = await payUsdc(conn, payer, w, USDC_MINT, spec.amount);
                    recExtra = { payoutKind: "USDC" };
                    logStr = `got $${spec.amount} USDC`;
                }
                appendDraw({ ts: now(), kind: "milestone_win", cap: m.cap, winner: w, amountUsd: spec.amount, ...recExtra, sig });
                console.log(`🏆 $${m.cap.toLocaleString()} → ${w} ${logStr} | ${sig}`);
            }
        }
        appendDraw({ ts: now(), kind: "milestone_batch_paid", cap: m.cap });

        if (m.startRecurring && START_CAP <= m.cap) {
            appendDraw({ ts: now(), kind: "recurring_activation", active: true, cap: m.cap, mode: "two_wheel" });
            console.log(`✅ Two-wheel recurring draws activated (cap ${m.cap.toLocaleString()}).`);
        }
    }
}

// ---------- two-wheel recurring (amount first, then wallet) ----------
async function maybeRunTwoWheel() {
    const state = drawsState();
    const { fdvUsd } = await fetchTokenMetrics(TOKEN_MINT);
    const currentFdv = Number(fdvUsd) || 0;

    // Deactivate if FDV falls below STOP_CAP (when configured)
    if (state.recurringActive && STOP_CAP > 0 && currentFdv > 0 && currentFdv < STOP_CAP) {
        appendDraw({ ts: now(), kind: "recurring_activation", active: false, cap: STOP_CAP, mode: "two_wheel", reason: "fdv_below_stop" });
        console.log(`⛔ Two-wheel recurring disabled (fdv ${currentFdv.toLocaleString()} < ${STOP_CAP.toLocaleString()}).`);
        state.recurringActive = false;
        return;
    }

    // ensure activation
    if (!state.recurringActive) {
        if (START_CAP === 0) {
            appendDraw({ ts: now(), kind: "recurring_activation", active: true, cap: 0, mode: "two_wheel" });
            state.recurringActive = true;
        } else {
            if (currentFdv >= START_CAP) {
                appendDraw({ ts: now(), kind: "recurring_activation", active: true, cap: START_CAP, mode: "two_wheel" });
                console.log(`✅ Two-wheel recurring draws activated (fdv ${currentFdv.toLocaleString()} ≥ ${START_CAP.toLocaleString()}).`);
                state.recurringActive = true;
            } else {
                console.log(`⏸ Recurring locked until fdv ≥ ${START_CAP.toLocaleString()} (current ${currentFdv.toLocaleString()}).`);
                return;
            }
        }
    }

    // interval guard
    if (state.lastRecurringTs && now() - state.lastRecurringTs < REC_MS - 15_000) {
        console.log("🕒 Two-wheel payout already sent recently.");
        return;
    }

    const conn = getConn();
    const payer = getTreasury();
    const registry = loadJson(REG_PATH) || [];
    const { addresses, weights } = await getEligibleWeighted(conn, registry);
    if (!addresses.length) { console.log("⚠️ No eligible wallets."); return; }

    // fetch FDV to decide if the $1000 tier is active
    const tiers = currentTiers(currentFdv, state.tierAdded);

    // Seeded RNG
    const { seedHex, rng } = await deriveSeedRng();

    // Amount first
    const amountIdx = Math.floor(rng() * tiers.amounts.length);
    const amountUsd = tiers.amounts[amountIdx];
    console.log(`🎯 Prize selected: $${amountUsd}`);

    // Wallet second
    const aliasTable = buildAlias(weights);
    const winnerIdx = pickAlias(aliasTable, rng);
    if (winnerIdx < 0) { console.log("⚠️ Could not select winner."); return; }
    const winner = addresses[winnerIdx];
    console.log(`🎉 Winner selected: ${winner}`);

    // Payout (with preflight balance check and robust error logging)
    let sig = null, payoutMeta = {};
    const pre = await preflightPayout(conn, payer, amountUsd);
    if (!pre.ok) {
        // Log and record a skipped draw due to insufficient funds
        if (pre.kind === "SOL") {
            console.warn(`⚠️ Insufficient SOL: have ${pre.haveLamports} lamports, need ${pre.lamportsNeeded}`);
            appendDraw({ ts: now(), kind: "payout_skipped_insufficient_funds", reason: "SOL", amountUsd, need: pre.lamportsNeeded, have: pre.haveLamports });
        } else {
            console.warn(`⚠️ Insufficient USDC: have ${pre.tokenBal}, need ${pre.tokenNeeded}`);
            appendDraw({ ts: now(), kind: "payout_skipped_insufficient_funds", reason: "USDC", amountUsd, need: pre.tokenNeeded, have: pre.tokenBal });
        }
        return; // skip this cycle
    }

    try {
        if (PAYOUT_AS === "SOL") {
            const amountSol = pre.amountSol;
            sig = await paySol(conn, payer, winner, amountSol);
            payoutMeta = { payoutKind: "SOL", amountSol, solPriceUsd: pre.solUsd };
        } else {
            sig = await payUsdc(conn, payer, winner, USDC_MINT, amountUsd);
            payoutMeta = { payoutKind: "USDC" };
        }
    } catch (e) {
        // Surface detailed logs on SendTransactionError
        const errStr = String(e?.transactionMessage || e?.message || e);
        const logs = e?.transactionLogs || e?.logs || null;
        console.error("Payout error:", errStr);
        if (logs) console.error("Logs:", logs);
        appendDraw({ ts: now(), kind: "payout_error", amountUsd, error: errStr, logs });
        return;
    }

    appendDraw({
        ts: now(),
        kind: "recurring_two_wheel",
        prize: { amountUsd, tiers, fdvUsd },
        winner,
        winnerIndex: winnerIdx,
        weightMode: WEIGHT_MODE,
        rng: { seed: seedHex, method: "sha256(blockhash|height|bucket)+xorshift32" },
        sig,
        ...payoutMeta
    });
    console.log(`🎉 Two-wheel → $${amountUsd} to ${winner} | ${sig}`);
}

// ---------- Tiny /api/verify stub (enable via API_PORT) ----------
async function startApi() {
    if (!API_PORT) return;
    const http = await import("http");
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" };
            if (url.pathname === "/api/verify") {
                const addr = (url.searchParams.get("addr") || "").trim();
                const draws = loadJson(DRAWS_PATH) || [];
                const last = [...draws].reverse().find(d => d.kind === "recurring_two_wheel");
                const registry = loadJson(REG_PATH) || [];
                const included = registry.includes(addr);
                const proof = {
                    addr,
                    included,
                    rng: last?.rng || null,
                    winner: last?.winner || null,
                    winnerIndex: last?.winnerIndex ?? null,
                    tiers: last?.prize?.tiers || null,
                    fdvUsd: last?.prize?.fdvUsd ?? null,
                    timestamp: last?.ts ?? null
                };
                res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS });
                res.end(JSON.stringify({ ok: true, proof }));
                return;
            }
            if (url.pathname === "/api/health") {
                const st = drawsState();
                const serverTime = Date.now();
                const lastRecurringTs = st.lastRecurringTs || 0;
                const nextAt = lastRecurringTs ? (lastRecurringTs + REC_MS) : 0;
                res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS });
                res.end(JSON.stringify({
                    ok: true,
                    intervalMs: REC_MS,
                    startCap: START_CAP,
                    stopCap: STOP_CAP,
                    payoutAs: PAYOUT_AS,
                    active: st.recurringActive,
                    lastRecurringTs,
                    nextAt,
                    serverTime,
                    tokenMint: TOKEN_MINT || null,
                    tokenTicker: TOKEN_TICKER || null
                }));
                return;
            }
            if (url.pathname === "/api/price") {
                try {
                    const solPriceUsd = await fetchSolPriceUsd().catch(() => null);
                    const metrics = TOKEN_MINT ? await fetchTokenMetrics(TOKEN_MINT).catch(() => null) : null;
                    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS });
                    res.end(JSON.stringify({
                        ok: true,
                        solPriceUsd,
                        token: metrics ? {
                            priceUsd: metrics.priceUsd ?? null,
                            fdvUsd: metrics.fdvUsd ?? null,
                            source: metrics.source ?? null
                        } : null
                    }));
                } catch (e) {
                    res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS });
                    res.end(JSON.stringify({ ok: false, error: String(e) }));
                }
                return;
            }
            if (url.pathname === "/api/treasury") {
                const conn = getConn();
                const payer = getTreasury();
                const solLamports = await getSolBalanceLamports(conn, payer.publicKey);
                let usdc = null;
                try {
                    if (USDC_MINT) usdc = await getTokenBalanceForOwner(conn, USDC_MINT, payer.publicKey.toBase58());
                } catch {}
                res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS });
                res.end(JSON.stringify({ ok: true, solLamports, sol: solLamports / LAMPORTS_PER_SOL, usdc }));
                return;
            }
            res.writeHead(404, { ...CORS }); res.end("Not Found");
        } catch (e) {
            res.writeHead(500, { "Content-Type": "application/json", ...CORS });
            res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
    });
    server.listen(API_PORT, API_HOST, () => {
        console.log(`API listening on http://${API_HOST}:${API_PORT}`);
    });
}

// ---------- Manual test spin (CLI: --test-spin [--usd=AMOUNT]) ----------
function getCliNumberFlag(name, fallback) {
    const pref = `--${name}=`;
    const hit = process.argv.find(a => a.startsWith(pref));
    if (!hit) return fallback;
    const n = Number(hit.slice(pref.length));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function testSpin() {
    try {
        const conn = getConn();
        const payer = getTreasury();
        const registry = loadJson(REG_PATH) || [];
        if (!Array.isArray(registry) || registry.length === 0) {
            console.error("❌ No wallets in registry. Add at least one valid Solana address to state/registry.json");
            return;
        }

        // Build eligibility/weights like the real draw
        const { addresses, weights } = await getEligibleWeighted(conn, registry);
        if (!addresses.length) {
            console.error("❌ No eligible wallets (min balance filter may have excluded all). Lower MIN_ELIGIBLE_BALANCE for testing or fund a test account.");
            return;
        }

        // Amount FIRST (for test mode too)
        const amountUsd = getCliNumberFlag("usd", Number(process.env.TEST_SPIN_USD || "10"));
        console.log(`🧪 Test prize selected: $${amountUsd}`);

        // Then pick winner
        const aliasTable = buildAlias(weights);
        const rng = Math.random;
        const winnerIdx = pickAlias(aliasTable, rng);
        const winner = addresses[winnerIdx];
        console.log(`🧪 Test winner selected: ${winner}`);

        // Payout
        let sig, payoutMeta = {};
        if (PAYOUT_AS === "SOL") {
            const solUsd = await fetchSolPriceUsd();
            const amountSol = amountUsd / solUsd;
            sig = await paySol(conn, payer, winner, amountSol);
            payoutMeta = { payoutKind: "SOL", amountSol, solPriceUsd: solUsd };
        } else {
            sig = await payUsdc(conn, payer, winner, USDC_MINT, amountUsd);
            payoutMeta = { payoutKind: "USDC" };
        }

        appendDraw({
            ts: now(),
            kind: "test_spin",
            prize: { amountUsd },
            winner,
            winnerIndex: winnerIdx,
            ...payoutMeta,
            sig
        });
        console.log(`🧪 Test spin → $${amountUsd} to ${winner} | ${sig}`);
    } catch (e) {
        console.error("Test spin error:", e);
    }
}

function startRecurringLoop() {
    if (!(REC_MS > 0)) {
        console.log("⏹ Recurring loop disabled (RECURRING_INTERVAL_MS ≤ 0).");
        return;
    }

    const MIN_DELAY_MS = 5_000;
    let timer = null;
    let running = false;

    const computeDelay = () => {
        const state = drawsState();
        const lastTs = state.lastRecurringTs || 0;
        const fallbackWindow = Math.min(REC_MS || 0, 60_000);
        const target = lastTs
            ? (lastTs + REC_MS)
            : (Date.now() + Math.max(MIN_DELAY_MS, fallbackWindow || MIN_DELAY_MS));
        const rawDelay = target - Date.now();
        return rawDelay <= MIN_DELAY_MS ? MIN_DELAY_MS : rawDelay;
    };

    const queueNext = () => {
        const delay = computeDelay();
        if (timer) clearTimeout(timer);
        timer = setTimeout(runCycle, delay);
        const eta = new Date(Date.now() + delay).toISOString();
        console.log(`⏱ Next recurring check in ${(delay / 1000).toFixed(1)}s (≈ ${eta}).`);
    };

    const runCycle = async () => {
        if (running) {
            queueNext();
            return;
        }
        running = true;
        try {
            try { await handleMilestones(); } catch (e) { console.error("Milestones error:", e); }
            try { await maybeRunTwoWheel(); } catch (e) { console.error("Recurring error:", e); }
        } finally {
            running = false;
            queueNext();
        }
    };

    runCycle();
}

async function main() {
    if (process.argv.includes("--test-spin")) {
        await testSpin();
        // still start API if configured so UI can query /api/verify afterwards
        try { await startApi(); } catch (e) { console.error("API error:", e); }
        return;
    }
    startRecurringLoop();
    try { await startApi(); } catch (e) { console.error("API error:", e); }
}
main();
