import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 py-8 sm:px-6 md:px-10 md:py-12" aria-busy="true">
      <div className="mx-auto max-w-[720px]">
        <Skeleton className="h-7 w-80" />
        <Skeleton className="mt-3 h-4 w-96 max-w-full" />
        <Skeleton className="mt-10 h-10 w-64 rounded-lg" />
        <Skeleton className="mt-6 h-[300px] w-full rounded-xl" />
      </div>
    </div>
  );
}
