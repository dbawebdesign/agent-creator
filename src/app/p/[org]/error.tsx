"use client";

import { useEffect } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function PortalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-6 pt-24 text-center">
      <p className="text-[15px] font-semibold text-ink">Something didn’t load</p>
      <p className="mt-1.5 text-[13.5px] text-ink-3">Your team’s work is safe. Give it another try — if it keeps happening, let us know.</p>
      <Button variant="secondary" className="mt-6" onClick={reset}>
        <RotateCcw aria-hidden /> Try again
      </Button>
      {error.digest ? <p className="mt-4 font-mono text-[11px] text-ink-4">Ref {error.digest}</p> : null}
    </div>
  );
}
