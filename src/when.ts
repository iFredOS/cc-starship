// Reset times in the user's language and clock: "18:00", "tomorrow 6:00 PM",
// "sam. 18 h", "30 oct. 18 h". Québécois French follows OQLF style (18 h 30).

export type Language = "en" | "fr-CA";
export type Clock = "24h" | "12h";

export interface Prefs {
  language: Language | "auto";
  clock: Clock | "auto";
}

export const DEFAULT_PREFS: Prefs = { language: "auto", clock: "auto" };

const WORDS = {
  en: {
    tomorrow: "tomorrow",
    days: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  },
  "fr-CA": {
    tomorrow: "demain",
    days: ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."],
    months: [
      "janv.",
      "févr.",
      "mars",
      "avr.",
      "mai",
      "juin",
      "juil.",
      "août",
      "sept.",
      "oct.",
      "nov.",
      "déc.",
    ],
  },
};

/** Turns "auto" into the system locale's language and clock. */
export function resolvePrefs(
  prefs: Prefs,
  locale = Intl.DateTimeFormat().resolvedOptions().locale,
): { language: Language; clock: Clock } {
  const language = prefs.language !== "auto" ? prefs.language : /^fr/i.test(locale) ? "fr-CA" : "en";
  const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
  const clock = prefs.clock !== "auto" ? prefs.clock : cycle === "h11" || cycle === "h12" ? "12h" : "24h";
  return { language, clock };
}

function time(d: Date, language: Language, clock: Clock): string {
  const h = d.getHours(), m = d.getMinutes();
  const mm = String(m).padStart(2, "0");
  if (language === "fr-CA") {
    const hour = clock === "12h" ? (h + 11) % 12 + 1 : h;
    const suffix = clock === "12h" ? (h < 12 ? " a.m." : " p.m.") : "";
    return `${hour} h${m ? ` ${mm}` : ""}${suffix}`;
  }
  if (clock === "12h") return `${(h + 11) % 12 + 1}:${mm} ${h < 12 ? "AM" : "PM"}`;
  return `${String(h).padStart(2, "0")}:${mm}`;
}

/** `when` relative to `now`: today → time, tomorrow → "tomorrow", this week → weekday, later → date. */
export function formatWhen(when: Date, now: Date, prefs: { language: Language; clock: Clock }): string {
  const w = WORDS[prefs.language];
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(when) - day(now)) / 86400e3);
  const t = time(when, prefs.language, prefs.clock);
  if (days <= 0) return t;
  if (days === 1) return `${w.tomorrow} ${t}`;
  if (days < 7) return `${w.days[when.getDay()]} ${t}`;
  const month = w.months[when.getMonth()];
  const date = prefs.language === "fr-CA" ? `${when.getDate()} ${month}` : `${month} ${when.getDate()}`;
  return `${date} ${t}`;
}
