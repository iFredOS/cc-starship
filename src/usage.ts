// The shell prompt's Claude usage segment: reads what the status bar saved.

/** "✻ 5h 42% · 7d 23%", a window shown as 0% once its reset time has passed; "" when unknown. */
export function usageText(file: string, nowSeconds = Date.now() / 1000): string {
  let fields: number[];
  try {
    fields = Deno.readTextFileSync(file).trim().split(/\s+/).map(Number);
  } catch {
    return "";
  }
  if (fields.length !== 4 || fields.some(Number.isNaN)) return "";
  const [reset5, pct5, reset7, pct7] = fields;
  const current = (reset: number, pct: number) => (reset > 0 && nowSeconds >= reset ? 0 : pct);
  return `✻ 5h ${current(reset5, pct5)}% · 7d ${current(reset7, pct7)}%`;
}
