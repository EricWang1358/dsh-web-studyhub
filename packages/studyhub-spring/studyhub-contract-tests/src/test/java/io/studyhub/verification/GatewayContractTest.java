package io.studyhub.verification;

import io.studyhub.gateway.StudyHubApplication;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;

import static org.junit.jupiter.api.Assertions.*;

class GatewayContractTest {
    @Test void compareLiveServersAndOpenTheRealUi(@TempDir Path temporary) throws Exception {
        Path repo = Path.of("../../..").toRealPath();
        var builder = new SpringApplicationBuilder(StudyHubApplication.class);
        boolean realModel = Boolean.getBoolean("studyhub.real-model");
        var args = new ArrayList<>(List.of("--server.port=0", "--server.address=127.0.0.1",
                "--studyhub.data-dir=" + temporary.resolve("spring"),
                "--studyhub.sidecar-entry=" + repo.resolve("packages/studyhub-desktop/entry/sidecar.mjs")));
        if (realModel) {
            String model = System.getProperty("studyhub.model-dir", "../studyhub-retrieval/target/model");
            args.add("--studyhub.retrieval.model-dir=" + Path.of(model).toRealPath());
        }
        try (var context = builder.run(args.toArray(String[]::new))) {
            int port = ((ServletWebServerApplicationContext) context).getWebServer().getPort();
            Path report = temporary.resolve("browser.log");
            Process check = new ProcessBuilder("node", "src/test/node/gateway-contract.mjs",
                    "http://127.0.0.1:" + port, temporary.toString(), Boolean.toString(realModel))
                    .redirectErrorStream(true).redirectOutput(report.toFile()).start();
            try {
                assertTrue(check.waitFor(3, TimeUnit.MINUTES), "Node/Chromium contract timed out");
                String result = Files.readString(report);
                System.out.print(result);
                assertEquals(0, check.exitValue(), result);
            } finally {
                if (check.isAlive()) {
                    check.descendants().forEach(ProcessHandle::destroyForcibly);
                    check.destroyForcibly().waitFor();
                }
            }
        }
    }
}
