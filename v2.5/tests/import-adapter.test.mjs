import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
  buildBoatDTO,
  buildImportDTO,
  buildRowerDTO,
  migrateBoatToCurrent,
  migrateRowerToCurrent,
  validateBoat,
  validateRower,
} from '../js/core.mjs';
import {
  collectionExchange,
  detachImportedBoatRowerReferences,
  mergeCollectionImport,
  migrateCollection,
  previewCollectionImport,
  sameCollectionImportPreview,
} from '../js/import-adapter.mjs';
import {
  EXCHANGE_FORMAT,
  EXCHANGE_SCHEMA_VERSION,
  STORAGE_KINDS,
  StorageValidationError,
  createBoatRepository,
  createMemoryStorage,
  createRowerRepository,
  withExclusiveRepositoryWrite,
} from '../js/storage.mjs';

const timestamp='2026-07-15T08:00:00.000Z';
const clock=()=>new Date(timestamp);

function profile(name,weight=80){
  return buildRowerDTO({
    name,
    legLen:90,
    torsoLen:95,
    wingspan:188,
    SB:40,
    weight,
    stemmX:48,
  });
}

function repository(storage=createMemoryStorage(),overrides={}){
  let id=0;
  const result=createRowerRepository({
    storage,
    validateRecord:validateRower,
    clock,
    idFactory:()=>`local-${++id}`,
    channelFactory:false,
    storageEventTarget:null,
    ...overrides,
  });
  result.load();
  return result;
}

function boatRepository(storage=createMemoryStorage(),overrides={}){
  let id=0;
  const result=createBoatRepository({
    storage,
    validateRecord:validateBoat,
    clock,
    idFactory:()=>`local-boat-${++id}`,
    channelFactory:false,
    storageEventTarget:null,
    ...overrides,
  });
  result.load();
  return result;
}

function legacyRower(name='Altprofil',weight=80){
  return {
    schemaVersion:2,
    kind:'rower',
    name,
    legLen:90,
    torsoLen:95,
    wingspan:188,
    SB:40,
    weight,
    stemmX:48,
  };
}

function legacyBoat(name='Altboot'){
  const seat={
    schemaVersion:2,kind:'seat',rig:'skull',DA:158,IH:87,L:289,d:2,handGap:18,
    a:15,anlage:4,aussen:0,dBB:0.5,stemmW:42,rollL:75,rueh:5,
  };
  return {
    schemaVersion:2,
    kind:'boat',
    name,
    preset:'4x',
    blade:'big',
    rig:'skull',
    strokeSide:1,
    phiA:66,
    phiR:44,
    c:8,
    seatOffset:5,
    s1:{...seat},
    s2:{...seat},
  };
}

function currentBoat(name='Importboot',assignments=[]){
  const boat=JSON.parse(JSON.stringify(buildBoatDTO(legacyBoat(name))));
  for(const {position,id,revision=1} of assignments){
    boat.seats[position-1].rowerRef={id,revision};
  }
  return boat;
}

function exchangeWithRecords(kind,records,{exportedAt='2026-07-14T07:00:00.000Z'}={}){
  return {
    format:EXCHANGE_FORMAT,
    schemaVersion:EXCHANGE_SCHEMA_VERSION,
    kind,
    exportedAt,
    records,
  };
}

function legacyCollectionMigrator(migrateRecord){
  return (envelope,{expectedKind})=>{
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)) throw new TypeError('legacy envelope must be an object');
    if(Number.isSafeInteger(envelope.schemaVersion)&&envelope.schemaVersion>SCHEMA_VERSION){
      throw new UnsupportedSchemaVersionError('import',envelope.schemaVersion);
    }
    if(envelope.schemaVersion!==2||envelope.kind!==expectedKind||!Array.isArray(envelope.items)){
      throw new TypeError('legacy envelope is invalid');
    }
    return {
      schemaVersion:SCHEMA_VERSION,
      kind:expectedKind,
      items:envelope.items.map((item,index)=>migrateRecord(item,{storage:false,path:`items[${index}]`}).value),
    };
  };
}

