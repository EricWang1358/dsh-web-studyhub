package io.studyhub.ai;

/** Resolve the provider's configured credential name at dispatch. Return null if it is absent. */
@FunctionalInterface
public interface ProviderSecrets {
    String resolve(String name);
}
