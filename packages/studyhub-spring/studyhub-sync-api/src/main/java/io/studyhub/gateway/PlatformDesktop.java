package io.studyhub.gateway;

import io.studyhub.platform.spi.DesktopHost;
import java.io.IOException;
import java.net.URI;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "studyhub.desktop.enabled", havingValue = "true")
final class PlatformDesktop {
    private final DesktopHost host;
    private final AtomicBoolean opened = new AtomicBoolean();
    PlatformDesktop(DesktopHost host) { this.host = host; }

    @EventListener void ready(ApplicationReadyEvent event) throws IOException {
        if (!(event.getApplicationContext() instanceof ServletWebServerApplicationContext server)
                || !opened.compareAndSet(false, true)) return;
        host.open(URI.create("http://127.0.0.1:" + server.getWebServer().getPort()), server::close);
    }
}
