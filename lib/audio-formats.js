/* What StudyHub accepts as audio and as subtitles, and how big. Pure data (no Node imports) so the browser's file
   pickers and the host's readers share one answer; lib/audio-file.js re-exports the audio part. */

export const AUDIO_MIME = Object.freeze({
  '.mp3': 'audio/mp3', '.wav': 'audio/wav', '.m4a': 'audio/m4a', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.opus': 'audio/opus', '.webm': 'audio/webm',
  '.aiff': 'audio/aiff', '.aif': 'audio/aiff',
});
export const AUDIO_EXTENSIONS = Object.freeze(Object.keys(AUDIO_MIME));

/** Subtitle files the importer reads: timed text (SRT, WebVTT), Bilibili BCC JSON, and "[00:01:02] text" lines. */
export const SUBTITLE_EXTENSIONS = Object.freeze(['.srt', '.vtt', '.json', '.txt']);
/** The subtitle formats a file picker can tell apart from documents (JSON and TXT are documents too). */
export const SUBTITLE_TIMED_EXTENSIONS = Object.freeze(['.srt', '.vtt']);

export const MAX_AUDIO_BYTES = 512 * 1024 * 1024;
export const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
