package io.studyhub.contracts;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class GeneratedContractsTest {
    private static String className(String wireName) {
        return Arrays.stream(wireName.split("[^A-Za-z0-9]+"))
                .map(part -> Character.toUpperCase(part.charAt(0)) + part.substring(1))
                .collect(Collectors.joining());
    }

    @Test void compiledRecordComponentsMatchEveryClosedWireSchema() throws Exception {
        var reader = new ObjectMapper();
        try (var resource = InputRecords.class.getResourceAsStream("/META-INF/studyhub/runtime-contracts.json")) {
            assertNotNull(resource);
            int closed = 0;
            boolean foundAnswer = false;
            for (var domain : reader.readTree(resource)) {
                for (var operation : domain.path("operations")) {
                    if (operation.path("name").asText().equals("review.answer")) {
                        assertTrue(operation.path("writes").toString().contains("\"attempts\""));
                        foundAnswer = true;
                    }
                    var schema = operation.path("input");
                    if (!schema.has("properties") || schema.path("additionalProperties").asBoolean(true)) continue;
                    String type = className(domain.path("id").asText()) + className(operation.path("name").asText()) + "Input";
                    var record = Class.forName(InputRecords.class.getName() + "$" + type);
                    assertTrue(record.isRecord());
                    var names = new ArrayList<String>();
                    schema.path("properties").fieldNames().forEachRemaining(names::add);
                    assertEquals(names, Arrays.stream(record.getRecordComponents()).map(c -> c.getName()).toList());
                    closed++;
                }
            }
            assertTrue(foundAnswer);
            assertEquals(InputRecords.class.getDeclaredClasses().length, closed);
        }
    }

    @Test void nestedInputCollectionsAreSnapshots() {
        var item = new HashMap<String, Object>();
        item.put("key", "sample");
        var records = new ArrayList<>(List.of(item));
        var input = new InputRecords.SystemUsageFrequencyRecordInput(records);
        item.clear();
        records.clear();
        assertEquals(List.of(java.util.Map.of("key", "sample")), input.records());
        assertThrows(UnsupportedOperationException.class, () -> input.records().clear());
    }
}
