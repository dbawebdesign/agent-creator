import { readFileSync } from "node:fs";
import { heuristicSpec } from "@/server/agents/architect";
const t = readFileSync(process.argv[2]!, "utf8");
const spec = heuristicSpec({ transcript: t, orgName: process.argv[3], industry: process.argv[4] });
console.log(JSON.stringify(spec, null, 2));
