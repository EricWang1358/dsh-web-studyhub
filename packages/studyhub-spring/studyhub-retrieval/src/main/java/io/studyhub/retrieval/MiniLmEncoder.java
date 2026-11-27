package io.studyhub.retrieval;

import ai.djl.huggingface.tokenizers.HuggingFaceTokenizer;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.Properties;

public final class MiniLmEncoder implements SentenceEncoder, AutoCloseable {
    private final HuggingFaceTokenizer tokenizer;
    private final OrtSession session;
    private final String identity;

    private MiniLmEncoder(HuggingFaceTokenizer tokenizer, OrtSession session, String identity) {
        this.tokenizer = tokenizer;
        this.session = session;
        this.identity = identity;
    }

    public static MiniLmEncoder open(Path directory) throws IOException {
        return open(directory, 2);
    }

    public static MiniLmEncoder open(Path directory, int threads) throws IOException {
        if (threads < 1) throw new IllegalArgumentException("Inference thread count must be positive");
        Properties manifest = new Properties();
        try (var input = MiniLmEncoder.class.getResourceAsStream("model.properties")) {
            manifest.load(input);
        }
        Path weights = verifiedFile(directory, manifest, "model");
        Path vocabulary = verifiedFile(directory, manifest, "tokenizer");
        var tokenizer = HuggingFaceTokenizer.builder().optTokenizerPath(vocabulary)
                .optMaxLength(128).optTruncation(true).optPadding(false).build();
        try (var options = new OrtSession.SessionOptions()) {
            options.setIntraOpNumThreads(threads);
            var session = OrtEnvironment.getEnvironment().createSession(weights.toString(), options);
            String id = manifest.getProperty("model.sha256") + "/" + manifest.getProperty("tokenizer.sha256") + "/mean-l2-128";
            return new MiniLmEncoder(tokenizer, session, id);
        } catch (OrtException | RuntimeException | Error failure) {
            tokenizer.close();
            throw new IOException("Cannot initialize MiniLM inference", failure);
        }
    }

    private static Path verifiedFile(Path root, Properties properties, String feature) throws IOException {
        Path file = root.resolve(properties.getProperty(feature + ".file"));
        if (Files.size(file) != Long.parseLong(properties.getProperty(feature + ".bytes"))) {
            throw new IOException("Unexpected file size for " + file);
        }
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
        try (InputStream in = new DigestInputStream(Files.newInputStream(file), digest)) {
            in.transferTo(OutputStream.nullOutputStream());
        }
        if (!HexFormat.of().formatHex(digest.digest()).equals(properties.getProperty(feature + ".sha256"))) {
            throw new IOException("SHA-256 mismatch for " + file);
        }
        return file;
    }

    @Override public int dimensions() { return 384; }
    @Override public String identity() { return identity; }

    @Override public float[] encode(String text) throws IOException {
        var encoded = tokenizer.encode(text);
        long[] mask = encoded.getAttentionMask();
        var env = OrtEnvironment.getEnvironment();
        try (var ids = OnnxTensor.createTensor(env, new long[][]{encoded.getIds()});
             var attention = OnnxTensor.createTensor(env, new long[][]{mask});
             var types = OnnxTensor.createTensor(env, new long[][]{encoded.getTypeIds()});
             var output = session.run(Map.of("input_ids", ids, "attention_mask", attention, "token_type_ids", types))) {
            float[][] tokens = ((float[][][]) output.get("last_hidden_state").orElseThrow().getValue())[0];
            float[] summed = new float[dimensions()];
            for (int t = 0; t < tokens.length; t++) {
                if (mask[t] == 0) continue;
                for (int d = 0; d < summed.length; d++) summed[d] += tokens[t][d];
            }
            // Dividing by the number of tokens before L2 normalization gives the same unit vector.
            double squareSum = 0;
            for (float value : summed) squareSum += (double) value * value;
            if (!Double.isFinite(squareSum) || squareSum == 0) throw new IOException("Invalid MiniLM vector");
            double length = Math.sqrt(squareSum);
            for (int d = 0; d < summed.length; d++) summed[d] /= length;
            return summed;
        } catch (OrtException failure) {
            throw new IOException("MiniLM inference failed", failure);
        }
    }

    @Override public void close() throws IOException {
        try { session.close(); }
        catch (OrtException failure) { throw new IOException("Cannot close MiniLM session", failure); }
        finally { tokenizer.close(); }
    }
}