test('capacity is rejected before approval using the repository-specific limit',()=>{
  const storage=createMemoryStorage();
  const target=repository(storage,{limits:{maxRecords:2}});
  target.create(profile('Bestand'));
  const before=target.snapshot();
  const rawBefore=storage.getItem(target.key);
  let approveCalled=false;
  let incomingId=0;
  const exchange=collectionExchange(
    STORAGE_KINDS.rowers,
    [profile('Neu A'),profile('Neu B')],
    buildRowerDTO,
    {clock,idFactory:()=>`incoming-${++incomingId}`},
  );

  assert.throws(()=>mergeCollectionImport({
    repository:target,
    text:JSON.stringify(exchange),
    validateRecord:validateRower,
    builder:buildRowerDTO,
    approve:()=>{ approveCalled=true; return true; },
    clock,
  }),/Import würde 3 Datensätze erzeugen; maximal 2 sind erlaubt/u);
  assert.equal(approveCalled,false);
  assert.deepEqual(target.snapshot(),before);
  assert.equal(storage.getItem(target.key),rawBefore);
  target.close();
});

test('capacity preflight runs after exact duplicate elimination',()=>{
  const target=repository(createMemoryStorage(),{limits:{maxRecords:2}});
  target.create(profile('Identisch'));
  let incomingId=0;
  const exchange=collectionExchange(
    STORAGE_KINDS.rowers,
    [profile('Identisch'),profile('Einzigartig')],
    buildRowerDTO,
    {clock,idFactory:()=>`boundary-${++incomingId}`},
  );
  let preview;
  const result=mergeCollectionImport({
    repository:target,
    text:JSON.stringify(exchange),
    validateRecord:validateRower,
    builder:buildRowerDTO,
    approve:value=>{ preview=value; return true; },
    clock,
  });

  assert.equal(preview.total,2);
  assert.equal(preview.maxRecords,2);
  assert.equal(preview.capacityExceeded,false);
  assert.equal(result.added,1);
  assert.equal(result.duplicatesSkipped,1);
  assert.equal(target.list().length,2);
  target.close();
});

test('import preview is side-effect free and matches the unchanged commit contract',()=>{
  const target=repository();
  target.create(profile('Bestand'));
  const before=target.snapshot();
  const exchange=collectionExchange(
    STORAGE_KINDS.rowers,
    [profile('Neu')],
    buildRowerDTO,
    {clock,idFactory:()=> 'preview-new'},
  );
  const options={
    repository:target,
    text:JSON.stringify(exchange),
    validateRecord:validateRower,
    builder:buildRowerDTO,
    clock,
  };

  const approved=previewCollectionImport(options);
  assert.deepEqual(target.snapshot(),before);
  const result=mergeCollectionImport({...options,approve:fresh=>sameCollectionImportPreview(approved,fresh)});
  assert.equal(result.added,1);
  assert.equal(result.total,2);
  target.close();
});

test('a confirmed import aborts atomically when the fresh locked preview changed',async()=>{
  const target=repository();
  const exchange=collectionExchange(
    STORAGE_KINDS.rowers,
    [profile('Import')],
    buildRowerDTO,
    {clock,idFactory:()=> 'queued-import'},
  );
  const options={
    repository:target,
    text:JSON.stringify(exchange),
    validateRecord:validateRower,
    builder:buildRowerDTO,
    clock,
  };
  const humanApproved=previewCollectionImport(options);

  target.create(profile('Parallel gespeichert'));
  const beforeAttempt=target.snapshot();
  await assert.rejects(withExclusiveRepositoryWrite(target,()=>mergeCollectionImport({
    ...options,
    approve:fresh=>{
      if(sameCollectionImportPreview(humanApproved,fresh)) return true;
      const error=new Error('Import preview changed while waiting for the write lock');
      error.code='import-preview-changed';
      throw error;
    },
  }),{shared:false}),error=>error?.code==='import-preview-changed');

  assert.deepEqual(target.snapshot(),beforeAttempt);
  assert.deepEqual(target.list().map(record=>record.value.name),['Parallel gespeichert']);
  target.close();
});

