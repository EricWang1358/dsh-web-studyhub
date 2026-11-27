package io.studyhub.ai;

import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

@ConfigurationProperties("studyhub.ai")
public record WorkflowSettings(Map<String, Workflow.Provider> providers,
                               @DefaultValue("4") int concurrency,
                               @DefaultValue("30") int rpm,
                               @DefaultValue("120000") long tpm,
                               @DefaultValue("120000") long tokenBudget,
                               @DefaultValue("512") int outputTokens,
                               @DefaultValue("16") int maxTopics,
                               @DefaultValue("65536") int maxSourceBytes,
                               @DefaultValue("90") int timeoutSeconds) {
    public WorkflowSettings {
        if (providers == null || providers.isEmpty()) {
            providers = Map.of(
                "openai", new Workflow.Provider("gpt", "gpt-4o-mini", "https://api.openai.com", "OPENAI_API_KEY", true),
                "deepseek", new Workflow.Provider("deepseek", "deepseek-chat", "https://api.deepseek.com", "DEEPSEEK_API_KEY", false),
                "ollama", new Workflow.Provider("qwen", "qwen2.5:7b", "http://127.0.0.1:11434", "", true));
        }
        providers = Map.copyOf(providers);
        if (concurrency < 1 || rpm < 1 || tpm < 1 || tokenBudget < 1 || outputTokens < 1 || maxTopics < 1
                || maxSourceBytes < 1 || timeoutSeconds < 1) throw new IllegalArgumentException("Invalid workflow limits");
    }
    Workflow.Provider provider(String id) {
        var result = providers.get(id);
        if (result == null) throw new IllegalArgumentException("Unknown provider: " + id);
        return result;
    }
}
