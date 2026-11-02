"use server";

import { z } from "zod";
import { searchStudio } from "@/server/queries/studio";
import { studio } from "./ctx";

const input = z.object({ agency: z.string().min(1).max(64), q: z.string().trim().min(1).max(80) });

/** ⌘K search across the agency's agents and clients (capped; scoped to the caller's agency). */
export async function paletteSearch(agency: string, q: string) {
  const parsed = input.safeParse({ agency, q });
  if (!parsed.success) return { agents: [], clients: [] };
  const ctx = await studio(parsed.data.agency, "viewer");
  return searchStudio(ctx.agency.id, parsed.data.q, 8);
}
