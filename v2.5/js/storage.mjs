/**
 * Versioned, defensive persistence for Rudertrimm v2.
 *
 * The module is deliberately independent from the DOM and from localStorage.
 * Callers inject a Storage-compatible adapter and domain validators. Collection
 * records, the current workspace, and exchange files use explicit envelopes.
 */

export const STORAGE_SCHEMA_VERSION = 3;
export const EXCHANGE_SCHEMA_VERSION = 2;
export const STORAGE_FORMAT = 'rudertrimm.storage';
export const EXCHANGE_FORMAT = 'rudertrimm.exchange';

export const STORAGE_KINDS = Object.freeze({
  rowers: 'rudertrimm.rowers',
  boats: 'rudertrimm.boats',
  efaCandidates: 'rudertrimm.efa-candidates',
  workspace: 'rudertrimm.current-workspace',
});

export const STORAGE_KEYS = Object.freeze({
  rowers: 'rudertrimm:v2:rowers',
  boats: 'rudertrimm:v2:boats',
  efaCandidates: 'rudertrimm:v2:efa-candidates',
  workspace: 'rudertrimm:v2:current-workspace',
  quarantinePrefix: 'rudertrimm:v2:quarantine:',
});

export const STORAGE_LIMITS = Object.freeze({
  maxBytes: 1_048_576,
  // Storage v3 keeps the current DTO and a local baseline snapshot. The larger
  // internal ceiling lets every formerly valid 1 MiB v2 envelope migrate
  // atomically; exchange/import files deliberately remain capped at maxBytes.
  maxStorageBytes: 2_621_440,
  maxRecords: 250,
  maxHistoryEntries: 500,
  maxHistoryPerEntity: 20,
  maxHistoryFloors: 500,
  maxNameLength: 80,
  maxDepth: 32,
  maxNodes: 20_000,
});

const COLLECTION_KINDS = new Set([STORAGE_KINDS.rowers, STORAGE_KINDS.boats, STORAGE_KINDS.efaCandidates]);
const FORBIDDEN_WORKSPACE_KEYS = new Set(['db', 'databases', 'rowers', 'boats', 'records']);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const HISTORY_OPERATIONS = new Set(['baseline', 'create', 'update', 'import', 'migration', 'delete']);
const HISTORY_SOURCES = new Set(['local-ui', 'json-import', 'efa-csv', 'migration', 'system']);
let fallbackIdCounter = 0;

export class StorageValidationError extends TypeError {
  constructor(message, details = []) {
    super(message);
    this.name = 'StorageValidationError';
    this.code = 'validation';
    this.details = Object.freeze([...details]);
  }
}

export class RevisionConflictError extends Error {
  constructor(message = 'The persisted revision changed') {
    super(message);
    this.name = 'RevisionConflictError';
    this.code = 'revision-conflict';
  }
}

export class NoSelectionError extends Error {
  constructor(message = 'An explicit record id is required') {
    super(message);
    this.name = 'NoSelectionError';
    this.code = 'no-selection';
  }
}

export class UnsafeRecoveryError extends Error {
  constructor(message = 'Persisting is blocked because invalid source bytes could not be backed up safely') {
    super(message);
    this.name = 'UnsafeRecoveryError';
    this.code = 'unsafe-recovery';
  }
}

export class MigrationPendingError extends Error {
  constructor(message = 'A supported data migration must be committed before other writes') {
    super(message);
    this.name = 'MigrationPendingError';
    this.code = 'migration-pending';
  }
}

export class UnsupportedSchemaError extends StorageValidationError {
  constructor(message = 'Stored data uses a newer unsupported schema version', details = []) {
    super(message, details);
    this.name = 'UnsupportedSchemaError';
    this.code = 'unsupported-schema';
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) throw new StorageValidationError(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new StorageValidationError(`${label} has unexpected or missing fields`, [{actual, expected: wanted}]);
  }
}

function assertRevision(value, label, {allowZero = true} = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new StorageValidationError(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
  }
}

function assertTimestamp(value, label) {
  const date = typeof value === 'string' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new StorageValidationError(`${label} must be an ISO-compatible timestamp`);
  }
}

function assertId(value, label = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new StorageValidationError(`${label} is not a safe stable id`);
  }
}

function assertNameLimit(value, label, limits) {
  if (!isPlainObject(value) || !Object.hasOwn(value, 'name')) {
    throw new StorageValidationError(`${label}.name is required`);
  }
  if (typeof value.name !== 'string') throw new StorageValidationError(`${label}.name must be a string`);
  const length = [...value.name].length;
  if (length < 1 || length > limits.maxNameLength) {
    throw new StorageValidationError(`${label}.name must contain 1-${limits.maxNameLength} characters`);
  }
}

function assertJsonSafe(value, limits, label = 'value') {
  const ancestors = new WeakSet();
  let nodes = 0;

  function visit(current, path, depth) {
    nodes += 1;
    if (nodes > limits.maxNodes) throw new StorageValidationError(`${label} contains too many values`);
    if (depth > limits.maxDepth) throw new StorageValidationError(`${label} exceeds the maximum nesting depth`);
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new StorageValidationError(`${path} must be finite`);
      return;
    }
    if (typeof current !== 'object') throw new StorageValidationError(`${path} is not JSON-safe`);
    if (ancestors.has(current)) throw new StorageValidationError(`${path} contains a cycle`);
    ancestors.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
    } else {
      if (!isPlainObject(current)) throw new StorageValidationError(`${path} must be a plain object`);
      for (const key of Object.keys(current)) {
        if (DANGEROUS_KEYS.has(key)) throw new StorageValidationError(`${path}.${key} is forbidden`);
        visit(current[key], `${path}.${key}`, depth + 1);
      }
    }
    ancestors.delete(current);
  }

  visit(value, label, 0);
}

function assertWorkspaceIsolation(value, path = 'workspace') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertWorkspaceIsolation(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_WORKSPACE_KEYS.has(key)) {
      throw new StorageValidationError(`${path}.${key} is forbidden in the current workspace`);
    }
    assertWorkspaceIsolation(child, `${path}.${key}`);
  }
}

export function utf8ByteLength(text) {
  if (typeof text !== 'string') throw new TypeError('Expected text');
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength;
  return unescape(encodeURIComponent(text)).length;
}

