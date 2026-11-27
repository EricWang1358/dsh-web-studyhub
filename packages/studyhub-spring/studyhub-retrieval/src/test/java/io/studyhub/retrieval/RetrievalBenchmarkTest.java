package io.studyhub.retrieval;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.regex.Pattern;
import jdk.jfr.Recording;
import jdk.jfr.consumer.RecordingFile;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;

import static org.junit.jupiter.api.Assertions.assertTrue;

@EnabledIfSystemProperty(named = "studyhub.benchmark", matches = "true")
class RetrievalBenchmarkTest {
    private record Passage(String id, String text) { }
    private record Probe(String id, String query) { }

    // Hand-labeled known-item searches. Each expected id identifies a taxonomy entry.
    private static final List<Probe> PROBES = List.of(
            new Probe("C15", "Windows 与 Linux 的文件路径、临时文件名和脚本假设为什么不同？"),
            new Probe("C31", "How do we verify observable equivalence after a backend rewrite?"),
            new Probe("C33", "任务显示已取消，为什么在后台还持续占用资源？"),
            new Probe("C35", "A crash followed by a retry billed the same completed step twice"),
            new Probe("C48", "外部模型下载会一直挂起，或者后来下载到不同版本"),
            new Probe("C38", "Can an old release safely read a file saved by a new release?"),
            new Probe("C23", "界面如何用键盘和屏幕阅读器操作？"),
            new Probe("C28", "Independent tasks are waiting for each other instead of running concurrently"),
            new Probe("C44", "所有用户打开首页都载入了很少用的功能"),
            new Probe("C26", "Unused code remained after an old feature was retired"),
            new Probe("C58", "两个课程的记录使用相同编号，读取到了另一个课程的数据"),
            new Probe("C36", "A test becomes flaky when the machine is busy or midnight passes"));

    @Test void measureHybridSearch(@TempDir Path temporary) throws Exception {
        Path repo = Path.of("../../..").toRealPath();
        int maximum = Integer.getInteger("studyhub.benchmark.pages", 1000);
        List<Passage> corpus = new ArrayList<>();
        var pattern = Pattern.compile("(?ms)^## (C\\d+) ([^\\n]+)\\n(.*?)(?=^## |\\z)");
        var classes = pattern.matcher(Files.readString(repo.resolve("docs/agent-lessons/taxonomy.md")));
        while (classes.find()) {
            if (!classes.group(2).contains("(merged")) {
                corpus.add(new Passage(classes.group(1), classes.group(2) + "\n" + classes.group(3).strip()));
            }
        }
        int categories = corpus.size();
        Set<String> seen = new HashSet<>();
        var roots = List.of("docs", "references", "skills", "changes");
        outer: for (String root : roots) {
            try (var files = Files.walk(repo.resolve(root))) {
                for (Path file : files.filter(f -> f.toString().endsWith(".md")).sorted().toList()) {
                    if (file.endsWith("taxonomy.md")) continue;
                    int ordinal = 0;
                    for (String line : Files.readAllLines(file)) {
                        ordinal++;
                        String passage = line.strip();
                        if (passage.length() < 48) continue;
                        passage = passage.substring(0, Math.min(500, passage.length()));
                        if (!seen.add(passage)) continue;
                        corpus.add(new Passage(repo.relativize(file).toString().replace('\\', '/') + "#" + ordinal, passage));
                        if (corpus.size() >= maximum) break outer;
                    }
                }
            }
        }
        assertTrue(corpus.size() >= maximum, () -> "Only " + corpus.size() + " real corpus entries");
        var scope = new HybridIndex.Scope("benchmark", "engineering");
        try (var encoder = MiniLmEncoder.open(Path.of(System.getProperty("studyhub.model-dir", "target/model")));
             var index = new HybridIndex(temporary.resolve("benchmark.sqlite"), encoder)) {
            System.out.println("passages bm25_recall bm25_mrr rrf_recall rrf_mrr rrf_p95_ms process_rss_MiB index_seconds first_query_ms");
            long indexingNanos = 0;
            int count = 0;
            for (Passage item : corpus) {
                long started = System.nanoTime();
                index.put(scope, item.id(), item.text());
                indexingNanos += System.nanoTime() - started;
                count++;
                if (count == categories || count == 1000 || count == maximum) {
                    double elapsed = indexingNanos / 1e9;
                    long build = System.nanoTime();
                    index.search(scope, PROBES.getFirst().query(), 10);
                    double firstMs = (System.nanoTime() - build) / 1e6;
                    int found = 0;
                    double reciprocal = 0;
                    int lexicalFound = 0;
                    double lexicalReciprocal = 0;
                    List<Long> timings = new ArrayList<>();
                    for (int repeat = 0; repeat < 3; repeat++) {
                        for (Probe probe : PROBES) {
                            if (repeat == 0) {
                                int rank = index.lexicalIds(scope, probe.query(), 10).indexOf(probe.id()) + 1;
                                if (rank > 0) {
                                    lexicalFound++;
                                    lexicalReciprocal += 1.0 / rank;
                                }
                            }
                            long before = System.nanoTime();
                            var hits = index.search(scope, probe.query(), 10);
                            timings.add(System.nanoTime() - before);
                            for (int i = 0; i < hits.size() && repeat == 0; i++) {
                                if (probe.id().equals(hits.get(i).sourceId())) {
                                    found++;
                                    reciprocal += 1.0 / (i + 1);
                                    break;
                                }
                            }
                        }
                    }
                    timings.sort(Long::compareTo);
                    double p95 = timings.get((int)Math.ceil(0.95 * timings.size()) - 1) / 1e6;
                    long resident = residentBytes(temporary.resolve("sample.jfr"));
                    System.out.printf(Locale.ROOT, "%d %.4f %.4f %.4f %.4f %.2f %.1f %.2f %.2f%n", count,
                            (double)lexicalFound / PROBES.size(), lexicalReciprocal / PROBES.size(),
                            (double)found / PROBES.size(), reciprocal / PROBES.size(),
                            p95, resident / 1048576.0, elapsed, firstMs);
                }
            }
        }
    }

    private static long residentBytes(Path sample) throws Exception {
        try (var recording = new Recording()) {
            recording.enable("jdk.ResidentSetSize").with("period", "endChunk");
            recording.start();
            recording.stop();
            recording.dump(sample);
        }
        return RecordingFile.readAllEvents(sample).stream()
                .filter(event -> event.getEventType().getName().equals("jdk.ResidentSetSize"))
                .findFirst().orElseThrow().getLong("size");
    }
}
