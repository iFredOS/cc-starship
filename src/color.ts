// 24-bit terminal colors and WCAG contrast, shared by the status bar and the control panel.
const ESC = "\x1b";

export const rgb = (hex: string) => hex.match(/\w\w/g)!.map((h) => parseInt(h, 16));
export const fg = (hex: string) => `${ESC}[38;2;${rgb(hex).join(";")}m`;
export const bg = (hex: string) => `${ESC}[48;2;${rgb(hex).join(";")}m`;

/** WCAG contrast ratio between two colors. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b] = rgb(hex).map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** How colorful a color is (0 for grays), for picking accents. */
export function chroma(hex: string): number {
  const c = rgb(hex);
  return Math.max(...c) - Math.min(...c);
}
