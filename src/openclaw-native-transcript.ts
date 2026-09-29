import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
function openDatabase(databasePath: string) {
  // Load the experimental API only for the opt-in native runner.
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(databasePath, { readOnly: true });
}
import { zstdDecompressSync } from "node:zlib";
import { isRecord } from "./value-coerce.js";

const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_EVENTS = 512;

/** Decode the retained, runtime-owned checkout receipt; never ignore unreadable events. */
export function readNativeOpenclawTranscript(databasePath: string, sessionId: string): string {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) throw new Error("Invalid native session id.");
  const db = openDatabase(databasePath);
  try {
    db.exec("BEGIN");
    const bounds = db
      .prepare(`SELECT count(*) AS count,
      max(length(CAST(event_json AS BLOB))) AS text_bytes,
      max(length(event_zstd)) AS compressed_bytes,
      max(event_utf8_bytes) AS decoded_bytes
      FROM transcript_events WHERE session_id = ?`)
      .get(sessionId);
    if (
      !bounds ||
      typeof bounds.count !== "number" ||
      bounds.count < 1 ||
      bounds.count > MAX_EVENTS
    ) {
      throw new Error("Native checkout transcript is missing or exceeds its event limit.");
    }
    for (const key of ["text_bytes", "compressed_bytes", "decoded_bytes"]) {
      const size = bounds[key];
      if (size !== null && (typeof size !== "number" || size < 0 || size > MAX_EVENT_BYTES)) {
        throw new Error("Native checkout transcript event exceeds its size limit.");
      }
    }
    const lines: string[] = [];
    let totalBytes = 0;
    let previousSeq: number | undefined;
    for (const row of db
      .prepare(`SELECT seq, event_json, event_zstd, event_utf8_bytes
      FROM transcript_events WHERE session_id = ? ORDER BY seq LIMIT ?`)
      .iterate(sessionId, MAX_EVENTS + 1)) {
      if (
        typeof row.seq !== "number" ||
        !Number.isSafeInteger(row.seq) ||
        (previousSeq === undefined ? row.seq !== 0 && row.seq !== 1 : row.seq !== previousSeq + 1)
      ) {
        throw new Error("Native checkout transcript sequence is incomplete.");
      }
      previousSeq = row.seq;
      let bytes: Buffer;
      if (typeof row.event_json === "string" && row.event_zstd === null) {
        bytes = Buffer.from(row.event_json);
      } else if (
        row.event_json === null &&
        row.event_zstd instanceof Uint8Array &&
        typeof row.event_utf8_bytes === "number" &&
        Number.isSafeInteger(row.event_utf8_bytes) &&
        row.event_utf8_bytes > 0 &&
        row.event_utf8_bytes <= MAX_EVENT_BYTES
      ) {
        bytes = zstdDecompressSync(row.event_zstd, { maxOutputLength: MAX_EVENT_BYTES });
        if (bytes.length !== row.event_utf8_bytes)
          throw new Error("Native transcript decoded size differs.");
      } else {
        throw new Error("Unsupported native transcript payload encoding.");
      }
      totalBytes += bytes.length;
      if (
        bytes.length > MAX_EVENT_BYTES ||
        totalBytes > MAX_TRANSCRIPT_BYTES ||
        lines.length >= MAX_EVENTS
      ) {
        throw new Error("Native checkout transcript exceeds its size limit.");
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!isRecord(JSON.parse(text))) throw new Error("Malformed native transcript event.");
      lines.push(text);
    }
    if (lines.length !== bounds.count) throw new Error("Native transcript changed while reading.");
    return lines.join("\n");
  } finally {
    db.close();
  }
}

/** An isolated OAuth run must have one eligible local account and an exact saved order. */
export function assertExclusiveNativeXaiProfile(databasePath: string, profileId: string): void {
  const db = openDatabase(databasePath);
  try {
    const profiles = db
      .prepare(`SELECT p.key AS id, json_extract(p.value, '$.type') AS type FROM auth_profile_store,
      json_each(store_json, '$.profiles') p WHERE json_extract(p.value, '$.provider') = 'xai'`)
      .all();
    const orders = db
      .prepare(`SELECT json_extract(state_json, '$.order.xai') AS value
      FROM auth_profile_state WHERE json_extract(state_json, '$.order.xai') IS NOT NULL`)
      .all();
    if (
      profiles.length !== 1 ||
      profiles[0]?.id !== profileId ||
      profiles[0]?.type !== "oauth" ||
      orders.length !== 1 ||
      orders[0]?.value !== JSON.stringify([profileId])
    ) {
      throw new Error(
        "Native xAI review requires the requested account as its sole local xAI profile and saved order.",
      );
    }
  } finally {
    db.close();
  }
}
