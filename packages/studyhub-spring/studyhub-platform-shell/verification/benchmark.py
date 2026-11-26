"""Measure fresh relay processes on the same host. Build the relay JAR with -Prelay-aot."""
import argparse
import ctypes
import http.client
import json
import math
import os
import platform
import secrets
import shutil
import socket
import statistics
import subprocess
import tempfile
import time
from pathlib import Path


def rss_mib(pid):
    if os.name != "nt":
        status = Path(f"/proc/{pid}/status").read_text().splitlines()
        return int(next(line for line in status if line.startswith("VmRSS:")).split()[1]) / 1024
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("faults", wintypes.DWORD)] + [
            (name, ctypes.c_size_t) for name in ("peak", "rss", "qpp", "qp", "qpnp", "qnp", "pf", "ppf")]
    kernel = ctypes.windll.kernel32
    kernel.OpenProcess.restype = wintypes.HANDLE
    handle = kernel.OpenProcess(0x0410, False, pid)
    if not handle:
        raise ctypes.WinError()
    try:
        info = Counters()
        info.cb = ctypes.sizeof(info)
        if not ctypes.windll.psapi.GetProcessMemoryInfo(wintypes.HANDLE(handle), ctypes.byref(info), info.cb):
            raise ctypes.WinError()
        return info.rss / (1024 * 1024)
    finally:
        kernel.CloseHandle(wintypes.HANDLE(handle))


def sample(java, jar, flags, env, log):
    with socket.socket() as reserve:
        reserve.bind(("127.0.0.1", 0))
        port = reserve.getsockname()[1]
    env = dict(env, SERVER_PORT=str(port))
    start = time.monotonic()
    with log.open("wb") as output:
        proc = subprocess.Popen([java, "--enable-preview", *flags, "-jar", str(jar)], env=env,
                                stdout=output, stderr=subprocess.STDOUT)
        connection = None
        try:
            while time.monotonic() - start < 75 and proc.poll() is None:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
                try:
                    connection.request("GET", "/actuator/health")
                    response = connection.getresponse()
                    if response.status == 200 and json.loads(response.read())["status"] == "UP":
                        break
                except (OSError, http.client.HTTPException):
                    pass
                connection.close()
                time.sleep(0.025)
            else:
                raise RuntimeError("Relay startup failed\n" + log.read_text(errors="replace")[-5000:])
            ready_ms = (time.monotonic() - start) * 1000
            durations = []
            for _ in range(100):
                before = time.perf_counter()
                connection.request("GET", "/actuator/health")
                response = connection.getresponse()
                if response.status != 200 or json.loads(response.read())["status"] != "UP":
                    raise RuntimeError("Health probe failed")
                durations.append(time.perf_counter() - before)
            return {"startup_ms": round(ready_ms, 2), "rss_mib": round(rss_mib(proc.pid), 2),
                    "health_p99_ms": round(sorted(durations)[math.ceil(.99 * len(durations)) - 1] * 1000, 3),
                    "requests_per_s": round(len(durations) / sum(durations), 2)}
        finally:
            if connection: connection.close()
            proc.terminate()
            try: proc.wait(timeout=12)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


def benchmark():
    parser = argparse.ArgumentParser()
    parser.add_argument("jar", type=Path)
    parser.add_argument("--java", default="java")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.runs < 1: parser.error("--runs must be positive")
    source_jar = args.jar.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="studyhub-benchmark-") as directory:
        root = Path(directory)
        # Keep both layouts on the same filesystem, including when invoked from a WSL mount.
        jar = root / source_jar.name
        shutil.copyfile(source_jar, jar)
        env = dict(os.environ, STUDYHUB_SYNC_TOKEN=secrets.token_hex(32), STUDYHUB_SYNC_DATA_DIR=str(root/"data"))
        extracted, archive = root/"extracted", root/"app.jsa"
        subprocess.run([args.java, "-Djarmode=tools", "-jar", str(jar), "extract",
                        "--destination", str(extracted)], check=True)
        optimized_jar, = extracted.glob("*.jar")
        aot = "-Dspring.aot.enabled=true"
        subprocess.run([args.java, "--enable-preview", aot, "-Dspring.context.exit=onRefresh",
                        "-XX:ArchiveClassesAtExit=" + str(archive), "-jar", str(optimized_jar)],
                       check=True, env=env, timeout=120)
        if archive.stat().st_size < 1024: raise RuntimeError("CDS training produced an empty archive")
        variants = {"standard": (jar, []), "aot_cds": (optimized_jar, [aot, "-Xshare:on", "-XX:SharedArchiveFile=" + str(archive)])}
        rows = {name: [] for name in variants}
        for i in range(args.runs):
            for name in (list(variants) if i % 2 == 0 else reversed(variants)):
                binary, flags = variants[name]
                result = sample(args.java, binary, flags, env, root/(name+".log"))
                rows[name].append(result)
                print(name, result, flush=True)
        report = {"platform": platform.platform(), "java": subprocess.run([args.java, "-version"],
                  capture_output=True, text=True).stderr.splitlines()[0], "samples": rows,
                  "median": {name: {k: statistics.median(r[k] for r in runs) for k in runs[0]} for name, runs in rows.items()}}
        data = json.dumps(report, indent=2)
        print(data)
        if args.out: args.out.write_text(data + "\n", encoding="utf-8")


if __name__ == "__main__":
    benchmark()
