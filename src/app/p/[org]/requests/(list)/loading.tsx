import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div
      className="mx-auto w-full max-w-[1040px] px-4 pt-8 md:px-6 md:pt-14"
      aria-busy="true"
      aria-label="Loading"
    >
      <Skeleton className="h-8 w-40" />
      <Skeleton className="mt-3 h-4 w-96 max-w-full" />
      <Skeleton className="mt-6 h-12 w-full rounded-xl" />
      <div className="mt-8 divide-y divide-line rounded-xl border border-line bg-surface">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3.5 px-5 py-4">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
