export function formatInputPopulations(
  parentPaths: string[],
  maximumShown = parentPaths.length,
) {
  const labels = parentPaths.map((parentPath) =>
    parentPath === "All events" ? "All collected events" : parentPath,
  );

  if (labels.length <= maximumShown) {
    return labels.join(", ");
  }

  const remaining = labels.length - maximumShown;
  return `${labels.slice(0, maximumShown).join(", ")} (and ${remaining} more)`;
}

export function formatDisplayedGates(
  gateNames: string[],
  status: "resolved" | "unavailable" = "resolved",
) {
  if (status === "unavailable") {
    return "Unavailable";
  }
  return gateNames.length > 0 ? gateNames.join(", ") : "None";
}

export function displayedGateLabel(gateNames: string[]) {
  return `Displayed gate${gateNames.length === 1 ? "" : "s"}`;
}