test('legacy core export migrates through the strict repository exchange format',()=>{
  const target=repository();
  let preview;
  const result=mergeCollectionImport({
    repository:target,
    text:JSON.stringify(buildImportDTO('rudertrimm.rowers',[profile('Testprofil Synthetisch')])),
    validateRecord:validateRower,
    builder:buildRowerDTO,
    approve:value=>{ preview=value; return true; },
    clock,
    idFactory:()=> 'legacy-import-1',
  });

  assert.equal(result.legacy,true);
  assert.equal(result.added,1);
  assert.equal(preview.total,1);
  assert.equal(target.list()[0].value.name,'Testprofil Synthetisch');
  target.close();
});

test('legacy fallback cannot bypass the repository UTF-8 byte limit',()=>{
  const storage=createMemoryStorage();
  const target=repository(storage,{limits:{maxBytes:2_000}});
  const before=target.snapshot();
  const rawBefore=storage.getItem(target.key);
  const oversizedLegacy=`${JSON.stringify(buildImportDTO('rudertrimm.rowers',[profile('Zu groß')]))}${' '.repeat(2_100)}`;
  let approveCalled=false;

  assert.throws(()=>mergeCollectionImport({
    repository:target,
    text:oversizedLegacy,
    validateRecord:validateRower,
    builder:buildRowerDTO,
    approve:()=>{ approveCalled=true; return true; },
    clock,
  }),StorageValidationError);
  assert.equal(approveCalled,false);
  assert.deepEqual(target.snapshot(),before);
  assert.equal(storage.getItem(target.key),rawBefore);
  target.close();
});

test('exact duplicate import is skipped without creating a new repository revision',()=>{
  const target=repository();
  target.create(profile('Identisch'));
  const before=target.snapshot();
  const text=JSON.stringify(buildImportDTO('rudertrimm.rowers',[profile('Identisch')]));
  const result=mergeCollectionImport({
    repository:target,
    text,
    validateRecord:validateRower,
    builder:buildRowerDTO,
    clock,
    idFactory:()=> 'duplicate-file-id',
  });

  assert.equal(result.added,0);
  assert.equal(result.duplicatesSkipped,1);
  assert.deepEqual(target.snapshot(),before);
  target.close();
});

test('record-id collision is remapped while different content remains importable',()=>{
  const target=repository();
  const existing=target.create(profile('Vorhanden'));
  const exchange={
    format:EXCHANGE_FORMAT,
    schemaVersion:EXCHANGE_SCHEMA_VERSION,
    kind:STORAGE_KINDS.rowers,
    exportedAt:timestamp,
    records:[{
      id:existing.id,
      revision:1,
      updatedAt:timestamp,
      value:profile('Neu',75),
    }],
  };
  const result=mergeCollectionImport({
    repository:target,
    text:JSON.stringify(exchange),
    validateRecord:validateRower,
    builder:buildRowerDTO,
    clock,
    idFactory:()=> 'remapped-import-id',
  });

  assert.equal(result.remapped,1);
  assert.equal(result.added,1);
  assert.equal(target.select('remapped-import-id').record.value.name,'Neu');
  target.close();
});

test('boat rower-reference detachment is deterministic, idempotent and preserves trim identity',()=>{
  const original=currentBoat('Mehrfach belegt',[
    {position:1,id:'rower-bow',revision:2},
    {position:3,id:'rower-three',revision:4},
    {position:4,id:'rower-stroke',revision:7},
  ]);
  const originalBytes=JSON.stringify(original);
  const originalSeatIdentity=original.seats.map(({id,trimId,position})=>({id,trimId,position}));

  const first=detachImportedBoatRowerReferences(original);
  assert.equal(first.referencesDetached,3);
  assert.equal(JSON.stringify(original),originalBytes,'the imported source value stays untouched');
  assert.deepEqual(first.value.seats.map(({id,trimId,position})=>({id,trimId,position})),originalSeatIdentity);
  assert.deepEqual(first.value.seats.map(seat=>seat.rowerRef),[null,null,null,null]);

  const second=detachImportedBoatRowerReferences(first.value);
  assert.equal(second.referencesDetached,0);
  assert.strictEqual(second.value,first.value,'a second pass is a no-op, including object identity');
  assert.throws(()=>detachImportedBoatRowerReferences(profile('Kein Boot')),/validated boat DTO/u);
});

