import { createMarkerConversionScript, MARKER_SCRIPT_FILENAME } from '../lib/marker-external.js';

export function downloadMarkerScript() {
  const url = URL.createObjectURL(new Blob([createMarkerConversionScript()], { type: 'text/x-python;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = MARKER_SCRIPT_FILENAME;
  try { link.click(); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
