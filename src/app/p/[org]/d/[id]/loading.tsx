import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div
      className="mx-auto w-full max-w-[1040px] px-4 pt-5 md:px-6 md:pt-8"
      aria-busy="true"
      aria-label="Loading"
    >
      <Skeleton className="h-6 w-20" />
      <div className="mt-6 grid gap-12 md:grid-cols-[minmax(0,1fr)_220px]">
        <div>
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-7 rounded-full" />
            <Skeleton className="h-3.5 w-40" />
          </div>
          <Skeleton className="mt-5 h-8 w-4/5" />
          <div className="mt-6 space-y-3 rounded-2xl border border-line bg-surface p-6 md:p-10">
            {[100, 92, 96, 60, 0, 88, 94, 70].map((w, i) =>
              w ? (
                <Skeleton key={i} className="h-3.5" />
              ) : (
                <div key={i} className="h-3" />
              ),
            )}
          </div>
        </div>
        <div className="hidden space-y-5 md:block">
          {[0, 1, 2, 3].map((i) => (
            <div key={i}>
              <Skeleton className="h-3 w-16" />
              <Skeleton className="mt-2 h-3.5 w-32" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
