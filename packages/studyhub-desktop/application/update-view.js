import { releaseDownloadPrefix } from '../../../lib/update-check.js';

/**
 * Compute Desktop NSIS `.exe`, `.msi`, `.zip`, and `SHA256SUMS` release URLs for a given version.
 */
export function desktopReleaseAssets(latest, prefix = releaseDownloadPrefix()) {
  if (!latest) {
    return {
      assetName: null,
      assetUrl: null,
      setupName: null,
      setupUrl: null,
      installerName: null,
      installerUrl: null,
      zipName: null,
      zipUrl: null,
      sha256Url: null,
    };
  }
  const base = `${prefix}v${latest}/`;
  const setupName = `StudyHub-Desktop-${latest}-win-x64-setup.exe`;
  const installerName = `StudyHub-Desktop-${latest}-win-x64.msi`;
  const zipName = `StudyHub-Desktop-${latest}-win-x64.zip`;
  return {
    assetName: setupName,
    assetUrl: `${base}${setupName}`,
    setupName,
    setupUrl: `${base}${setupName}`,
    installerName,
    installerUrl: `${base}${installerName}`,
    zipName,
    zipUrl: `${base}${zipName}`,
    sha256Url: `${base}SHA256SUMS-Desktop-${latest}.txt`,
  };
}

/**
 * Transform core `update.check` payload into the Desktop upgrade view:
 * desktop `.msi`/`.zip` guidance, no DSH plugin installer or restart flags.
 */
export function desktopUpdateView(view, prefix = releaseDownloadPrefix()) {
  if (!view || typeof view !== 'object') return view;
  const { pendingRestart: _pr, restartFailed: _rf, ...rest } = view;
  return {
    ...rest,
    ...desktopReleaseAssets(view.latest, prefix),
    install: {
      available: false,
      desktop: true,
      host: 'desktop',
    },
  };
}
