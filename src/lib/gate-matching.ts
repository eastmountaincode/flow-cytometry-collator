export type GateStatisticsRow = {
  gateName: string;
  axisX: string;
  axisY: string;
  parentPath: string;
};

export type GatePlotCandidate = {
  parentPath: string;
  nativeOutputGateNames: string[] | null;
  detectedAxisX?: string | null;
  detectedAxisY?: string | null;
};

export type GateStatisticsMatch = {
  rows: GateStatisticsRow[];
  method: "native" | "axis" | "hierarchy" | "position" | "none";
} | null;

type GateStatisticsGroup = {
  id: number;
  parentKey: string;
  axisKey: string | null;
  rows: GateStatisticsRow[];
  firstRowIndex: number;
};

function normalizeGateText(value: string) {
  return value
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalGate(value: string) {
  return normalizeGateText(value)
    .replace(/\s+/g, "")
    .toLocaleLowerCase();
}

function canonicalPath(value: string) {
  const normalized = normalizeGateText(value);
  if (
    normalized === "" ||
    canonicalGate(normalized) === "all" ||
    canonicalGate(normalized) === "allevents"
  ) {
    return "";
  }

  return normalized
    .split(/\s*\/\s*/)
    .map(canonicalGate)
    .filter(Boolean)
    .join("/");
}

function fullGatePath(row: GateStatisticsRow) {
  return row.parentPath === "All events"
    ? row.gateName
    : `${row.parentPath} / ${row.gateName}`;
}

function canonicalAxes(axisX: string, axisY: string) {
  if (!axisX || !axisY) {
    return null;
  }

  return [axisX, axisY]
    .map((axis) => normalizeGateText(axis).toLocaleLowerCase())
    .join("::");
}

function groupStatisticsRows(rows: GateStatisticsRow[]) {
  const groups: GateStatisticsGroup[] = [];
  const groupsByKey = new Map<string, GateStatisticsGroup>();

  rows.forEach((row, rowIndex) => {
    const parentKey = canonicalPath(row.parentPath);
    const axisKey = canonicalAxes(row.axisX, row.axisY);
    const key = axisKey
      ? `${parentKey}::${axisKey}`
      : `${parentKey}::row-${rowIndex}`;
    const group = groupsByKey.get(key) ?? {
      id: groups.length,
      parentKey,
      axisKey,
      rows: [],
      firstRowIndex: rowIndex,
    };
    group.rows.push(row);
    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, group);
      groups.push(group);
    }
  });

  return groups;
}

function rowMatchesGate(row: GateStatisticsRow, gateName: string) {
  return canonicalGate(row.gateName) === canonicalGate(gateName);
}

export function normalizeKnownGatePath(
  path: string,
  rows: GateStatisticsRow[],
) {
  if (canonicalPath(path) === "") {
    return "All events";
  }

  const pathKey = canonicalPath(path);
  const matchingRow = rows.find(
    (row) => canonicalPath(fullGatePath(row)) === pathKey,
  );
  return matchingRow ? fullGatePath(matchingRow) : null;
}

export function matchGateStatistics(
  plots: GatePlotCandidate[],
  rows: GateStatisticsRow[],
): GateStatisticsMatch[] {
  const matches: GateStatisticsMatch[] = plots.map(() => null);
  if (rows.length === 0) {
    return matches;
  }

  const groups = groupStatisticsRows(rows);
  const allocatedGroups = new Set<number>();
  const groupForRow = new Map<GateStatisticsRow, GateStatisticsGroup>();
  for (const group of groups) {
    for (const row of group.rows) {
      groupForRow.set(row, group);
    }
  }

  const assignGroup = (
    plotIndex: number,
    group: GateStatisticsGroup,
    method: NonNullable<GateStatisticsMatch>["method"],
  ) => {
    matches[plotIndex] = { rows: group.rows, method };
    allocatedGroups.add(group.id);
  };

  for (const [plotIndex, plot] of plots.entries()) {
    if (plot.nativeOutputGateNames === null) {
      continue;
    }

    const matchingRows = plot.nativeOutputGateNames.flatMap((gateName) => {
      const sameParent = rows.find(
        (row) =>
          canonicalPath(row.parentPath) === canonicalPath(plot.parentPath) &&
          rowMatchesGate(row, gateName),
      );
      const row = sameParent ?? rows.find((candidate) =>
        rowMatchesGate(candidate, gateName),
      );
      return row ? [row] : [];
    });

    matches[plotIndex] = {
      rows: [...new Set(matchingRows)],
      method: "native",
    };
    for (const row of matchingRows) {
      const group = groupForRow.get(row);
      if (group) {
        allocatedGroups.add(group.id);
      }
    }
  }

  const unallocatedGroups = () =>
    groups.filter((group) => !allocatedGroups.has(group.id));

  for (const [plotIndex, plot] of plots.entries()) {
    if (matches[plotIndex]) {
      continue;
    }

    const axisKey = canonicalAxes(
      plot.detectedAxisX ?? "",
      plot.detectedAxisY ?? "",
    );
    if (!axisKey) {
      continue;
    }

    const exactMatches = unallocatedGroups().filter(
      (group) =>
        group.parentKey === canonicalPath(plot.parentPath) &&
        group.axisKey === axisKey,
    );
    if (exactMatches.length === 1) {
      assignGroup(plotIndex, exactMatches[0], "axis");
    }
  }

  for (const [plotIndex, plot] of plots.entries()) {
    if (matches[plotIndex]) {
      continue;
    }

    const axisKey = canonicalAxes(
      plot.detectedAxisX ?? "",
      plot.detectedAxisY ?? "",
    );
    if (!axisKey) {
      continue;
    }

    const axisMatches = unallocatedGroups().filter(
      (group) => group.axisKey === axisKey,
    );
    if (axisMatches.length === 1) {
      assignGroup(plotIndex, axisMatches[0], "axis");
    }
  }

  const unresolvedByParent = new Map<string, number[]>();
  for (const [plotIndex, plot] of plots.entries()) {
    if (matches[plotIndex]) {
      continue;
    }
    const parentKey = canonicalPath(plot.parentPath);
    unresolvedByParent.set(parentKey, [
      ...(unresolvedByParent.get(parentKey) ?? []),
      plotIndex,
    ]);
  }

  for (const [parentKey, plotIndexes] of unresolvedByParent) {
    const candidateGroups = unallocatedGroups()
      .filter((group) => group.parentKey === parentKey)
      .sort(
        (first, second) => first.firstRowIndex - second.firstRowIndex,
      );
    if (candidateGroups.length !== plotIndexes.length) {
      continue;
    }

    plotIndexes.forEach((plotIndex, index) => {
      assignGroup(plotIndex, candidateGroups[index], "hierarchy");
    });
  }

  const knownPaths = new Set([
    "",
    ...rows.map((row) => canonicalPath(fullGatePath(row))),
  ]);
  for (const [plotIndex, plot] of plots.entries()) {
    if (matches[plotIndex]) {
      continue;
    }

    const parentKey = canonicalPath(plot.parentPath);
    const childGroups = groups.filter(
      (group) => group.parentKey === parentKey,
    );
    if (knownPaths.has(parentKey) && childGroups.length === 0) {
      matches[plotIndex] = { rows: [], method: "none" };
    }
  }

  if (rows.length === plots.length) {
    for (const [plotIndex] of plots.entries()) {
      if (matches[plotIndex]) {
        continue;
      }

      const group = groupForRow.get(rows[plotIndex]);
      if (group && !allocatedGroups.has(group.id)) {
        assignGroup(plotIndex, group, "position");
      }
    }
  }

  return matches;
}
