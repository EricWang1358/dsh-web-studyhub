package io.studyhub.sync;

import io.studyhub.domain.Fsrs6;
import io.studyhub.domain.sync.*;
import io.studyhub.storage.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.security.GeneralSecurityException;
import java.sql.SQLException;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;

class SyncIntegrationTest {
    @TempDir Path root;
    private static final String TOKEN = "0123456789abcdef".repeat(2);
    private final UUID vault = UUID.fromString("be000000-0000-0000-0000-000000000001");
    private final StudyOp.CardKey card = new StudyOp.CardKey("lib-a","course","identical-card-id");
    private final Clock origin = Clock.fixed(Instant.parse("2026-03-01T00:00:00Z"),ZoneOffset.UTC);

    @Test void partitionedClientsConvergeOverARealRelayAndResumeChunks() throws Exception {
        var key = Packets.key(new byte[32]);
        try (var context = (ServletWebServerApplicationContext) new SpringApplicationBuilder(SyncServerApplication.class)
                .run("--server.address=127.0.0.1","--server.port=0","--studyhub.sync.token="+TOKEN,
                    "--studyhub.sync.data-dir="+root.resolve("cloud"),"--spring.config.name=studyhub-relay");
             var adb = StudyDatabase.open(root.resolve("a.sqlite")); var bdb = StudyDatabase.open(root.resolve("b.sqlite"))) {
            var server = URI.create("http://127.0.0.1:" + context.getWebServer().getPort());
            var a = new SyncReplica(adb,vault,"win",key,origin);
            var b = new SyncReplica(bdb,vault,"linux",key,Clock.offset(origin,Duration.ofMinutes(5)));
            var left = new SyncPeer(a,server,TOKEN); var right = new SyncPeer(b,server,TOKEN);
            var notifications = new LinkedBlockingQueue<String>();
            var socket = right.subscribe(notifications::offer).get(10,TimeUnit.SECONDS);
            try {
                assertEquals("ready", notifications.poll(10,TimeUnit.SECONDS));
                var client = HttpClient.newHttpClient();
                var noAuth = HttpRequest.newBuilder(server.resolve("/sync/v1/vaults/"+vault+"/ops")).GET().build();
                assertEquals(401,client.send(noAuth,HttpResponse.BodyHandlers.discarding()).statusCode());
                var health = HttpRequest.newBuilder(server.resolve("/actuator/health")).GET().build();
                assertEquals(200,client.send(health,HttpResponse.BodyHandlers.discarding()).statusCode());
                var wrong = new SyncPeer(a,server,"wrong");
                assertThrows(ExecutionException.class, () -> wrong.subscribe(ignored -> {}).get(10,TimeUnit.SECONDS));
                for (int i = 0; i < 100; i++) {
                    var at = origin.instant().plus(Duration.ofHours(3L*i));
                    a.record(new UUID(1,i),card,StudyOp.Kind.ATTEMPT,
                        StudyOp.Answer.issued(at,ZoneId.of("Asia/Shanghai"),i%6,Fsrs6.Settings.defaults()),null,null);
                    b.record(new UUID(2,i),card,StudyOp.Kind.ATTEMPT,
                        StudyOp.Answer.issued(at.plusSeconds(300),ZoneId.of("America/New_York"),5-i%6,Fsrs6.Settings.defaults()),null,null);
                }
                var other = new StudyOp.CardKey("lib-b","course",card.card());
                a.record(new UUID(3,1),other,StudyOp.Kind.DELETE,null,null,null);
                a.record(new UUID(3,2),card,StudyOp.Kind.SET,null,"title","older title");
                b.record(new UUID(3,3),card,StudyOp.Kind.SET,null,"title","new title");
                left.sync(); assertNotNull(notifications.poll(10,TimeUnit.SECONDS));
                right.sync(); left.sync(); right.sync();
                var view = a.card(card);
                assertEquals(view,b.card(card));
                assertEquals(200,view.review().reps());
                assertEquals("new title",view.metadata().get("title"));
                assertFalse(view.deleted());
                assertTrue(b.card(other).deleted());
                assertTrue(a.pending().isEmpty());
                assertEquals(a.cursor(),b.cursor());
                assertEquals(203,context.getBean(PacketJournal.class).db.read(db -> {
                    try (var sql=db.createStatement(); var rows=sql.executeQuery("SELECT count(*) FROM sync_packets")) {
                        rows.next(); return rows.getInt(1);
                    }
                }).intValue());
                var clear = "原始课程材料".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                var spool = new BlobStore(root.resolve("staged"));
                var chunks = List.of(a.stageChunk(spool,clear),a.stageChunk(spool,clear));
                assertEquals(1,left.uploadMissing(spool,chunks.subList(0,1)));
                assertEquals(1,left.uploadMissing(spool,chunks));
                assertEquals(0,left.uploadMissing(spool,chunks));
                var data = new ByteArrayOutputStream();
                right.download(chunks,data);
                var expected = new ByteArrayOutputStream();
                expected.write(clear); expected.write(clear);
                assertArrayEquals(expected.toByteArray(),data.toByteArray());
                nodeStore("export");
                var from = new NodeBackup(a,left); var to = new NodeBackup(b,right);
                UUID backup = from.upload(root.resolve("export.json"));
                assertEquals(backup,from.upload(root.resolve("export.json")));
                to.download(backup,root.resolve("restored.json"));
                assertThrows(FileAlreadyExistsException.class, () -> to.download(backup,root.resolve("restored.json")));
                nodeStore("restore");
                verifyConcurrentCompensations(a,b,left,right);
            } finally { socket.abort(); }
        }
        try (var reopen = StudyDatabase.open(root.resolve("a.sqlite"))) {
            var restarted = new SyncReplica(reopen,vault,"win",key,origin);
            assertEquals(200,restarted.card(card).attempts().size());
        }
    }

