import type { ParsedPlot, ParsedReport } from "@/lib/novoexpress-parser";

export type ExportGrouping = "plot-type" | "sample";

export type ExportSection = {
  key: string;
  label: string;
  parentPaths: string[];
  plots: ParsedPlot[];
};

export type ExportPage = {
  section: ExportSection;
  plots: ParsedPlot[];
  firstPlot: number;
  lastPlot: number;
  part: number;
  partCount: number;
};

export const EXPORT_PLOTS_PER_PAGE = 6;

export function getExportSections(
  report: ParsedReport,
  grouping: ExportGrouping,
): ExportSection[] {
  if (grouping === "plot-type") {
    return report.groups.map((group) => ({
      key: group.key,
      label: group.label,
      parentPaths: group.parentPaths,
      plots: group.plots,
    }));
  }

  const sectionsBySample = new Map<string, ExportSection>();
  for (const plot of report.plots) {
    const section = sectionsBySample.get(plot.sampleKey) ?? {
      key: `sample::${plot.sampleKey}`,
      label: plot.sampleName,
      parentPaths: [],
      plots: [],
    };
    section.plots.push(plot);
    if (!section.parentPaths.includes(plot.parentPath)) {
      section.parentPaths.push(plot.parentPath);
    }
    sectionsBySample.set(plot.sampleKey, section);
  }

  return [...sectionsBySample.values()].map((section) => ({
    ...section,
    plots: [...section.plots].sort(
      (a, b) =>
        a.indexInSample - b.indexInSample ||
        a.documentIndex - b.documentIndex,
    ),
  }));
}

export function getExportPages(
  report: ParsedReport,
  grouping: ExportGrouping,
): ExportPage[] {
  return getExportSections(report, grouping).flatMap((section) => {
    const partCount = Math.ceil(
      section.plots.length / EXPORT_PLOTS_PER_PAGE,
    );

    return Array.from({ length: partCount }, (_, pageIndex) => {
      const start = pageIndex * EXPORT_PLOTS_PER_PAGE;
      const plots = section.plots.slice(
        start,
        start + EXPORT_PLOTS_PER_PAGE,
      );

      return {
        section,
        plots,
        firstPlot: start + 1,
        lastPlot: start + plots.length,
        part: pageIndex + 1,
        partCount,
      };
    });
  });
}
