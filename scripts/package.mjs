import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
mkdirSync("artifacts", { recursive: true });
rmSync("artifacts/community-lottery-winners.zip", { force: true });
execFileSync(
  "zip",
  ["-qr", "../artifacts/community-lottery-winners.zip", "."],
  { cwd: "dist" },
);
console.log("已封裝 artifacts/community-lottery-winners.zip");
