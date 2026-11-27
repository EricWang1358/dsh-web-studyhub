package io.studyhub.gateway;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Import;
import io.studyhub.platform.PlatformConfiguration;
import io.studyhub.sync.SyncServerApplication;
import io.studyhub.sync.SyncClientMain;
import java.util.Arrays;
import org.springframework.boot.DefaultApplicationArguments;

@SpringBootApplication(scanBasePackages = {"io.studyhub.gateway", "io.studyhub.ai"})
@Import(PlatformConfiguration.class)
public class StudyHubApplication {
    public static void main(String[] args) throws Exception {
        var options = new DefaultApplicationArguments(args);
        var modes = options.getOptionValues("studyhub.mode");
        String mode = modes == null ? "desktop" : modes.getFirst();
        if ("sync".equals(mode)) { SyncServerApplication.main(args); return; }
        if ("sync-client".equals(mode)) { SyncClientMain.main(args); return; }
        if (!"desktop".equals(mode)) throw new IllegalArgumentException("Unknown StudyHub mode " + mode);
        var app = new SpringApplication(StudyHubApplication.class);
        if (options.containsOption("headless")) {
            args = Arrays.copyOf(args, args.length + 2);
            args[args.length - 2] = "--studyhub.headless=true";
            args[args.length - 1] = "--studyhub.desktop.enabled=false";
        } else if (Boolean.getBoolean("studyhub.desktop.enabled")) {
            app.setHeadless(false);
        }
        app.run(args);
    }
}
