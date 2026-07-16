import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRowerDTO,
  hasHiddenSingleSeatProfile,
  migrateBoatToCurrent,
  migrateCurrentConfigToCurrent,
  migrateRowerToCurrent,
  SCHEMA_VERSION,
  validateBoat,
  validateCurrentConfig,
  validateRower,
} from '../js/core.mjs';
import {
  EXCHANGE_FORMAT,
  EXCHANGE_SCHEMA_VERSION,
  MigrationPendingError,
  NoSelectionError,
  RevisionConflictError,
  STORAGE_KEYS,
  STORAGE_KINDS,
  STORAGE_SCHEMA_VERSION,
  StorageValidationError,
  UnsafeRecoveryError,
  createMemoryStorage,
  createBoatRepository,
  createRowerRepository,
  createStableId,
  createWorkspaceRepository,
  parseImportEnvelope,
  withExclusiveRepositoryWrite,
} from '../js/storage.mjs';

function makeClock(start = Date.UTC(2026, 6, 15, 8, 0, 0)) {
  let tick = 0;
  return () => new Date(start + tick++ * 1_000);
}

function makeIds(prefix = 'record') {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function validateProfile(value, path = 'profile') {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({path, code: 'type'});
  } else {
    if (typeof value.name !== 'string' || value.name.length === 0) errors.push({path: `${path}.name`, code: 'name'});
    if (typeof value.score !== 'number' || !Number.isFinite(value.score)) errors.push({path: `${path}.score`, code: 'finite'});
    else if (value.score < 0 || value.score > 100) errors.push({path: `${path}.score`, code: 'range'});
  }
  return {ok: errors.length === 0, value, errors};
}

function makeRepository(storage = createMemoryStorage(), overrides = {}) {
  return createRowerRepository({
    storage,
    validateRecord: validateProfile,
    clock: makeClock(),
    idFactory: makeIds(),
    channelFactory: false,
    storageEventTarget: null,
    ...overrides,
  });
}

function legacyProfileEnvelope({exchange = false, revision = 7, records} = {}) {
  const timestamp = '2026-07-15T07:00:00.000Z';
  return {
    format: exchange ? EXCHANGE_FORMAT : 'rudertrimm.storage',
    schemaVersion: exchange ? EXCHANGE_SCHEMA_VERSION : 2,
    kind: STORAGE_KINDS.rowers,
    ...(exchange ? {exportedAt: timestamp} : {revision, updatedAt: timestamp}),
    records: records ?? [{
      id: 'legacy-profile', revision: 3, updatedAt: timestamp,
      value: {displayName: 'Altprofil', points: 73},
    }],
  };
}

function migrateLegacyProfile(value) {
  if (!Object.hasOwn(value, 'points')) return value;
  return {name: value.name ?? value.displayName, score: value.points};
}

function validSingleSeatConfigWithHiddenProfile() {
  const seat = {
    schemaVersion: 2, kind: 'seat',
    rig: 'skull', DA: 159, IH: 88, L: 288, d: 2, handGap: 18, a: 15, anlage: 4,
    aussen: 0, dBB: 0.5, stemmW: 42, rollL: 75, rueh: 5,
  };
  const rower = name => ({
    schemaVersion: 2, kind: 'rower', name,
    legLen: 90, torsoLen: 95, wingspan: 188, SB: 40, weight: 80, stemmX: 48,
  });
  return {
    schemaVersion: 2,
    kind: 'currentConfig',
    boat: {
      schemaVersion: 2, kind: 'boat', name: 'Einer', preset: '1x', blade: 'big', rig: 'skull',
      strokeSide: 1, phiA: 66, phiR: 44, c: 8, seatOffset: 5,
      s1: {...seat}, s2: {...seat},
    },
    crew: {s1: rower('Schlagmann'), s2: rower('Verborgene Person')},
    editSeat: 's1', mode: 'werkstatt', heightRef: 'sitz', kg: 0, t: 0, recovery: false,
  };
}

test('null and wrong-root storage recover to an empty envelope and quarantine the raw value', () => {
  for (const raw of ['null', '{}', '"wrong root"']) {
    const storage = createMemoryStorage({[STORAGE_KEYS.rowers]: raw});
    const repository = makeRepository(storage);
    const result = repository.load();

    assert.equal(result.ok, false);
    assert.equal(result.recovered, true);
    assert.deepEqual(repository.list(), []);
    assert.equal(result.quarantine.stored, true);
    assert.equal(storage.getItem(result.quarantine.key), raw);
    assert.equal(storage.getItem(STORAGE_KEYS.rowers), raw, 'recovery must not destroy the original before an explicit commit');

    repository.create({name: 'Recovered', score: 50});
    assert.equal(repository.list().length, 1);
    assert.notEqual(storage.getItem(STORAGE_KEYS.rowers), raw);
    repository.close();
  }
});

test('identical corrupt payload is quarantined only once across repository instances', () => {
  const raw = 'null';
  const storage = createMemoryStorage({[STORAGE_KEYS.rowers]: raw});
  const keys = [];

  for (let index = 0; index < 3; index += 1) {
    const repository = makeRepository(storage);
    const result = repository.load();
    keys.push(result.quarantine.key);
    if (index > 0) assert.equal(result.quarantine.deduplicated, true);
    repository.close();
  }

  const quarantineKeys = Array.from({length: storage.length}, (_, index) => storage.key(index))
    .filter(key => key.startsWith(STORAGE_KEYS.quarantinePrefix));
  assert.equal(new Set(keys).size, 1);
  assert.equal(quarantineKeys.length, 1);
  assert.equal(storage.getItem(quarantineKeys[0]), raw);
});

test('failed quarantine blocks replacement writes and preserves corrupt bytes exactly', () => {
  const backing = createMemoryStorage({[STORAGE_KEYS.rowers]: 'null'});
  const quarantineError = new Error('Quarantine quota exhausted');
  quarantineError.name = 'QuotaExceededError';
  const storage = {
    getItem: key => backing.getItem(key),
    removeItem: key => backing.removeItem(key),
    setItem(key, value) {
      if (String(key).startsWith(STORAGE_KEYS.quarantinePrefix)) throw quarantineError;
      backing.setItem(key, value);
    },
  };
  const repository = makeRepository(storage);
  const first = repository.load();

  assert.equal(first.ok, false);
  assert.equal(first.rawPresent, true);
  assert.equal(first.quarantine.stored, false);
  assert.equal(first.quarantine.error, quarantineError);
  assert.throws(() => repository.create({name: 'Darf nicht ersetzen', score: 50}), UnsafeRecoveryError);
  assert.equal(backing.getItem(STORAGE_KEYS.rowers), 'null');

  const repeated = repository.load();
  assert.equal(repeated.quarantine, first.quarantine, 'the first quarantine result must survive identical reloads');
  assert.throws(() => repository.importText(JSON.stringify({
    format: EXCHANGE_FORMAT,
    schemaVersion: EXCHANGE_SCHEMA_VERSION,
    kind: STORAGE_KINDS.rowers,
    exportedAt: '2026-07-15T08:00:00.000Z',
    records: [],
  })), UnsafeRecoveryError);
  assert.equal(backing.getItem(STORAGE_KEYS.rowers), 'null');
  repository.close();
});

test('read failure blocks writes until a successful load proves valid or absent bytes', () => {
  const backing = createMemoryStorage();
  let readsBlocked = true;
  const storage = {
    getItem(key) {
      if (readsBlocked) throw new Error('Storage read blocked');
      return backing.getItem(key);
    },
    setItem: (key, value) => backing.setItem(key, value),
    removeItem: key => backing.removeItem(key),
  };
  const repository = makeRepository(storage);
  const failed = repository.load();

  assert.equal(failed.ok, false);
  assert.equal(failed.rawPresent, null);
  assert.throws(() => repository.create({name: 'Noch gesperrt', score: 50}), UnsafeRecoveryError);
  assert.equal(backing.getItem(STORAGE_KEYS.rowers), null);

  readsBlocked = false;
  const recovered = repository.load();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.rawPresent, false);
  const record = repository.create({name: 'Wieder möglich', score: 50});
  assert.equal(record.value.name, 'Wieder möglich');
  repository.close();
});

