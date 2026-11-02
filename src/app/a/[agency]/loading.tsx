import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 py-8 sm:px-6 md:px-10 md:py-12" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-3.5 w-40" />
      <Skeleton className="mt-3 h-7 w-72" />
      <Skeleton className="mt-8 h-[88px] w-full rounded-xl" />
      <div className="mt-12 space-y-3">
        <Skeleton className="h-4 w-36" />
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-line px-5 py-4 last:border-0">
              <Skeleton className="size-7 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-1/2" />
                <Skeleton className="h-3 w-1/3" />
              </div>
              <Skeleton className="h-3 w-14" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