test('boat import cannot bind a foreign rower id to an unrelated local profile',()=>{
  const localRowers=repository();
  const unrelatedLocalPerson=localRowers.create(profile('Unbeteiligte lokale Person'));
  const target=boatRepository();
  const before=target.snapshot();
  const exchange=exchangeWithRecords(STORAGE_KINDS.boats,[{
    id:'foreign-boat',
    revision:1,
    updatedAt:'2026-07-14T07:00:00.000Z',
    value:currentBoat('Fremdes Boot',[
      {position:2,id:'foreign-rower-two',revision:3},
      {position:4,id:unrelatedLocalPerson.id,revision:unrelatedLocalPerson.revision},
    ]),
  }]);
  const options={
    repository:target,
    text:JSON.stringify(exchange),
    validateRecord:validateBoat,
    builder:buildBoatDTO,
    migrateRecord:migrateBoatToCurrent,
    transformIncomingValue:detachImportedBoatRowerReferences,
    clock,
  };

  const approved=previewCollectionImport(options);
  assert.equal(approved.referencesDetached,2);
  assert.equal(approved.added,1);
  assert.deepEqual(target.snapshot(),before,'preview is side-effect free');

  const unsanitized=previewCollectionImport({...options,transformIncomingValue:undefined});
  assert.equal(unsanitized.referencesDetached,0);
  assert.equal(sameCollectionImportPreview(approved,unsanitized),false,
    'confirmation freshness includes the explicit detachment contract');

  const cancelled=mergeCollectionImport({...options,approve:()=>false});
  assert.equal(cancelled.cancelled,true);
  assert.equal(cancelled.referencesDetached,2);
  assert.deepEqual(target.snapshot(),before,'cancelling after preview performs no commit');

  const result=mergeCollectionImport({...options,approve:fresh=>sameCollectionImportPreview(approved,fresh)});
  assert.equal(result.referencesDetached,2);
  assert.deepEqual(target.select('foreign-boat').record.value.seats.map(seat=>seat.rowerRef),[null,null,null,null]);
  assert.equal(localRowers.select(unrelatedLocalPerson.id).record.value.name,'Unbeteiligte lokale Person');
  target.close();
  localRowers.close();
});

test('boat import into an empty repository leaves an already unassigned crew byte-equivalent',()=>{
  const target=boatRepository();
  const value=currentBoat('Leeres Mannschaftsboot');
  const text=JSON.stringify(exchangeWithRecords(STORAGE_KINDS.boats,[{
    id:'unassigned-boat',
    revision:1,
    updatedAt:'2026-07-14T07:00:00.000Z',
    value,
  }]));
  const options={
    repository:target,
    text,
    validateRecord:validateBoat,
    builder:buildBoatDTO,
    migrateRecord:migrateBoatToCurrent,
    transformIncomingValue:detachImportedBoatRowerReferences,
    clock,
  };
  const preview=previewCollectionImport(options);
  assert.equal(preview.existing,0);
  assert.equal(preview.referencesDetached,0);
  const result=mergeCollectionImport({...options,approve:fresh=>sameCollectionImportPreview(preview,fresh)});
  assert.equal(result.added,1);
  assert.deepEqual(target.select('unassigned-boat').record.value,value);
  target.close();
});