test('mixed valid and invalid imports fail atomically with record-level schema errors', () => {
  const source = makeRepository();
  source.load();
  source.create({name: 'Valid', score: 80});
  source.create({name: 'Invalid later', score: 90});
  const envelope = JSON.parse(source.exportText());
  envelope.records[1].value.score = 101;

  const target = makeRepository();
  target.load();
  target.create({name: 'Existing', score: 70});
  const before = target.snapshot();

  assert.throws(() => target.importText(JSON.stringify(envelope)), StorageValidationError);
  assert.deepEqual(target.snapshot(), before);
  source.close();
  target.close();
});

test('markup-looking strings remain inert data in the storage layer', () => {
  delete globalThis.__rudertrimmStoragePwned;
  const repository = makeRepository();
  repository.load();
  const payload = '<img src=x onerror=globalThis.__rudertrimmStoragePwned=1>';
  const created = repository.create({name: payload, score: 50});

  assert.equal(created.value.name, payload);
  assert.equal(repository.select(created.id).record.value.name, payload);
  assert.equal(globalThis.__rudertrimmStoragePwned, undefined);
  assert.equal(JSON.parse(repository.storage.getItem(STORAGE_KEYS.rowers)).records[0].value.name, payload);
  repository.close();
});

test('nonfinite numbers and injected domain ranges are rejected before commit', () => {
  const repository = makeRepository();
  repository.load();

  assert.throws(() => repository.create({name: 'Infinity', score: Infinity}), /finite/);
  assert.throws(() => repository.create({name: 'NaN', score: NaN}), /finite/);
  assert.throws(() => repository.create({name: 'Out of range', score: 101}), StorageValidationError);
  assert.deepEqual(repository.list(), []);
  assert.equal(repository.storage.getItem(STORAGE_KEYS.rowers), null);
  repository.close();
});

test('quota failure leaves both in-memory and persisted state unchanged', () => {
  const backing = createMemoryStorage();
  const quotaStorage = {
    getItem: key => backing.getItem(key),
    removeItem: key => backing.removeItem(key),
    setItem() {
      const error = new Error('Storage quota exhausted');
      error.name = 'QuotaExceededError';
      throw error;
    },
  };
  const repository = makeRepository(quotaStorage);
  repository.load();
  const before = repository.snapshot();

  assert.throws(() => repository.create({name: 'Does not fit', score: 50}), {name: 'QuotaExceededError'});
  assert.deepEqual(repository.snapshot(), before);
  assert.equal(backing.getItem(STORAGE_KEYS.rowers), null);
  repository.close();
});

test('supported record migration stays pending until one revisioned atomic commit', () => {
  const unchanged = {
    id: 'current-profile', revision: 5, updatedAt: '2026-07-15T07:00:00.000Z',
    value: {name: 'Aktuell', score: 81},
  };
  const envelope = legacyProfileEnvelope({records: [
    legacyProfileEnvelope().records[0],
    unchanged,
  ]});
  const raw = JSON.stringify(envelope);
  const storage = createMemoryStorage({[STORAGE_KEYS.rowers]: raw});
  const repository = makeRepository(storage, {migrateRecord: migrateLegacyProfile});

  const loaded = repository.load();
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.migration, {
    migrated: true, recordIds: ['legacy-profile'], workspace: false,
  });
  assert.deepEqual(repository.migrationStatus(), {
    pending: true, recordIds: ['legacy-profile'], workspace: false,
  });
  assert.equal(repository.select('legacy-profile').record.value.score, 73);
  assert.equal(storage.getItem(STORAGE_KEYS.rowers), raw, 'read-time migration must not write');
  assert.throws(() => repository.create({name: 'Zu früh', score: 50}), MigrationPendingError);

  const committed = repository.commitPendingMigration({expectedRevision: 7});
  assert.deepEqual(committed, {
    changed: true, revision: 8, recordIds: ['legacy-profile'], workspace: false,
  });
  const persisted = JSON.parse(storage.getItem(STORAGE_KEYS.rowers));
  assert.equal(persisted.revision, 8);
  assert.equal(persisted.records[0].id, 'legacy-profile');
  assert.equal(persisted.records[0].revision, 4);
  assert.equal(persisted.records[0].value.score, 73);
  assert.equal(persisted.records[1].id, unchanged.id);
  assert.equal(persisted.records[1].revision, unchanged.revision,
    'records that needed no value migration retain their revision');
  assert.equal(persisted.records[1].updatedAt, unchanged.updatedAt);

  const rawAfterCommit = storage.getItem(STORAGE_KEYS.rowers);
  assert.deepEqual(repository.commitPendingMigration(), {
    changed: false, revision: 8, recordIds: [], workspace: false,
  });
  assert.equal(storage.getItem(STORAGE_KEYS.rowers), rawAfterCommit, 'idempotent commit must not write twice');
  repository.close();
});

test('a changed migration value cannot suppress pending state with migrated false', () => {
  const raw = JSON.stringify(legacyProfileEnvelope());
  const storage = createMemoryStorage({[STORAGE_KEYS.rowers]: raw});
  const repository = makeRepository(storage, {
    migrateRecord(value) {
      return {value: migrateLegacyProfile(value), migrated: false};
    },
  });

  const loaded = repository.load();
  assert.equal(loaded.migration.migrated, true);
  assert.equal(repository.migrationStatus().pending, true);
  assert.equal(storage.getItem(STORAGE_KEYS.rowers), raw);
  assert.throws(() => repository.create({name: 'Gesperrt', score: 50}), MigrationPendingError);

  repository.commitPendingMigration();
  const persisted = JSON.parse(storage.getItem(STORAGE_KEYS.rowers));
  assert.equal(persisted.records[0].revision, 4);
  assert.equal(persisted.records[0].value.score, 73);
  repository.close();
});

test('workspace migration is validated, write-blocking, and committed exactly once', () => {
  const raw = JSON.stringify({
    format: 'rudertrimm.storage',
    schemaVersion: STORAGE_SCHEMA_VERSION,
    kind: STORAGE_KINDS.workspace,
    revision: 4,
    updatedAt: '2026-07-15T07:00:00.000Z',
    workspace: {name: 'Alt-Arbeitsstand', oldMode: 'bench'},
  });
  const storage = createMemoryStorage({[STORAGE_KEYS.workspace]: raw});
  const validateWorkspace = value => ({
    ok: value?.mode === 'werkstatt', value,
    errors: value?.mode === 'werkstatt' ? [] : [{path: 'workspace.mode', code: 'enum'}],
  });
  const workspace = createWorkspaceRepository({
    storage,
    validateWorkspace,
    migrateWorkspace(value) {
      if (!Object.hasOwn(value, 'oldMode')) return value;
      return {name: value.name, mode: value.oldMode === 'bench' ? 'werkstatt' : value.oldMode};
    },
    clock: makeClock(),
    channelFactory: false,
    storageEventTarget: null,
  });

  const loaded = workspace.load();
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.migration, {migrated: true, recordIds: [], workspace: true});
  assert.equal(workspace.get().mode, 'werkstatt');
  assert.equal(storage.getItem(STORAGE_KEYS.workspace), raw);
  assert.throws(() => workspace.save({name: 'Neu', mode: 'werkstatt'}), MigrationPendingError);

  assert.deepEqual(workspace.commitPendingMigration(), {
    changed: true, revision: 5, recordIds: [], workspace: true,
  });
  const persisted = JSON.parse(storage.getItem(STORAGE_KEYS.workspace));
  assert.equal(persisted.revision, 5);
  assert.deepEqual(persisted.workspace, {name: 'Alt-Arbeitsstand', mode: 'werkstatt'});
  assert.equal(workspace.commitPendingMigration().changed, false);
  workspace.close();
});

