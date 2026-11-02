import { Toaster } from "@/components/shared/toaster";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-canvas">
      {children}
      <Toaster />
    </div>
  );
}