test('the transform hook cannot bypass strict current validation or future-schema rejection',()=>{
  const target=boatRepository();
  const before=target.snapshot();
  let approveCalled=false;
  const validText=JSON.stringify(exchangeWithRecords(STORAGE_KINDS.boats,[{
    id:'invalid-after-transform',
    revision:1,
    updatedAt:'2026-07-14T07:00:00.000Z',
    value:currentBoat('Vor Transformation'),
  }]));
  assert.throws(()=>mergeCollectionImport({
    repository:target,
    text:validText,
    validateRecord:validateBoat,
    builder:buildBoatDTO,
    migrateRecord:migrateBoatToCurrent,
    transformIncomingValue:value=>({value:{...value,name:''},referencesDetached:0}),
    approve:()=>{ approveCalled=true; return true; },
    clock,
  }),StorageValidationError);
  assert.equal(approveCalled,false);
  assert.deepEqual(target.snapshot(),before);

  let transformCalled=false;
  const future={...currentBoat('Zukunft'),schemaVersion:SCHEMA_VERSION+1};
  const futureText=JSON.stringify(exchangeWithRecords(STORAGE_KINDS.boats,[{
    id:'future-before-transform',
    revision:1,
    updatedAt:'2026-07-14T07:00:00.000Z',
    value:future,
  }]));
  assert.throws(()=>mergeCollectionImport({
    repository:target,
    text:futureText,
    validateRecord:validateBoat,
    builder:buildBoatDTO,
    migrateRecord:migrateBoatToCurrent,
    transformIncomingValue:value=>{
      transformCalled=true;
      return detachImportedBoatRowerReferences(value);
    },
    approve:()=>{ approveCalled=true; return true; },
    clock,
  }),error=>error instanceof UnsupportedSchemaVersionError&&error.actual===SCHEMA_VERSION+1);
  assert.equal(transformCalled,false,'future DTOs fail before any sanitizer runs');
  assert.equal(approveCalled,false);
  assert.deepEqual(target.snapshot(),before);
  target.close();
});

test('preview rejection and malformed imports leave storage unchanged',()=>{
  const target=repository();
  target.create(profile('Bestand'));
  const before=target.snapshot();
  const valid=collectionExchange(
    STORAGE_KINDS.rowers,
    [profile('Abgelehnt')],
    buildRowerDTO,
    {clock,idFactory:()=> 'cancelled-import'},
  );
  const cancelled=mergeCollectionImport({
    repository:target,
    text:JSON.stringify(valid),
    validateRecord:validateRower,
    builder:buildRowerDTO,
    approve:()=>false,
    clock,
  });
  assert.equal(cancelled.cancelled,true);
  assert.deepEqual(target.snapshot(),before);

  assert.throws(()=>mergeCollectionImport({
    repository:target,
    text:'{"kind":"rudertrimm.rowers","items":[{"name":"broken"}]}',
    validateRecord:validateRower,
    builder:buildRowerDTO,
    clock,
  }));
  assert.deepEqual(target.snapshot(),before);
  target.close();
});

test('legacy local collection migration is atomic and keeps the source DTO strict',()=>{
  const target=repository();
  const migrated=migrateCollection(
    target,
    STORAGE_KINDS.rowers,
    [profile('Altbestand')],
    buildRowerDTO,
    {clock,idFactory:()=> 'migrated-local-id'},
  );
  assert.equal(migrated,true);
  assert.equal(target.list()[0].id,'migrated-local-id');
  assert.equal(target.list()[0].value.name,'Altbestand');
  target.close();
});

test('storage exchanges preview v2 rower and boat values with an exact migrated count',()=>{
  const cases=[{
    kind:STORAGE_KINDS.rowers,
    values:[legacyRower('Alt A'),legacyRower('Alt B',75)],
    create:storage=>repository(storage,{migrateRecord:migrateRowerToCurrent}),
    validateRecord:validateRower,
    builder:buildRowerDTO,
    migrateRecord:migrateRowerToCurrent,
  },{
    kind:STORAGE_KINDS.boats,
    values:[legacyBoat()],
    create:storage=>boatRepository(storage,{migrateRecord:migrateBoatToCurrent}),
    validateRecord:validateBoat,
    builder:buildBoatDTO,
    migrateRecord:migrateBoatToCurrent,
  }];

  for(const entry of cases){
    const storage=createMemoryStorage();
    const target=entry.create(storage);
    const records=entry.values.map((value,index)=>({
      id:`v2-record-${index+1}`,
      revision:3,
      updatedAt:'2026-07-14T07:00:00.000Z',
      value,
    }));
    const options={
      repository:target,
      text:JSON.stringify(exchangeWithRecords(entry.kind,records)),
      validateRecord:entry.validateRecord,
      builder:entry.builder,
      migrateRecord:entry.migrateRecord,
      clock,
    };
    const preview=previewCollectionImport(options);
    const fresh=previewCollectionImport(options);

    assert.equal(preview.incoming,entry.values.length);
    assert.equal(preview.added,entry.values.length);
    assert.equal(preview.migrated,entry.values.length);
    assert.equal(preview.legacy,true);
    assert.equal(sameCollectionImportPreview(preview,fresh),true);
    assert.equal(sameCollectionImportPreview(preview,{...fresh,migrated:0}),false,
      'human confirmation must be invalidated when the migration count changes');
    assert.equal(target.list().length,0,'preview remains side-effect free');
    assert.equal(storage.getItem(target.key),null);
    target.close();
  }
});

