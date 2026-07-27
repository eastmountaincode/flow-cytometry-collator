const safariBrowser = /Safari\//;
const otherSafariTokenBrowsers =
  /(?:Chrome|Chromium|CriOS|FxiOS|Edg|EdgiOS|OPR)\//;

export function shouldBufferReportResponse(userAgent: string) {
  // Safari can upload the report but fail while JavaScript consumes the
  // streamed response, so let fetch buffer that response internally.
  return (
    safariBrowser.test(userAgent) && !otherSafariTokenBrowsers.test(userAgent)
  );
}
