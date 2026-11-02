"use server";

import { z } from "zod";
import { pickerClients, searchStudio } from "@/server/queries/studio";
import { money } from "@/components/studio/bits";
import { studio } from "./ctx";

const input = z.object({ agency: z.string().min(1).max(64), q: z.string().trim().min(1).max(80) });

/** ⌘K search across the agency's agents and clients (capped; scoped to the caller's agency). */
export async function paletteSearch(agency: string, q: string) {
  const parsed = input.safeParse({ agency, q });
  if (!parsed.success) return { agents: [], clients: [] };
  const ctx = await studio(parsed.data.agency, "viewer");
  return searchStudio(ctx.agency.id, parsed.data.q, 8);
}

/** New-agent client picker: name search over the agency's clients (capped at 20). */
export async function clientPickerSearch(agency: string, q: string) {
  const parsed = input.safeParse({ agency, q });
  if (!parsed.success) return [];
  const ctx = await studio(parsed.data.agency, "member");
  const rows = await pickerClients(ctx.agency.id, { q: parsed.data.q, limit: 20 });
  return rows.map((c) => ({ id: c.id, name: c.name, slug: c.slug, price: c.plan ? `${money(c.plan.priceCents)} / mo · ${c.plan.name}` : null }));
}