test('rower and boat repository factories accept the real pure Core v2 migrators', () => {
  const legacyConfig = validSingleSeatConfigWithHiddenProfile();
  const cases = [{
    kind: STORAGE_KINDS.rowers,
    key: STORAGE_KEYS.rowers,
    value: legacyConfig.crew.s1,
    create: options => createRowerRepository(options),
    validateRecord: validateRower,
    migrateRecord: migrateRowerToCurrent,
  }, {
    kind: STORAGE_KINDS.boats,
    key: STORAGE_KEYS.boats,
    value: legacyConfig.boat,
    create: options => createBoatRepository(options),
    validateRecord: validateBoat,
    migrateRecord: migrateBoatToCurrent,
  }];

  for (const entry of cases) {
    const raw = JSON.stringify({
      format: 'rudertrimm.storage',
      schemaVersion: 2,
      kind: entry.kind,
      revision: 2,
      updatedAt: '2026-07-15T07:00:00.000Z',
      records: [{
        id: 'stable-record', revision: 3, updatedAt: '2026-07-15T07:00:00.000Z', value: entry.value,
      }],
    });
    const storage = createMemoryStorage({[entry.key]: raw});
    const repository = entry.create({
      storage,
      validateRecord: entry.validateRecord,
      migrateRecord: entry.migrateRecord,
      clock: makeClock(),
      channelFactory: false,
      storageEventTarget: null,
    });

    const loaded = repository.load();
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.migration.recordIds, ['stable-record']);
    assert.equal(repository.select('stable-record').record.value.schemaVersion, SCHEMA_VERSION);
    assert.equal(storage.getItem(entry.key), raw, 'Core migration remains read-only until commit');

    repository.commitPendingMigration({expectedRevision: 2});
    const persisted = JSON.parse(storage.getItem(entry.key));
    assert.equal(persisted.records[0].id, 'stable-record');
    assert.equal(persisted.records[0].revision, 4);
    assert.equal(persisted.records[0].value.schemaVersion, SCHEMA_VERSION);
    repository.close();
  }
});

test('mixed valid and invalid stored migrations abort without a partial pending state', () => {
  const envelope = legacyProfileEnvelope({records: [
    legacyProfileEnvelope().records[0],
    {
      id: 'invalid-later', revision: 2, updatedAt: '2026-07-15T07:00:00.000Z',
      value: {name: 'Ungültig', points: 150},
    },
  ]});
  const raw = JSON.stringify(envelope);
  const storage = createMemoryStorage({[STORAGE_KEYS.rowers]: raw});
  const repository = makeRepository(storage, {migrateRecord: migrateLegacyProfile});

  const loaded = repository.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.recovered, true);
  assert.equal(loaded.quarantine.stored, true);
  assert.deepEqual(repository.migrationStatus(), {pending: false, recordIds: [], workspace: false});
  assert.equal(storage.getItem(STORAGE_KEYS.rowers), raw);
  assert.deepEqual(repository.list(), []);
  repository.close();
});

test('migration quota failure preserves source bytes and a retryable pending plan', () => {
  const raw = JSON.stringify(legacyProfileEnvelope());
  const backing = createMemoryStorage({[STORAGE_KEYS.rowers]: raw});
  let failWrites = true;
  const storage = {
    getItem: key => backing.getItem(key),
    removeItem: key => backing.removeItem(key),
    setItem(key, value) {
      if (key === STORAGE_KEYS.rowers && failWrites) {
        const error = new Error('Migration quota exhausted');
        error.name = 'QuotaExceededError';
        throw error;
      }
      backing.setItem(key, value);
    },
  };
  const repository = makeRepository(storage, {migrateRecord: migrateLegacyProfile});
  repository.load();

  assert.throws(() => repository.commitPendingMigration(), {name: 'QuotaExceededError'});
  assert.equal(backing.getItem(STORAGE_KEYS.rowers), raw);
  assert.deepEqual(repository.migrationStatus(), {
    pending: true, recordIds: ['legacy-profile'], workspace: false,
  });
  assert.throws(() => repository.create({name: 'Weiter gesperrt', score: 50}), MigrationPendingError);

  failWrites = false;
  assert.equal(repository.commitPendingMigration().revision, 8);
  assert.equal(JSON.parse(backing.getItem(STORAGE_KEYS.rowers)).records[0].revision, 4);
  repository.close();
});

test('future envelope plus Core record/workspace schemas preserve bytes, avoid quarantine, and block writes', () => {
  const futureEnvelope = legacyProfileEnvelope();
  futureEnvelope.schemaVersion = STORAGE_SCHEMA_VERSION + 1;
  futureEnvelope.addedByFuture = true;
  const futureRaw = JSON.stringify(futureEnvelope);
  const futureStorage = createMemoryStorage({[STORAGE_KEYS.rowers]: futureRaw});
  const futureRepository = makeRepository(futureStorage, {migrateRecord: migrateLegacyProfile});
  const future = futureRepository.load();

  assert.equal(future.ok, false);
  assert.equal(future.recovered, false);
  assert.equal(future.unsupportedSchema, true);
  assert.equal(future.error.code, 'unsupported-schema');
  assert.equal(future.quarantine, null);
  assert.equal(futureStorage.getItem(STORAGE_KEYS.rowers), futureRaw);
  assert.equal([...Array(futureStorage.length).keys()].map(index => futureStorage.key(index))
    .some(key => key?.startsWith(STORAGE_KEYS.quarantinePrefix)), false);
  assert.throws(
    () => futureRepository.create({name: 'Nicht überschreiben', score: 50}),
    error => error?.code === 'unsupported-schema',
  );
  futureRepository.close();

  const futureRower = {...validSingleSeatConfigWithHiddenProfile().crew.s1, schemaVersion: SCHEMA_VERSION + 1};
  const domainEnvelope = legacyProfileEnvelope({records: [{
    id: 'future-domain', revision: 1, updatedAt: '2026-07-15T07:00:00.000Z',
    value: futureRower,
  }]});
  const domainRaw = JSON.stringify(domainEnvelope);
  const domainStorage = createMemoryStorage({[STORAGE_KEYS.rowers]: domainRaw});
  const domainRepository = createRowerRepository({
    storage: domainStorage,
    validateRecord: validateRower,
    migrateRecord: migrateRowerToCurrent,
    clock: makeClock(),
    idFactory: makeIds(),
    channelFactory: false,
    storageEventTarget: null,
  });
  const domain = domainRepository.load();
  assert.equal(domain.error.code, 'unsupported-schema');
  assert.equal(domain.recovered, false);
  assert.equal(domain.quarantine, null);
  assert.equal(domainStorage.getItem(STORAGE_KEYS.rowers), domainRaw);
  assert.throws(
    () => domainRepository.create(buildRowerDTO({
      name: 'Aktuell', legLen: 90, torsoLen: 95, wingspan: 188, SB: 40, weight: 80, stemmX: 48,
    })),
    error => error?.code === 'unsupported-schema',
  );
  domainRepository.close();

  const workspaceRaw = JSON.stringify({
    format: 'rudertrimm.storage',
    schemaVersion: STORAGE_SCHEMA_VERSION,
    kind: STORAGE_KINDS.workspace,
    revision: 3,
    updatedAt: '2026-07-15T07:00:00.000Z',
    workspace: {schemaVersion: SCHEMA_VERSION + 1, kind: 'currentConfig'},
  });
  const workspaceStorage = createMemoryStorage({[STORAGE_KEYS.workspace]: workspaceRaw});
  const workspace = createWorkspaceRepository({
    storage: workspaceStorage,
    validateWorkspace: validateCurrentConfig,
    migrateWorkspace: migrateCurrentConfigToCurrent,
    clock: makeClock(),
    channelFactory: false,
    storageEventTarget: null,
  });
  const futureWorkspace = workspace.load();
  assert.equal(futureWorkspace.error.code, 'unsupported-schema');
  assert.equal(futureWorkspace.recovered, false);
  assert.equal(futureWorkspace.quarantine, null);
  assert.equal(workspaceStorage.getItem(STORAGE_KEYS.workspace), workspaceRaw);
  assert.equal([...Array(workspaceStorage.length).keys()].map(index => workspaceStorage.key(index))
    .some(key => key?.startsWith(STORAGE_KEYS.quarantinePrefix)), false);
  assert.throws(() => workspace.clear(), error => error?.code === 'unsupported-schema');
  assert.equal(workspaceStorage.getItem(STORAGE_KEYS.workspace), workspaceRaw);
  workspace.close();
});

