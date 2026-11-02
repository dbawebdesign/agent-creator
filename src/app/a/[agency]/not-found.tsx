import Link from "next/link";
import { buttonClass } from "@/components/ui/button";

export default function StudioNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
      <p className="tabular text-[13px] font-medium text-ink-3">404</p>
      <h1 className="mt-2 text-[20px] font-semibold tracking-[-0.02em] text-ink">We couldn’t find that</h1>
      <p className="mt-2 text-[13.5px] text-ink-3">It may have been archived, or you may not have access.</p>
      <Link href="/" className={buttonClass("secondary", "md", "mt-6")}>
        Back to Studio
      </Link>
    </div>
  );
}
