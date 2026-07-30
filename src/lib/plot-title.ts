export function joinNovoExpressPlotTitleLines(lines: string[]) {
  const nonEmptyLines = lines.filter(Boolean);
  const selectedLines = nonEmptyLines.slice(0, 1);

  for (const line of nonEmptyLines.slice(1)) {
    const previousLine = selectedLines.at(-1) ?? "";
    if (!previousLine.endsWith("/") && !line.startsWith("/")) {
      break;
    }
    selectedLines.push(line);
  }

  return selectedLines.join(" ");
}
