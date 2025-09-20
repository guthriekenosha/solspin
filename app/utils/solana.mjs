import { Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount, createTransferInstruction, getMint, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import bs58 from "bs58";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getConn() {
    const url = process.env.RPC_URL;
    if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) {
        throw new Error("❌ RPC_URL is not set or invalid. Please set RPC_URL in your .env file, e.g. RPC_URL=https://api.devnet.solana.com");
    }
    return new Connection(url, "confirmed");
}

export function getTreasury() {
    const kpPathEnv = process.env.TREASURY_KEYPAIR;
    if (!kpPathEnv) {
        throw new Error("❌ TREASURY_KEYPAIR is not set. Add TREASURY_KEYPAIR=app/state/treasury.json (or an absolute path) to your .env.");
    }
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const candidates = [];
    if (path.isAbsolute(kpPathEnv)) {
        candidates.push(kpPathEnv);
    } else {
        candidates.push(kpPathEnv);
        candidates.push(path.resolve(process.cwd(), kpPathEnv));
        candidates.push(path.resolve(__dirname, "..", kpPathEnv));
        const stripped = kpPathEnv.replace(/^app[\\/]/, "");
        candidates.push(path.resolve(__dirname, "..", stripped));
    }

    let raw = null, used = null, lastErr = null;
    for (const cand of candidates) {
        try {
            raw = fs.readFileSync(cand, "utf8");
            used = cand;
            break;
        } catch (e) { lastErr = e; }
    }
    if (raw == null) {
        throw new Error(`❌ Could not read TREASURY_KEYPAIR from any of:\n- ${candidates.join("\n- ")}\nReason: ${lastErr ? lastErr.message : "file not found"}`);
    }

    let arr;
    try {
        arr = JSON.parse(raw);
    } catch (e) {
        throw new Error(`❌ TREASURY_KEYPAIR at "${used}" is not valid JSON. It must be a JSON array of 64+ numbers (secret key).`);
    }
    if (!Array.isArray(arr) || arr.length < 64) {
        throw new Error(`❌ TREASURY_KEYPAIR at "${used}" must be a JSON array of 64+ numbers (secret key). Current length: ${Array.isArray(arr) ? arr.length : "n/a"}`);
    }
    const secret = Uint8Array.from(arr);
    return Keypair.fromSecretKey(secret);
}

export async function getTokenBalanceForOwner(conn, mint, owner) {
    // Reads ATA and returns token balance as float tokens (not raw)
    const mintPk = new PublicKey(mint);
    const ownerPk = new PublicKey(owner);
    const ata = await getAssociatedTokenAddress(mintPk, ownerPk, false);
    try {
        const acct = await getAccount(conn, ata);
        const mintInfo = await getMint(conn, mintPk);
        return Number(acct.amount) / 10 ** mintInfo.decimals;
    } catch {
        return 0;
    }
}

export async function payUsdc(conn, payer, toPubkey, usdcMint, amountUsd) {
    const mintPk = new PublicKey(usdcMint);
    const toPk = new PublicKey(toPubkey);

    const mintInfo = await getMint(conn, mintPk);
    const decimals = mintInfo.decimals;
    const units = BigInt(Math.round(amountUsd * 10 ** decimals));

    const fromAtaInfo = await getOrCreateAssociatedTokenAccount(conn, payer, mintPk, payer.publicKey);
    const toAtaInfo   = await getOrCreateAssociatedTokenAccount(conn, payer, mintPk, toPk);

    const fromAta = fromAtaInfo.address;
    const toAta   = toAtaInfo.address;

    const { Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");
    const ix = createTransferInstruction(fromAta, toAta, payer.publicKey, units);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
    return sig;
}

export function loadJson(relPath) {
    const p = path.resolve(__dirname, "..", relPath);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

export function saveJson(relPath, data) {
    const p = path.resolve(__dirname, "..", relPath);
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
}