test('import parsing migrates side-effect-free and reports exact migration metadata', () => {
  const envelope = legacyProfileEnvelope({exchange: true});
  const text = JSON.stringify(envelope);
  let calls = 0;
  const parsed = parseImportEnvelope(text, {
    expectedKind: STORAGE_KINDS.rowers,
    validateRecord: validateProfile,
    migrateRecord(value, context) {
      calls += 1;
      assert.equal(context.storage, false);
      assert.equal(context.record.id, 'legacy-profile');
      return migrateLegacyProfile(value);
    },
  });

  assert.equal(parsed.ok, true);
  assert.equal(calls, 1);
  assert.deepEqual(parsed.migration, {
    migrated: true, recordIds: ['legacy-profile'], workspace: false,
  });
  assert.equal(parsed.envelope.records[0].value.score, 73);
  assert.equal(envelope.records[0].value.points, 73, 'the caller-owned import object remains untouched');
  assert.equal(text, JSON.stringify(envelope), 'parsing has no storage or input side effect');
});

test('import commit advances only migrated record revisions once', () => {
  const storage = createMemoryStorage();
  const repository = makeRepository(storage, {migrateRecord: migrateLegacyProfile});
  repository.load();
  const text = JSON.stringify(legacyProfileEnvelope({exchange: true}));

  repository.importText(text, {expectedRevision: 0});
  const persisted = JSON.parse(storage.getItem(STORAGE_KEYS.rowers));
  assert.equal(persisted.revision, 1);
  assert.equal(persisted.records[0].id, 'legacy-profile');
  assert.equal(persisted.records[0].revision, 4);
  assert.equal(persisted.records[0].updatedAt, persisted.updatedAt);
  assert.deepEqual(persisted.records[0].value, {name: 'Altprofil', score: 73});
  assert.equal(text, JSON.stringify(legacyProfileEnvelope({exchange: true})), 'import source bytes stay untouched');
  repository.close();
});

test('late external legacy bytes become pending and commit under the existing write lock', async () => {
  const storage = createMemoryStorage();
  const repository = makeRepository(storage, {migrateRecord: migrateLegacyProfile});
  repository.load();
  storage.setItem(STORAGE_KEYS.rowers, JSON.stringify(legacyProfileEnvelope({revision: 11})));

  const lockRequests = [];
  const lockManager = {
    request(name, options, callback) {
      lockRequests.push({name, options});
      return callback();
    },
  };
  const result = await withExclusiveRepositoryWrite(
    repository,
    () => repository.commitPendingMigration({expectedRevision: 11}),
    {lockManager},
  );

  assert.equal(result.changed, true);
  assert.equal(result.revision, 12);
  assert.equal(repository.select('legacy-profile').record.value.score, 73);
  assert.equal(lockRequests.length, 1);
  assert.equal(lockRequests[0].name, `rudertrimm:v2:repository-write:${STORAGE_KEYS.rowers}`);
  assert.equal(repository.migrationStatus().pending, false);
  repository.close();
});

test('pending migration never overwrites bytes changed after its read', () => {
  const originalRaw = JSON.stringify(legacyProfileEnvelope());
  const storage = createMemoryStorage({[STORAGE_KEYS.rowers]: originalRaw});
  const repository = makeRepository(storage, {migrateRecord: migrateLegacyProfile});
  repository.load();

  const externalRaw = JSON.stringify(legacyProfileEnvelope({revision: 9, records: [{
    id: 'external-current', revision: 1, updatedAt: '2026-07-15T07:00:00.000Z',
    value: {name: 'Extern', score: 88},
  }]}));
  storage.setItem(STORAGE_KEYS.rowers, externalRaw);
  assert.throws(() => repository.commitPendingMigration(), RevisionConflictError);
  assert.equal(storage.getItem(STORAGE_KEYS.rowers), externalRaw);
  assert.equal(repository.migrationStatus().pending, true,
    'the stale plan remains visible until the lock reloads the fresh source');

  repository.reloadFromExternal('test-conflict-refresh');
  assert.equal(repository.migrationStatus().pending, true,
    'the fresh v2 storage envelope now has its own retryable v3 history-baseline migration');
  assert.equal(repository.select('external-current').record.value.score, 88);
  repository.commitPendingMigration({expectedRevision:9});
  assert.equal(repository.migrationStatus().pending, false);
  repository.close();
});

test('versioned export/import roundtrip preserves ids, record revisions, and inert values', () => {
  const source = makeRepository();
  source.load();
  source.create({name: 'Alex', score: 91});
  source.create({name: 'Ivan', score: 77});
  const text = source.exportText();
  const exported = JSON.parse(text);

  assert.equal(exported.format, EXCHANGE_FORMAT);
  assert.equal(exported.schemaVersion, EXCHANGE_SCHEMA_VERSION);
  assert.equal(exported.kind, STORAGE_KINDS.rowers);

  const target = makeRepository(createMemoryStorage(), {idFactory: makeIds('target')});
  target.load();
  target.importText(text);
  assert.deepEqual(target.list(), source.list());
  source.close();
  target.close();
});

test('stale repository and stale expected revisions raise optimistic conflicts', () => {
  const storage = createMemoryStorage();
  const first = makeRepository(storage, {idFactory: makeIds('first')});
  const stale = makeRepository(storage, {idFactory: makeIds('stale')});
  first.load();
  stale.load();

  first.create({name: 'First writer', score: 50});
  assert.throws(() => stale.create({name: 'Stale writer', score: 60}), RevisionConflictError);
  assert.equal(first.list().length, 1);

  stale.load();
  assert.throws(() => stale.create({name: 'Wrong revision', score: 60}, {expectedRevision: 0}), RevisionConflictError);
  assert.equal(stale.list().length, 1);
  first.close();
  stale.close();
});

test('exclusive repository writes serialize stale tabs before read-compare-write', async () => {
  const storage = createMemoryStorage();
  const first = makeRepository(storage, {idFactory: makeIds('first')});
  const second = makeRepository(storage, {idFactory: makeIds('second')});
  first.load();
  second.load();

  let tail = Promise.resolve();
  const requests = [];
  const lockManager = {
    request(name, options, callback) {
      requests.push({name, options});
      const result = tail.then(() => callback());
      tail = result.catch(() => undefined);
      return result;
    },
  };

  const [firstRecord, secondRecord] = await Promise.all([
    withExclusiveRepositoryWrite(first, () => first.create(
      {name: 'Tab A', score: 50},
      {expectedRevision: first.snapshot().revision},
    ), {lockManager}),
    withExclusiveRepositoryWrite(second, () => second.create(
      {name: 'Tab B', score: 60},
      {expectedRevision: second.snapshot().revision},
    ), {lockManager}),
  ]);

  const persisted = JSON.parse(storage.getItem(STORAGE_KEYS.rowers));
  assert.equal(persisted.revision, 2);
  assert.deepEqual(persisted.records.map(record => record.value.name), ['Tab A', 'Tab B']);
  assert.notEqual(firstRecord.id, secondRecord.id);
  assert.equal(requests.length, 2);
  assert.equal(new Set(requests.map(request => request.name)).size, 1);
  assert.deepEqual(requests.map(request => request.options.mode), ['exclusive', 'exclusive']);
  first.close();
  second.close();
});

