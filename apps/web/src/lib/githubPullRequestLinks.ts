export function parseGitHubPullRequestNumber(href: string): number | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com" && !url.hostname.endsWith(".github.com")) {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[2] !== "pull") {
    return null;
  }
  const number = Number(parts[3]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
