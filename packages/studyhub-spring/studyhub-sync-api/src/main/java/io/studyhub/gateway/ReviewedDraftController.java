package io.studyhub.gateway;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/ai/reviewed-drafts")
final class ReviewedDraftController {
    private final ReviewedDraftPublisher publisher;
    ReviewedDraftController(ReviewedDraftPublisher publisher) { this.publisher = publisher; }

    @PostMapping ResponseEntity<Map<String,String>> start(@RequestBody ReviewedDraftJournal.Command command) throws Exception {
        return ResponseEntity.accepted().body(publisher.start(command));
    }

    @PostMapping("/{id}/prepare") JsonNode prepare(@PathVariable String id) throws Exception {
        return publisher.prepare(id);
    }

    @PostMapping("/{id}/publish") JsonNode publish(@PathVariable String id) throws Exception {
        return publisher.publish(id, "draft.publish", JsonNodeFactory.instance.objectNode());
    }

    @ExceptionHandler(IllegalStateException.class) ResponseEntity<?> conflict(IllegalStateException error) {
        return ResponseEntity.status(409).body(Map.of("error", error.getMessage()));
    }
    @ExceptionHandler(IllegalArgumentException.class) ResponseEntity<?> invalid(IllegalArgumentException error) {
        return ResponseEntity.badRequest().body(Map.of("error", error.getMessage()));
    }
}
