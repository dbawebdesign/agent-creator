/**
 * Plain-English schedules. Turns common cron expressions into "Weekdays at 6:00 AM"
 * and back from a small set of presets used by the workflow editor.
 */
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function time(h: number, m: number) {
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, "0")} ${ampm}`;
}

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]!);
}

export function humanizeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  if (/^\*\/\d+$/.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `Every ${min.slice(2)} minutes`;
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") return min === "0" ? "Every hour" : `Every hour at :${min.padStart(2, "0")}`;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return cron;
  const at = time(Number(hour), Number(min));
  if (mon !== "*") return `${at} (custom)`;
  if (dom === "*" && dow === "*") return `Every day at ${at}`;
  if (dom === "*" && (dow === "1-5" || dow === "MON-FRI")) return `Weekdays at ${at}`;
  if (dom === "*" && (dow === "0,6" || dow === "6,0")) return `Weekends at ${at}`;
  if (dom === "*" && /^\d$/.test(dow)) return `${DAYS[Number(dow) % 7]}s at ${at}`;
  if (dom === "*" && /^\d(,\d)+$/.test(dow)) return `${dow.split(",").map((d) => SHORT[Number(d) % 7]).join(", ")} at ${at}`;
  if (/^\d+$/.test(dom) && dow === "*") return `Monthly on the ${ordinal(Number(dom))} at ${at}`;
  return `${at} (custom)`;
}

export type Cadence = "daily" | "weekdays" | "weekly" | "monthly" | "hourly" | "custom";

export function parseCadence(cron: string): { cadence: Cadence; time: string; day: number } {
  const p = cron.trim().split(/\s+/);
  const [min = "0", hour = "9", dom = "*", mon = "*", dow = "*"] = p;
  const t = /^\d+$/.test(min) && /^\d+$/.test(hour) ? `${hour.padStart(2, "0")}:${min.padStart(2, "0")}` : "09:00";
  if (p.length !== 5 || mon !== "*") return { cadence: "custom", time: t, day: 1 };
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && dow === "*") return { cadence: "hourly", time: t, day: 1 };
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return { cadence: "custom", time: t, day: 1 };
  if (dom === "*" && dow === "*") return { cadence: "daily", time: t, day: 1 };
  if (dom === "*" && dow === "1-5") return { cadence: "weekdays", time: t, day: 1 };
  if (dom === "*" && /^\d$/.test(dow)) return { cadence: "weekly", time: t, day: Number(dow) };
  if (/^\d+$/.test(dom) && dow === "*") return { cadence: "monthly", time: t, day: Number(dom) };
  return { cadence: "custom", time: t, day: 1 };
}

export function buildCron(cadence: Exclude<Cadence, "custom">, t: string, day: number): string {
  const [h = "9", m = "0"] = t.split(":");
  const hh = String(Number(h));
  const mm = String(Number(m));
  switch (cadence) {
    case "hourly":
      return `${mm} * * * *`;
    case "daily":
      return `${mm} ${hh} * * *`;
    case "weekdays":
      return `${mm} ${hh} * * 1-5`;
    case "weekly":
      return `${mm} ${hh} * * ${day % 7}`;
    case "monthly":
      return `${mm} ${hh} ${Math.min(28, Math.max(1, day))} * *`;
  }
}

export const DAY_NAMES = DAYS;

export function describeTrigger(trigger: { type: string; cron?: string; event?: string; label?: string }): string {
  if (trigger.type === "schedule" && trigger.cron) return humanizeCron(trigger.cron);
  if (trigger.type === "event") {
    return (
      {
        "email.received": "When an email arrives",
        "sms.received": "When a text arrives",
        "slack.message": "When someone messages in Slack",
        webhook: "When a webhook fires",
        "deliverable.approved": "When a deliverable is approved",
      } as Record<string, string>
    )[trigger.event ?? ""] ?? "On an event";
  }
  return "When asked";
}