test('committing a migrated exchange advances each migrated record revision and timestamp exactly once',()=>{
  const previewTimestamp='2026-07-16T09:30:00.000Z';
  const commitTimestamp='2026-07-16T09:31:00.000Z';
  const previewClock=()=>new Date(previewTimestamp);
  const repositoryClock=()=>new Date(commitTimestamp);
  const storage=createMemoryStorage();
  const target=repository(storage,{
    migrateRecord:migrateRowerToCurrent,
    clock:repositoryClock,
  });
  const exchange=exchangeWithRecords(STORAGE_KINDS.rowers,[{
    id:'stable-v2-record',
    revision:7,
    updatedAt:'2026-07-14T07:00:00.000Z',
    value:legacyRower('Revisionstest'),
  }]);
  const options={
    repository:target,
    text:JSON.stringify(exchange),
    validateRecord:validateRower,
    builder:buildRowerDTO,
    migrateRecord:migrateRowerToCurrent,
    clock:previewClock,
  };
  const approved=previewCollectionImport(options);
  const result=mergeCollectionImport({
    ...options,
    approve:fresh=>sameCollectionImportPreview(approved,fresh),
  });
  const record=target.select('stable-v2-record').record;

  assert.equal(result.migrated,1);
  assert.equal(result.added,1);
  assert.equal(target.snapshot().revision,1,'one atomic import commit advances the repository once');
  assert.equal(record.revision,8,'v2 record revision advances exactly once');
  assert.equal(record.updatedAt,commitTimestamp,'record timestamp must come from the authoritative repository commit');
  assert.equal(target.snapshot().updatedAt,commitTimestamp);
  assert.equal(record.value.schemaVersion,SCHEMA_VERSION);
  const persisted=JSON.parse(storage.getItem(target.key));
  assert.equal(persisted.records[0].revision,8);
  assert.equal(persisted.records[0].updatedAt,persisted.updatedAt);
  assert.notEqual(persisted.records[0].updatedAt,previewTimestamp,
    'a side-effect-free preview clock must not become persisted commit truth');
  target.close();
});

test('legacy Core schema-2 collection callback reports migrated records in preview and commit',()=>{
  const target=repository(createMemoryStorage(),{migrateRecord:migrateRowerToCurrent});
  const text=JSON.stringify({
    schemaVersion:2,
    kind:STORAGE_KINDS.rowers,
    items:[legacyRower('Core-Legacy')],
  });
  const options={
    repository:target,
    text,
    validateRecord:validateRower,
    builder:buildRowerDTO,
    migrateRecord:migrateRowerToCurrent,
    migrateLegacyImport:legacyCollectionMigrator(migrateRowerToCurrent),
    idFactory:()=> 'legacy-core-record',
    clock,
  };
  const approved=previewCollectionImport(options);
  assert.equal(approved.migrated,1);
  assert.equal(approved.legacy,true);
  assert.equal(target.list().length,0);

  const result=mergeCollectionImport({...options,approve:fresh=>sameCollectionImportPreview(approved,fresh)});
  assert.equal(result.migrated,1);
  assert.equal(result.added,1);
  assert.equal(target.select('legacy-core-record').record.value.schemaVersion,SCHEMA_VERSION);
  target.close();
});

