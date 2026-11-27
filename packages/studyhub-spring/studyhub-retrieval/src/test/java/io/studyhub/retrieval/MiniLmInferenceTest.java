package io.studyhub.retrieval;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

import static org.junit.jupiter.api.Assertions.*;

@EnabledIfSystemProperty(named = "studyhub.real-model", matches = "true")
class MiniLmInferenceTest {
    @Test void realQuantizedSentenceEncoderRanksChineseParaphraseAcrossLanguages() throws Exception {
        try (var encoder = MiniLmEncoder.open(Path.of(System.getProperty("studyhub.model-dir", "target/model")))) {
            var query = encoder.encode("How does a car engine work?");
            var chinese = encoder.encode("汽车发动机是如何工作的？");
            var distractor = encoder.encode("香蕉和苹果是两种水果。");
            assertEquals(384, query.length);
            assertEquals(1.0, dot(query, query), 1e-5);
            assertTrue(dot(query, chinese) > dot(query, distractor));
        }
    }

    private static double dot(float[] a, float[] b) {
        double value = 0;
        for (int i = 0; i < a.length; i++) value += (double)a[i] * b[i];
        return value;
    }
}
