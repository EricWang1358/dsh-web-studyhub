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
 * What the browser's refusal means for the learner. getUserMedia/getDisplayMedia reject with a DOMException whose name
 * says what happened ("Not supported" alone helps nobody); unknown errors pass through. The text is the Chinese source
 * copy: the live class shows it through uiMessage(), which translates it (ui/locales/en.audio.json). This module stays
 * free of the i18n catalogue so the client can be loaded on its own.
 */
export function describeCaptureError(error, kind = 'microphone') {
  const tab = kind === 'tab';
  const text = {
    NotAllowedError: tab ? '没有允许共享标签页（或取消了共享）。点「开始实录」后，选择正在播放课程的标签页，并勾选「共享标签页音频」。'
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
  return text ? Object.assign(new Error(text), { name: error.name, cause: error }) : error;
}

export async function captureAudio(kind, onAudio, onEnded, onState) {
  if (!globalThis.navigator?.mediaDevices || !globalThis.AudioContext)
    throw new Error('这个页面不能采集声音。请用最新版 Chrome 或 Edge，通过 HTTPS 或 localhost 打开。');
  // The chooser must be invoked directly from the learner's click.
  let stream;
  try {
    stream = await (kind === 'tab'
      ? navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      : navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false }));
  } catch (error) { throw describeCaptureError(error, kind); }
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
    if (!stream.getAudioTracks().length) throw new Error('没有共享声音。请选择正在播放的标签页，并勾选「共享标签页音频」');
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
