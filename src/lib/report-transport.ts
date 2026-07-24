import type {
  ParsedPlot,
  ParsedReport,
  PlotGroup,
} from "./novoexpress-parser";

export type TransportPlotGroup = Omit<PlotGroup, "plots"> & {
  plotIds: string[];
};

export type TransportReport = Omit<ParsedReport, "groups"> & {
  groups: TransportPlotGroup[];
};

export function serializeReport(report: ParsedReport): TransportReport {
  return {
    ...report,
    groups: report.groups.map(({ plots, ...group }) => ({
      ...group,
      plotIds: plots.map((plot) => plot.id),
    })),
  };
}

export function hydrateReport(report: TransportReport): ParsedReport {
  const plotsById = new Map<string, ParsedPlot>(
    report.plots.map((plot) => [plot.id, plot]),
  );

  return {
    ...report,
    groups: report.groups.map(({ plotIds, ...group }) => ({
      ...group,
      plots: plotIds.map((plotId) => {
        const plot = plotsById.get(plotId);
        if (!plot) {
          throw new Error(`The server omitted plot ${plotId}.`);
        }
        return plot;
      }),
    })),
  };
}
