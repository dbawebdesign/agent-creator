import { cn } from "@/lib/utils";

const control =
  "w-full rounded-md border border-line bg-surface px-3 text-[13.5px] text-ink placeholder:text-ink-4 shadow-xs transition-[border,box-shadow] duration-150 hover:border-line-strong focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 disabled:opacity-60";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, "min-h-24 py-2 leading-relaxed", className)} {...props} />;
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(control, "h-9 appearance-none pr-8", className)} {...props} />;
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("mb-1.5 block text-[13px] font-medium text-ink-2", className)} {...props} />;
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <p className="mt-1.5 text-[12.5px] text-bad">{error}</p> : hint ? <p className="mt-1.5 text-[12.5px] text-ink-3">{hint}</p> : null}
    </div>
  );
}
