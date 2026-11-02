import { Badge } from "@/components/ui/badge";
import type { PortalStatus } from "./status";

/** The one status pill the portal uses everywhere (cards, detail pages, team). Renders nothing for null. */
export function StatusPill({
  status,
  className,
}: {
  status: PortalStatus | null;
  className?: string;
}) {
  if (!status) return null;
  return (
    <Badge tone={status.tone} dot className={className}>
      {status.label}
    </Badge>
  );
}
