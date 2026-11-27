package io.studyhub.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.MeterRegistry;
import java.nio.file.Path;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = "studyhub.ai.enabled", havingValue = "true")
@EnableConfigurationProperties(WorkflowSettings.class)
class WorkflowConfiguration {
    @Bean(destroyMethod = "close")
    WorkflowService workflowService(WorkflowSettings settings, ObjectMapper json, MeterRegistry metrics,
            org.springframework.beans.factory.ObjectProvider<ProviderSecrets> secrets,
            @Qualifier("studyhubDataDirectory") Path data) throws Exception {
        return new WorkflowService(data.resolve("workflows"), settings, json, metrics,
                secrets.getIfAvailable(() -> System::getenv));
    }
}
