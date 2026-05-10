import {
  fetchRepositoryInfo,
  GithubInfo,
} from "fumadocs-ui/components/github-info";

/**
 * Server component wrapper that silently no-ops when the GitHub repo
 * doesn't exist (so it doesn't break the build before we publish the repo).
 */
export async function SafeGithubInfo(props: Parameters<typeof GithubInfo>[0]) {
  try {
    // Probe first so a failing fetch doesn't take down the whole tree.
    await fetchRepositoryInfo({ owner: props.owner, repo: props.repo });
    return <GithubInfo {...props} />;
  } catch {
    return null;
  }
}
