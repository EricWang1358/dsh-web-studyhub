/* WP15 test fixtures: a GitHub release object as the releases/latest API returns it. */
export const REPO = 'https://github.com/EricWang1358/dsh-web-studyhub';
export const githubRelease = (tag, extra = {}) => {
  const version = tag.replace(/^v/, '');
  return { tag_name: tag, name: `StudyHub ${version}`, draft: false, prerelease: false, published_at: '2026-10-05T08:00:00Z',
    html_url: `${REPO}/releases/tag/${tag}`, body: `## What's new\n- calmer update check for ${version}`,
    assets: [
      { name: `ericwang1358-dsh-daily-flashcard-${version}.tgz`, browser_download_url: `${REPO}/releases/download/${tag}/ericwang1358-dsh-daily-flashcard-${version}.tgz` },
      { name: `SHA256SUMS-${version}.txt`, browser_download_url: `${REPO}/releases/download/${tag}/SHA256SUMS-${version}.txt` },
      { name: `studyhub-setup-${version}.md`, browser_download_url: `${REPO}/releases/download/${tag}/studyhub-setup-${version}.md` },
    ], ...extra };
};
