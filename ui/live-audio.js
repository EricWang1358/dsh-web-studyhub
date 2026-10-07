// Literal worklet source survives production minification and runs off the UI thread.
export const PCM_WORKLET_SOURCE = `
/** Fractional sample weights preserve timing at 44.1 kHz. */
class PcmEncoder {
  constructor(rate, emit) {
    this.ratio = rate / 16000;
    this.emit = emit;
    this.weight = 0;
    this.sum = 0;
    this.bytes = new ArrayBuffer(3200);
    this.view = new DataView(this.bytes);
    this.offset = 0;
  }
  push(samples) {
    for (const sample of samples) {
      let remaining = 1;
      while (remaining > 1e-8) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * take;
        this.weight += take;
        remaining -= take;
        if (this.weight >= this.ratio - 1e-8) {
          const value = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.view.setInt16(this.offset, Math.round(value * (value < 0 ? 32768 : 32767)), true);
          this.offset += 2;
          this.sum = this.weight = 0;
          if (this.offset === this.bytes.byteLength) this.flush();
        }
      }
    }
  }
  flush() {
    if (!this.offset) return;
    this.emit(this.bytes.slice(0, this.offset));
    this.offset = 0;
  }
}

class StudyPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.paused = false;
    this.encoder = new PcmEncoder(sampleRate, (bytes) => this.port.postMessage(bytes, [bytes]));
    this.port.onmessage = ({ data }) => {
      if (data === 'flush') { this.encoder.flush(); this.port.postMessage('flushed'); }
      else this.paused = data === 'pause';
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!this.paused && channels?.length) {
      let mono = channels[0];
      if (channels.length > 1) {
        if (this.mono?.length !== mono.length) this.mono = new Float32Array(mono.length);
        mono = this.mono;
        mono.fill(0);
        for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
      }
      this.encoder.push(mono);
    }
    return true;
  }
}
registerProcessor('study-pcm', StudyPcm);`;

/**
 * A tab-sharing refusal (NotAllowedError of getDisplayMedia) has four different causes that look alike to the code that catches it, so it
 * is told apart by what can be observed, strongest first:
 *   blocked          the frame's permissions policy denies display-capture (document.permissionsPolicy), or the browser's own message says so:
 *                    an iframe without allow="display-capture", a host webview. No picker was shown and none ever will be.
 *   embedded-instant refused within INSTANT_REFUSAL_MS inside a frame while the policy could not be read: probably the same, said as "probably".
 *   instant          refused within INSTANT_REFUSAL_MS at top level: no picker was shown either (system screen-recording permission, a managed policy).
 *   cancelled        refused after a human-scale delay: the picker was shown and dismissed.
 * The time is only the secondary signal: measured in Chromium, a policy refusal comes back in 0-1 ms while a picker needs a person to look and
 * click, so 300 ms separates them with room for a loaded machine; a late "instant" lands on "cancelled", the wording that makes no claim about frames.
 * `unknown` is a refusal nobody measured. Never claim a cause the observation does not support.
 */
export const INSTANT_REFUSAL_MS = 300;
export function classifyTabRefusal({ error, elapsedMs, policyAllowed, embedded } = {}) {
  if (error?.name !== 'NotAllowedError') return null;
  if (policyAllowed === false || /permissions? policy|feature policy/i.test(error.message || '')) return 'blocked';
  if (typeof elapsedMs !== 'number' || Number.isNaN(elapsedMs)) return 'unknown';
  if (elapsedMs < INSTANT_REFUSAL_MS) return embedded ? 'embedded-instant' : 'instant';
  return 'cancelled';
}

/** Does this frame's permissions policy allow display-capture? true / false, or null when the browser cannot say (no document, an old browser). */
export function tabSharingAllowed(doc = globalThis.document) {
  try {
    const policy = doc?.permissionsPolicy || doc?.featurePolicy;
    return typeof policy?.allowsFeature === 'function' ? !!policy.allowsFeature('display-capture') : null;
  } catch { return null; }
}

/** What captureAudio reads from the browser; tests pass their own. */
const browserEnv = () => ({
  now: () => globalThis.performance?.now?.() ?? Date.now(),
  tabAllowed: () => tabSharingAllowed(),
  embedded: () => !!globalThis.top && globalThis.top !== globalThis,
});

const TAB_REFUSAL = {
  blocked: '这里不允许共享标签页：浏览器的权限策略没有放行屏幕共享（嵌在别的页面里的面板通常如此），所以不会弹出选择窗口，再点「开始实录」也没有用。请把「声音来源」改成「麦克风」（外放课程声音，让麦克风收音），或在独立的浏览器窗口里打开 StudyHub 再录；也可以课后在「音频转写」里导入录音。',
  'embedded-instant': '点下去就被拒绝了，没有弹出选择窗口。这个面板嵌在别的页面里，很可能不允许共享标签页，再点「开始实录」多半也没有用。请把「声音来源」改成「麦克风」（外放课程声音，让麦克风收音），或在独立的浏览器窗口里打开 StudyHub 再录；也可以课后在「音频转写」里导入录音。',
  instant: '浏览器没有弹出选择窗口就拒绝了共享（可能是系统的屏幕录制权限没打开，或被管理策略禁止）。请检查浏览器和系统的屏幕录制权限；或把「声音来源」改成「麦克风」，外放课程声音让麦克风收音。',
  cancelled: '已取消共享。要录课，请再点一次「开始实录」，在弹出的窗口里选标签页并勾选「共享标签页音频」。',
  unknown: '没有共享标签页。要录课，请点「开始实录」，在弹出的窗口里选标签页并勾选「共享标签页音频」；如果根本没有弹出窗口，请改用麦克风，或在独立的浏览器窗口里打开 StudyHub。',
};

