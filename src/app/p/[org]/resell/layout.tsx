import { notFound } from "next/navigation";
import { getPortal } from "@/server/queries/portal";

/** Only clients resell. Checked above the loading boundary so everyone else gets a real 404. */
export default async function ResellLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const p = await getPortal(org);
  if (!p.canResell) notFound();
  return children;
}