    private void verifyConcurrentCompensations(SyncReplica a, SyncReplica b, SyncPeer left, SyncPeer right) throws Exception {
        var scope = new StudyOp.CardKey("library", "course", "correctable-card");
        var first = UUID.randomUUID(); var second = UUID.randomUUID();
        var reviewsA = new RecordReviewAttempt(a); var reviewsB = new RecordReviewAttempt(b);
        var at = origin.instant(); var later = at.plus(Duration.ofDays(3));
        var settings = new Fsrs6.Settings(.85, 12, true);
        var zone = ZoneId.of("Asia/Shanghai");
        reviewsA.record(first,scope,2,at,zone,settings);
        reviewsA.record(second,scope,4,later,zone,settings);
        left.sync(); right.sync();

        var local = reviewsA.correct(UUID.randomUUID(),scope,first,5);
        var remote = reviewsB.correct(UUID.randomUUID(),scope,first,0);
        var correctedFirst=Fsrs6.schedule(Fsrs6.Review.fresh(),5,at,zone,settings);
        assertEquals(Fsrs6.schedule(correctedFirst,4,later,zone,settings),a.card(scope).review());
        var undo = reviewsA.undo(UUID.randomUUID(),scope,second);
        reviewsB.correct(UUID.randomUUID(),scope,second,1);
        assertEquals(undo,reviewsA.undo(undo.id(),scope,second));
        assertThrows(ConcurrentModificationException.class, () -> reviewsA.correct(UUID.randomUUID(),scope,second,3));
        left.sync(); right.sync(); left.sync();
        var merged = a.card(scope);
        assertEquals(merged,b.card(scope));
        var winner = local.stamp().compareTo(remote.stamp()) > 0 ? local : remote;
        assertEquals(List.of(first),merged.attempts());
        assertEquals(2,merged.history().getFirst().originalGrade());
        assertEquals(winner.id(),merged.history().getFirst().correctionId());
        assertEquals(undo.id(),merged.history().getLast().undoId());
        assertEquals(1,merged.history().getLast().grade());
        assertEquals(Fsrs6.schedule(Fsrs6.Review.fresh(),winner.compensation().grade(),at,zone,settings),merged.review());
        var operations = new ArrayList<>(a.operations());
        Collections.reverse(operations);
        operations.addAll(List.of(local,remote,undo));
        assertEquals(merged,CardReplica.project(scope,operations));
        assertEquals(local,reviewsA.correct(local.id(),scope,first,5));
        assertThrows(ConcurrentModificationException.class, () -> reviewsA.correct(local.id(),scope,first,4));
    }

