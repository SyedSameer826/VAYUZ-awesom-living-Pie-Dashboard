import { parse } from "@babel/parser";
import fs from "fs";
const files = process.argv.slice(2);
let ok = true;
for (const f of files) {
  try {
    parse(fs.readFileSync(f, "utf8"), { sourceType: "module", plugins: ["jsx"] });
    console.log("OK  ", f.split("/").slice(-1)[0]);
  } catch (e) {
    ok = false;
    console.log("FAIL", f.split("/").slice(-1)[0], "->", e.message);
  }
}
process.exit(ok ? 0 : 1);
