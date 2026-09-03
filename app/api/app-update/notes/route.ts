import { getGitHubReleaseNotes, getGitUpdateNotes } from "@/lib/github-release-notes";
import { checkNpmUpdate } from "@/lib/npm-update";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function noContent(): Response {
  return new Response(null, { status: 204, headers: NO_STORE_HEADERS });
}

// GET /api/app-update/notes — what the pending update contains: the commit
// list for a git checkout, the GitHub release body for a package install.
export async function GET() {
  try {
    const status = await checkNpmUpdate(false);
    if (!status.updateAvailable || !status.availableVersion) return noContent();

    const notes = status.installMethod === "git"
      ? await getGitUpdateNotes(status)
      : await getGitHubReleaseNotes(status.availableVersion);
    if (!notes || notes.version !== status.availableVersion) return noContent();
    return Response.json(notes, { headers: NO_STORE_HEADERS });
  } catch {
    return noContent();
  }
}
