package io.studyhub.sync;

import io.studyhub.storage.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.*;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import java.nio.file.Path;
import java.util.Map;

@SpringBootApplication
public class SyncServerApplication {
    public static void main(String[] args) {
        var app = new SpringApplication(SyncServerApplication.class);
        app.setDefaultProperties(Map.of("spring.config.name","studyhub-relay","spring.threads.virtual.enabled","true",
            "server.address","127.0.0.1","server.port","8080",
            "spring.web.resources.add-mappings","false","management.endpoints.web.exposure.include","health"));
        app.run(args);
    }
    @Bean(destroyMethod="close")
    StudyDatabase relayDatabase(@Value("${studyhub.sync.data-dir:${STUDYHUB_SYNC_DATA_DIR:./studyhub-sync-data}}") Path directory) throws Exception {
        return StudyDatabase.open(directory.resolve("relay.sqlite"));
    }
    @Bean PacketJournal packetJournal(StudyDatabase db) throws Exception { return new PacketJournal(db); }
}
