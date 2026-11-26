import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MAX_REQUEST_BYTES } from '../../../lib/documents.js';
import { createStudyRuntime } from '../../../lib/runtime/builtins.js';
import { actionGrants, fields, reads, writesFor } from '../../../lib/runtime/domain-contracts.js';
import { MAX_RESTORE_REQUEST_BYTES } from '../../../packages/studyhub-desktop/adapters/http/local-server.mjs';

const target = resolve(process.argv[2]);
const source = join(target, 'generated-sources/contracts/io/studyhub/contracts');
const resources = join(target, 'classes/META-INF/studyhub');
await Promise.all([source, resources].map(path => mkdir(path, { recursive: true })));

const prefix = '// Generated from the StudyHub Node runtime contracts.\npackage io.studyhub.contracts;\n\n';
const scratch = await mkdtemp(join(tmpdir(), 'studyhub-contracts-'));
let runtime;
try {
  runtime = createStudyRuntime(scratch);
  const domains = runtime.describe().map(domain => ({
    ...domain,
    fields: fields[domain.id],
    reads: reads[domain.id],
    grants: actionGrants[domain.id] ?? {},
    operations: domain.operations.map(op => ({ ...op, writes: writesFor(domain.id, op.name) })),
  }));
  await writeFile(join(resources, 'runtime-contracts.json'), JSON.stringify(domains));
  await writeRecords(domains);
} finally {
  try { await runtime?.dispose(); }
  finally { await rm(scratch, { recursive: true, force: true }); }
}

await writeFile(join(source, 'TransportLimits.java'), prefix + `public final class TransportLimits {
    private TransportLimits() {}
    public static final int MAX_REQUEST_BYTES = ${MAX_REQUEST_BYTES};
    public static final int MAX_RESTORE_REQUEST_BYTES = ${MAX_RESTORE_REQUEST_BYTES};
}
`);

function className(wireName) {
  return wireName.split(/[^A-Za-z0-9]+/).map(s => s[0].toUpperCase() + s.slice(1)).join('');
}

function javaType(schema) {
  // oneOf can mix wire types. The raw JSON value preserves each variant.
  return ({ boolean: 'Boolean', integer: 'java.math.BigInteger', number: 'java.math.BigDecimal',
    string: 'String', array: 'List<?>', object: 'Map<String, ?>' })[schema.type] ?? 'Object';
}

async function writeRecords(domains) {
  const records = [];
  for (const domain of domains) {
    for (const { name, input } of domain.operations) {
      // A closed record would lose extra fields accepted by an open schema.
      // Consumers read those operation schemas directly from runtime-contracts.json.
      if (input.additionalProperties !== false || !input.properties) continue;
      const members = Object.entries(input.properties);
      const record = className(domain.id) + className(name) + 'Input';
      const args = members.map(([key, schema]) => javaType(schema) + ' ' + key);
      const copies = members.flatMap(([key, schema]) => {
        switch (javaType(schema)) {
          case 'List<?>': return [`            if (${key} != null) ${key} = freezeList(${key});`];
          case 'Map<String, ?>': return [`            if (${key} != null) ${key} = freezeMap(${key});`];
          case 'Object': return [`            ${key} = freeze(${key});`];
          default: return [];
        }
      });
      records.push('    /** ' + domain.api + ' / ' + name + ' */\n    public record ' + record +
        '(' + args.join(', ') + ') {' + (copies.length ? '\n        public ' + record +
          ' {\n' + copies.join('\n') + '\n        }\n    ' : '') + '}');
    }
  }
  await writeFile(join(source, 'InputRecords.java'), prefix + `import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Closed RPC input schemas. Null members represent optional or null input. */
public final class InputRecords {
    private InputRecords() {}

    private static Object freeze(Object value) {
        if (value instanceof List<?> list) return freezeList(list);
        if (value instanceof Map<?, ?> map) return freezeMap(map);
        return value;
    }

    private static List<?> freezeList(List<?> values) {
        return values.stream().map(InputRecords::freeze).toList();
    }

    private static Map<String, ?> freezeMap(Map<?, ?> values) {
        var copy = new LinkedHashMap<String, Object>();
        values.forEach((key, value) -> copy.put((String) key, freeze(value)));
        return Collections.unmodifiableMap(copy);
    }

${records.join('\n\n')}
}
`);
}
