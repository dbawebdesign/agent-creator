"use client";

import { useMemo } from "react";
import { Input } from "@/components/ui/field";

const COMMON: [string, string][] = [
  ["America/New_York", "Eastern"],
  ["America/Chicago", "Central"],
  ["America/Denver", "Mountain"],
  ["America/Phoenix", "Arizona"],
  ["America/Los_Angeles", "Pacific"],
  ["America/Anchorage", "Alaska"],
  ["Pacific/Honolulu", "Hawaii"],
];

export function allTimezones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? COMMON.map(([z]) => z);
  } catch {
    return COMMON.map(([z]) => z);
  }
}

export function isTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.length > 0;
  } catch {
    return false;
  }
}

/** Searchable IANA timezone input (native datalist), common US zones first. */
export function TimezoneField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const zones = useMemo(() => {
    const common = new Set(COMMON.map(([z]) => z));
    return [...COMMON, ...allTimezones().filter((z) => !common.has(z)).map((z) => [z, ""] as [string, string])];
  }, []);
  const invalid = value.length > 0 && !isTimezone(value);
  return (
    <>
      <Input
        id={id}
        list={`${id}-list`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="America/New_York"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-hint`}
      />
      <datalist id={`${id}-list`}>
        {zones.map(([z, label]) => (
          <option key={z} value={z}>
            {label ? `${label} time (US)` : z.replace(/_/g, " ")}
          </option>
        ))}
      </datalist>
      <p id={`${id}-hint`} className={invalid ? "mt-1.5 text-[12px] font-medium text-bad" : "mt-1.5 text-[12px] text-ink-3"}>
        {invalid ? "Pick a timezone from the list, like America/Chicago." : "Overnight work lands at 6 AM here. Type a city to search."}
      </p>
    </>
  );
}