function quarantineFingerprint(text) {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${utf8ByteLength(text)}-${hash.toString(16).padStart(16, '0')}`;
}

function enforceTextLimit(text, limits, label, maxBytes = limits.maxBytes) {
  const bytes = utf8ByteLength(text);
  if (bytes > maxBytes) {
    throw new StorageValidationError(`${label} exceeds ${maxBytes} UTF-8 bytes`, [{bytes, maxBytes}]);
  }
  return bytes;
}

function jsonClone(value, limits, label = 'value') {
  assertJsonSafe(value, limits, label);
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function normalizeLimits(overrides = {}) {
  const limits = {...STORAGE_LIMITS, ...overrides};
  if(Object.hasOwn(overrides,'maxBytes')&&!Object.hasOwn(overrides,'maxStorageBytes')){
    limits.maxStorageBytes=limits.maxBytes;
  }
  for (const key of [
    'maxBytes', 'maxStorageBytes', 'maxRecords', 'maxHistoryEntries', 'maxHistoryPerEntity',
    'maxHistoryFloors', 'maxNameLength', 'maxDepth', 'maxNodes',
  ]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new RangeError(`${key} must be a positive safe integer`);
  }
  if(limits.maxStorageBytes<limits.maxBytes) throw new RangeError('maxStorageBytes must not be lower than maxBytes');
  return Object.freeze(limits);
}

function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError('clock must return a valid date');
  return date.toISOString();
}

// Browser clocks can move backwards after NTP/manual correction. Repository
// chronology therefore uses the greatest already persisted canonical timestamp
// as a floor; revisions never become unreadable merely because wall time changed.
function monotonicStoreTimestamp(clock,state) {
  const timestamps=[nowIso(clock),state?.updatedAt];
  for(const record of state?.records??[]) timestamps.push(record.updatedAt);
  for(const entry of state?.history?.entries??[]) timestamps.push(entry.changedAt);
  return timestamps.filter(Boolean).sort().at(-1);
}

function validatorResult(validator, value, path) {
  if (typeof validator !== 'function') return value;
  const result = validator(value, path);
  if (result === true || result === undefined) return value;
  if (result === false) throw new StorageValidationError(`${path} failed validation`);
  if (isPlainObject(result) && typeof result.ok === 'boolean') {
    if (!result.ok) throw new StorageValidationError(`${path} failed validation`, result.errors ?? []);
    return result.value ?? value;
  }
  return result;
}

function assertStorageSchemaVersion(value, label = 'envelope.schemaVersion', {allowPrevious = false} = {}) {
  if (Number.isSafeInteger(value) && value > STORAGE_SCHEMA_VERSION) {
    throw new UnsupportedSchemaError(`${label} ${value} is newer than supported version ${STORAGE_SCHEMA_VERSION}`, [{
      actual: value,
      supported: STORAGE_SCHEMA_VERSION,
    }]);
  }
  if (value !== STORAGE_SCHEMA_VERSION && !(allowPrevious && value === 2)) {
    throw new StorageValidationError('Unsupported storage schema version');
  }
}

function assertExchangeSchemaVersion(value, label = 'envelope.schemaVersion') {
  if (Number.isSafeInteger(value) && value > EXCHANGE_SCHEMA_VERSION) {
    throw new UnsupportedSchemaError(`${label} ${value} is newer than supported exchange version ${EXCHANGE_SCHEMA_VERSION}`, [{
      actual: value,
      supported: EXCHANGE_SCHEMA_VERSION,
    }]);
  }
  if (value !== EXCHANGE_SCHEMA_VERSION) throw new StorageValidationError('Unsupported exchange schema version');
}

function migrationMetadata({recordIds = [], historyBaselineIds = [], storageEnvelope = false, workspace = false} = {}) {
  const ids = Object.freeze([...recordIds]);
  const baselineIds = Object.freeze([...historyBaselineIds]);
  const metadata = {
    migrated: ids.length > 0 || baselineIds.length > 0 || storageEnvelope || workspace,
    recordIds: ids,
    workspace,
  };
  // Keep the established public metadata shape stable while carrying the
  // storage-envelope migration plan internally to the single locked commit.
  Object.defineProperties(metadata, {
    historyBaselineIds: {value: baselineIds},
    storageEnvelope: {value: storageEnvelope},
  });
  return Object.freeze(metadata);
}

const NO_MIGRATION = migrationMetadata();

function applyValueMigration(migrate, value, {limits, path, context}) {
  if (typeof migrate !== 'function') return {value, migrated: false};
  const candidate = jsonClone(value, limits, `${path} migration input`);
  let result;
  try {
    result = migrate(candidate, Object.freeze({...context, path}));
  } catch (error) {
    // Domain modules deliberately use their own forward-version error type.
    // Normalize it at this storage boundary so future bytes follow the single
    // no-quarantine/write-blocking contract instead of looking corrupt.
    if (error?.code === 'unsupported-schema-version') {
      throw new UnsupportedSchemaError(error.message, [{
        path,
        actual: error.actual,
        supported: error.supported,
      }]);
    }
    throw error;
  }
  let migratedValue;
  let explicitlyMigrated = null;
  if (isPlainObject(result)
      && Object.keys(result).length === 2
      && Object.hasOwn(result, 'value')
      && typeof result.migrated === 'boolean') {
    migratedValue = result.value;
    explicitlyMigrated = result.migrated;
  } else {
    migratedValue = result === undefined ? candidate : result;
  }
  assertJsonSafe(migratedValue, limits, `${path} migrated value`);
  const valueChanged = JSON.stringify(migratedValue) !== JSON.stringify(value);
  // A callback may explicitly mark a semantic migration even when the JSON is
  // unchanged, but it may never suppress a real value change and its revision.
  const migrated = explicitlyMigrated === true || valueChanged;
  return {value: migratedValue, migrated};
}

function uuidFromBytes(bytes) {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

/** Generate an RFC-4122-shaped stable id. Randomness is not used as an auth secret. */
export function createStableId({cryptoObject = globalThis.crypto, now = Date.now, random = Math.random} = {}) {
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') return cryptoObject.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes);
    return uuidFromBytes(bytes);
  }
  let seed = Number(now()) + (++fallbackIdCounter * 0x9e3779b1);
  for (let index = 0; index < bytes.length; index += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    bytes[index] = (seed ^ Math.floor(random() * 256)) & 0xff;
  }
  return uuidFromBytes(bytes);
}

function normalizeAudit(audit, defaults) {
  const source = audit?.source ?? defaults.source;
  const reason = audit?.reason ?? defaults.reason;
  if (!HISTORY_SOURCES.has(source)) throw new StorageValidationError(`Unknown history source: ${String(source)}`);
  if (typeof reason !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(reason)) {
    throw new StorageValidationError('History reason must be a short controlled code');
  }
  return Object.freeze({source, reason});
}

function historyEntry({entityId, revision, changedAt, operation, source, reason, snapshot}, limits) {
  assertId(entityId, 'history.entityId');
  assertRevision(revision, 'history.revision', {allowZero: false});
  assertTimestamp(changedAt, 'history.changedAt');
  if (!HISTORY_OPERATIONS.has(operation)) throw new StorageValidationError(`Unknown history operation: ${String(operation)}`);
  normalizeAudit({source, reason}, {source: 'system', reason: 'unknown'});
  if (snapshot !== null) {
    if (!isPlainObject(snapshot)) throw new StorageValidationError('history.snapshot must be a plain object or null');
    assertJsonSafe(snapshot, limits, 'history.snapshot');
  }
  if (operation === 'delete' && snapshot !== null) throw new StorageValidationError('Delete history must not retain a snapshot');
  if (operation !== 'delete' && snapshot === null) throw new StorageValidationError('Non-delete history requires a snapshot');
  return {
    entityId,
    revision,
    changedAt,
    operation,
    source,
    reason,
    snapshot: snapshot === null ? null : jsonClone(snapshot, limits, 'history.snapshot'),
  };
}

function historyFloor(value) {
  exactKeys(value, ['entityId', 'throughRevision'], 'history floor');
  assertId(value.entityId, 'history floor entityId');
  assertRevision(value.throughRevision, 'history floor revision', {allowZero: false});
  return {entityId: value.entityId, throughRevision: value.throughRevision};
}

function emptyHistory() {
  return {entries: [], floors: []};
}

function normalizeHistory(value, {
  records, limits, kind, validateRecord, migrateRecord,
}) {
  exactKeys(value, ['entries', 'floors'], 'history');
  if (!Array.isArray(value.entries) || !Array.isArray(value.floors)) {
    throw new StorageValidationError('history entries and floors must be arrays');
  }
  if (value.entries.length > limits.maxHistoryEntries) throw new StorageValidationError('History entry limit exceeded');
  if (value.floors.length > limits.maxHistoryFloors) throw new StorageValidationError('History floor limit exceeded');
  const floors = value.floors.map(historyFloor);
  const floorIds = new Set();
  for (const floor of floors) {
    if (floorIds.has(floor.entityId)) throw new StorageValidationError(`Duplicate history floor: ${floor.entityId}`);
    floorIds.add(floor.entityId);
  }
  const projectedSnapshots=new Map();
  const entries = value.entries.map((entry,index) => {
    exactKeys(entry, ['entityId', 'revision', 'changedAt', 'operation', 'source', 'reason', 'snapshot'], 'history entry');
    const normalized=historyEntry(entry, limits);
    if(normalized.snapshot!==null){
      const path=`history.entries[${index}].snapshot`;
      const projected=typeof migrateRecord==='function'
        ?applyValueMigration(migrateRecord,normalized.snapshot,{
          limits,path,context:{kind,storage:true,history:true},
        }).value
        :normalized.snapshot;
      const validated=validatorResult(validateRecord, projected, path);
      assertJsonSafe(validated,limits,path);
      assertNameLimit(validated,path,limits);
      if(JSON.stringify(validated)!==JSON.stringify(projected)){
        throw new StorageValidationError(`history.entries[${index}].snapshot is not a canonical current-domain DTO`);
      }
      projectedSnapshots.set(normalized,projected);
    }
    return normalized;
  });
  const latest = new Map();
  const counts = new Map();
  for (const entry of entries) {
    const previous = latest.get(entry.entityId);
    const floor = floors.find(candidate => candidate.entityId === entry.entityId)?.throughRevision ?? 0;
    if ((!previous && entry.revision <= floor) || (previous && entry.revision <= previous.revision)) {
      throw new StorageValidationError(`History revisions are not strictly increasing for ${entry.entityId}`);
    }
    if(previous&&entry.changedAt<previous.changedAt){
      throw new StorageValidationError(`History timestamps move backwards for ${entry.entityId}`);
    }
    if(previous?.operation==='delete'){
      throw new StorageValidationError(`History continues after deletion for ${entry.entityId}`);
    }
    latest.set(entry.entityId, entry);
    counts.set(entry.entityId, (counts.get(entry.entityId) ?? 0) + 1);
  }
  for (const [entityId, count] of counts) {
    if (count > limits.maxHistoryPerEntity) throw new StorageValidationError(`History limit exceeded for ${entityId}`);
  }
  const recordsById = new Map(records.map(record => [record.id, record]));
  for (const record of records) {
    const entry = latest.get(record.id);
    if (!entry) throw new StorageValidationError(`Current record ${record.id} has no history baseline`);
    if (entry.operation === 'delete') throw new StorageValidationError(`Current record ${record.id} ends in a delete tombstone`);
    // The immutable historical bytes may use an older domain schema, but their
    // read-only projection must still describe exactly the current record. A
    // migration is never permission to hide a mismatching latest fact.
    if (entry.revision !== record.revision
        || JSON.stringify(projectedSnapshots.get(entry)) !== JSON.stringify(record.value)) {
      throw new StorageValidationError(`Current record ${record.id} does not match its latest history snapshot`);
    }
  }
  for (const [entityId, entry] of latest) {
    if (!recordsById.has(entityId) && entry.operation !== 'delete') {
      throw new StorageValidationError(`History for missing record ${entityId} lacks a delete tombstone`);
    }
    if (recordsById.has(entityId) && entry.operation === 'delete') {
      throw new StorageValidationError(`Delete tombstone conflicts with current record ${entityId}`);
    }
  }
  return {entries, floors};
}

function setHistoryFloor(history, entityId, throughRevision) {
  const existing = history.floors.find(floor => floor.entityId === entityId);
  if (existing) existing.throughRevision = Math.max(existing.throughRevision, throughRevision);
  else history.floors.push({entityId, throughRevision});
}

function compactHistory(history, records, limits) {
  const activeIds = new Set(records.map(record => record.id));
  const byEntity = new Map();
  for (const entry of history.entries) {
    if (!byEntity.has(entry.entityId)) byEntity.set(entry.entityId, []);
    byEntity.get(entry.entityId).push(entry);
  }
  for (const [entityId, entries] of byEntity) {
    while (entries.length > limits.maxHistoryPerEntity) {
      const removed = entries.shift();
      const index = history.entries.indexOf(removed);
      if (index >= 0) history.entries.splice(index, 1);
      setHistoryFloor(history, entityId, removed.revision);
    }
  }
  while (history.entries.length > limits.maxHistoryEntries) {
    const latestByEntity = new Map();
    for (const entry of history.entries) latestByEntity.set(entry.entityId, entry);
    const removable = history.entries
      .filter(entry => !(activeIds.has(entry.entityId) && latestByEntity.get(entry.entityId) === entry))
      .sort((left, right) => left.changedAt.localeCompare(right.changedAt)
        || left.entityId.localeCompare(right.entityId) || left.revision - right.revision)[0];
    if (!removable) throw new StorageValidationError('History cannot be compacted without losing current baselines');
    history.entries.splice(history.entries.indexOf(removable), 1);
    setHistoryFloor(history, removable.entityId, removable.revision);
  }
  if (history.floors.length > limits.maxHistoryFloors) throw new StorageValidationError('History floor limit exceeded');
  return history;
}

function compactHistoryToStorageBytes(envelope,limits,stringify){
  if(!COLLECTION_KINDS.has(envelope.kind)||!envelope.history) return envelope;
  const activeIds=new Set(envelope.records.map(record=>record.id));
  const byteLength=()=>{
    const text=stringify(envelope);
    if(typeof text!=='string') throw new StorageValidationError('stringify callback must return text');
    return utf8ByteLength(text);
  };
  while(byteLength()>limits.maxStorageBytes){
    const latestByEntity=new Map();
    for(const entry of envelope.history.entries) latestByEntity.set(entry.entityId,entry);
    const removable=envelope.history.entries
      .filter(entry=>!(activeIds.has(entry.entityId)&&latestByEntity.get(entry.entityId)===entry))
      .sort((left,right)=>left.changedAt.localeCompare(right.changedAt)
        ||left.entityId.localeCompare(right.entityId)||left.revision-right.revision)[0];
    if(!removable){
      throw new StorageValidationError(`Storage envelope exceeds ${limits.maxStorageBytes} UTF-8 bytes and no obsolete history snapshot can be removed`);
    }
    envelope.history.entries.splice(envelope.history.entries.indexOf(removable),1);
    setHistoryFloor(envelope.history,removable.entityId,removable.revision);
    if(envelope.history.floors.length>limits.maxHistoryFloors){
      throw new StorageValidationError('History floor limit exceeded during byte retention');
    }
  }
  return envelope;
}

function appendHistory(history, record, operation, timestamp, audit, records, limits) {
  history.entries.push(historyEntry({
    entityId: record.id,
    revision: record.revision,
    changedAt: timestamp,
    operation,
    source: audit.source,
    reason: audit.reason,
    snapshot: record.value,
  }, limits));
  return compactHistory(history, records, limits);
}

/**
 * Privacy deletion overrides normal append-only retention: purge all PII snapshots,
 * advance the floor and append only a null tombstone. The floor keeps the retired
 * entity id reserved against resurrection without retaining the deleted profile.
 */
function privacyDeleteHistory(history, record, timestamp, audit, records, limits) {
  history.entries = history.entries.filter(entry => entry.entityId !== record.id);
  setHistoryFloor(history, record.id, record.revision);
  history.entries.push(historyEntry({
    entityId: record.id,
    revision: record.revision + 1,
    changedAt: timestamp,
    operation: 'delete',
    source: audit.source,
    reason: audit.reason,
    snapshot: null,
  }, limits));
  return compactHistory(history, records, limits);
}

function emptyCollectionEnvelope(kind, timestamp) {
  return deepFreeze({
    format: STORAGE_FORMAT,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    kind,
    revision: 0,
    updatedAt: timestamp,
    records: [],
    history: emptyHistory(),
  });
}

function emptyWorkspaceEnvelope(timestamp) {
  return deepFreeze({
    format: STORAGE_FORMAT,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    kind: STORAGE_KINDS.workspace,
    revision: 0,
    updatedAt: timestamp,
    workspace: null,
  });
}

function normalizeRecord(record, {kind, validateRecord, migrateRecord, limits, path, storage}) {
  exactKeys(record, ['id', 'revision', 'updatedAt', 'value'], path);
  assertId(record.id, `${path}.id`);
  assertRevision(record.revision, `${path}.revision`, {allowZero: false});
  assertTimestamp(record.updatedAt, `${path}.updatedAt`);
  assertJsonSafe(record.value, limits, `${path}.value`);
  const migration = applyValueMigration(migrateRecord, record.value, {
    limits,
    path: `${path}.value`,
    context: {
      kind,
      storage,
      record: Object.freeze({id: record.id, revision: record.revision, updatedAt: record.updatedAt}),
    },
  });
  const value = validatorResult(validateRecord, migration.value, `${path}.value`);
  assertJsonSafe(value, limits, `${path}.value`);
  assertNameLimit(value, `${path}.value`, limits);
  return {
    record: {
      id: record.id,
      revision: record.revision,
      updatedAt: record.updatedAt,
      value: jsonClone(value, limits, `${path}.value`),
    },
    migrated: migration.migrated,
  };
}

function normalizeCollectionEnvelope(envelope, {
  kind, validateRecord, migrateRecord, migrateHistoryRecord = migrateRecord, limits, storage = true,
}) {
  const sourceSchema = envelope?.schemaVersion;
  if (isPlainObject(envelope) && Object.hasOwn(envelope, 'schemaVersion')) {
    // Future envelopes may add fields. Detect their version before exact-key
    // validation so newer bytes are blocked intact instead of quarantined.
    if (storage) assertStorageSchemaVersion(sourceSchema, undefined, {allowPrevious: true});
    else assertExchangeSchemaVersion(sourceSchema);
  }
  const fields = storage
    ? sourceSchema === 2
      ? ['format', 'schemaVersion', 'kind', 'revision', 'updatedAt', 'records']
      : ['format', 'schemaVersion', 'kind', 'revision', 'updatedAt', 'records', 'history']
    : ['format', 'schemaVersion', 'kind', 'exportedAt', 'records'];
  exactKeys(envelope, fields, storage ? 'storage envelope' : 'exchange envelope');
  const expectedFormat = storage ? STORAGE_FORMAT : EXCHANGE_FORMAT;
  if (envelope.format !== expectedFormat) throw new StorageValidationError(`Expected format ${expectedFormat}`);
  if (storage) assertStorageSchemaVersion(sourceSchema, undefined, {allowPrevious: true});
  else assertExchangeSchemaVersion(sourceSchema);
  if (envelope.kind !== kind || !COLLECTION_KINDS.has(kind)) throw new StorageValidationError('Unexpected collection kind');
  if (storage) {
    assertRevision(envelope.revision, 'envelope.revision');
    assertTimestamp(envelope.updatedAt, 'envelope.updatedAt');
  } else {
    assertTimestamp(envelope.exportedAt, 'envelope.exportedAt');
  }
  if (!Array.isArray(envelope.records)) throw new StorageValidationError('envelope.records must be an array');
  if (envelope.records.length > limits.maxRecords) throw new StorageValidationError(`At most ${limits.maxRecords} records are allowed`);
  const ids = new Set();
  const migratedRecordIds = [];
  const records = envelope.records.map((record, index) => {
    const normalized = normalizeRecord(record, {
      kind, validateRecord, migrateRecord, limits, path: `records[${index}]`, storage,
    });
    if (ids.has(normalized.record.id)) throw new StorageValidationError(`Duplicate record id: ${normalized.record.id}`);
    ids.add(normalized.record.id);
    if (normalized.migrated) migratedRecordIds.push(normalized.record.id);
    return normalized.record;
  });
  const historyBaselineIds = storage && sourceSchema === 2 ? records.map(record => record.id) : [];
  const history = storage
    ? sourceSchema === 2
      ? {
        entries: records.map(record => historyEntry({
          entityId: record.id,
          revision: record.revision,
          changedAt: record.updatedAt,
          operation: 'baseline',
          source: 'migration',
          reason: 'history-start',
          snapshot: record.value,
        }, limits)),
        floors: [],
      }
      : normalizeHistory(envelope.history, {
        records,limits,kind,validateRecord,migrateRecord:migrateHistoryRecord,
      })
    : null;
  const normalizedEnvelope = storage ? {
    format: STORAGE_FORMAT,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    kind,
    revision: envelope.revision,
    updatedAt: envelope.updatedAt,
    records,
    history,
  } : {
    format: EXCHANGE_FORMAT,
    schemaVersion: EXCHANGE_SCHEMA_VERSION,
    kind,
    exportedAt: envelope.exportedAt,
    records,
  };
  return {envelope: normalizedEnvelope, migration: migrationMetadata({
    recordIds: migratedRecordIds,
    historyBaselineIds,
    storageEnvelope: storage && sourceSchema === 2,
  })};
}

function normalizeWorkspaceEnvelope(envelope, {validateWorkspace, migrateWorkspace, limits, storage = true}) {
  const fields = storage
    ? ['format', 'schemaVersion', 'kind', 'revision', 'updatedAt', 'workspace']
    : ['format', 'schemaVersion', 'kind', 'exportedAt', 'workspace'];
  if (isPlainObject(envelope) && Object.hasOwn(envelope, 'schemaVersion')) {
    if (storage) assertStorageSchemaVersion(envelope.schemaVersion, undefined, {allowPrevious: true});
    else assertExchangeSchemaVersion(envelope.schemaVersion);
  }
  exactKeys(envelope, fields, storage ? 'workspace storage envelope' : 'workspace exchange envelope');
  if (envelope.format !== (storage ? STORAGE_FORMAT : EXCHANGE_FORMAT)) throw new StorageValidationError('Unexpected workspace format');
  if (storage) assertStorageSchemaVersion(envelope.schemaVersion, undefined, {allowPrevious: true});
  else assertExchangeSchemaVersion(envelope.schemaVersion);
  if (envelope.kind !== STORAGE_KINDS.workspace) throw new StorageValidationError('Unexpected workspace kind');
  if (storage) {
    assertRevision(envelope.revision, 'envelope.revision');
    assertTimestamp(envelope.updatedAt, 'envelope.updatedAt');
  } else {
    assertTimestamp(envelope.exportedAt, 'envelope.exportedAt');
  }
  let workspace = envelope.workspace;
  let migrated = false;
  if (workspace !== null) {
    assertJsonSafe(workspace, limits, 'workspace');
    const migration = applyValueMigration(migrateWorkspace, workspace, {
      limits,
      path: 'workspace',
      context: {kind: STORAGE_KINDS.workspace, storage},
    });
    workspace = migration.value;
    migrated = migration.migrated;
    assertWorkspaceIsolation(workspace);
    workspace = validatorResult(validateWorkspace, workspace, 'workspace');
    assertJsonSafe(workspace, limits, 'workspace');
    assertWorkspaceIsolation(workspace);
    workspace = jsonClone(workspace, limits, 'workspace');
  }
  const normalizedEnvelope = storage ? {
    format: STORAGE_FORMAT,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    kind: STORAGE_KINDS.workspace,
    revision: envelope.revision,
    updatedAt: envelope.updatedAt,
    workspace,
  } : {
    format: EXCHANGE_FORMAT,
    schemaVersion: EXCHANGE_SCHEMA_VERSION,
    kind: STORAGE_KINDS.workspace,
    exportedAt: envelope.exportedAt,
    workspace,
  };
  return {envelope: normalizedEnvelope, migration: migrationMetadata({
    storageEnvelope: storage && envelope.schemaVersion === 2,
    workspace: migrated,
  })};
}

function parseEnvelopeText(text, {
  kind, parse, validateRecord, validateWorkspace, migrateRecord, migrateWorkspace, limits, storage,
}) {
  if (typeof text !== 'string') throw new TypeError('Envelope input must be text');
  enforceTextLimit(text, limits, storage ? 'stored envelope' : 'import file',
    storage ? limits.maxStorageBytes : limits.maxBytes);
  const parsed = parse(text);
  // Storage-v2 was only ever valid up to the historical exchange ceiling.
  // Only v3 may use the extra headroom required by its local history snapshots.
  if(storage&&parsed?.schemaVersion===2){
    enforceTextLimit(text,limits,'stored v2 envelope',limits.maxBytes);
  }
  return kind === STORAGE_KINDS.workspace
    ? normalizeWorkspaceEnvelope(parsed, {validateWorkspace, migrateWorkspace, limits, storage})
    : normalizeCollectionEnvelope(parsed, {kind, validateRecord, migrateRecord, limits, storage});
}

/** Parse and strictly validate a versioned exchange file without side effects. */
export function parseImportEnvelope(text, {
  expectedKind,
  parse = JSON.parse,
  validateRecord,
  validateWorkspace,
  migrateRecord,
  migrateWorkspace,
  limits: limitOverrides,
} = {}) {
  if (!Object.values(STORAGE_KINDS).includes(expectedKind)) throw new RangeError('expectedKind is required');
  const limits = normalizeLimits(limitOverrides);
  try {
    const normalized = parseEnvelopeText(text, {
      kind: expectedKind, parse, validateRecord, validateWorkspace,
      migrateRecord, migrateWorkspace, limits, storage: false,
    });
    return Object.freeze({
      ok: true,
      envelope: deepFreeze(normalized.envelope),
      migration: normalized.migration,
      errors: Object.freeze([]),
    });
  } catch (error) {
    return Object.freeze({ok: false, envelope: null, migration: NO_MIGRATION, errors: Object.freeze([error])});
  }
}

function serializeEnvelope(envelope, {stringify, limits, label, maxBytes = limits.maxBytes}) {
  assertJsonSafe(envelope, limits, label);
  const text = stringify(envelope);
  if (typeof text !== 'string') throw new StorageValidationError('stringify callback must return text');
  enforceTextLimit(text, limits, label, maxBytes);
  return text;
}

function assertStorageAdapter(storage) {
  for (const method of ['getItem', 'setItem', 'removeItem']) {
    if (!storage || typeof storage[method] !== 'function') throw new TypeError(`storage.${method} is required`);
  }
}

/** Minimal injectable Storage implementation for tests and non-browser hosts. */
export function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    clear() { values.clear(); },
    dump() { return Object.fromEntries(values); },
  };
}

/**
 * Serialize one repository write across same-origin browsing contexts.
 *
 * Persistent callers must supply Web Locks support. Session- and memory-backed
 * repositories are tab-local and can opt out through `shared: false`.
 * Human confirmation belongs before the lock. Inside, perform only reload,
 * captured-intent/revision validation and write. This helper locks one key;
 * multi-repository callers must nest in the fixed workspace → boats → rowers order.
 */
export async function withExclusiveRepositoryWrite(repository, action, {
  lockManager = globalThis.navigator?.locks,
  shared = true,
} = {}) {
  if (!repository || typeof repository.key !== 'string' || typeof repository.reloadFromExternal !== 'function') {
    throw new TypeError('A versioned repository is required');
  }
  if (typeof action !== 'function') throw new TypeError('action must be a function');

  const run = async () => {
    repository.reloadFromExternal('write-lock');
    return action();
  };
  if (!shared) return run();
  if (!lockManager || typeof lockManager.request !== 'function') {
    const error = new Error('Web Locks are required for safe persistent repository writes');
    error.code = 'coordination-unavailable';
    throw error;
  }
  return lockManager.request(
    `rudertrimm:v2:repository-write:${repository.key}`,
    {mode: 'exclusive'},
    run,
  );
}

function createChannel(channelFactory, name) {
  if (channelFactory === false) return null;
  if (typeof channelFactory === 'function') return channelFactory(name);
  if (typeof BroadcastChannel === 'function') return new BroadcastChannel(name);
  return null;
}

class VersionedStore {
  constructor({
    kind,
    key,
    storage,
    validateRecord,
    validateWorkspace,
    migrateRecord,
    migrateWorkspace,
    parse = JSON.parse,
    stringify = JSON.stringify,
    limits,
    clock = () => new Date(),
    idFactory = () => createStableId(),
    channelFactory,
    storageEventTarget = typeof window === 'object' ? window : null,
  }) {
    assertStorageAdapter(storage);
    if (!Object.values(STORAGE_KINDS).includes(kind)) throw new RangeError('Unknown store kind');
    if (typeof key !== 'string' || !key) throw new TypeError('A storage key is required');
    this.kind = kind;
    this.key = key;
    this.storage = storage;
    this.validateRecord = validateRecord;
    this.validateWorkspace = validateWorkspace;
    this.migrateRecord = migrateRecord;
    this.migrateWorkspace = migrateWorkspace;
    this.parse = parse;
    this.stringify = stringify;
    this.limits = normalizeLimits(limits);
    this.clock = clock;
    this.idFactory = idFactory;
    this.listeners = new Set();
    this.instanceId = createStableId();
    const timestamp = nowIso(clock);
    this.state = kind === STORAGE_KINDS.workspace
      ? emptyWorkspaceEnvelope(timestamp)
      : emptyCollectionEnvelope(kind, timestamp);
    this.persistedRaw = null;
    this.recovery = null;
    this.pendingMigration = null;
    this.channel = createChannel(channelFactory, 'rudertrimm:v2:storage');
    this.storageEventTarget = storageEventTarget;
    this.onChannelMessage = event => {
      const message = event?.data;
      if (message?.type === 'rudertrimm-storage-change' && message.key === this.key && message.sender !== this.instanceId) {
        this.reloadFromExternal('broadcast');
      }
    };
    this.onStorageEvent = event => {
      const eventKey = event?.key;
      const sameArea = !event?.storageArea || event.storageArea === this.storage;
      if (sameArea && (eventKey === this.key || eventKey === null)) {
        this.reloadFromExternal('storage-event');
      }
    };
    if (this.channel?.addEventListener) this.channel.addEventListener('message', this.onChannelMessage);
    else if (this.channel) this.channel.onmessage = this.onChannelMessage;
    this.storageEventTarget?.addEventListener?.('storage', this.onStorageEvent);
  }

  defaultEnvelope() {
    const timestamp = monotonicStoreTimestamp(this.clock,this.state);
    return this.kind === STORAGE_KINDS.workspace
      ? emptyWorkspaceEnvelope(timestamp)
      : emptyCollectionEnvelope(this.kind, timestamp);
  }

  normalizeStored(envelope, {migrate = false} = {}) {
    return this.kind === STORAGE_KINDS.workspace
      ? normalizeWorkspaceEnvelope(envelope, {
        validateWorkspace: this.validateWorkspace,
        migrateWorkspace: migrate ? this.migrateWorkspace : undefined,
        limits: this.limits,
        storage: true,
      })
      : normalizeCollectionEnvelope(envelope, {
        kind: this.kind,
        validateRecord: this.validateRecord,
        migrateRecord: migrate ? this.migrateRecord : undefined,
        // Historical snapshots are immutable legacy facts. They still need a
        // current-domain projection on every validation pass, including the
        // migration commit and later reloads, but are never rewritten in place.
        migrateHistoryRecord: this.migrateRecord,
        limits: this.limits,
        storage: true,
      });
  }

  normalizeForPersistence(envelope){
    const normalized=this.normalizeStored(envelope).envelope;
    if(!COLLECTION_KINDS.has(this.kind)) return normalized;
    const fitted=jsonClone(normalized,this.limits,'storage retention');
    compactHistoryToStorageBytes(fitted,this.limits,this.stringify);
    return this.normalizeStored(fitted).envelope;
  }

  quarantine(raw, error) {
    const result = {stored: false, deduplicated: false, key: null, error: null};
    if (typeof raw !== 'string' || utf8ByteLength(raw) > this.limits.maxStorageBytes) {
      result.error = new StorageValidationError('Invalid payload was too large to duplicate into quarantine');
      return Object.freeze(result);
    }
    try {
      const baseKey = `${STORAGE_KEYS.quarantinePrefix}${encodeURIComponent(this.kind)}:${quarantineFingerprint(raw)}`;
      const existing = this.storage.getItem(baseKey);
      if (existing === raw) {
        result.stored = true;
        result.deduplicated = true;
        result.key = baseKey;
        return Object.freeze(result);
      }
      const key = existing === null ? baseKey : `${baseKey}:${createStableId()}`;
      this.storage.setItem(key, raw);
      result.stored = true;
      result.key = key;
    } catch (quarantineError) {
      result.error = quarantineError;
    }
    return Object.freeze(result);
  }

  adoptRaw(raw, {quarantine = true} = {}) {
    if (raw === null) {
      this.state = this.defaultEnvelope();
      this.persistedRaw = null;
      this.recovery = null;
      this.pendingMigration = null;
      return Object.freeze({
        ok: true, recovered: false, rawPresent: false, state: this.snapshot(),
        migration: NO_MIGRATION, quarantine: null, error: null,
      });
    }
    try {
      const normalized = parseEnvelopeText(raw, {
        kind: this.kind,
        parse: this.parse,
        validateRecord: this.validateRecord,
        validateWorkspace: this.validateWorkspace,
        migrateRecord: this.migrateRecord,
        migrateWorkspace: this.migrateWorkspace,
        limits: this.limits,
        storage: true,
      });
      this.state = deepFreeze(normalized.envelope);
      this.persistedRaw = raw;
      this.recovery = null;
      this.pendingMigration = normalized.migration.migrated
        ? Object.freeze({
          sourceRaw: raw,
          sourceRevision: normalized.envelope.revision,
          recordIds: normalized.migration.recordIds,
          historyBaselineIds: normalized.migration.historyBaselineIds,
          storageEnvelope: normalized.migration.storageEnvelope,
          workspace: normalized.migration.workspace,
        })
        : null;
      return Object.freeze({
        ok: true,
        recovered: false,
        rawPresent: true,
        state: this.snapshot(),
        migration: normalized.migration,
        quarantine: null,
        error: null,
      });
    } catch (error) {
      if (error?.code === 'unsupported-schema') {
        this.state = this.defaultEnvelope();
        this.persistedRaw = raw;
        this.pendingMigration = null;
        this.recovery = Object.freeze({
          raw, error, quarantine: null, readFailure: false, unsupportedSchema: true,
        });
        return Object.freeze({
          ok: false,
          recovered: false,
          rawPresent: true,
          unsupportedSchema: true,
          state: this.snapshot(),
          migration: NO_MIGRATION,
          quarantine: null,
          error,
        });
      }
      const prior = this.recovery?.readFailure === false && this.recovery.raw === raw
        ? this.recovery
        : null;
      this.state = this.defaultEnvelope();
      this.persistedRaw = raw;
      this.pendingMigration = null;
      const quarantineResult = quarantine
        ? (prior?.quarantine ?? this.quarantine(raw, error))
        : null;
      this.recovery = Object.freeze({raw, error, quarantine: quarantineResult, readFailure: false});
      return Object.freeze({
        ok: false, recovered: true, rawPresent: true, state: this.snapshot(),
        migration: NO_MIGRATION, quarantine: quarantineResult, error,
      });
    }
  }

  markReadFailure(error, {resetState = false} = {}) {
    if (resetState) this.state = this.defaultEnvelope();
    this.pendingMigration = null;
    this.recovery = Object.freeze({raw: null, error, quarantine: null, readFailure: true});
    return Object.freeze({
      ok: false,
      recovered: true,
      rawPresent: null,
      state: this.snapshot(),
      migration: NO_MIGRATION,
      quarantine: null,
      error,
    });
  }

  load({quarantine = true} = {}) {
    let raw;
    try {
      raw = this.storage.getItem(this.key);
    } catch (error) {
      return this.markReadFailure(error, {resetState: true});
    }
    return this.adoptRaw(raw, {quarantine});
  }

  reloadFromExternal(source) {
    const before = this.state.revision;
    try {
      const raw = this.storage.getItem(this.key);
      if (raw === this.persistedRaw && this.recovery?.readFailure !== true) return false;
      const result = this.adoptRaw(raw);
      this.emit({type: 'external-sync', source, beforeRevision: before, revision: this.state.revision, result});
      return true;
    } catch (error) {
      this.markReadFailure(error);
      this.emit({type: 'external-sync-error', source, beforeRevision: before, error});
      return false;
    }
  }

  snapshot() {
    return deepFreeze(jsonClone(this.state, this.limits, 'snapshot'));
  }

  constraints() {
    return this.limits;
  }

  migrationStatus() {
    const pending = this.pendingMigration;
    return Object.freeze({
      pending: pending !== null,
      recordIds: pending?.recordIds ?? Object.freeze([]),
      workspace: pending?.workspace ?? false,
    });
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    const frozenEvent = Object.freeze({...event});
    for (const listener of this.listeners) {
      try { listener(frozenEvent); } catch { /* Subscriber failures must not roll back a committed write. */ }
    }
  }

  assertFresh(expectedRevision) {
    if (expectedRevision !== undefined && expectedRevision !== this.state.revision) {
      throw new RevisionConflictError(`Expected revision ${expectedRevision}, current revision is ${this.state.revision}`);
    }
    const currentRaw = this.storage.getItem(this.key);
    if (currentRaw !== this.persistedRaw) throw new RevisionConflictError('Storage changed in another context');
  }

  persist(next, {expectedRevision, reason}) {
    if (this.pendingMigration) throw new MigrationPendingError();
    if (this.recovery?.error?.code === 'unsupported-schema') throw this.recovery.error;
    if (this.recovery && this.recovery.quarantine?.stored !== true) {
      throw new UnsafeRecoveryError();
    }
    this.assertFresh(expectedRevision);
    const normalized = this.normalizeForPersistence(next);
    const raw = serializeEnvelope(normalized, {
      stringify: this.stringify,
      limits: this.limits,
      label: 'storage envelope',
      maxBytes: this.limits.maxStorageBytes,
    });
    this.storage.setItem(this.key, raw);
    this.state = deepFreeze(normalized);
    this.persistedRaw = raw;
    this.recovery = null;
    this.emit({type: 'commit', reason, revision: normalized.revision});
    try {
      this.channel?.postMessage?.({
        type: 'rudertrimm-storage-change', key: this.key, revision: normalized.revision, sender: this.instanceId,
      });
    } catch (error) {
      this.emit({type: 'sync-notification-error', revision: normalized.revision, error});
    }
    return this.snapshot();
  }

  /**
   * Persist a previously validated migration as one compare-and-write commit.
   * Source bytes remain authoritative until setItem succeeds; retries therefore
   * cannot lose the old value or increment revisions twice after quota failure.
   */
  commitPendingMigration({expectedRevision} = {}) {
    const pending = this.pendingMigration;
    if (!pending) {
      return Object.freeze({
        changed: false,
        revision: this.state.revision,
        recordIds: Object.freeze([]),
        workspace: false,
      });
    }
    if (expectedRevision !== undefined && expectedRevision !== pending.sourceRevision) {
      throw new RevisionConflictError(`Expected revision ${expectedRevision}, current migration source is ${pending.sourceRevision}`);
    }
    const currentRaw = this.storage.getItem(this.key);
    if (currentRaw !== pending.sourceRaw) throw new RevisionConflictError('Migration source bytes changed in another context');

    const timestamp = monotonicStoreTimestamp(this.clock,this.state);
    const next = jsonClone(this.state, this.limits, 'pending migration');
    assertRevision(next.revision + 1, 'migrated envelope revision');
    next.revision += 1;
    next.updatedAt = timestamp;
    if (this.kind !== STORAGE_KINDS.workspace) {
      const migratedIds = new Set(pending.recordIds);
      const baselineIds = new Set(pending.historyBaselineIds);
      next.records = next.records.map(record => {
        if (!migratedIds.has(record.id)) return record;
        assertRevision(record.revision + 1, `migrated record ${record.id} revision`, {allowZero: false});
        return {...record, revision: record.revision + 1, updatedAt: timestamp};
      });
      for (const id of migratedIds) {
        const record = next.records.find(candidate => candidate.id === id);
        if (!record) throw new StorageValidationError(`Migrated record ${id} disappeared before commit`);
        if (baselineIds.has(id)) {
          const baseline = next.history.entries.find(entry => entry.entityId === id);
          if (!baseline) throw new StorageValidationError(`History baseline for ${id} disappeared before commit`);
          baseline.revision = record.revision;
          baseline.changedAt = timestamp;
          baseline.snapshot = jsonClone(record.value, this.limits, 'migrated history baseline');
        } else {
          appendHistory(
            next.history,
            record,
            'migration',
            timestamp,
            {source: 'migration', reason: 'domain-schema-migration'},
            next.records,
            this.limits,
          );
        }
      }
    }
    const normalized = this.normalizeForPersistence(next);
    const raw = serializeEnvelope(normalized, {
      stringify: this.stringify,
      limits: this.limits,
      label: 'migrated storage envelope',
      maxBytes: this.limits.maxStorageBytes,
    });

    // No in-memory state changes before this single write: quota or adapter
    // failures leave both the original bytes and the retryable pending plan intact.
    this.storage.setItem(this.key, raw);
    this.state = deepFreeze(normalized);
    this.persistedRaw = raw;
    this.pendingMigration = null;
    this.recovery = null;
    this.emit({type: 'commit', reason: 'migration', revision: normalized.revision});
    try {
      this.channel?.postMessage?.({
        type: 'rudertrimm-storage-change', key: this.key, revision: normalized.revision, sender: this.instanceId,
      });
    } catch (error) {
      this.emit({type: 'sync-notification-error', revision: normalized.revision, error});
    }
    return Object.freeze({
      changed: true,
      revision: normalized.revision,
      recordIds: pending.recordIds,
      workspace: pending.workspace,
    });
  }

  exportEnvelope() {
    const timestamp = monotonicStoreTimestamp(this.clock,this.state);
    if (this.kind === STORAGE_KINDS.workspace) {
      return deepFreeze(normalizeWorkspaceEnvelope({
        format: EXCHANGE_FORMAT,
        schemaVersion: EXCHANGE_SCHEMA_VERSION,
        kind: this.kind,
        exportedAt: timestamp,
        workspace: this.state.workspace,
      }, {validateWorkspace: this.validateWorkspace, limits: this.limits, storage: false}).envelope);
    }
    return deepFreeze(normalizeCollectionEnvelope({
      format: EXCHANGE_FORMAT,
      schemaVersion: EXCHANGE_SCHEMA_VERSION,
      kind: this.kind,
      exportedAt: timestamp,
      records: this.state.records,
    }, {kind: this.kind, validateRecord: this.validateRecord, limits: this.limits, storage: false}).envelope);
  }

  exportText() {
    return serializeEnvelope(this.exportEnvelope(), {stringify: this.stringify, limits: this.limits, label: 'export file'});
  }

  importText(text, {expectedRevision, migratedRecordIds = [], audit} = {}) {
    if (!Array.isArray(migratedRecordIds)
        || migratedRecordIds.some(id => typeof id !== 'string' || id.length === 0)) {
      throw new TypeError('migratedRecordIds must be an array of non-empty ids');
    }
    const parsed = parseImportEnvelope(text, {
      expectedKind: this.kind,
      parse: this.parse,
      validateRecord: this.validateRecord,
      validateWorkspace: this.validateWorkspace,
      migrateRecord: this.migrateRecord,
      migrateWorkspace: this.migrateWorkspace,
      limits: this.limits,
    });
    if (!parsed.ok) throw parsed.errors[0];
    const importedIds = this.kind === STORAGE_KINDS.workspace
      ? new Set()
      : new Set(parsed.envelope.records.map(record => record.id));
    if (migratedRecordIds.some(id => !importedIds.has(id))) {
      throw new StorageValidationError('migratedRecordIds contains an id outside the import envelope');
    }
    if(this.kind!==STORAGE_KINDS.workspace){
      const activeIds=new Set(this.state.records.map(record=>record.id));
      const retiredIds=new Set([
        ...this.state.history.entries.map(entry=>entry.entityId),
        ...this.state.history.floors.map(floor=>floor.entityId),
      ].filter(id=>!activeIds.has(id)));
      const resurrected=[...importedIds].find(id=>retiredIds.has(id));
      if(resurrected){
        throw new StorageValidationError(`Import must not reuse retired entity id ${resurrected}; preview through the merge adapter to remap it`);
      }
    }
    // An adapter may already have transformed a legacy DTO for preview. Carry its
    // concrete IDs into this one authoritative commit so revision and timestamp are
    // advanced exactly once with the repository clock, never with preview time.
    const committedMigrationIds = new Set([...parsed.migration.recordIds, ...migratedRecordIds]);
    const timestamp = monotonicStoreTimestamp(this.clock,this.state);
    const next = this.kind === STORAGE_KINDS.workspace ? {
      format: STORAGE_FORMAT,
      schemaVersion: STORAGE_SCHEMA_VERSION,
      kind: this.kind,
      revision: this.state.revision + 1,
      updatedAt: timestamp,
      workspace: parsed.envelope.workspace,
    } : (() => {
      const auditMeta = normalizeAudit(audit, {source: 'json-import', reason: 'collection-import'});
      const currentById = new Map(this.state.records.map(record => [record.id, record]));
      const records = parsed.envelope.records.map(incoming => {
        const current = currentById.get(incoming.id);
        if (current) {
          if (JSON.stringify(current.value) === JSON.stringify(incoming.value)) return current;
          return {...incoming, revision: current.revision + 1, updatedAt: timestamp};
        }
        if (!committedMigrationIds.has(incoming.id)) return incoming;
        assertRevision(incoming.revision + 1, `imported migrated record ${incoming.id} revision`, {allowZero: false});
        return {...incoming, revision: incoming.revision + 1, updatedAt: timestamp};
      });
      const history = jsonClone(this.state.history, this.limits, 'import history');
      const recordsById = new Map(records.map(record => [record.id, record]));
      for (const record of records) {
        const current = currentById.get(record.id);
        if (!current || JSON.stringify(current.value) !== JSON.stringify(record.value)) {
          appendHistory(history, record, 'import', timestamp, auditMeta, records, this.limits);
        }
      }
      for (const current of this.state.records) {
        if (!recordsById.has(current.id)) {
          privacyDeleteHistory(history, current, timestamp, {
            source: auditMeta.source,
            reason: 'collection-import-delete',
          }, records, this.limits);
        }
      }
      return {
        format: STORAGE_FORMAT,
        schemaVersion: STORAGE_SCHEMA_VERSION,
        kind: this.kind,
        revision: this.state.revision + 1,
        updatedAt: timestamp,
        records,
        history,
      };
    })();
    return this.persist(next, {expectedRevision, reason: 'import'});
  }

  close() {
    if (this.channel?.removeEventListener) this.channel.removeEventListener('message', this.onChannelMessage);
    else if (this.channel) this.channel.onmessage = null;
    this.channel?.close?.();
    this.storageEventTarget?.removeEventListener?.('storage', this.onStorageEvent);
    this.listeners.clear();
  }
}

export class CollectionRepository extends VersionedStore {
  constructor(options) {
    if (!COLLECTION_KINDS.has(options?.kind)) throw new RangeError('Unknown collection kind');
    super(options);
  }

  list() {
    return this.snapshot().records;
  }

  history(entityId) {
    if (entityId !== undefined) assertId(entityId, 'history entity id');
    const entries = entityId === undefined
      ? this.state.history.entries
      : this.state.history.entries.filter(entry => entry.entityId === entityId);
    return deepFreeze(jsonClone(entries, this.limits, 'history entries'));
  }

  historyFloors() {
    return deepFreeze(jsonClone(this.state.history.floors, this.limits, 'history floors'));
  }

  /**
   * Active ids plus history/tombstone floors. Privacy-deleted ids stay reserved so
   * an import or delayed cross-repository save cannot resurrect their identity.
   */
  reservedIds() {
    return Object.freeze([...new Set([
      ...this.state.records.map(record => record.id),
      ...this.state.history.entries.map(entry => entry.entityId),
      ...this.state.history.floors.map(floor => floor.entityId),
    ])]);
  }

  select(id) {
    if (typeof id !== 'string' || id.length === 0) {
      return Object.freeze({ok: false, code: 'no-selection', record: null});
    }
    const record = this.state.records.find(entry => entry.id === id);
    return record
      ? Object.freeze({ok: true, code: 'ok', record: deepFreeze(jsonClone(record, this.limits, 'record'))})
      : Object.freeze({ok: false, code: 'not-found', record: null});
  }

  create(value, {expectedRevision, audit} = {}) {
    const timestamp = monotonicStoreTimestamp(this.clock,this.state);
    assertJsonSafe(value, this.limits, 'record.value');
    assertNameLimit(value, 'record.value', this.limits);
    const validated = validatorResult(this.validateRecord, value, 'record.value');
    assertJsonSafe(validated, this.limits, 'record.value');
    assertNameLimit(validated, 'record.value', this.limits);
    let id;
    const reservedIds = new Set(this.reservedIds());
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.idFactory();
      assertId(candidate);
      if (!reservedIds.has(candidate)) { id = candidate; break; }
    }
    if (!id) throw new StorageValidationError('Could not allocate a unique record id');
    const record = {
      id,
      revision: 1,
      updatedAt: timestamp,
      value: jsonClone(validated, this.limits, 'record.value'),
    };
    const next = {
      ...jsonClone(this.state, this.limits, 'working copy'),
      revision: this.state.revision + 1,
      updatedAt: timestamp,
      records: [...this.state.records, record],
    };
    const auditMeta = normalizeAudit(audit, {source: 'local-ui', reason: 'created'});
    appendHistory(next.history, record, 'create', timestamp, auditMeta, next.records, this.limits);
    if (next.records.length > this.limits.maxRecords) throw new StorageValidationError(`At most ${this.limits.maxRecords} records are allowed`);
    this.persist(next, {expectedRevision, reason: 'create'});
    return this.select(record.id).record;
  }

  update(id, value, {expectedRevision, expectedRecordRevision, audit} = {}) {
    if (typeof id !== 'string' || id.length === 0) throw new NoSelectionError();
    const index = this.state.records.findIndex(entry => entry.id === id);
    if (index < 0) throw new NoSelectionError('The selected record does not exist');
    const current = this.state.records[index];
    if (expectedRecordRevision !== undefined && expectedRecordRevision !== current.revision) {
      throw new RevisionConflictError(`Expected record revision ${expectedRecordRevision}, current revision is ${current.revision}`);
    }
    assertJsonSafe(value, this.limits, 'record.value');
    assertNameLimit(value, 'record.value', this.limits);
    const validated = validatorResult(this.validateRecord, value, 'record.value');
    assertJsonSafe(validated, this.limits, 'record.value');
    assertNameLimit(validated, 'record.value', this.limits);
    const timestamp = monotonicStoreTimestamp(this.clock,this.state);
    const next = jsonClone(this.state, this.limits, 'working copy');
    next.records[index] = {
      id,
      revision: current.revision + 1,
      updatedAt: timestamp,
      value: jsonClone(validated, this.limits, 'record.value'),
    };
    next.revision = this.state.revision + 1;
    next.updatedAt = timestamp;
    appendHistory(
      next.history,
      next.records[index],
      'update',
      timestamp,
      normalizeAudit(audit, {source: 'local-ui', reason: 'updated'}),
      next.records,
      this.limits,
    );
    this.persist(next, {expectedRevision, reason: 'update'});
    return this.select(id).record;
  }

  delete(id, {expectedRevision, expectedRecordRevision, audit} = {}) {
    if (typeof id !== 'string' || id.length === 0) throw new NoSelectionError();
    const index = this.state.records.findIndex(entry => entry.id === id);
    if (index < 0) throw new NoSelectionError('The selected record does not exist');
    const current = this.state.records[index];
    if (expectedRecordRevision !== undefined && expectedRecordRevision !== current.revision) {
      throw new RevisionConflictError(`Expected record revision ${expectedRecordRevision}, current revision is ${current.revision}`);
    }
    const timestamp = monotonicStoreTimestamp(this.clock,this.state);
    const next = jsonClone(this.state, this.limits, 'working copy');
    next.records.splice(index, 1);
    next.revision = this.state.revision + 1;
    next.updatedAt = timestamp;
    privacyDeleteHistory(
      next.history,
      current,
      timestamp,
      normalizeAudit(audit, {source: 'local-ui', reason: 'privacy-delete'}),
      next.records,
      this.limits,
    );
    this.persist(next, {expectedRevision, reason: 'delete'});
    return deepFreeze(jsonClone(current, this.limits, 'deleted record'));
  }
}

export class WorkspaceRepository extends VersionedStore {
  constructor(options) {
    super({...options, kind: STORAGE_KINDS.workspace});
  }

  get() {
    return this.snapshot().workspace;
  }

  save(workspace, {expectedRevision} = {}) {
    assertJsonSafe(workspace, this.limits, 'workspace');
    assertWorkspaceIsolation(workspace);
    const validated = validatorResult(this.validateWorkspace, workspace, 'workspace');
    assertJsonSafe(validated, this.limits, 'workspace');
    assertWorkspaceIsolation(validated);
    const timestamp = monotonicStoreTimestamp(this.clock,this.state);
    const next = {
      format: STORAGE_FORMAT,
      schemaVersion: STORAGE_SCHEMA_VERSION,
      kind: STORAGE_KINDS.workspace,
      revision: this.state.revision + 1,
      updatedAt: timestamp,
      workspace: jsonClone(validated, this.limits, 'workspace'),
    };
    this.persist(next, {expectedRevision, reason: 'save-workspace'});
    return this.get();
  }

  clear({expectedRevision} = {}) {
    const timestamp = monotonicStoreTimestamp(this.clock,this.state);
    return this.persist({
      format: STORAGE_FORMAT,
      schemaVersion: STORAGE_SCHEMA_VERSION,
      kind: STORAGE_KINDS.workspace,
      revision: this.state.revision + 1,
      updatedAt: timestamp,
      workspace: null,
    }, {expectedRevision, reason: 'clear-workspace'});
  }
}

export function createRowerRepository(options) {
  return new CollectionRepository({...options, kind: STORAGE_KINDS.rowers, key: options?.key ?? STORAGE_KEYS.rowers});
}

export function createBoatRepository(options) {
  return new CollectionRepository({...options, kind: STORAGE_KINDS.boats, key: options?.key ?? STORAGE_KEYS.boats});
}

export function createEfaCandidateRepository(options) {
  return new CollectionRepository({
    ...options,
    kind: STORAGE_KINDS.efaCandidates,
    key: options?.key ?? STORAGE_KEYS.efaCandidates,
  });
}

export function createWorkspaceRepository(options) {
  return new WorkspaceRepository({...options, key: options?.key ?? STORAGE_KEYS.workspace});
}
