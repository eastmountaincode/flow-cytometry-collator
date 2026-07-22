import type { ParsedReport } from "@/lib/novoexpress-parser";

export async function exportCollatedPdf(
  report: ParsedReport,
  columns: number,
) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 30;
  const headerHeight = 58;
  const footerHeight = 18;
  const gap = 12;
  const availableWidth = pageWidth - margin * 2;
  const availableHeight =
    pageHeight - margin * 2 - headerHeight - footerHeight;
  const cellWidth = (availableWidth - gap * (columns - 1)) / columns;
  const rows = Math.max(
    1,
    Math.round((columns * availableHeight) / availableWidth),
  );
  const cellHeight =
    (availableHeight - gap * (rows - 1)) / rows;
  const plotsPerPage = columns * rows;
  let hasPage = false;

  for (const group of report.groups) {
    for (let start = 0; start < group.plots.length; start += plotsPerPage) {
      if (hasPage) {
        pdf.addPage("letter", "landscape");
      }
      hasPage = true;

      const pagePlots = group.plots.slice(start, start + plotsPerPage);
      const part = Math.floor(start / plotsPerPage) + 1;
      const partCount = Math.ceil(group.plots.length / plotsPerPage);

      pdf.setTextColor(24, 38, 51);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(16);
      pdf.text(group.label, margin, margin + 14);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.setTextColor(76, 94, 108);
      pdf.text(`Parent population: ${group.parentPath}`, margin, margin + 31);
      pdf.text(
        `Samples: ${group.plots.length}, page ${part} of ${partCount}`,
        pageWidth - margin,
        margin + 14,
        { align: "right" },
      );

      for (let index = 0; index < pagePlots.length; index += 1) {
        const plot = pagePlots[index];
        const column = index % columns;
        const row = Math.floor(index / columns);
        const cellX = margin + column * (cellWidth + gap);
        const cellY = margin + headerHeight + row * (cellHeight + gap);
        const labelHeight = 18;
        const availableWidth = cellWidth;
        const availableHeight = cellHeight - labelHeight;
        const aspectRatio = plot.box.width / plot.box.height;
        let imageWidth = availableWidth;
        let imageHeight = imageWidth / aspectRatio;

        if (imageHeight > availableHeight) {
          imageHeight = availableHeight;
          imageWidth = imageHeight * aspectRatio;
        }

        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8.5);
        pdf.setTextColor(35, 48, 60);
        pdf.text(plot.sampleName, cellX, cellY + 10, {
          maxWidth: cellWidth,
        });
        pdf.addImage(
          plot.imageUrl,
          "JPEG",
          cellX + (cellWidth - imageWidth) / 2,
          cellY + labelHeight,
          imageWidth,
          imageHeight,
          undefined,
          "FAST",
        );
      }

      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(7.5);
      pdf.setTextColor(112, 126, 138);
      pdf.text(report.fileName, margin, pageHeight - 13);
      pdf.text("Generated locally in the browser", pageWidth - margin, pageHeight - 13, {
        align: "right",
      });
    }
  }

  const baseName = report.fileName.replace(/\.pdf$/i, "");
  pdf.save(`${baseName}-collated.pdf`);
}