test('shared writes fail closed without Web Locks while tab-local writes remain usable', async () => {
  const repository = makeRepository();
  repository.load();
  let calls = 0;

  await assert.rejects(
    withExclusiveRepositoryWrite(repository, () => { calls += 1; }, {lockManager: null}),
    error => error?.code === 'coordination-unavailable',
  );
  assert.equal(calls, 0);

  const record = await withExclusiveRepositoryWrite(repository, () => {
    calls += 1;
    return repository.create({name: 'Nur dieser Tab', score: 70});
  }, {lockManager: null, shared: false});
  assert.equal(record.value.name, 'Nur dieser Tab');
  assert.equal(calls, 1);
  repository.close();
});

test('no-selection is explicit and can never fall through to record zero', () => {
  const repository = makeRepository();
  repository.load();
  const record = repository.create({name: 'Record zero equivalent', score: 50});

  assert.deepEqual(repository.select(''), {ok: false, code: 'no-selection', record: null});
  assert.throws(() => repository.update('', {name: 'Overwrite', score: 20}), NoSelectionError);
  assert.throws(() => repository.delete(''), NoSelectionError);
  assert.equal(repository.select(record.id).record.value.name, 'Record zero equivalent');
  assert.equal(repository.list().length, 1);
  repository.close();
});

test('record revision conflicts are detected independently from repository revision', () => {
  const repository = makeRepository();
  repository.load();
  const record = repository.create({name: 'Versioned', score: 50});
  const updated = repository.update(record.id, {name: 'Versioned', score: 60}, {expectedRecordRevision: 1});
  assert.equal(updated.revision, 2);
  assert.throws(
    () => repository.update(record.id, {name: 'Versioned', score: 70}, {expectedRecordRevision: 1}),
    RevisionConflictError,
  );
  assert.equal(repository.select(record.id).record.value.score, 60);
  repository.close();
});

test('workspace has a separate key and rejects database arrays at every depth', () => {
  const storage = createMemoryStorage();
  const workspace = createWorkspaceRepository({
    storage,
    validateWorkspace: value => ({ok: true, value, errors: []}),
    clock: makeClock(),
    channelFactory: false,
    storageEventTarget: null,
  });
  workspace.load();
  workspace.save({schemaVersion: 2, kind: 'currentConfig', boat: {name: 'One'}, crew: {s1: {}, s2: {}}});

  assert.ok(storage.getItem(STORAGE_KEYS.workspace));
  assert.equal(storage.getItem(STORAGE_KEYS.rowers), null);
  assert.equal(storage.getItem(STORAGE_KEYS.boats), null);
  assert.throws(() => workspace.save({schemaVersion: 2, db: []}), /forbidden/);
  assert.throws(() => workspace.save({schemaVersion: 2, settings: {boats: []}}), /forbidden/);
  assert.equal(Object.hasOwn(JSON.parse(storage.getItem(STORAGE_KEYS.workspace)), 'records'), false);
  workspace.close();
});

test('external legacy 1x workspace migrates under lock without retaining the hidden profile', async () => {
  const storage=createMemoryStorage();
  const observer=createWorkspaceRepository({
    storage,validateWorkspace:validateCurrentConfig,migrateWorkspace:migrateCurrentConfigToCurrent,clock:makeClock(),
    channelFactory:false,storageEventTarget:null,
  });
  observer.load();

  const legacySingle=validSingleSeatConfigWithHiddenProfile();
  assert.equal(hasHiddenSingleSeatProfile(legacySingle),true);
  const legacyRaw=JSON.stringify({
    format:'rudertrimm.storage',schemaVersion:STORAGE_SCHEMA_VERSION,kind:STORAGE_KINDS.workspace,
    revision:1,updatedAt:'2026-07-15T07:00:00.000Z',workspace:legacySingle,
  });

  const externalSyncs=[];
  const commits=[];
  observer.subscribe(event=>{
    if(event.type==='external-sync') externalSyncs.push(event);
    if(event.type==='commit') commits.push(event);
  });
  storage.setItem(STORAGE_KEYS.workspace,legacyRaw);
  assert.equal(observer.reloadFromExternal('test-external-1x'),true);
  assert.equal(observer.snapshot().revision,1);
  assert.deepEqual(observer.migrationStatus(),{pending:true,recordIds:[],workspace:true});
  assert.equal(observer.get().schemaVersion,SCHEMA_VERSION);
  assert.equal(observer.get().crew.length,1);
  assert.equal(storage.getItem(STORAGE_KEYS.workspace),legacyRaw,'external read must not rewrite legacy bytes');

  const lockRequests=[];
  const lockManager={
    async request(name,options,callback){
      lockRequests.push({name,options});
      return callback();
    },
  };
  const scrubInLock=()=>observer.commitPendingMigration({expectedRevision:observer.snapshot().revision});

  const first=await withExclusiveRepositoryWrite(observer,scrubInLock,{lockManager});
  assert.deepEqual(first,{changed:true,revision:2,recordIds:[],workspace:true});
  assert.equal(lockRequests.length,1);
  assert.equal(lockRequests[0].options.mode,'exclusive');
  assert.equal(lockRequests[0].name,`rudertrimm:v2:repository-write:${STORAGE_KEYS.workspace}`);
  assert.equal(commits.length,1);
  assert.equal(commits[0].revision,2);
  assert.equal(externalSyncs.length,1,'the locked scrub must not manufacture another external sync');

  const rawAfterFirst=storage.getItem(STORAGE_KEYS.workspace);
  const persistedAfterFirst=JSON.parse(rawAfterFirst);
  assert.equal(persistedAfterFirst.workspace.schemaVersion,SCHEMA_VERSION);
  assert.equal(persistedAfterFirst.workspace.crew.length,1);
  assert.doesNotMatch(rawAfterFirst,/Verborgene Person/u);
  assert.equal(hasHiddenSingleSeatProfile(observer.get()),false);

  const second=await withExclusiveRepositoryWrite(observer,scrubInLock,{lockManager});
  assert.deepEqual(second,{changed:false,revision:2,recordIds:[],workspace:false});
  assert.equal(storage.getItem(STORAGE_KEYS.workspace),rawAfterFirst,'idempotent scrub must not write again');
  assert.equal(commits.length,1,'idempotent scrub must not add a commit/revision');
  assert.equal(externalSyncs.length,1,'idempotent scrub must not add a sync cycle');
  assert.equal(lockRequests.length,2);

  observer.close();
});

test('name, record-count, and byte limits are enforced without partial writes', () => {
  const nameLimited = makeRepository(createMemoryStorage(), {limits: {maxNameLength: 5}});
  nameLimited.load();
  assert.throws(() => nameLimited.create({name: '123456', score: 50}), /1-5/);
  assert.equal(nameLimited.list().length, 0);

  const recordLimited = makeRepository(createMemoryStorage(), {limits: {maxRecords: 1}});
  recordLimited.load();
  recordLimited.create({name: 'One', score: 50});
  assert.throws(() => recordLimited.create({name: 'Two', score: 50}), /At most 1/);
  assert.equal(recordLimited.list().length, 1);

  const byteLimited = makeRepository(createMemoryStorage(), {limits: {maxBytes: 300}});
  byteLimited.load();
  assert.throws(() => byteLimited.create({name: 'Large', score: 50, note: 'x'.repeat(500)}), /exceeds 300/);
  assert.equal(byteLimited.list().length, 0);
  nameLimited.close();
  recordLimited.close();
  byteLimited.close();
});

