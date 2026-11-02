/** Badge for teammates who aren't working right now. */
export function agentStatus(a: {
  status: string;
}): { tone: "neutral" | "warn"; label: string } | null {
  if (a.status === "paused") return { tone: "neutral", label: "Paused" };
  if (a.status === "provisioning")
    return { tone: "warn", label: "Getting set up" };
  return null;
}
