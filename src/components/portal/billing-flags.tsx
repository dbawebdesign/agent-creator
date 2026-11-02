"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

const MESSAGES: Record<
  string,
  [kind: "success" | "info" | "error", text: string]
> = {
  connected: [
    "success",
    "Stripe is connected. Your customers can pay you directly.",
  ],
  pending: [
    "info",
    "Stripe needs a few more details before you can take payments.",
  ],
  connect_forbidden: ["error", "Only a workspace admin can connect Stripe."],
  error: ["error", "Stripe didn’t finish. Try again in a moment."],
};

/** One toast for ?billing=… (Stripe Connect return) or ?checkout=success, then a clean URL. */
export function PortalBillingFlags() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    const billing = sp.get("billing");
    const checkout = sp.get("checkout");
    if (!billing && !checkout) return;
    done.current = true;
    if (checkout === "success")
      toast.success("You’re all set. Your plan is active.");
    else if (billing) {
      const [kind, text] = MESSAGES[billing] ?? [
        "error",
        "Stripe returned an error. Try again in a moment.",
      ];
      toast[kind](text);
    }
    const next = new URLSearchParams(sp.toString());
    ["billing", "checkout", "session_id"].forEach((k) => next.delete(k));
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, {
      scroll: false,
    });
  }, [sp, router, pathname]);
  return null;
}
