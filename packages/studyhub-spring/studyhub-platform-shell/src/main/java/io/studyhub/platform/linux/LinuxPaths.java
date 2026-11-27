package io.studyhub.platform.linux;

import io.studyhub.platform.spi.AppPaths;
import java.nio.file.Path;
import java.util.Map;

public record LinuxPaths(Path data, Path config) implements AppPaths {
    public static LinuxPaths from(Map<String, String> env, Path home) {
        return new LinuxPaths(base(env.get("XDG_DATA_HOME"), home.resolve(".local/share")).resolve("studyhub"),
                base(env.get("XDG_CONFIG_HOME"), home.resolve(".config")).resolve("studyhub"));
    }

    private static Path base(String value, Path fallback) {
        if (value == null || value.isBlank()) return fallback;
        Path path = Path.of(value);
        return path.isAbsolute() ? path : fallback;
    }
}