test('future domain schema is rejected before approval and cannot write through the legacy callback',()=>{
  const storage=createMemoryStorage();
  const target=repository(storage,{migrateRecord:migrateRowerToCurrent});
  target.create(profile('Bestand'));
  const before=target.snapshot();
  const rawBefore=storage.getItem(target.key);
  let approveCalled=false;
  const future={...profile('Zukunft'),schemaVersion:SCHEMA_VERSION+1};
  const text=JSON.stringify({
    schemaVersion:2,
    kind:STORAGE_KINDS.rowers,
    items:[future],
  });

  assert.throws(()=>mergeCollectionImport({
    repository:target,
    text,
    validateRecord:validateRower,
    builder:buildRowerDTO,
    migrateRecord:migrateRowerToCurrent,
    migrateLegacyImport:legacyCollectionMigrator(migrateRowerToCurrent),
    approve:()=>{ approveCalled=true; return true; },
    clock,
  }),error=>error instanceof UnsupportedSchemaVersionError
    && error.code==='unsupported-schema-version'
    && error.actual===SCHEMA_VERSION+1);
  assert.equal(approveCalled,false);
  assert.deepEqual(target.snapshot(),before);
  assert.equal(storage.getItem(target.key),rawBefore);
  target.close();
});

test('mixed valid and invalid v2 record migration is atomic and never reaches approval',()=>{
  const storage=createMemoryStorage();
  const target=repository(storage,{migrateRecord:migrateRowerToCurrent});
  target.create(profile('Bestand'));
  const before=target.snapshot();
  const rawBefore=storage.getItem(target.key);
  let approveCalled=false;
  const invalid={...legacyRower('Ungültig'),weight:'80'};
  const text=JSON.stringify(exchangeWithRecords(STORAGE_KINDS.rowers,[{
    id:'valid-first',
    revision:2,
    updatedAt:'2026-07-14T07:00:00.000Z',
    value:legacyRower('Gültig'),
  },{
    id:'invalid-second',
    revision:2,
    updatedAt:'2026-07-14T07:00:00.000Z',
    value:invalid,
  }]));

  assert.throws(()=>mergeCollectionImport({
    repository:target,
    text,
    validateRecord:validateRower,
    builder:buildRowerDTO,
    migrateRecord:migrateRowerToCurrent,
    approve:()=>{ approveCalled=true; return true; },
    clock,
  }));
  assert.equal(approveCalled,false);
  assert.deepEqual(target.snapshot(),before);
  assert.equal(storage.getItem(target.key),rawBefore);
  assert.equal(target.select('valid-first').ok,false);
  target.close();
});

test('current v3 exchange is idempotent and reports zero migrated records',()=>{
  const target=repository(createMemoryStorage(),{migrateRecord:migrateRowerToCurrent});
  const originalTimestamp='2026-07-14T07:00:00.000Z';
  const text=JSON.stringify(exchangeWithRecords(STORAGE_KINDS.rowers,[{
    id:'current-v3-record',
    revision:5,
    updatedAt:originalTimestamp,
    value:profile('Aktuell'),
  }]));
  const options={
    repository:target,
    text,
    validateRecord:validateRower,
    builder:buildRowerDTO,
    migrateRecord:migrateRowerToCurrent,
    clock,
  };
  const preview=previewCollectionImport(options);
  assert.equal(preview.migrated,0);
  assert.equal(preview.legacy,false);

  const result=mergeCollectionImport({...options,approve:fresh=>sameCollectionImportPreview(preview,fresh)});
  const record=target.select('current-v3-record').record;
  assert.equal(result.migrated,0);
  assert.equal(record.revision,5);
  assert.equal(record.updatedAt,originalTimestamp);
  assert.equal(record.value.schemaVersion,SCHEMA_VERSION);
  target.close();
});