    @Test void separateSQLiteWritersResolveDifferentDefaultsOnceForTheSameReceipt() throws Exception {
        var path=root.resolve("race.sqlite");
        var key=Packets.key(new byte[32]);
        var id=UUID.randomUUID();
        try (var first=StudyDatabase.open(path); var second=StudyDatabase.open(path);
             var workers=Executors.newVirtualThreadPerTaskExecutor()) {
            var replica=new SyncReplica(first,vault,"shared",key,origin);
            var clock=Clock.offset(origin,Duration.ofDays(10));
            var zoneA=ZoneId.of("Asia/Shanghai"); var zoneB=ZoneId.of("Europe/Berlin");
            var settingsA=new Fsrs6.Settings(.82,8,true); var settingsB=new Fsrs6.Settings(.95,100,false);
            var a=new RecordReviewAttempt(replica,() -> zoneA,() -> settingsA);
            var b=new RecordReviewAttempt(new SyncReplica(second,vault,"shared",key,clock),() -> zoneB,() -> settingsB);
            var start=new CountDownLatch(1);
            var left=workers.submit(() -> { start.await(); return a.record(id,card,3,null,null,null); });
            var right=workers.submit(() -> { start.await(); return b.record(id,card,3,null,null,null); });
            start.countDown();
            var winner=left.get(15,TimeUnit.SECONDS);
            assertEquals(winner,right.get(15,TimeUnit.SECONDS));
            assertTrue(List.of(StudyOp.Answer.issued(origin.instant(),zoneA,3,settingsA),
                StudyOp.Answer.issued(clock.instant(),zoneB,3,settingsB)).contains(winner.answer()));
            assertEquals(List.of(winner),replica.operations());
            assertEquals(1,replica.pending().size());
        }
    }

    @Test void firstIssuedDefaultsSurviveARealCliInAnotherTimeZoneAndRepeatedConcurrentCommands() throws Exception {
        var path = root.resolve("attempts.sqlite");
        var id = UUID.randomUUID();
        var zone = ZoneId.of("Pacific/Auckland");
        var settings = new Fsrs6.Settings(.81,9,false);
        StudyOp original;
        byte[] sealed;
        try (var db = StudyDatabase.open(path)) {
            var replica = new SyncReplica(db,vault,"cli",Packets.key(new byte[32]),origin);
            var command = new RecordReviewAttempt(replica,() -> zone,() -> settings);
            try (var threads = Executors.newVirtualThreadPerTaskExecutor()) {
                var futures = new ArrayList<Future<StudyOp>>();
                for (int i=0; i<12; i++) futures.add(threads.submit(() -> command.record(id,card,3,null,null,null)));
                original = futures.getFirst().get(15,TimeUnit.SECONDS);
                for (var future : futures) assertEquals(original,future.get(15,TimeUnit.SECONDS));
            }
            assertEquals(StudyOp.Answer.issued(origin.instant(),zone,3,settings),original.answer());
            assertEquals(1,replica.pending().size());
            sealed = replica.pending().getFirst().data();
        }
        var result = cli(path,null,"attempt",card.library(),card.course(),card.card(),"3",id.toString());
        assertEquals(0,result.code(),result.output());
        try (var db = StudyDatabase.open(path)) {
            var replica = new SyncReplica(db,vault,"cli",Packets.key(new byte[32]),Clock.offset(origin,Duration.ofDays(7)));
            var commands = new RecordReviewAttempt(replica,() -> { throw new AssertionError("Unexpected default zone lookup"); },
                () -> { throw new AssertionError("Unexpected default settings lookup"); });
            assertEquals(original,commands.record(id,card,3,null,null,null));
            assertThrows(ConcurrentModificationException.class,() -> commands.record(id,card,3,null,ZoneOffset.UTC,null));
            assertThrows(ConcurrentModificationException.class,() -> commands.record(id,card,3,null,null,Fsrs6.Settings.defaults()));
            assertThrows(ConcurrentModificationException.class,() -> commands.record(id,card,3,Instant.EPOCH,null,null));
            assertThrows(ConcurrentModificationException.class,() -> commands.record(id,card,4,null,null,null));
            var otherCourse = new StudyOp.CardKey(card.library(),"elsewhere",card.card());
            var otherLibrary = new StudyOp.CardKey("elsewhere",card.course(),card.card());
            for (var other : List.of(otherCourse,otherLibrary)) {
                assertThrows(IllegalArgumentException.class,() -> commands.undo(UUID.randomUUID(),other,id));
                assertThrows(IllegalArgumentException.class,() -> commands.correct(UUID.randomUUID(),other,id,5));
            }
            assertEquals(1,replica.operations().size());
            assertArrayEquals(sealed,replica.pending().getFirst().data());
        }
        assertEquals(0,cli(path,null,"correct",card.library(),card.course(),card.card(),id.toString(),"1",UUID.randomUUID().toString()).code());
        assertEquals(0,cli(path,null,"undo",card.library(),card.course(),card.card(),id.toString(),UUID.randomUUID().toString()).code());
        try (var db = StudyDatabase.open(path)) {
            var replica = new SyncReplica(db,vault,"cli",Packets.key(new byte[32]),origin);
            assertEquals(Fsrs6.Review.fresh(),replica.card(card).review());
            assertEquals(3,replica.card(card).history().getFirst().originalGrade());
            assertEquals(1,replica.card(card).history().getFirst().grade());
        }
    }

