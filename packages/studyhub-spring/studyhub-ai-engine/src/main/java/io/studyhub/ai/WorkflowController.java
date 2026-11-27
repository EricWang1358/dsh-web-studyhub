package io.studyhub.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import static io.studyhub.ai.Workflow.*;

@RestController
@RequestMapping("/api/ai/jobs")
@ConditionalOnProperty(name = "studyhub.ai.enabled", havingValue = "true")
final class WorkflowController {
    private final WorkflowService service;
    private final ObjectMapper json;
    WorkflowController(WorkflowService service, ObjectMapper json) { this.service = service; this.json = json; }

    @PostMapping ResponseEntity<View> start(@RequestBody Request request) {
        if (request.publication() || request.id().startsWith("reviewed-"))
            throw new IllegalArgumentException("Start a source-linked publication through /api/ai/reviewed-drafts");
        return ResponseEntity.accepted().body(service.start(request));
    }
    @GetMapping List<View> list() { return service.list(); }
    @GetMapping("/{id}") View status(@PathVariable String id) { return service.status(id); }
    @PostMapping("/{id}/cancel") View cancel(@PathVariable String id) { return service.cancel(id); }
    @PostMapping("/{id}/resume") View resume(@PathVariable String id) { return service.resume(id); }

    record Receipt(String receipt, String result, long tokens) {}
    @PostMapping("/{id}/reconcile") View reconcile(@PathVariable String id, @RequestBody Receipt receipt) {
        return service.reconcile(id, receipt.receipt(), receipt.result(), receipt.tokens());
    }

    @GetMapping(value = "/{id}/events", produces = "text/event-stream")
    void events(@PathVariable String id, HttpServletResponse response) throws IOException, InterruptedException {
        View view = service.status(id);
        response.setContentType("text/event-stream;charset=UTF-8");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Accel-Buffering", "no");
        var out = response.getOutputStream();
        long previous = -1;
        while (true) {
            if (view.revision() != previous) {
                String event = "id: " + view.revision() + "\nevent: progress\ndata: " + json.writeValueAsString(view) + "\n\n";
                out.write(event.getBytes(StandardCharsets.UTF_8));
                previous = view.revision();
            } else {
                out.write(": keepalive\n\n".getBytes(StandardCharsets.UTF_8));
            }
            out.flush();
            if (view.status() != Status.QUEUED && view.status() != Status.RUNNING && view.status() != Status.CANCELLING) return;
            view = service.await(id, previous, 15000);
        }
    }
    @ExceptionHandler(NoSuchElementException.class)
    ResponseEntity<Map<String,String>> missing(NoSuchElementException failure) {
        return ResponseEntity.status(404).body(Map.of("error", failure.getMessage()));
    }
    @ExceptionHandler({IllegalArgumentException.class, ProviderRouter.Failure.class})
    ResponseEntity<Map<String,String>> bad(RuntimeException failure) {
        return ResponseEntity.badRequest().body(Map.of("error", failure.getMessage()));
    }
    @ExceptionHandler(IllegalStateException.class)
    ResponseEntity<Map<String,String>> conflict(IllegalStateException failure) {
        return ResponseEntity.status(409).body(Map.of("error", failure.getMessage()));
    }
}
