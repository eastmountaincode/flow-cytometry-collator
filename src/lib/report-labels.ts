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
