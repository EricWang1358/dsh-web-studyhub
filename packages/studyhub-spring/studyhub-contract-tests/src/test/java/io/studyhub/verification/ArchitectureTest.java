package io.studyhub.verification;

import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.lang.ArchRule;
import io.studyhub.verification.fixtures.linux.LinuxOnly;
import io.studyhub.verification.fixtures.spi.ImpureSpi;
import io.studyhub.verification.fixtures.windows.WindowsOnly;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationContext;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static org.junit.jupiter.api.Assertions.*;

class ArchitectureTest {
    // Import by Maven module, so moving a domain class to another Java package cannot bypass the rule.
    private static final ArchRule PURE_DOMAIN = noClasses().should().dependOnClassesThat()
            .resideInAnyPackage("org.springframework..", "java.sql..", "javax.sql..", "org.sqlite..",
                    "org.jooq..", "org.flywaydb..", "jakarta.persistence..", "..storage..");

    private static ArchRule noPlatformDependency(String from, String... prohibited) {
        return noClasses().that().resideInAPackage(from).should().dependOnClassesThat()
                .resideInAnyPackage(prohibited);
    }

    private static final ArchRule WINDOWS = noPlatformDependency("..windows..", "..linux..");
    private static final ArchRule LINUX = noPlatformDependency("..linux..", "..windows..");
    private static final ArchRule SPI = noPlatformDependency("..spi..", "..windows..", "..linux..");

    @Test void domainHasNoFrameworkOrStorageDependencies() throws IOException {
        checkModule("studyhub-domain", PURE_DOMAIN);
    }

    @Test void platformAdaptersCommunicateThroughNeutralInterfaces() throws IOException {
        checkModule("studyhub-platform-shell", WINDOWS, LINUX, SPI);
    }

    private static ArchRule noHttpController(String origin) {
        return noClasses().that().haveSimpleName(origin).should().dependOnClassesThat()
                .areAnnotatedWith(org.springframework.web.bind.annotation.RestController.class);
    }

    @Test void publishingAndRecordingReviewsCannotCallAnHttpController() throws IOException {
        checkModule("studyhub-sync-api", noHttpController("ReviewedDraftPublisher"), noHttpController("RecordReviewAttempt"),
                noHttpController("SyncReplica"), noHttpController("DesktopReviewHistory"));
    }

    private void checkModule(String moduleName, ArchRule... rules) throws IOException {
        Path module = Path.of("..", moduleName);
        assertTrue(Files.isRegularFile(module.resolve("pom.xml")), "Missing module " + module);
        var imported = new ClassFileImporter().importPath(module.resolve("target/classes"));
        assertFalse(imported.isEmpty(), "No production classes inspected for " + module);
        for (var rule : rules) rule.check(imported);
    }

    private record ImpureDomain(Connection connection, DataSource source, ApplicationContext spring) { }
    @org.springframework.web.bind.annotation.RestController private static class TestController { }
    private record CoupledUseCase(TestController controller) { }

    @Test void guardsRejectKnownForbiddenEdges() {
        var classes = new ClassFileImporter().importClasses(ImpureDomain.class, LinuxOnly.class, WindowsOnly.class, ImpureSpi.class);
        String domainFailures = PURE_DOMAIN.evaluate(classes).getFailureReport().toString();
        for (var dependency : new String[]{"java.sql.Connection", "javax.sql.DataSource", "org.springframework.context.ApplicationContext"}) {
            assertTrue(domainFailures.contains(dependency), domainFailures);
        }
        assertTrue(WINDOWS.evaluate(classes).hasViolation());
        assertTrue(LINUX.evaluate(classes).hasViolation());
        assertTrue(SPI.evaluate(classes).hasViolation());
        var transport = new ClassFileImporter().importClasses(CoupledUseCase.class, TestController.class);
        assertTrue(noHttpController("CoupledUseCase").evaluate(transport).hasViolation());
    }
}
