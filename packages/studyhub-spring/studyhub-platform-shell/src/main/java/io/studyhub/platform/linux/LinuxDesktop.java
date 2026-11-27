package io.studyhub.platform.linux;

import io.studyhub.platform.spi.DesktopHost;
import java.awt.Desktop;
import java.io.IOException;
import java.net.URI;

public final class LinuxDesktop implements DesktopHost {
    @Override public void open(URI location, Runnable quit) throws IOException {
        if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE))
            Desktop.getDesktop().browse(location);
        else new ProcessBuilder("xdg-open", location.toASCIIString()).start();
    }
}