test('parse and schema callbacks are injected and import errors are returned without throwing', () => {
  let parseCalls = 0;
  let validationCalls = 0;
  const parse = text => { parseCalls += 1; return JSON.parse(text); };
  const validateRecord = value => {
    validationCalls += 1;
    return validateProfile(value);
  };
  const result = parseImportEnvelope(JSON.stringify({
    format: EXCHANGE_FORMAT,
    schemaVersion: EXCHANGE_SCHEMA_VERSION,
    kind: STORAGE_KINDS.rowers,
    exportedAt: '2026-07-15T08:00:00.000Z',
    records: [{id: 'valid-1', revision: 1, updatedAt: '2026-07-15T08:00:00.000Z', value: {name: 'A', score: 50}}],
  }), {expectedKind: STORAGE_KINDS.rowers, parse, validateRecord});

  assert.equal(result.ok, true);
  assert.equal(parseCalls, 1);
  assert.equal(validationCalls, 1);

  const invalid = parseImportEnvelope('null', {expectedKind: STORAGE_KINDS.rowers, parse, validateRecord});
  assert.equal(invalid.ok, false);
  assert.equal(invalid.envelope, null);
});

test('storage-event hook reloads an externally committed revision', () => {
  const listeners = new Set();
  const eventTarget = {
    addEventListener(type, listener) { if (type === 'storage') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'storage') listeners.delete(listener); },
    dispatch(key) { for (const listener of listeners) listener({key}); },
  };
  const storage = createMemoryStorage();
  const writer = makeRepository(storage, {idFactory: makeIds('writer'), storageEventTarget: eventTarget});
  const observer = makeRepository(storage, {idFactory: makeIds('observer'), storageEventTarget: eventTarget});
  writer.load();
  observer.load();
  writer.create({name: 'Synced', score: 50});
  assert.equal(observer.list().length, 0);

  eventTarget.dispatch(STORAGE_KEYS.rowers);
  assert.equal(observer.list().length, 1);
  assert.equal(observer.list()[0].value.name, 'Synced');
  writer.close();
  observer.close();
});

test('BroadcastChannel hook synchronizes only the matching repository key', () => {
  const channels = [];
  const channelFactory = name => {
    const listeners = new Set();
    const channel = {
      name,
      addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
      removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
      postMessage(data) {
        for (const peer of channels) {
          if (peer !== channel && peer.name === name) for (const listener of peer.listeners) listener({data});
        }
      },
      close() {},
      listeners,
    };
    channels.push(channel);
    return channel;
  };
  const storage = createMemoryStorage();
  const writer = makeRepository(storage, {idFactory: makeIds('writer'), channelFactory});
  const observer = makeRepository(storage, {idFactory: makeIds('observer'), channelFactory});
  writer.load();
  observer.load();

  writer.create({name: 'Broadcast', score: 50});
  assert.equal(observer.list().length, 1);
  assert.equal(observer.list()[0].value.name, 'Broadcast');
  writer.close();
  observer.close();
});

test('BroadcastChannel plus storage event emits one sync per distinct raw value', () => {
  const storageListeners = new Set();
  const eventTarget = {
    addEventListener(type, listener) { if (type === 'storage') storageListeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'storage') storageListeners.delete(listener); },
    dispatch(event) { for (const listener of storageListeners) listener(event); },
  };
  const channels = [];
  const channelFactory = name => {
    const listeners = new Set();
    const channel = {
      name,
      listeners,
      addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
      removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
      postMessage(data) {
        for (const peer of channels) {
          if (peer !== channel && peer.name === name) for (const listener of peer.listeners) listener({data});
        }
      },
      close() {},
    };
    channels.push(channel);
    return channel;
  };
  const storage = createMemoryStorage();
  const writer = makeRepository(storage, {idFactory: makeIds('writer'), channelFactory, storageEventTarget: eventTarget});
  const observer = makeRepository(storage, {idFactory: makeIds('observer'), channelFactory, storageEventTarget: eventTarget});
  writer.load();
  observer.load();
  const syncEvents = [];
  observer.subscribe(event => { if (event.type === 'external-sync') syncEvents.push(event); });

  const record = writer.create({name: 'Erster Stand', score: 50});
  assert.equal(syncEvents.length, 1);
  eventTarget.dispatch({key: STORAGE_KEYS.rowers, storageArea: storage});
  assert.equal(syncEvents.length, 1, 'the storage signal for already adopted bytes must be ignored');

  writer.update(record.id, {name: 'Zweiter Stand', score: 51});
  assert.equal(syncEvents.length, 2);
  eventTarget.dispatch({key: STORAGE_KEYS.rowers, storageArea: storage});
  assert.equal(syncEvents.length, 2);
  assert.equal(observer.list()[0].value.name, 'Zweiter Stand');
  writer.close();
  observer.close();
});

test('matching storage.clear empties a repository exactly once while foreign areas are ignored', () => {
  const listeners = new Set();
  const eventTarget = {
    addEventListener(type, listener) { if (type === 'storage') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'storage') listeners.delete(listener); },
    dispatch(event) { for (const listener of listeners) listener(event); },
  };
  const storage = createMemoryStorage();
  const repository = makeRepository(storage, {storageEventTarget: eventTarget});
  repository.load();
  repository.create({name: 'Vor Clear', score: 50});
  const events = [];
  repository.subscribe(event => { if (event.type === 'external-sync') events.push(event); });

  storage.clear();
  eventTarget.dispatch({key: null, storageArea: createMemoryStorage()});
  assert.equal(repository.list().length, 1);
  eventTarget.dispatch({key: null, storageArea: storage});
  assert.equal(repository.list().length, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].beforeRevision, 1);
  assert.equal(events[0].revision, 0);
  assert.equal(events[0].result.ok, true);
  assert.equal(events[0].result.recovered, false);
  eventTarget.dispatch({key: null, storageArea: storage});
  assert.equal(events.length, 1);
  repository.close();
});

test('repeated signals for identical corrupt bytes recover and quarantine exactly once', () => {
  const listeners = new Set();
  const eventTarget = {
    addEventListener(type, listener) { if (type === 'storage') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'storage') listeners.delete(listener); },
    dispatch(event) { for (const listener of listeners) listener(event); },
  };
  const storage = createMemoryStorage();
  const repository = makeRepository(storage, {storageEventTarget: eventTarget});
  repository.load();
  repository.create({name: 'Vor Korruption', score: 50});
  const events = [];
  repository.subscribe(event => { if (event.type === 'external-sync') events.push(event); });

  storage.setItem(STORAGE_KEYS.rowers, 'null');
  eventTarget.dispatch({key: STORAGE_KEYS.rowers, storageArea: storage});
  eventTarget.dispatch({key: STORAGE_KEYS.rowers, storageArea: storage});
  assert.equal(repository.list().length, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].result.ok, false);
  assert.equal(events[0].result.recovered, true);
  assert.equal(events[0].result.quarantine.stored, true);
  const quarantineKeys = Array.from({length: storage.length}, (_, index) => storage.key(index))
    .filter(key => key?.startsWith(STORAGE_KEYS.quarantinePrefix));
  assert.equal(quarantineKeys.length, 1);
  repository.close();
});

