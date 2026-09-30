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

export async function captureAudio(kind, onAudio, onEnded, onState) {
  if (!navigator.mediaDevices || !globalThis.AudioContext)
    throw new Error('此页面无法采集声音，请在支持音频采集的浏览器中打开（HTTPS 或 localhost）');
  // The chooser must be invoked directly from the learner's click.
  const stream = await (kind === 'tab'
    ? navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    : navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false }));
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
