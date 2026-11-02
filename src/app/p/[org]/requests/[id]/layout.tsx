import { notFound } from "next/navigation";
import { getPortal, getRequest } from "@/server/queries/portal";

/** Resolve the conversation before streaming starts, so a missing one answers with a real 404. */
export default async function RequestLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string; id: string }>;
}) {
  const { org, id } = await params;
  const p = await getPortal(org);
  if (!(await getRequest(p.org.id, id))) notFound();
  return children;
}
