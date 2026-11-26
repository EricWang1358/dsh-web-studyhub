package io.studyhub.platform;

import io.studyhub.platform.spi.*;
import io.studyhub.platform.windows.*;
import io.studyhub.platform.linux.*;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Locale;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

@Configuration(proxyBeanMethods = false)
public class PlatformConfiguration {
    private final boolean windows;

    public PlatformConfiguration() {
        String os = System.getProperty("os.name").toLowerCase(Locale.ROOT);
        windows = os.startsWith("windows");
        if (!windows && !os.contains("linux")) throw new IllegalStateException("Unsupported StudyHub platform " + os);
    }

    @Bean public AppPaths appPaths(Environment env) {
        AppPaths standard = windows ? WindowsPaths.system() : LinuxPaths.from(System.getenv(), Path.of(System.getProperty("user.home")));
        String override = env.getProperty("studyhub.data-dir", env.getProperty("STUDYHUB_DATA_DIR"));
        if (override == null || override.isBlank()) return standard;
        Path root = Path.of(override).toAbsolutePath().normalize();
        return new AppPaths() {
            public Path data() { return root; }
            public Path config() { return root.resolve("config"); }
        };
    }

    @Bean public SecretStore secretStore(AppPaths paths, Environment env) {
        Path directory = paths.config().resolve("secrets");
        if (windows) return new DpapiSecrets(directory);
        boolean graphical = System.getenv("WAYLAND_DISPLAY") != null || System.getenv("DISPLAY") != null;
        if (graphical && System.getenv("DBUS_SESSION_BUS_ADDRESS") != null && !env.getProperty("studyhub.headless", Boolean.class, false)) {
            var tool = Arrays.stream(System.getenv().getOrDefault("PATH", "").split(File.pathSeparator))
                    .filter(p -> !p.isBlank()).map(p -> Path.of(p).resolve("secret-tool"))
                    .filter(Files::isExecutable).findFirst();
            if (tool.isPresent()) return new KeyringSecrets(tool.get());
        }
        return new EncryptedSecrets(directory, env.getProperty("STUDYHUB_KEYSTORE_PASSWORD", "").toCharArray());
    }

    @Bean public Path studyhubDataDirectory(AppPaths paths) { return paths.data(); }

    @Bean public DesktopHost desktopHost(AppPaths paths, Environment env) {
        if (env.getProperty("studyhub.headless", Boolean.class, false)) return (location, quit) -> {};
        if (!windows) return new LinuxDesktop();
        Path launcher = Path.of(env.getProperty("studyhub.webview", "StudyHub.WebView.exe"));
        return new WindowsDesktop(launcher, paths.config().resolve("webview"));
    }
}
