package io.studyhub.gateway;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.StreamReadConstraints;
import io.studyhub.contracts.TransportLimits;
import java.io.*;
import java.nio.file.Files;
import java.nio.file.Path;

/** A bounded replayable request. Normal calls stay in memory. Larger uploads are streamed to a temporary file
 * so checking the effective top-level action (including duplicate JSON keys) never buffers an upload in heap. */
final class RpcBody implements AutoCloseable {
    private static final int MEMORY_LIMIT = 64 * 1024;
    private static final JsonFactory SCANNER = JsonFactory.builder().streamReadConstraints(StreamReadConstraints.builder()
            .maxStringLength(TransportLimits.MAX_RESTORE_REQUEST_BYTES).maxNestingDepth(10000).build()).build();
    private final ByteArrayOutputStream memory = new ByteArrayOutputStream();
    private Path file;
    private int size;

    void read(InputStream source) throws IOException {
        byte[] chunk = new byte[8192];
        OutputStream sink = memory;
        try {
            for (int count; (count = source.read(chunk)) != -1;) {
                size += count;
                if (size > TransportLimits.MAX_RESTORE_REQUEST_BYTES) return;
                if (file == null && size > MEMORY_LIMIT) {
                    file = Files.createTempFile("studyhub-rpc-", ".tmp");
                    sink = Files.newOutputStream(file);
                    memory.writeTo(sink);
                    memory.reset();
                }
                sink.write(chunk, 0, count);
            }
        } finally { sink.close(); }
    }
    int size() { return size; }
    InputStream open() throws IOException {
        return file == null ? new ByteArrayInputStream(memory.toByteArray()) : Files.newInputStream(file);
    }
    record Routing(String action, String id, String deckId) {}
    Routing routing() throws IOException {
        try (var input = open(); var parser = SCANNER.createParser(new InputStreamReader(input, java.nio.charset.StandardCharsets.UTF_8))) {
            String action = "", id = "", deckId = "";
            if (parser.nextToken() != JsonToken.START_OBJECT) return new Routing("", "", "");
            while (parser.nextToken() == JsonToken.FIELD_NAME) {
                String name = parser.currentName();
                JsonToken token = parser.nextToken();
                if (name.equals("action")) action = token == JsonToken.VALUE_STRING ? parser.getText() : "";
                if (name.equals("args")) {
                    id = "";
                    deckId = "";
                    if (token == JsonToken.START_OBJECT) {
                        while (parser.nextToken() == JsonToken.FIELD_NAME) {
                            String key = parser.currentName();
                            var value = parser.nextToken();
                            if (key.equals("id")) id = value == JsonToken.VALUE_STRING ? parser.getText() : "";
                            if (key.equals("deck")) deckId = value == JsonToken.START_OBJECT ? objectId(parser) : "";
                            parser.skipChildren();
                        }
                    }
                }
                parser.skipChildren();
            }
            if (parser.nextToken() != null) throw new IOException("Trailing JSON content");
            return new Routing(action, id, deckId);
        }
    }

    private static String objectId(com.fasterxml.jackson.core.JsonParser parser) throws IOException {
        String id = "";
        while (parser.nextToken() == JsonToken.FIELD_NAME) {
            String key = parser.currentName();
            var token = parser.nextToken();
            if (key.equals("id")) id = token == JsonToken.VALUE_STRING ? parser.getText() : "";
            parser.skipChildren();
        }
        return id;
    }
    @Override public void close() throws IOException { if (file != null) Files.deleteIfExists(file); }
}
