import {
  SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
  validateImportObject,
} from './core.mjs';
import {
  EXCHANGE_FORMAT,
  EXCHANGE_SCHEMA_VERSION,
  StorageValidationError,
  createStableId,
  parseImportEnvelope,
  utf8ByteLength,
} from './storage.mjs';

const defaultClock=()=>new Date();

function isoNow(clock){
  const value=clock();
  const date=value instanceof Date?value:new Date(value);
  if(!Number.isFinite(date.getTime())) throw new RangeError('clock must return a valid date');
  return date.toISOString();
}

function validationMessage(result){
  return result.errors.slice(0,5).map(error=>`${error.path}: ${error.message}`).join('\n');
}

export function canonicalJson(value){
  if(value===null||typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function collectionExchange(kind,values,builder,{clock=defaultClock,idFactory=createStableId}={}){
  if(!Array.isArray(values)) throw new TypeError('values must be an array');
  if(typeof builder!=='function') throw new TypeError('builder must be a function');
  const timestamp=isoNow(clock);
  return {
    format:EXCHANGE_FORMAT,
    schemaVersion:EXCHANGE_SCHEMA_VERSION,
    kind,
    exportedAt:timestamp,
    records:values.map(value=>({
      id:idFactory(),
      revision:1,
      updatedAt:timestamp,
      value:builder(value),
    })),
  };
}

/**
 * Bootstrap-only full-envelope replacement, not a merge. Call only after the
 * freshly loaded target repository is known to be empty; migrated values receive
 * new local repository record ids.
 */
export function migrateCollection(repository,kind,values,builder,options={}){
  if(!values.length) return false;
  repository.importText(JSON.stringify(collectionExchange(kind,values,builder,options)),{
    expectedRevision:repository.snapshot().revision,
  });
  return true;
}

function uniqueId(ids,idFactory){
  for(let attempt=0;attempt<16;attempt+=1){
    const id=idFactory();
    if(!ids.has(id)) return id;
  }
  throw new Error('Import-ID conflict could not be resolved');
}

const IMPORT_PREVIEW_FIELDS=Object.freeze([
  'kind','existing','incoming','added','duplicatesSkipped','remapped','migrated','referencesDetached','total','maxRecords','capacityExceeded','legacy',
  'baseRevision','planFingerprint',
]);

export function sameCollectionImportPreview(left,right){
  return !!left&&!!right&&IMPORT_PREVIEW_FIELDS.every(field=>Object.is(left[field],right[field]));
}

/**
 * Detach cross-repository rower references from an imported boat.
 *
 * A boat exchange cannot prove that a referenced rower id identifies the same
 * person in the receiving rower repository. Keeping the foreign id could bind a
 * seat to an unrelated local person after an id collision. Import therefore
 * preserves every boat/seat/trim id and value, but makes each assignment explicit
 * work for the receiving user. The transform is deterministic and idempotent.
 */
export function detachImportedBoatRowerReferences(value){
  if(value===null||typeof value!=='object'||Array.isArray(value)||value.kind!=='boat'||!Array.isArray(value.seats)){
    throw new TypeError('detachImportedBoatRowerReferences requires a validated boat DTO');
  }
  let referencesDetached=0;
  const seats=value.seats.map(seat=>{
    if(seat?.rowerRef===null) return seat;
    referencesDetached+=1;
    return {...seat,rowerRef:null};
  });
  return Object.freeze({
    value:referencesDetached===0?value:{...value,seats},
    referencesDetached,
  });
}

function prepareCollectionImport({
  repository,
  text,
  validateRecord,
  builder,
  migrateRecord,
  migrateLegacyImport,
  transformIncomingValue,
  clock=defaultClock,
  idFactory=createStableId,
}){
  if(!repository||typeof repository.importText!=='function') throw new TypeError('repository is required');
  if(typeof repository.constraints!=='function') throw new TypeError('repository constraints are required');
  if(typeof text!=='string') throw new TypeError('text must be a string');
  if(typeof validateRecord!=='function'||typeof builder!=='function') throw new TypeError('validator and builder are required');
  if(migrateRecord!==undefined&&typeof migrateRecord!=='function') throw new TypeError('migrateRecord must be a function');
  if(migrateLegacyImport!==undefined&&typeof migrateLegacyImport!=='function') throw new TypeError('migrateLegacyImport must be a function');
  if(transformIncomingValue!==undefined&&typeof transformIncomingValue!=='function') throw new TypeError('transformIncomingValue must be a function');
  const limits=repository.constraints();
  if(!limits||typeof limits!=='object') throw new TypeError('repository constraints are invalid');
  if(!Number.isSafeInteger(limits.maxBytes)||limits.maxBytes<1) throw new RangeError('repository maxBytes constraint is invalid');
  const importBytes=utf8ByteLength(text);
  if(importBytes>limits.maxBytes){
    throw new StorageValidationError(
      `import file exceeds ${limits.maxBytes} UTF-8 bytes`,
      [{bytes:importBytes,maxBytes:limits.maxBytes}],
    );
  }

  let parsed=parseImportEnvelope(text,{expectedKind:repository.kind,validateRecord,migrateRecord,limits});
  let legacy=false;
  const legacyMigratedRecordIds=new Set();
  if(!parsed.ok){
    // A strict exchange with a future domain DTO is not a legacy candidate. Storage
    // normalizes that error while parsing; restore the domain type at this UI/import
    // boundary so callers can distinguish "newer" from malformed without guessing.
    const futureDomain=parsed.errors.find(error=>error?.code==='unsupported-schema-version');
    if(futureDomain) throw futureDomain;
    const normalizedFuture=parsed.errors.find(error=>error?.code==='unsupported-schema'
      &&error.details?.some(detail=>detail?.supported===SCHEMA_VERSION&&String(detail?.path).endsWith('.value')));
    if(normalizedFuture){
      const detail=normalizedFuture.details.find(candidate=>candidate?.supported===SCHEMA_VERSION
        &&String(candidate?.path).endsWith('.value'));
      throw new UnsupportedSchemaVersionError(detail.path,detail.actual);
    }
    let oldEnvelope;
    try{ oldEnvelope=JSON.parse(text); }catch{ throw parsed.errors[0]; }
    const migratedEnvelope=migrateLegacyImport
      ?migrateLegacyImport(oldEnvelope,{expectedKind:repository.kind})
      :oldEnvelope;
    const validation=validateImportObject(migratedEnvelope);
    if(!validation.ok||migratedEnvelope.kind!==repository.kind){
      throw new TypeError(validation.ok?`Expected ${repository.kind}`:validationMessage(validation));
    }
    const legacyExchange=collectionExchange(repository.kind,migratedEnvelope.items,builder,{clock,idFactory});
    if(Array.isArray(oldEnvelope?.items)&&oldEnvelope.items.length===migratedEnvelope.items.length){
      // Count concrete DTO changes, not merely an old envelope label. This keeps a
      // mixed v2/v3 file and migrated duplicates truthful in the human preview.
      for(let index=0;index<migratedEnvelope.items.length;index+=1){
        if(canonicalJson(oldEnvelope.items[index])!==canonicalJson(migratedEnvelope.items[index])){
          legacyMigratedRecordIds.add(legacyExchange.records[index].id);
        }
      }
    }
    parsed=parseImportEnvelope(
      JSON.stringify(legacyExchange),
      {expectedKind:repository.kind,validateRecord,migrateRecord,limits},
    );
    if(!parsed.ok) throw parsed.errors[0];
    legacy=true;
  }
  const migratedSourceIds=new Set([...parsed.migration.recordIds,...legacyMigratedRecordIds]);
  let referencesDetached=0;
  if(transformIncomingValue){
    const transformedRecords=parsed.envelope.records.map((record,index)=>{
      const transformed=transformIncomingValue(record.value,Object.freeze({
        kind:repository.kind,
        recordId:record.id,
        index,
      }));
      if(transformed===null||typeof transformed!=='object'||Array.isArray(transformed)
          ||!Object.hasOwn(transformed,'value')
          ||!Number.isSafeInteger(transformed.referencesDetached)
          ||transformed.referencesDetached<0){
        throw new TypeError('transformIncomingValue must return {value, referencesDetached}');
      }
      referencesDetached+=transformed.referencesDetached;
      return {...record,value:transformed.value};
    });
    // Never trust a sanitizing hook as a validator. Reparse the transformed
    // exchange without migration so only a strict current-domain DTO can proceed.
    const transformedParsed=parseImportEnvelope(JSON.stringify({
      ...parsed.envelope,
      records:transformedRecords,
    }),{expectedKind:repository.kind,validateRecord,limits});
    if(!transformedParsed.ok) throw transformedParsed.errors[0];
    parsed=Object.freeze({
      ...transformedParsed,
      migration:parsed.migration,
    });
  }

  const current=repository.exportEnvelope();
  const baseRevision=repository.snapshot().revision;
  // Fingerprint only immutable source/base records. Generated collision IDs are
  // deliberately excluded so two honest previews of the same plan stay equal.
  const planFingerprint=canonicalJson({base:current.records,source:parsed.envelope.records});
  const fingerprints=new Set(current.records.map(record=>canonicalJson(record.value)));
  let duplicatesSkipped=0;
  const uniqueRecords=parsed.envelope.records.filter(record=>{
    const fingerprint=canonicalJson(record.value);
    if(fingerprints.has(fingerprint)){ duplicatesSkipped+=1; return false; }
    fingerprints.add(fingerprint);
    return true;
  });

  const ids=new Set(typeof repository.reservedIds==='function'
    ?repository.reservedIds()
    :current.records.map(record=>record.id));
  const migratedRecordIds=new Set();
  let remapped=0;
  const incoming=uniqueRecords.map(record=>{
    let id=record.id;
    if(ids.has(id)){ id=uniqueId(ids,idFactory); remapped+=1; }
    ids.add(id);
    if(!migratedSourceIds.has(record.id)) return {...record,id};
    if(!Number.isSafeInteger(record.revision)||record.revision<1||record.revision>=Number.MAX_SAFE_INTEGER){
      throw new RangeError('Migrierte Importrevision kann nicht sicher erhöht werden');
    }
    migratedRecordIds.add(id);
    // Revision and timestamp are assigned inside the repository's single commit,
    // using its authoritative clock. Preview time must never become stored truth.
    return {...record,id};
  });
  const migrated=migratedRecordIds.size;
  legacy ||= migrated>0;

  const maxRecords=limits.maxRecords;
  if(!Number.isSafeInteger(maxRecords)||maxRecords<1) throw new RangeError('repository maxRecords constraint is invalid');
  const total=current.records.length+incoming.length;
  const preview=Object.freeze({
    kind:repository.kind,
    existing:current.records.length,
    incoming:parsed.envelope.records.length,
    added:incoming.length,
    duplicatesSkipped,
    remapped,
    migrated,
    referencesDetached,
    total,
    maxRecords,
    capacityExceeded:total>maxRecords,
    legacy,
    baseRevision,
    planFingerprint,
  });
  if(preview.capacityExceeded){
    throw new RangeError(`Import würde ${total} Datensätze erzeugen; maximal ${maxRecords} sind erlaubt`);
  }
  return {preview,current,incoming,migratedRecordIds:[...migratedRecordIds]};
}

/** Build an exact, side-effect-free preview for human confirmation. */
export function previewCollectionImport(options){
  return prepareCollectionImport(options).preview;
}

/**
 * Rebuild the preview from the current repository and commit only if approved.
 * The approval callback is synchronous and non-interactive: human confirmation
 * happens on an earlier preview outside the lock, then the locked caller accepts
 * only an equal freshly rebuilt preview.
 */
export function mergeCollectionImport(options){
  const {repository,approve=()=>true,clock=defaultClock,audit}=options??{};
  if(typeof approve!=='function') throw new TypeError('approve must be a function');
  const {preview,current,incoming,migratedRecordIds}=prepareCollectionImport(options);
  if(!approve(preview)) return Object.freeze({...preview,added:0,cancelled:true});
  if(incoming.length===0) return Object.freeze({...preview,cancelled:false});

  repository.importText(JSON.stringify({
    ...current,
    exportedAt:isoNow(clock),
    records:[...current.records,...incoming],
  }),{expectedRevision:repository.snapshot().revision,migratedRecordIds,audit});
  return Object.freeze({...preview,cancelled:false});
}
