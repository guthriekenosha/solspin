import dotenv from "dotenv";
dotenv.config();
import { loadJson, saveJson } from "./utils/solana.mjs";

/**
 * Usage:
 *  node register.mjs add <WALLET>
 *  node register.mjs remove <WALLET>
 *  node register.mjs list
 */
const REG_PATH = process.env.REGISTRY_PATH || "./state/registry.json";

async function main() {
    const [, , cmd, wallet] = process.argv;
    const list = (loadJson(REG_PATH) || []);
    if (cmd === "add") {
        if (!wallet) throw new Error("wallet required");
        if (!list.includes(wallet)) list.push(wallet);
        saveJson(REG_PATH, list);
        console.log("✅ added:", wallet);
    } else if (cmd === "remove") {
        const i = list.indexOf(wallet);
        if (i >= 0) list.splice(i, 1);
        saveJson(REG_PATH, list);
        console.log("🗑 removed:", wallet);
    } else if (cmd === "list") {
        console.log(list);
    } else {
        console.log("Commands: add <WALLET> | remove <WALLET> | list");
    }
}
main();