package io.studyhub.platform.windows;

import io.studyhub.platform.spi.DesktopHost;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

public final class WindowsDesktop implements DesktopHost {
    private final Path webview;
    private final Path profile;
    private volatile Process child;
    private volatile boolean closing;

    public WindowsDesktop(Path webview, Path profile) {
        this.webview = webview;
        this.profile = profile;
    }

    @Override public void open(URI location, Runnable quit) throws IOException {
        if (!Files.isRegularFile(webview)) throw new IOException("WebView2 launcher missing at " + webview);
        Files.createDirectories(profile);
        child = new ProcessBuilder(webview.toString(), location.toASCIIString(), profile.toString())
                .redirectError(ProcessBuilder.Redirect.INHERIT).start();
        child.onExit().thenRun(() -> { if (!closing) quit.run(); });
    }

    @Override public void close() {
        closing = true;
        if (child == null || !child.isAlive()) return;
        try {
            child.getOutputStream().close();
            if (!child.waitFor(3, TimeUnit.SECONDS)) child.destroyForcibly();
        } catch (IOException closedPipe) { child.destroy(); }
        catch (InterruptedException interrupted) { child.destroyForcibly(); Thread.currentThread().interrupt(); }
    }
}