/**
 * What the browser's refusal means for the learner. getUserMedia/getDisplayMedia reject with a DOMException whose name
 * says what happened ("Not supported" alone helps nobody); unknown errors pass through. The text is the Chinese source
 * copy: the live class shows it through uiMessage(), which translates it (ui/locales/en.audio.json). This module stays
 * free of the i18n catalogue so the client can be loaded on its own.
 * `context` ({ elapsedMs, policyAllowed, embedded }) is what captureAudio observed around a tab-sharing refusal (classifyTabRefusal).
 */
export function describeCaptureError(error, kind = 'microphone', context = {}) {
  const tab = kind === 'tab';
  const refusal = tab ? classifyTabRefusal({ error, ...context }) : null;
  const text = {
    NotAllowedError: tab ? TAB_REFUSAL[refusal]
      : '浏览器没有允许使用麦克风。点地址栏左侧的锁形图标，把麦克风改为「允许」后再试。',
    SecurityError: '浏览器没有允许使用麦克风。点地址栏左侧的锁形图标，把麦克风改为「允许」后再试。',
    NotFoundError: tab ? '所选内容里没有声音。请选择正在播放课程的标签页，并勾选「共享标签页音频」。'
      : '没有找到麦克风。请插上麦克风，或在系统的声音设置里启用它。',
    NotSupportedError: '这个页面不能采集声音。请用最新版 Chrome 或 Edge，通过 HTTPS 或 localhost 打开。',
    TypeError: '这个页面不能采集声音。请用最新版 Chrome 或 Edge，通过 HTTPS 或 localhost 打开。',
    NotReadableError: '麦克风正被其他程序占用（例如会议软件）。关闭占用它的程序后再试。',
    AbortError: '采集声音被中断了，请再试一次。',
    OverconstrainedError: '这个麦克风不支持所需的设置，请在系统里换一个麦克风后再试。',
  }[error?.name];
  return text ? Object.assign(new Error(text), { name: error.name, cause: error }, refusal ? { tabRefusal: refusal } : {}) : error;
}

export async function captureAudio(kind, onAudio, onEnded, onState, env = browserEnv()) {
  if (!globalThis.navigator?.mediaDevices || !globalThis.AudioContext)
    throw new Error('这个页面不能采集声音。请用最新版 Chrome 或 Edge，通过 HTTPS 或 localhost 打开。');
  // The chooser must be invoked directly from the learner's click.
  let stream;
  const clicked = env.now();
  try {
    stream = await (kind === 'tab'
      ? navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      : navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false }));
  } catch (error) {
    // The policy says only "probably": ask the browser anyway above, and read what it says once it has answered.
    throw describeCaptureError(error, kind, { elapsedMs: env.now() - clicked, policyAllowed: env.tabAllowed(), embedded: env.embedded() });
  }
  let context, node, source, url, closed = false, paused = false;
  const tracks = stream.getTracks();
  const audioTracks = stream.getAudioTracks();
  const report = () => onState?.({ label: audioTracks.map(track => track.label).filter(Boolean).join(' · '),
    context: context?.state || '', muted: audioTracks.some(track => track.muted) });
  const ended = () => { if (!closed) onEnded?.(); };
  const cleanup = async () => {
    closed = true;
    for (const track of tracks) {
      track.removeEventListener('ended', ended);
      track.removeEventListener('mute', report); track.removeEventListener('unmute', report);
      track.stop();
    }
    context?.removeEventListener('statechange', report);
    source?.disconnect(); node?.disconnect();
    if (context && context.state !== 'closed') await context.close();
    if (url) URL.revokeObjectURL(url);
  };
  try {
    if (!stream.getAudioTracks().length) throw new Error('没有共享声音。Chrome / Edge 只有在共享「标签页」时才带声音（共享窗口没有；共享整个屏幕只有 Windows 上勾选「共享系统音频」才有）。请重新点「开始实录」，在弹出窗口顶部选「标签页」，点选正在播放课程的那一个，并勾选窗口左下角的「共享标签页音频」');
    context = new AudioContext();
    context.addEventListener('statechange', report);
    if (!context.audioWorklet) throw new Error('当前浏览器不支持实时采音，请使用较新的 Chrome 或 Edge');
    await context.resume();
    url = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'text/javascript' }));
    await context.audioWorklet.addModule(url);
    node = new AudioWorkletNode(context, 'study-pcm');
    node.port.onmessage = ({ data }) => { if (data instanceof ArrayBuffer && !paused) onAudio(data); };
    source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    source.connect(node);
    node.connect(context.destination); // Processor emits silence; only the message port carries captured audio.
    for (const track of tracks) track.addEventListener('ended', ended, { once: true });
    for (const track of audioTracks) { track.addEventListener('mute', report); track.addEventListener('unmute', report); }
    report();
    return {
      pause(value) {
        paused = value;
        node.port.postMessage(value ? 'pause' : 'resume');
        for (const track of stream.getAudioTracks()) track.enabled = !value;
      },
      async stop() {
        if (closed) return;
        closed = true;
        // Flush the final partial frame before closing the audio context.
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 250);
          const previous = node.port.onmessage;
          node.port.onmessage = (event) => {
            if (event.data === 'flushed') { clearTimeout(timeout); resolve(); }
            else previous(event);
          };
          node.port.postMessage('flush');
        });
        await cleanup();
      },
    };
  } catch (error) { await cleanup(); throw error; }
}
