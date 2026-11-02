import { notFound } from "next/navigation";
import { getDeliverable, getPortal } from "@/server/queries/portal";

/** Resolve the delivery above the loading boundary, so a missing one answers with a real 404. */
export default async function DeliverableLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string; id: string }>;
}) {
  const { org, id } = await params;
  const p = await getPortal(org);
  if (!(await getDeliverable(p.org.id, id))) notFound();
  return children;
}
