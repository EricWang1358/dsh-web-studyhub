import { createHash } from 'node:crypto';

/* Pure user-mode, read-only Windows WASAPI shared-mode loopback helper (C# 5.0 for built-in .NET Framework 4.x csc.exe).
   Safety invariants:
   1. Zero virtual driver, zero registry write, zero microphone / Hands-Free AG activation, zero dummy playback stream in Volume Mixer.
   2. Runs ONLY while a Live Class actively captures computer audio; pauses/stops exit the process and FinalReleaseComObject every COM handle.
   3. Background stdin watchdog exits within milliseconds if the parent Node process closes stdin or terminates unexpectedly.
   4. Hot-swaps automatically when the default eRender multimedia endpoint changes (plugging/unplugging headphones or Bluetooth audio). */

export const LIVE_LOOPBACK_HELPER_VERSION = '1.0.0';

export const LIVE_LOOPBACK_CS_SOURCE = `using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace StudyHub.LiveLoopback {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, uint dwStateMask, out IntPtr ppDevices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr pClient);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr pClient);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice {
        [PreserveSig] int Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        [PreserveSig] int OpenPropertyStore(uint stgmAccess, out IPropertyStore ppProperties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        [PreserveSig] int GetState(out uint pdwState);
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PropertyKey {
        public Guid fmtid;
        public uint pid;
        public PropertyKey(Guid f, uint p) { fmtid = f; pid = p; }
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PropVariant {
        public ushort vt;
        public ushort wReserved1;
        public ushort wReserved2;
        public ushort wReserved3;
        public IntPtr ptr1;
        public IntPtr ptr2;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore {
        [PreserveSig] int GetCount(out uint cProps);
        [PreserveSig] int GetAt(uint iProp, out PropertyKey pkey);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant pv);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant propvar);
        [PreserveSig] int Commit();
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint pNumBufferFrames);
        [PreserveSig] int GetStreamLatency(out long phnsLatency);
        [PreserveSig] int GetCurrentPadding(out uint pNumPaddingFrames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr ppClosestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr ppDeviceFormat);
        [PreserveSig] int GetDevicePeriod(out long phnsDefaultDevicePeriod, out long phnsMinimumDevicePeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient {
        [PreserveSig] int GetBuffer(out IntPtr ppData, out uint pNumFramesToRead, out uint pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);
        [PreserveSig] int ReleaseBuffer(uint numFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint pNumFramesInNextPacket);
    }

    internal sealed class PcmResampler {
        private readonly double ratio;
        private readonly Stream output;
        private readonly byte[] chunk = new byte[3200];
        private double weight;
        private double sum;
        private int offset;
        public long LastFlushTicks = DateTime.UtcNow.Ticks;

        public PcmResampler(int inputRate, Stream stdout) {
            this.ratio = (double)inputRate / 16000.0;
            this.output = stdout;
        }

        public void PushSample(double sample) {
            double remaining = 1.0;
            while (remaining > 1e-8) {
                double take = remaining < (this.ratio - this.weight) ? remaining : (this.ratio - this.weight);
                this.sum += sample * take;
                this.weight += take;
                remaining -= take;
                if (this.weight >= this.ratio - 1e-8) {
                    double v = this.sum / this.ratio;
                    if (v > 1.0) v = 1.0;
                    else if (v < -1.0) v = -1.0;
                    int s = (int)Math.Round(v * (v < 0.0 ? 32768.0 : 32767.0));
                    if (s > 32767) s = 32767;
                    else if (s < -32768) s = -32768;
                    short pcm = (short)s;
                    this.chunk[this.offset] = (byte)(pcm & 0xFF);
                    this.chunk[this.offset + 1] = (byte)((pcm >> 8) & 0xFF);
                    this.offset += 2;
                    this.sum = 0.0;
                    this.weight = 0.0;
                    if (this.offset == this.chunk.Length) this.FlushFull();
                }
            }
        }

        public void EmitSilenceChunk() {
            byte[] zeros = new byte[3200];
            this.output.Write(zeros, 0, zeros.Length);
            this.output.Flush();
            this.LastFlushTicks = DateTime.UtcNow.Ticks;
        }

        private void FlushFull() {
            this.output.Write(this.chunk, 0, this.offset);
            this.output.Flush();
            this.offset = 0;
            this.LastFlushTicks = DateTime.UtcNow.Ticks;
        }

        public void FlushRemainder() {
            if (this.offset <= 0) return;
            int aligned = this.offset - (this.offset % 2);
            if (aligned > 0) {
                this.output.Write(this.chunk, 0, aligned);
                this.output.Flush();
            }
            this.offset = 0;
        }
    }

    internal static class Program {
        private const int E_RENDER = 0;
        private const int E_MULTIMEDIA = 1;
        private const uint CLSCTX_ALL = 23U;
        private const uint STGM_READ = 0U;
        private const int AUDCLNT_SHAREMODE_SHARED = 0;
        private const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000U;
        private const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x00000002U;
        private const int HR_NOTFOUND = unchecked((int)0x80070490);
        private const int HR_DEVICE_INVALIDATED = unchecked((int)0x88890004);

        private static volatile bool running = true;

        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PropVariant pvar);

        private static string EscapeJson(string value) {
            if (value == null) return "";
            StringBuilder sb = new StringBuilder(value.Length + 8);
            for (int i = 0; i < value.Length; i++) {
                char c = value[i];
                if (c == '\\\\') sb.Append("\\\\\\\\");
                else if (c == '"') sb.Append("\\\\\\"");
                else if (c == '\\n') sb.Append("\\\\n");
                else if (c == '\\r') sb.Append("\\\\r");
                else if (c == '\\t') sb.Append("\\\\t");
                else if (c < 0x20) sb.AppendFormat(CultureInfo.InvariantCulture, "\\\\u{0:x4}", (int)c);
                else sb.Append(c);
            }
            return sb.ToString();
        }

        private static void ReleaseCom(object obj) {
            if (obj != null && Marshal.IsComObject(obj)) {
                try { Marshal.FinalReleaseComObject(obj); } catch { }
            }
        }

        private static string ReadFriendlyName(IMMDevice device) {
            IPropertyStore store = null;
            try {
                int hr = device.OpenPropertyStore(STGM_READ, out store);
                if (hr < 0 || store == null) return "";
                PropertyKey key = new PropertyKey(new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 14U);
                PropVariant pv;
                hr = store.GetValue(ref key, out pv);
                if (hr < 0) return "";
                try {
                    if (pv.vt == 31 && pv.ptr1 != IntPtr.Zero) {
                        return Marshal.PtrToStringUni(pv.ptr1) ?? "";
                    }
                    return "";
                } finally {
                    PropVariantClear(ref pv);
                }
            } catch {
                return "";
            } finally {
                ReleaseCom(store);
            }
        }

        private static int RunProbe(TextWriter stdout) {
            IMMDeviceEnumerator enumerator = null;
            IMMDevice device = null;
            try {
                enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
                int hr = enumerator.GetDefaultAudioEndpoint(E_RENDER, E_MULTIMEDIA, out device);
                if (hr == HR_NOTFOUND || device == null) {
                    stdout.WriteLine("{\\"ok\\":true,\\"version\\":\\"${LIVE_LOOPBACK_HELPER_VERSION}\\",\\"noDevice\\":true,\\"device\\":\\"\\"}");
                    return 0;
                }
                if (hr < 0) {
                    stdout.WriteLine(String.Format(CultureInfo.InvariantCulture, "{{\\"ok\\":false,\\"hr\\":{0}}}", hr));
                    return 2;
                }
                string name = ReadFriendlyName(device);
                stdout.WriteLine(String.Format(CultureInfo.InvariantCulture, "{{\\"ok\\":true,\\"version\\":\\"${LIVE_LOOPBACK_HELPER_VERSION}\\",\\"noDevice\\":false,\\"device\\":\\"{0}\\"}}", EscapeJson(name)));
                return 0;
            } catch (Exception ex) {
                stdout.WriteLine(String.Format(CultureInfo.InvariantCulture, "{{\\"ok\\":false,\\"error\\":\\"{0}\\"}}", EscapeJson(ex.Message)));
                return 2;
            } finally {
                ReleaseCom(device);
                ReleaseCom(enumerator);
            }
        }

        private static void StartStdinWatchdog() {
            Thread watchdog = new Thread(delegate() {
                try {
                    Stream stdin = Console.OpenStandardInput();
                    byte[] buf = new byte[64];
                    while (stdin.Read(buf, 0, buf.Length) > 0) { }
                } catch { }
                running = false;
                Thread.Sleep(600);
                Environment.Exit(0);
            });
            watchdog.IsBackground = true;
            watchdog.Start();
        }

        private static bool ParseWaveFormat(IntPtr ptr, out int channels, out int sampleRate, out int blockAlign, out int bitsPerSample, out bool isFloat) {
            channels = 0; sampleRate = 0; blockAlign = 0; bitsPerSample = 0; isFloat = false;
            ushort tag = (ushort)Marshal.ReadInt16(ptr, 0);
            channels = (ushort)Marshal.ReadInt16(ptr, 2);
            sampleRate = Marshal.ReadInt32(ptr, 4);
            blockAlign = (ushort)Marshal.ReadInt16(ptr, 12);
            bitsPerSample = (ushort)Marshal.ReadInt16(ptr, 14);
            ushort cbSize = (ushort)Marshal.ReadInt16(ptr, 16);
            if (channels <= 0 || sampleRate < 8000 || blockAlign <= 0) return false;
            if (tag == 3 && bitsPerSample == 32) { isFloat = true; return true; }
            if (tag == 1 && (bitsPerSample == 16 || bitsPerSample == 24 || bitsPerSample == 32)) { isFloat = false; return true; }
            if (tag == 0xFFFE && cbSize >= 22) {
                int subTag = Marshal.ReadInt32(ptr, 24);
                if (subTag == 3 && bitsPerSample == 32) { isFloat = true; return true; }
                if (subTag == 1 && (bitsPerSample == 16 || bitsPerSample == 24 || bitsPerSample == 32)) { isFloat = false; return true; }
            }
            return false;
        }

        private static void DecodeAndPush(byte[] raw, int frames, int channels, int blockAlign, int bitsPerSample, bool isFloat, PcmResampler resampler) {
            double invCh = 1.0 / (double)channels;
            int stride = bitsPerSample / 8;
            for (int f = 0; f < frames; f++) {
                int baseOffset = f * blockAlign;
                double mono = 0.0;
                for (int c = 0; c < channels; c++) {
                    int pos = baseOffset + c * stride;
                    double s = 0.0;
                    if (isFloat) {
                        float fv = BitConverter.ToSingle(raw, pos);
                        if (!Single.IsNaN(fv) && !Single.IsInfinity(fv)) s = (double)fv;
                    } else if (bitsPerSample == 16) {
                        short sv = BitConverter.ToInt16(raw, pos);
                        s = (double)sv / 32768.0;
                    } else if (bitsPerSample == 24) {
                        int iv = (raw[pos] | (raw[pos + 1] << 8) | ((sbyte)raw[pos + 2] << 16));
                        s = (double)iv / 8388608.0;
                    } else if (bitsPerSample == 32) {
                        int iv32 = BitConverter.ToInt32(raw, pos);
                        s = (double)iv32 / 2147483648.0;
                    }
                    mono += s * invCh;
                }
                resampler.PushSample(mono);
            }
        }

        private static int RunCapture(TextWriter stderr, Stream stdout) {
            StartStdinWatchdog();
            IMMDeviceEnumerator enumerator = null;
            try {
                enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
                IMMDevice testDevice = null;
                int checkHr = enumerator.GetDefaultAudioEndpoint(E_RENDER, E_MULTIMEDIA, out testDevice);
                ReleaseCom(testDevice);
                if (checkHr == HR_NOTFOUND) {
                    stderr.WriteLine("STATE:{\\"error\\":\\"no-device\\"}");
                    return 3;
                }

                while (running) {
                    IMMDevice device = null;
                    IAudioClient audioClient = null;
                    IAudioCaptureClient captureClient = null;
                    IntPtr mixFormat = IntPtr.Zero;
                    bool started = false;
                    try {
                        int hr = enumerator.GetDefaultAudioEndpoint(E_RENDER, E_MULTIMEDIA, out device);
                        if (hr == HR_NOTFOUND || device == null) {
                            stderr.WriteLine("STATE:{\\"noDevice\\":true,\\"label\\":\\"\\"}");
                            for (int w = 0; w < 25 && running; w++) Thread.Sleep(20);
                            continue;
                        }
                        if (hr < 0) {
                            stderr.WriteLine(String.Format(CultureInfo.InvariantCulture, "STATE:{{\\"error\\":\\"endpoint-0x{0:x8}\\"}}", hr));
                            return 4;
                        }
                        string currentId = "";
                        device.GetId(out currentId);
                        string friendly = ReadFriendlyName(device);

                        Guid iidAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
                        object acObj;
                        hr = device.Activate(ref iidAudioClient, CLSCTX_ALL, IntPtr.Zero, out acObj);
                        if (hr < 0 || acObj == null) {
                            stderr.WriteLine(String.Format(CultureInfo.InvariantCulture, "STATE:{{\\"error\\":\\"activate-0x{0:x8}\\"}}", hr));
                            return 4;
                        }
                        audioClient = (IAudioClient)acObj;
                        hr = audioClient.GetMixFormat(out mixFormat);
                        if (hr < 0 || mixFormat == IntPtr.Zero) {
                            stderr.WriteLine("STATE:{\\"error\\":\\"mix-format\\"}");
                            return 4;
                        }
                        int channels; int sampleRate; int blockAlign; int bitsPerSample; bool isFloat;
                        if (!ParseWaveFormat(mixFormat, out channels, out sampleRate, out blockAlign, out bitsPerSample, out isFloat)) {
                            stderr.WriteLine("STATE:{\\"error\\":\\"unsupported-format\\"}");
                            return 4;
                        }
                        hr = audioClient.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2000000L, 0L, mixFormat, IntPtr.Zero);
                        Marshal.FreeCoTaskMem(mixFormat);
                        mixFormat = IntPtr.Zero;
                        if (hr == HR_DEVICE_INVALIDATED) continue;
                        if (hr < 0) {
                            stderr.WriteLine(String.Format(CultureInfo.InvariantCulture, "STATE:{{\\"error\\":\\"init-0x{0:x8}\\"}}", hr));
                            return 4;
                        }
                        Guid iidCapture = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
                        object capObj;
                        hr = audioClient.GetService(ref iidCapture, out capObj);
                        if (hr < 0 || capObj == null) {
                            stderr.WriteLine("STATE:{\\"error\\":\\"capture-service\\"}");
                            return 4;
                        }
                        captureClient = (IAudioCaptureClient)capObj;
                        hr = audioClient.Start();
                        if (hr == HR_DEVICE_INVALIDATED) continue;
                        if (hr < 0) {
                            stderr.WriteLine(String.Format(CultureInfo.InvariantCulture, "STATE:{{\\"error\\":\\"start-0x{0:x8}\\"}}", hr));
                            return 4;
                        }
                        started = true;
                        stderr.WriteLine(String.Format(CultureInfo.InvariantCulture, "STATE:{{\\"ready\\":true,\\"noDevice\\":false,\\"label\\":\\"{0}\\",\\"rate\\":{1},\\"channels\\":{2}}}", EscapeJson(friendly), sampleRate, channels));

                        PcmResampler resampler = new PcmResampler(sampleRate, stdout);
                        byte[] rawBuf = new byte[65536];
                        long lastDevicePollTicks = DateTime.UtcNow.Ticks;

                        while (running) {
                            uint packetFrames = 0;
                            hr = captureClient.GetNextPacketSize(out packetFrames);
                            if (hr == HR_DEVICE_INVALIDATED) break;
                            if (hr < 0) return 5;

                            if (packetFrames == 0) {
                                Thread.Sleep(15);
                                long nowTicks = DateTime.UtcNow.Ticks;
                                if (nowTicks - resampler.LastFlushTicks >= 1000000L) {
                                    resampler.EmitSilenceChunk();
                                }
                            } else {
                                while (packetFrames > 0 && running) {
                                    IntPtr dataPtr;
                                    uint numFrames;
                                    uint flags;
                                    ulong devPos;
                                    ulong qpcPos;
                                    hr = captureClient.GetBuffer(out dataPtr, out numFrames, out flags, out devPos, out qpcPos);
                                    if (hr == HR_DEVICE_INVALIDATED) { packetFrames = 0; break; }
                                    if (hr < 0) return 5;
                                    int frameCount = (int)numFrames;
                                    if (frameCount > 0) {
                                        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || dataPtr == IntPtr.Zero) {
                                            for (int s = 0; s < frameCount; s++) resampler.PushSample(0.0);
                                        } else {
                                            int byteCount = frameCount * blockAlign;
                                            if (rawBuf.Length < byteCount) rawBuf = new byte[byteCount];
                                            Marshal.Copy(dataPtr, rawBuf, 0, byteCount);
                                            DecodeAndPush(rawBuf, frameCount, channels, blockAlign, bitsPerSample, isFloat, resampler);
                                        }
                                    }
                                    captureClient.ReleaseBuffer(numFrames);
                                    if (!running) break;
                                    hr = captureClient.GetNextPacketSize(out packetFrames);
                                    if (hr == HR_DEVICE_INVALIDATED) break;
                                    if (hr < 0) return 5;
                                }
                                if (hr == HR_DEVICE_INVALIDATED) break;
                            }

                            long checkTicks = DateTime.UtcNow.Ticks;
                            if (checkTicks - lastDevicePollTicks >= 20000000L) {
                                lastDevicePollTicks = checkTicks;
                                IMMDevice latest = null;
                                try {
                                    if (enumerator.GetDefaultAudioEndpoint(E_RENDER, E_MULTIMEDIA, out latest) == 0 && latest != null) {
                                        string latestId = "";
                                        latest.GetId(out latestId);
                                        if (!String.Equals(latestId, currentId, StringComparison.OrdinalIgnoreCase)) {
                                            break;
                                        }
                                    }
                                } finally {
                                    ReleaseCom(latest);
                                }
                            }
                        }
                        resampler.FlushRemainder();
                    } finally {
                        if (mixFormat != IntPtr.Zero) Marshal.FreeCoTaskMem(mixFormat);
                        if (started && audioClient != null) { try { audioClient.Stop(); } catch { } }
                        ReleaseCom(captureClient);
                        ReleaseCom(audioClient);
                        ReleaseCom(device);
                    }
                }
                return 0;
            } finally {
                ReleaseCom(enumerator);
            }
        }

        [MTAThread]
        public static int Main(string[] args) {
            UTF8Encoding utf8 = new UTF8Encoding(false);
            string mode = (args != null && args.Length > 0) ? args[0] : "--probe";
            if (String.Equals(mode, "--probe", StringComparison.OrdinalIgnoreCase)) {
                using (StreamWriter outWriter = new StreamWriter(Console.OpenStandardOutput(), utf8)) {
                    outWriter.AutoFlush = true;
                    return RunProbe(outWriter);
                }
            }
            if (String.Equals(mode, "--capture", StringComparison.OrdinalIgnoreCase)) {
                using (StreamWriter errWriter = new StreamWriter(Console.OpenStandardError(), utf8)) {
                    errWriter.AutoFlush = true;
                    return RunCapture(errWriter, Console.OpenStandardOutput());
                }
            }
            return 1;
        }
    }
}
`;

export const LIVE_LOOPBACK_SOURCE_SHA256 = createHash('sha256').update(LIVE_LOOPBACK_CS_SOURCE, 'utf8').digest('hex');
