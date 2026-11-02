import { PortalHomeLink } from "@/components/portal/home-link";

export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-6 pt-24 text-center">
      <p className="text-[15px] font-semibold text-ink">
        We couldn’t find that
      </p>
      <p className="mt-1.5 text-[13.5px] text-ink-3">
        It may have been archived, or the link is out of date.
      </p>
      <PortalHomeLink className="mt-6 text-[13.5px] font-medium text-accent-text hover:underline">
        Back to Today
      </PortalHomeLink>
    </div>
  );
}