test('stable id uses crypto byte fallback and remains unique without Web Crypto', () => {
  const cryptoFallback = {
    getRandomValues(bytes) {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
      return bytes;
    },
  };
  const cryptoId = createStableId({cryptoObject: cryptoFallback});
  assert.match(cryptoId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

  let time = 1_000;
  const first = createStableId({cryptoObject: null, now: () => time++, random: () => 0.5});
  const second = createStableId({cryptoObject: null, now: () => time++, random: () => 0.5});
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});

test('storage v2 projects one honest v3 history baseline without increasing the record revision', () => {
  const timestamp='2026-07-15T07:00:00.000Z';
  const raw=JSON.stringify({
    format:'rudertrimm.storage',schemaVersion:2,kind:STORAGE_KINDS.rowers,
    revision:4,updatedAt:timestamp,
    records:[{id:'existing-profile',revision:7,updatedAt:timestamp,value:{name:'Bestand',score:71}}],
  });
  const storage=createMemoryStorage({[STORAGE_KEYS.rowers]:raw});
  const repository=makeRepository(storage);
  const loaded=repository.load();

  assert.equal(loaded.ok,true);
  assert.equal(loaded.migration.migrated,true);
  assert.deepEqual(loaded.migration.recordIds,[]);
  assert.equal(repository.select('existing-profile').record.revision,7);
  assert.deepEqual(repository.history('existing-profile').map(entry=>({
    revision:entry.revision,operation:entry.operation,source:entry.source,reason:entry.reason,
  })),[{revision:7,operation:'baseline',source:'migration',reason:'history-start'}]);

  repository.commitPendingMigration({expectedRevision:4});
  const persisted=JSON.parse(storage.getItem(STORAGE_KEYS.rowers));
  assert.equal(persisted.schemaVersion,STORAGE_SCHEMA_VERSION);
  assert.equal(persisted.records[0].revision,7);
  assert.equal(persisted.history.entries.length,1);
  repository.close();
});

test('create and update persist immutable full snapshots in the same repository commit', () => {
  const repository=makeRepository();
  repository.load();
  const created=repository.create({name:'Historie',score:40});
  repository.update(created.id,{name:'Historie',score:55},{expectedRecordRevision:1});

  const history=repository.history(created.id);
  assert.deepEqual(history.map(entry=>[entry.revision,entry.operation,entry.snapshot.score]),[
    [1,'create',40],[2,'update',55],
  ]);
  assert.equal(Object.isFrozen(history),true);
  assert.equal(Object.isFrozen(history[0].snapshot),true);
  assert.equal(JSON.parse(repository.storage.getItem(STORAGE_KEYS.rowers)).history.entries.length,2);
  repository.close();
});

test('privacy delete removes prior PII snapshots and leaves only a data-poor tombstone', () => {
  const repository=makeRepository();
  repository.load();
  const created=repository.create({name:'Zu entfernen',score:64});
  repository.update(created.id,{name:'Noch personenbezogen',score:65});
  repository.delete(created.id,{expectedRecordRevision:2});

  assert.equal(repository.select(created.id).ok,false);
  assert.deepEqual(repository.history(created.id).map(entry=>({
    revision:entry.revision,operation:entry.operation,snapshot:entry.snapshot,reason:entry.reason,
  })),[{revision:3,operation:'delete',snapshot:null,reason:'privacy-delete'}]);
  assert.deepEqual(repository.historyFloors(),[{entityId:created.id,throughRevision:2}]);
  assert.equal(repository.storage.getItem(STORAGE_KEYS.rowers).includes('personenbezogen'),false);
  repository.close();
});

test('history retention records a floor and always preserves the current snapshot', () => {
  const repository=makeRepository(createMemoryStorage(),{
    limits:{maxHistoryPerEntity:2,maxHistoryEntries:3,maxHistoryFloors:10},
  });
  repository.load();
  const created=repository.create({name:'Retention',score:1});
  repository.update(created.id,{name:'Retention',score:2});
  repository.update(created.id,{name:'Retention',score:3});

  assert.deepEqual(repository.history(created.id).map(entry=>entry.snapshot.score),[2,3]);
  assert.deepEqual(repository.historyFloors(),[{entityId:created.id,throughRevision:1}]);
  assert.equal(repository.select(created.id).record.value.score,3);
  repository.close();
});

test('deleted and compacted entity ids remain reserved instead of being silently resurrected', () => {
  const ids=['reserved-id','reserved-id','fresh-id'];
  const repository=makeRepository(createMemoryStorage(),{idFactory:()=>ids.shift()});
  repository.load();
  const created=repository.create({name:'Alt',score:1});
  repository.delete(created.id);
  const replacement=repository.create({name:'Neu',score:2});

  assert.equal(created.id,'reserved-id');
  assert.equal(replacement.id,'fresh-id');
  repository.close();
});

test('native exchange import creates one local baseline without exporting private history', () => {
  const source=makeRepository();
  source.load();
  source.create({name:'Importquelle',score:77});
  source.update(source.list()[0].id,{name:'Importquelle',score:78});
  const exported=source.exportEnvelope();
  assert.equal(Object.hasOwn(exported,'history'),false);
  assert.equal(exported.schemaVersion,EXCHANGE_SCHEMA_VERSION);

  const target=makeRepository();
  target.load();
  target.importText(JSON.stringify(exported));
  const imported=target.list()[0];
  assert.deepEqual(target.history(imported.id).map(entry=>({
    revision:entry.revision,operation:entry.operation,source:entry.source,
  })),[{revision:2,operation:'import',source:'json-import'}]);
  source.close();
  target.close();
});

test('legacy history snapshots remain immutable but migration-aware across commit and reopen',()=>{
  const timestamp='2026-07-15T07:00:00.000Z';
  const legacy={displayName:'Altprofil',points:73};
  const raw=JSON.stringify({
    format:'rudertrimm.storage',schemaVersion:STORAGE_SCHEMA_VERSION,kind:STORAGE_KINDS.rowers,
    revision:7,updatedAt:timestamp,
    records:[{id:'legacy-profile',revision:3,updatedAt:timestamp,value:legacy}],
    history:{entries:[{
      entityId:'legacy-profile',revision:3,changedAt:timestamp,operation:'baseline',
      source:'migration',reason:'history-start',snapshot:legacy,
    }],floors:[]},
  });
  const storage=createMemoryStorage({[STORAGE_KEYS.rowers]:raw});
  const repository=makeRepository(storage,{migrateRecord:migrateLegacyProfile});
  const loaded=repository.load();
  assert.equal(loaded.ok,true);
  assert.deepEqual(loaded.migration.recordIds,['legacy-profile']);
  assert.deepEqual(repository.history('legacy-profile')[0].snapshot,legacy,
    'read-only projection never rewrites the historical fact');

  repository.commitPendingMigration({expectedRevision:7});
  const persisted=JSON.parse(storage.getItem(STORAGE_KEYS.rowers));
  assert.deepEqual(persisted.history.entries.map(item=>item.snapshot),[
    legacy,{name:'Altprofil',score:73},
  ]);
  assert.deepEqual(persisted.history.entries.map(item=>item.revision),[3,4]);
  repository.close();

  const reopened=makeRepository(storage,{migrateRecord:migrateLegacyProfile});
  const result=reopened.load();
  assert.equal(result.ok,true);
  assert.equal(result.migration.migrated,false);
  assert.equal(reopened.select('legacy-profile').record.value.score,73);
  reopened.close();
});

test('mismatching or noncanonical historical DTOs fail closed instead of legitimizing current data',()=>{
  const timestamp='2026-07-15T07:00:00.000Z';
  const envelope={
    format:'rudertrimm.storage',schemaVersion:STORAGE_SCHEMA_VERSION,kind:STORAGE_KINDS.rowers,
    revision:4,updatedAt:timestamp,
    records:[{id:'legacy-profile',revision:2,updatedAt:timestamp,value:{displayName:'A',points:70}}],
    history:{entries:[{
      entityId:'legacy-profile',revision:2,changedAt:timestamp,operation:'baseline',
      source:'migration',reason:'history-start',snapshot:{displayName:'B',points:70},
    }],floors:[]},
  };
  const mismatchStorage=createMemoryStorage({[STORAGE_KEYS.rowers]:JSON.stringify(envelope)});
  const mismatch=makeRepository(mismatchStorage,{migrateRecord:migrateLegacyProfile});
  assert.equal(mismatch.load().ok,false,'projected latest history must equal the projected current record');
  mismatch.close();

  const invalidHistory=structuredClone(envelope);
  invalidHistory.records[0]={id:'legacy-profile',revision:2,updatedAt:timestamp,value:{name:'Aktuell',score:70}};
  invalidHistory.history.entries=[
    {...invalidHistory.history.entries[0],revision:1,snapshot:{name:'x'.repeat(81),score:69}},
    {...invalidHistory.history.entries[0],revision:2,snapshot:{name:'Aktuell',score:70}},
  ];
  const invalidStorage=createMemoryStorage({[STORAGE_KEYS.rowers]:JSON.stringify(invalidHistory)});
  const invalid=makeRepository(invalidStorage);
  assert.equal(invalid.load().ok,false,'every retained snapshot obeys the same name boundary');
  invalid.close();
});

test('stored history rejects backwards chronology and any fact after privacy deletion',()=>{
  const repository=makeRepository();
  repository.load();
  const record=repository.create({name:'Zeit',score:1});
  repository.update(record.id,{name:'Zeit',score:2});
  const backwards=JSON.parse(repository.storage.getItem(STORAGE_KEYS.rowers));
  backwards.history.entries[0].changedAt='2026-07-16T12:00:00.000Z';
  backwards.history.entries[1].changedAt='2026-07-16T11:00:00.000Z';
  const backwardsStorage=createMemoryStorage({[STORAGE_KEYS.rowers]:JSON.stringify(backwards)});
  const backwardsReader=makeRepository(backwardsStorage);
  assert.equal(backwardsReader.load().ok,false);
  backwardsReader.close();
  repository.close();

  const t=index=>`2026-07-16T12:0${index}:00.000Z`;
  const value={name:'Wiederauferstehung',score:3};
  const afterDelete={
    format:'rudertrimm.storage',schemaVersion:STORAGE_SCHEMA_VERSION,kind:STORAGE_KINDS.rowers,
    revision:3,updatedAt:t(3),records:[{id:'retired',revision:3,updatedAt:t(3),value}],
    history:{entries:[
      {entityId:'retired',revision:1,changedAt:t(1),operation:'create',source:'local-ui',reason:'created',snapshot:value},
      {entityId:'retired',revision:2,changedAt:t(2),operation:'delete',source:'local-ui',reason:'privacy-delete',snapshot:null},
      {entityId:'retired',revision:3,changedAt:t(3),operation:'import',source:'json-import',reason:'imported',snapshot:value},
    ],floors:[]},
  };
  const deletedStorage=createMemoryStorage({[STORAGE_KEYS.rowers]:JSON.stringify(afterDelete)});
  const deletedReader=makeRepository(deletedStorage);
  assert.equal(deletedReader.load().ok,false);
  deletedReader.close();
});

test('direct import cannot resurrect a retired ID and leaves bytes unchanged',()=>{
  const repository=makeRepository();
  repository.load();
  const created=repository.create({name:'Alt',score:10});
  repository.delete(created.id);
  const before=repository.storage.getItem(STORAGE_KEYS.rowers);
  const timestamp='2026-07-16T12:00:00.000Z';
  const exchange={
    format:EXCHANGE_FORMAT,schemaVersion:EXCHANGE_SCHEMA_VERSION,kind:STORAGE_KINDS.rowers,
    exportedAt:timestamp,records:[{id:created.id,revision:1,updatedAt:timestamp,value:{name:'Neu',score:20}}],
  };
  assert.throws(()=>repository.importText(JSON.stringify(exchange)),StorageValidationError);
  assert.equal(repository.storage.getItem(STORAGE_KEYS.rowers),before);
  assert.equal(repository.select(created.id).ok,false);
  repository.close();
});

test('repository chronology remains monotonic when the browser clock moves backwards',()=>{
  let calls=0;
  const later=Date.UTC(2026,6,16,12,0,0);
  const earlier=Date.UTC(2026,6,16,8,0,0);
  const repository=makeRepository(createMemoryStorage(),{
    clock:()=>new Date(calls++===0?later:earlier),
  });
  repository.load();
  const created=repository.create({name:'Zeitboden',score:1});
  repository.update(created.id,{name:'Zeitboden',score:2});
  const times=repository.history(created.id).map(item=>item.changedAt);
  assert.deepEqual(times,[...times].sort());
  assert.equal(times[0],new Date(later).toISOString());
  repository.close();
});

test('v2 and exchange stay at 1 MiB while byte retention keeps a maximum valid record editable',()=>{
  const timestamp='2026-07-16T12:00:00.000Z';
  const v2={
    format:'rudertrimm.storage',schemaVersion:2,kind:STORAGE_KINDS.rowers,
    revision:1,updatedAt:timestamp,
    records:[{id:'large-v2',revision:1,updatedAt:timestamp,value:{name:'Gross',score:50,padding:''}}],
  };
  v2.records[0].value.padding='x'.repeat(1_048_576-JSON.stringify(v2).length);
  const exactV2=JSON.stringify(v2);
  assert.equal(exactV2.length,1_048_576);
  const v2Storage=createMemoryStorage({[STORAGE_KEYS.rowers]:exactV2});
  const v2Repository=makeRepository(v2Storage);
  assert.equal(v2Repository.load().ok,true);
  v2Repository.commitPendingMigration({expectedRevision:1});
  assert.ok(v2Storage.getItem(STORAGE_KEYS.rowers).length>1_048_576,'v3 may use its separate local-history ceiling');
  v2Repository.close();
  v2.records[0].value.padding+='x';
  const oversizedStorage=createMemoryStorage({[STORAGE_KEYS.rowers]:JSON.stringify(v2)});
  const oversized=makeRepository(oversizedStorage);
  assert.equal(oversized.load().ok,false,'v2 cannot bypass its historical 1 MiB contract');
  oversized.close();

  const exchange={
    format:EXCHANGE_FORMAT,schemaVersion:EXCHANGE_SCHEMA_VERSION,kind:STORAGE_KINDS.rowers,
    exportedAt:timestamp,
    records:[{id:'large-exchange',revision:1,updatedAt:timestamp,value:{name:'Gross',score:50,padding:''}}],
  };
  exchange.records[0].value.padding='y'.repeat(1_048_576-JSON.stringify(exchange).length);
  const exactExchange=JSON.stringify(exchange);
  assert.equal(exactExchange.length,1_048_576);
  const target=makeRepository();
  target.load();
  target.importText(exactExchange);
  const selected=target.select('large-exchange').record;
  target.update(selected.id,{...selected.value,score:51},{expectedRecordRevision:selected.revision});
  assert.deepEqual(target.historyFloors(),[{entityId:selected.id,throughRevision:1}]);
  assert.deepEqual(target.history(selected.id).map(item=>item.revision),[2]);
  assert.ok(target.storage.getItem(STORAGE_KEYS.rowers).length<=2_621_440);
  assert.ok(target.exportText().length<=1_048_576,'private history never expands the exchange file');
  const reopened=makeRepository(target.storage);
  assert.equal(reopened.load().ok,true);
  assert.equal(reopened.select(selected.id).record.value.score,51);
  reopened.close(); target.close();
});

test('a live external v2 signal migrates and mutates inside one exclusive write path',async()=>{
  const storage=createMemoryStorage();
  const repository=makeRepository(storage,{migrateRecord:migrateLegacyProfile});
  repository.load();
  storage.setItem(STORAGE_KEYS.rowers,JSON.stringify(legacyProfileEnvelope({revision:7})));

  const updated=await withExclusiveRepositoryWrite(repository,()=>{
    if(repository.migrationStatus().pending){
      repository.commitPendingMigration({expectedRevision:repository.snapshot().revision});
    }
    const current=repository.select('legacy-profile').record;
    return repository.update(current.id,{...current.value,score:74},{
      expectedRevision:repository.snapshot().revision,
      expectedRecordRevision:current.revision,
    });
  },{shared:false});

  assert.equal(updated.value.score,74);
  assert.equal(updated.revision,5,'migration and requested mutation each advance the record exactly once');
  assert.equal(repository.snapshot().revision,9);
  assert.equal(repository.migrationStatus().pending,false);
  repository.close();
});
