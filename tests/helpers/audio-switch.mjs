import { SWITCH_MODE, switchOptions } from './runtime-switch.mjs';

export { SWITCH_MODE };

/** The audio paths behind a migration switch. In runtime mode every one of them is routed through the unified runtime. */
export const AUDIO_SWITCHES = Object.freeze(['audioSingle', 'audioBatch', 'audioSubtitles', 'audioReview', 'audioLiveCorrection', 'audioLiveSave']);

/** StudyService options for the audio suites: nothing on the legacy side, the runtime for every audio path on the other. */
export const audioSwitch = ({ complete } = {}) => switchOptions(SWITCH_MODE, { complete, paths: [...AUDIO_SWITCHES] });
