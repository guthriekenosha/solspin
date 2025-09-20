import dotenv from "dotenv";
dotenv.config();
import { getConn } from "./utils/solana.mjs";

/**
 * This is a placeholder. In practice, create the SPL token with
 * your preferred tool (sugar, SPL CLI, or your own script),
 * set metadata with Metaplex if needed, and add liquidity later.
 *
 * Keep this file if you want to script mint creation.
 */
async function main() {
    const conn = getConn();
    console.log("RPC:", (await conn.getVersion()).solana_core);
    console.log("Create your SPL mint with SPL CLI or Metaplex tools; then set TOKEN_MINT in .env");
}
main();