/** The export file name: study-library-YYYY-MM-DD.json (local date). */
export function backupFileName(date = new Date()) {
  return `study-library-${date.toLocaleDateString('en-CA')}.json`;
}
