/**
 * One status vocabulary for the portal. Only exceptions get a pill: an active teammate or a delivered item
 * that needs nothing from you shows none. Tones: warn = waiting on you, good = done, neutral = for your info.
 */
export type PortalStatus = { tone: "neutral" | "good" | "warn"; label: string };

/** Teammates who aren't working right now. */
export function agentStatus(a: { status: string }): PortalStatus | null {
  if (a.status === "paused") return { tone: "neutral", label: "Paused" };
  if (a.status === "provisioning")
    return { tone: "neutral", label: "Getting set up" };
  return null;
}

/** A deliverable: waiting on your OK, approved, or sent back. */
export function deliverableStatus(d: {
  status: string;
  needsReview?: boolean;
}): PortalStatus | null {
  if (d.status === "approved") return { tone: "good", label: "Approved" };
  if (d.status === "changes_requested")
    return { tone: "neutral", label: "Changes requested" };
  if (d.needsReview && (d.status === "new" || d.status === "seen"))
    return { tone: "warn", label: "Needs your OK" };
  return null;
}

export const PAUSED: PortalStatus = { tone: "neutral", label: "Paused" };