test('fresh-preview gate detects same-count repository changes and same-count file changes',()=>{
  const target=repository();
  const existing=target.create(profile('Bestand A'));
  const importText=JSON.stringify(exchangeWithRecords(STORAGE_KINDS.rowers,[{
    id:'incoming-b',
    revision:1,
    updatedAt:'2026-07-14T07:00:00.000Z',
    value:profile('Import B'),
  }]));
  const options={
    repository:target,
    text:importText,
    validateRecord:validateRower,
    builder:buildRowerDTO,
    migrateRecord:migrateRowerToCurrent,
    clock,
  };
  const humanApproved=previewCollectionImport(options);
  target.update(existing.id,profile('Bestand C'),{
    expectedRevision:target.snapshot().revision,
    expectedRecordRevision:existing.revision,
  });
  const freshAfterUpdate=previewCollectionImport(options);
  assert.deepEqual({
    existing:freshAfterUpdate.existing,
    incoming:freshAfterUpdate.incoming,
    added:freshAfterUpdate.added,
    total:freshAfterUpdate.total,
  },{
    existing:humanApproved.existing,
    incoming:humanApproved.incoming,
    added:humanApproved.added,
    total:humanApproved.total,
  },'the repro deliberately keeps every summary count unchanged');
  assert.equal(sameCollectionImportPreview(humanApproved,freshAfterUpdate),false,
    'repository revision/content changes must invalidate an old human confirmation');

  const beforeAttempt=target.snapshot();
  const rawBefore=target.storage.getItem(target.key);
  assert.throws(()=>mergeCollectionImport({
    ...options,
    approve:fresh=>{
      if(sameCollectionImportPreview(humanApproved,fresh)) return true;
      const error=new Error('stale import preview');
      error.code='import-preview-changed';
      throw error;
    },
  }),error=>error?.code==='import-preview-changed');
  assert.deepEqual(target.snapshot(),beforeAttempt);
  assert.equal(target.storage.getItem(target.key),rawBefore);
  target.close();

  const fileTarget=repository();
  fileTarget.create(profile('Bestand'));
  const first=previewCollectionImport({
    repository:fileTarget,
    text:importText,
    validateRecord:validateRower,
    builder:buildRowerDTO,
    migrateRecord:migrateRowerToCurrent,
    clock,
  });
  const differentText=JSON.stringify(exchangeWithRecords(STORAGE_KINDS.rowers,[{
    id:'incoming-d',
    revision:1,
    updatedAt:'2026-07-14T07:00:00.000Z',
    value:profile('Import D'),
  }]));
  const differentFile=previewCollectionImport({
    repository:fileTarget,
    text:differentText,
    validateRecord:validateRower,
    builder:buildRowerDTO,
    migrateRecord:migrateRowerToCurrent,
    clock,
  });
  assert.equal(sameCollectionImportPreview(first,differentFile),false,
    'a different merge plan with identical counters needs new human approval');
  fileTarget.close();
});

test('legacy callback migrated count distinguishes v2 items from already-current v3 items',()=>{
  const target=repository(createMemoryStorage(),{migrateRecord:migrateRowerToCurrent});
  const text=JSON.stringify({
    schemaVersion:2,
    kind:STORAGE_KINDS.rowers,
    items:[legacyRower('Alt'),profile('Bereits aktuell')],
  });
  const preview=previewCollectionImport({
    repository:target,
    text,
    validateRecord:validateRower,
    builder:buildRowerDTO,
    migrateRecord:migrateRowerToCurrent,
    migrateLegacyImport:legacyCollectionMigrator(migrateRowerToCurrent),
    clock,
  });
  assert.equal(preview.incoming,2);
  assert.equal(preview.migrated,1,'only the actual v2 item may be reported as migrated');
  target.close();
});

test('future schema in a strict storage exchange preserves its typed error and performs no write',()=>{
  const storage=createMemoryStorage();
  const target=repository(storage,{migrateRecord:migrateRowerToCurrent});
  target.create(profile('Bestand'));
  const before=target.snapshot();
  const rawBefore=storage.getItem(target.key);
  let approveCalled=false;
  let thrown=null;
  const future={...profile('Zukunft'),schemaVersion:SCHEMA_VERSION+1};
  const text=JSON.stringify(exchangeWithRecords(STORAGE_KINDS.rowers,[{
    id:'future-domain-record',
    revision:1,
    updatedAt:'2026-07-14T07:00:00.000Z',
    value:future,
  }]));
  try{
    mergeCollectionImport({
      repository:target,
      text,
      validateRecord:validateRower,
      builder:buildRowerDTO,
      migrateRecord:migrateRowerToCurrent,
      migrateLegacyImport:legacyCollectionMigrator(migrateRowerToCurrent),
      approve:()=>{ approveCalled=true; return true; },
      clock,
    });
  }catch(error){ thrown=error; }

  assert.equal(approveCalled,false);
  assert.deepEqual(target.snapshot(),before);
  assert.equal(storage.getItem(target.key),rawBefore);
  assert.equal(thrown instanceof UnsupportedSchemaVersionError,true);
  assert.equal(thrown?.code,'unsupported-schema-version');
  target.close();
});
