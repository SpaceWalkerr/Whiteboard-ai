export type MeasureText = (text: string, fontSize: number) => number;

/** Rough width for environments without canvas (tests); real exports pass a canvas measurer. */
export const approximateMeasure: MeasureText = (text, fontSize) => text.length * fontSize * 0.55;

/** Greedy word wrap that respects explicit newlines; very long words are split. */
export function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  measure: MeasureText,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (measure(candidate, fontSize) <= maxWidth || line === "") {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
      while (measure(line, fontSize) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut), fontSize) > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}
