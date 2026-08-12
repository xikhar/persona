export function isAllowedRendererNavigation(
  targetUrl: string,
  rendererUrl: string,
): boolean {
  try {
    const target = new URL(targetUrl);
    const renderer = new URL(rendererUrl);
    if (renderer.protocol === "file:") {
      return target.protocol === "file:" && target.pathname === renderer.pathname;
    }
    return target.origin === renderer.origin;
  } catch {
    return false;
  }
}