    private record Exit(int code, String output) {}

    @Test void actualV1PacketAndOutOfOrderCompensationsPreserveScopesAndFenceOlderReaders() throws Exception {
        var key = Packets.key(new byte[32]);
        // Captured from the previous exec JAR (58bbe78e…), via its real sync-client attempt command.
        UUID target = UUID.fromString("6b36a189-f2b6-45dd-9d1d-b557188f66a1");
        var old = Base64.getMimeDecoder().decode(Files.readAllBytes(Path.of("src/test/resources/v1-review-packet.b64")));
        var correctionId = UUID.randomUUID();
        var correction = new StudyOp(2,correctionId,new HybridTime(100,1,"peer"),card,StudyOp.Kind.CORRECT,
            null,null,null,new StudyOp.Compensation(target,1));
        var futureId = UUID.randomUUID();
        var future = SyncReplica.JSON.valueToTree(correction).deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode)future).put("version",3).put("id",futureId.toString());
        var futurePacket = Packets.encrypt(key,vault,futureId,SyncReplica.JSON.writeValueAsBytes(future));
        var sealed = Packets.encrypt(key,vault,correctionId,SyncReplica.JSON.writeValueAsBytes(correction));
        var first = new PacketJournal.Packet(1,correctionId,sealed);
        var path = root.resolve("out-of-order.sqlite");
        try (var db=StudyDatabase.open(path);
             var existingReader=java.sql.DriverManager.getConnection("jdbc:sqlite:"+path.toUri());
             var sql=existingReader.createStatement()) {
            var r=new SyncReplica(db,vault,"cli",key,origin);
            try (var value=sql.executeQuery("SELECT count(*) FROM sync_packets")) { assertTrue(value.next()); }
            assertThrows(SQLException.class,() -> r.receive(0,List.of(first,new PacketJournal.Packet(2,futureId,futurePacket))));
            ((com.fasterxml.jackson.databind.node.ObjectNode)future).put("version",2.5);
            var fractional=Packets.encrypt(key,vault,futureId,SyncReplica.JSON.writeValueAsBytes(future));
            assertThrows(SQLException.class,() -> r.receive(0,List.of(new PacketJournal.Packet(1,futureId,fractional))));
            assertEquals(0,r.cursor());
            assertTrue(r.operations().isEmpty());
            assertEquals(PacketJournal.Layout.V1,db.read(PacketJournal::layout));
            r.receive(0,List.of(first));
            assertEquals(1,r.cursor());
            assertTrue(r.card(card).attempts().isEmpty());
            assertEquals(PacketJournal.Layout.V2,db.read(PacketJournal::layout));
            assertThrows(SQLException.class,() -> sql.executeQuery("SELECT seq,id,data FROM sync_packets"));
            assertThrows(SQLException.class,() -> sql.executeUpdate("UPDATE sync_clients SET cursor=20"));
            r.receive(1,List.of(new PacketJournal.Packet(2,target,old)));
            var answer=r.operations().stream().filter(o -> o.id().equals(target)).findFirst().orElseThrow().answer();
            assertEquals("Europe/Berlin",answer.zone());
            assertEquals(Instant.parse("2025-02-09T21:00:00Z"),answer.at());
            assertEquals(4,r.card(card).history().getFirst().originalGrade());
            assertEquals(1,r.card(card).history().getFirst().grade());
            var wrongScope=new StudyOp.CardKey(card.library(),"other-course",card.card());
            var remoteUndo=new StudyOp(2,UUID.randomUUID(),new HybridTime(200,1,"peer"),wrongScope,StudyOp.Kind.UNDO,
                null,null,null,new StudyOp.Compensation(target,null));
            r.receive(2,List.of(new PacketJournal.Packet(3,remoteUndo.id(),
                Packets.encrypt(key,vault,remoteUndo.id(),SyncReplica.JSON.writeValueAsBytes(remoteUndo)))));
            r.record(UUID.randomUUID(),null,StudyOp.Kind.DESKTOP_ATTEMPT,null,"library","{\"manifest\":1}");
            assertEquals(List.of(target),r.card(card).attempts());
            assertTrue(r.card(wrongScope).history().isEmpty());
            assertThrows(IllegalArgumentException.class,() -> new RecordReviewAttempt(r).undo(UUID.randomUUID(),card,remoteUndo.id()));
            assertThrows(IllegalArgumentException.class,() -> new RecordReviewAttempt(r).undo(UUID.randomUUID(),card,UUID.randomUUID()));
            sql.executeUpdate("UPDATE sync_version SET version=3");
            assertThrows(SQLException.class,() -> r.operations());
            assertThrows(SQLException.class,() -> r.acknowledge(target));
            assertThrows(SQLException.class,() -> new RecordReviewAttempt(r).record(UUID.randomUUID(),card,2,null,null,null));
            assertThrows(SQLException.class,() -> new SyncReplica(db,vault,"cli",key,origin));
            try (var rows=sql.executeQuery("SELECT version,(SELECT count(*) FROM sync_packets_v2) FROM sync_version")) {
                rows.next(); assertEquals(3,rows.getInt(1)); assertEquals(4,rows.getInt(2));
            }
        }
    }

    @Test
    @EnabledIfSystemProperty(named="studyhub.previous-sync-jar",matches=".+")
    void actualPreviousReleaseReadsNewV1PacketsAndRefusesTheUpgradedJournal() throws Exception {
        String oldJar = System.getProperty("studyhub.previous-sync-jar");
        var path = root.resolve("obsolete.sqlite");
        var id = UUID.randomUUID();
        try (var db=StudyDatabase.open(path)) {
            var replica=new SyncReplica(db,vault,"cli",Packets.key(new byte[32]),origin);
            var reviews=new RecordReviewAttempt(replica);
            reviews.record(id,card,4,null,null,null);
            var v1Read=cli(path,oldJar,"show",card.library(),card.course(),card.card());
            assertEquals(0,v1Read.code(),v1Read.output()); assertTrue(v1Read.output().contains(id.toString()));
            reviews.undo(UUID.randomUUID(),card,id);
            var refused=cli(path,oldJar,"attempt",card.library(),card.course(),card.card(),"4",UUID.randomUUID().toString());
            assertNotEquals(0,refused.code()); assertTrue(refused.output().contains("Unknown sync journal version"),refused.output());
            assertEquals(2,replica.operations().size());
            try (var cloud=(ServletWebServerApplicationContext)new SpringApplicationBuilder(SyncServerApplication.class)
                    .run("--server.address=127.0.0.1","--server.port=0","--studyhub.sync.token="+TOKEN,
                        "--studyhub.sync.data-dir="+root.resolve("old-reader-relay"),"--spring.config.name=studyhub-relay")) {
                var server=URI.create("http://127.0.0.1:"+cloud.getWebServer().getPort());
                new SyncPeer(replica,server,TOKEN).sync();
                var oldPath=root.resolve("old-peer.sqlite");
                var oldPull=cliWithRelay(oldPath,oldJar,server,"sync");
                assertNotEquals(0,oldPull.code()); assertTrue(oldPull.output().contains("Unreadable encrypted operation"),oldPull.output());
                try (var oldDb=StudyDatabase.open(oldPath)) {
                    var oldPeer=new SyncReplica(oldDb,vault,"cli",Packets.key(new byte[32]),origin);
                    assertEquals(0,oldPeer.cursor()); assertTrue(oldPeer.operations().isEmpty());
                    assertEquals(PacketJournal.Layout.V1,oldDb.read(PacketJournal::layout));
                    new SyncPeer(oldPeer,server,TOKEN).sync();
                    assertEquals(replica.card(card),oldPeer.card(card));
                    assertEquals(2,oldPeer.cursor());
                }
            }
        }
    }

    private Exit cli(Path db, String previousJar, String... args) throws Exception {
        return cliWithRelay(db,previousJar,null,args);
    }
    private Exit cliWithRelay(Path db, String previousJar, URI server, String... args) throws Exception {
        var command = new ArrayList<>(List.of(Path.of(System.getProperty("java.home"),"bin","java").toString(),
            "--enable-preview","-Duser.timezone=America/New_York"));
        if (previousJar == null) command.addAll(List.of("-cp",System.getProperty("surefire.test.class.path",
            System.getProperty("java.class.path")),SyncClientMain.class.getName()));
        else command.addAll(List.of("-jar",previousJar,"--studyhub.mode=sync-client"));
        command.addAll(List.of(args));
        var log = Files.createTempFile(root,"client-",".log");
        var builder = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(log.toFile());
        builder.environment().putAll(Map.of("STUDYHUB_SYNC_DB",db.toString(),"STUDYHUB_SYNC_VAULT",vault.toString(),
            "STUDYHUB_SYNC_DEVICE","cli","STUDYHUB_SYNC_KEY",Base64.getEncoder().encodeToString(new byte[32])));
        if (server != null) builder.environment().putAll(Map.of("STUDYHUB_SYNC_URL",server.toString(),"STUDYHUB_SYNC_TOKEN",TOKEN));
        var process = builder.start();
        try {
            assertTrue(process.waitFor(45,TimeUnit.SECONDS),"CLI timeout");
            return new Exit(process.exitValue(),Files.readString(log));
        } finally { process.destroyForcibly(); process.waitFor(); }
    }

    private void nodeStore(String mode) throws Exception {
        var proc = new ProcessBuilder("node",Path.of("src/test/resources/node-backup-peer.mjs").toRealPath().toString(),
            mode,root.toString()).inheritIO().start();
        try { assertTrue(proc.waitFor(45,TimeUnit.SECONDS)); assertEquals(0,proc.exitValue()); }
        finally { proc.destroyForcibly(); proc.waitFor(); }
    }

    @Test void tamperedFutureOrMisroutedPacketsRollBackTheWholePull() throws Exception {
        var key = Packets.key(new byte[32]);
        var id = UUID.randomUUID();
        try (var a = StudyDatabase.open(root.resolve("a.sqlite")); var b = StudyDatabase.open(root.resolve("b.sqlite"))) {
            var left = new SyncReplica(a,vault,"a",key,origin); var right = new SyncReplica(b,vault,"b",key,origin);
            left.record(id,card,StudyOp.Kind.SET,null,"topic","private string");
            var packet = left.pending().getFirst();
            assertThrows(GeneralSecurityException.class, () -> Packets.decrypt(key,UUID.randomUUID(),id,packet.data()));
            var tampered = packet.data().clone(); tampered[20] ^= 42;
            assertThrows(SQLException.class, () -> right.receive(0,List.of(packet,new PacketJournal.Packet(2,UUID.randomUUID(),tampered))));
            assertEquals(0,right.cursor()); assertTrue(right.operations().isEmpty());
            var future = packet.data().clone(); future[0] = 2;
            assertThrows(SQLException.class, () -> right.receive(0,List.of(new PacketJournal.Packet(1,id,future))));
            assertEquals(0,right.cursor());
            assertThrows(ConcurrentModificationException.class, () -> left.record(id,card,StudyOp.Kind.SET,null,"topic","conflict"));
            assertArrayEquals(packet.data(),left.pending().getFirst().data());
            byte[] wrongKey = new byte[32]; wrongKey[0] = 9;
            assertThrows(SQLException.class, () -> new SyncReplica(a,vault,"a",Packets.key(wrongKey),origin));
            assertEquals(1,left.pending().size());
        }
    }
}
