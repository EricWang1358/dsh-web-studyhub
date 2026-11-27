package io.studyhub.platform.windows;

import io.studyhub.platform.spi.AppPaths;
import java.nio.file.Path;

public record WindowsPaths(Path data, Path config) implements AppPaths {
    public static WindowsPaths system() {
        String base = System.getenv("LOCALAPPDATA");
        Path local = base == null || base.isBlank() ? Path.of(System.getProperty("user.home"), "AppData", "Local") : Path.of(base);
        Path root = local.resolve("StudyHub");
        return new WindowsPaths(root, root.resolve("config"));
    }
}
