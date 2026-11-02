"use client";

import { useEffect } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function StudioError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
      <p className="text-[13px] font-medium text-bad">Something went wrong</p>
      <h1 className="mt-2 text-[20px] font-semibold tracking-[-0.02em] text-ink">This page didn’t load</h1>
      <p className="mt-2 text-[13.5px] text-ink-3">It’s on us. Try again — if it keeps happening, share this code with support: {error.digest ?? "n/a"}.</p>
      <Button className="mt-6" onClick={reset}>
        <RotateCcw /> Try again
      </Button>
    </div>
  );
}
