/**
 * Pure helpers for the portal: plain-English schedules, greetings, labels.
 * No server imports — safe in server and client components.
 */
import type { ChannelKind, WorkflowTrigger } from "@/server/db/schema/agents";

export function hourIn(timezone: string, date = new Date()): number {
  try {
    const h = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: timezone,
    }).format(date);
    return Number(h) % 24;
  } catch {
    return date.getHours();
  }
}

export function greeting(timezone: string, date = new Date()): string {
  const h = hourIn(timezone, date);
  // Small hours (midnight to 5 AM in the org's timezone): neither evening nor morning.
  if (h < 5) return "Hello";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/** A first name for display: "linda" (from an email) → "Linda"; "dana" → "Dana"; keeps "McKenna", "de Vries". */
export function displayFirstName(raw: string): string {
  const name = raw.trim();
  if (!name) return name;
  return name === name.toLowerCase()
    ? name[0]!.toUpperCase() + name.slice(1)
    : name;
}

export function longDate(timezone: string, date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: timezone,
    }).format(date);
  } catch {
    return date.toDateString();
  }
}

/** "6 AM", "9:08 PM": on-the-hour times drop ":00", matching schedules ("Every Monday at 6 AM"). */
export function clockTime(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    })
      .format(date)
      .replace(/:00(?=\s?[AP]M)/, "");
  } catch {
    return date.toLocaleTimeString();
  }
}

/** "today", "tomorrow", "Thursday", "Nov 12" — relative to now in the org timezone. */
export function dayWord(
  date: Date,
  timezone: string,
  now = new Date(),
): string {
  const key = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  const a = key(date);
  if (a === key(now)) return "today";
  if (a === key(new Date(now.getTime() + 86400000))) return "tomorrow";
  if (a === key(new Date(now.getTime() - 86400000))) return "yesterday";
  const diffDays = (date.getTime() - now.getTime()) / 86400000;
  if (diffDays > 0 && diffDays < 7)
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      timeZone: timezone,
    }).format(date);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: timezone,
  }).format(date);
}

/** Bucket label for the feed: "This morning", "Yesterday", "Earlier this week", "Earlier". */
export function feedBucket(
  date: Date,
  timezone: string,
  now = new Date(),
): string {
  const word = dayWord(date, timezone, now);
  if (word === "today") {
    const h = hourIn(timezone, date);
    return h < 12 ? "This morning" : h < 17 ? "This afternoon" : "This evening";
  }
  if (word === "yesterday") return "Yesterday";
  const diffDays = (now.getTime() - date.getTime()) / 86400000;
  if (diffDays < 7) return "Earlier this week";
  return "Earlier";
}

function fmtHour(h: number, m: number): string {
  const suffix = h < 12 ? "AM" : "PM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m === 0
    ? `${hh} ${suffix}`
    : `${hh}:${String(m).padStart(2, "0")} ${suffix}`;
}

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

/** Cron → "every weekday at 6 AM". Falls back to "on a regular schedule". */
export function humanizeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return "on a regular schedule";
  const [min, hour, dom, mon, dow] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === "*") return `every ${everyMin[1]} minutes`;
  if (/^\d+$/.test(min) && hour === "*") return "every hour";
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (/^\d+$/.test(min) && everyHour) return `every ${everyHour[1]} hours`;
  if (!/^\d+$/.test(min) || !/^[\d,]+$/.test(hour))
    return "on a regular schedule";
  const times = hour
    .split(",")
    .map((h) => fmtHour(Number(h), Number(min)))
    .join(" and ");
  const at = `at ${times}`;
  if (dom === "*" && mon === "*") {
    if (dow === "*") return `every day ${at}`;
    if (dow === "1-5" || dow === "MON-FRI") return `every weekday ${at}`;
    if (dow === "0,6" || dow === "6,0") return `every weekend ${at}`;
    if (/^[0-7](,[0-7])*$/.test(dow)) {
      const names = dow.split(",").map((d) => DAYS[Number(d) % 7]!);
      if (names.length === 1) return `every ${names[0]} ${at}`;
      return `every ${names.slice(0, -1).join(", ")} and ${names.at(-1)} ${at}`;
    }
  }
  if (/^\d+$/.test(dom) && mon === "*" && dow === "*")
    return `on the ${ordinal(Number(dom))} of every month ${at}`;
  return "on a regular schedule";
}

const EVENT_WORDS: Record<string, string> = {
  "email.received": "whenever an email comes in",
  "sms.received": "whenever a text comes in",
  "slack.message": "when you message them in Slack",
  webhook: "when your systems send an update",
  "deliverable.approved": "right after you approve their work",
};

export function humanizeTrigger(
  trigger: WorkflowTrigger | null | undefined,
): string {
  if (!trigger) return "whenever you ask";
  if (trigger.type === "schedule") return humanizeCron(trigger.cron);
  if (trigger.type === "event")
    return EVENT_WORDS[trigger.event] ?? "when something happens";
  return "whenever you ask";
}

export function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export const KIND_LABEL: Record<string, string> = {
  report: "Report",
  document: "Document",
  table: "Table",
  email_draft: "Email draft",
  message: "Message",
  action: "Action",
};

export const CHANNEL_LABEL: Record<ChannelKind, string> = {
  email: "Email",
  sms: "Text",
  slack: "Slack",
  portal: "Portal",
  api: "API",
  mcp: "Claude / Codex",
};

/** "~11 hours", "about 40 minutes". */
export function hoursPhrase(hours: number): string {
  if (hours <= 0) return "";
  if (hours < 1)
    return `about ${Math.max(5, Math.round((hours * 60) / 5) * 5)} minutes`;
  const r = hours < 10 ? Math.round(hours * 2) / 2 : Math.round(hours);
  return `~${r} ${r === 1 ? "hour" : "hours"}`;
}

export function shortHours(hours: number): string {
  if (hours <= 0) return "";
  if (hours < 1) return `${Math.max(5, Math.round(hours * 60))}m`;
  const r = hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours);
  return `${r}h`;
}

export function numberWord(n: number): string {
  const w = [
    "no",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
  ];
  return n <= 10 ? w[n]! : String(n);
}
