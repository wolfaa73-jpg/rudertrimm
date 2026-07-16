/**
 * Pure append-only history helpers.
 *
 * This module deliberately knows nothing about the DOM or persistence. Stored
 * entries remain immutable facts; a validity end is derived only for a read
 * view, because rewriting a previous entry would break the append-only contract.
 * Privacy deletion is the deliberate exception at the storage boundary: it
 * purges PII snapshots and retains only a floor plus null tombstone.
 */

export const HISTORY_OPERATIONS=Object.freeze([
  'baseline','create','update','import','migration','delete',
]);

export const HISTORY_LIMITS=Object.freeze({
  maxDepth:32,
  maxNodes:20_000,
  maxSourceLength:80,
  maxReasonLength:500,
});

const OPERATION_SET=new Set(HISTORY_OPERATIONS);
const ENTRY_FIELDS=Object.freeze([
  'entityId','revision','changedAt','operation','source','reason','snapshot',
]);
const DANGEROUS_KEYS=new Set(['__proto__','prototype','constructor']);
const UNSAFE_TEXT=/[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const SAFE_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class HistoryValidationError extends TypeError{
  constructor(message,details=[]){
    super(message);
    this.name='HistoryValidationError';
    this.code='history-validation';
    this.details=Object.freeze(details.map(detail=>Object.freeze({...detail})));
  }
}

function fail(path,code,message){
  throw new HistoryValidationError(message,[{path,code,message}]);
}

function isPlainObject(value){
  if(value===null||typeof value!=='object'||Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function ownDataKeys(value,path){
  const keys=Reflect.ownKeys(value);
  if(keys.some(key=>typeof key!=='string')) fail(path,'symbol-key',`${path} must not contain symbol keys`);
  for(const key of keys){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable){
      fail(path,'non-json-property',`${path} must contain enumerable data properties only`);
    }
  }
  return keys;
}

function exactEntryKeys(value){
  if(!isPlainObject(value)) fail('entry','plain-object','History entry must be a plain object');
  const actual=ownDataKeys(value,'entry').sort();
  const expected=[...ENTRY_FIELDS].sort();
  if(actual.length!==expected.length||actual.some((key,index)=>key!==expected[index])){
    fail('entry','exact-fields','History entry has unexpected or missing fields');
  }
}

function normalizeText(value,{path,maxLength}){
  if(typeof value!=='string') fail(path,'type',`${path} must be a string`);
  const normalized=value.trim();
  const length=[...normalized].length;
  if(length<1||length>maxLength) fail(path,'length',`${path} must contain 1-${maxLength} characters`);
  if(UNSAFE_TEXT.test(normalized)) fail(path,'unsafe-text',`${path} contains unsafe text characters`);
  return normalized;
}

function normalizeTimestamp(value,path){
  const date=typeof value==='string'?new Date(value):null;
  if(!date||!Number.isFinite(date.getTime())||date.toISOString()!==value){
    fail(path,'timestamp',`${path} must be a canonical ISO timestamp`);
  }
  return value;
}

function normalizeJson(value,{path='snapshot',limits=HISTORY_LIMITS}={}){
  const ancestors=new WeakSet();
  let nodes=0;

  function visit(current,currentPath,depth){
    nodes+=1;
    if(nodes>limits.maxNodes) fail(path,'node-limit',`${path} contains too many values`);
    if(depth>limits.maxDepth) fail(path,'depth-limit',`${path} exceeds the nesting limit`);
    if(current===null||typeof current==='string'||typeof current==='boolean') return current;
    if(typeof current==='number'){
      if(!Number.isFinite(current)) fail(currentPath,'non-finite',`${currentPath} must be finite`);
      return Object.is(current,-0)?0:current;
    }
    if(typeof current!=='object') fail(currentPath,'json-safe',`${currentPath} is not JSON-safe`);
    if(ancestors.has(current)) fail(currentPath,'cycle',`${currentPath} contains a cycle`);
    ancestors.add(current);

    let normalized;
    if(Array.isArray(current)){
      const keys=Reflect.ownKeys(current);
      for(const key of keys){
        if(typeof key!=='string') fail(currentPath,'symbol-key',`${currentPath} must not contain symbol keys`);
        if(key==='length') continue;
        const descriptor=Object.getOwnPropertyDescriptor(current,key);
        if(!/^(0|[1-9][0-9]*)$/u.test(key)||Number(key)>=current.length
          ||!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable){
          fail(currentPath,'array-shape',`${currentPath} must be a dense JSON array`);
        }
      }
      normalized=[];
      for(let index=0;index<current.length;index+=1){
        if(!Object.hasOwn(current,index)) fail(`${currentPath}[${index}]`,'array-hole',`${currentPath} must be a dense JSON array`);
        normalized.push(visit(current[index],`${currentPath}[${index}]`,depth+1));
      }
    }else{
      if(!isPlainObject(current)) fail(currentPath,'plain-object',`${currentPath} must be a plain object`);
      const keys=ownDataKeys(current,currentPath).sort();
      normalized={};
      for(const key of keys){
        if(DANGEROUS_KEYS.has(key)) fail(`${currentPath}.${key}`,'dangerous-key',`${currentPath} contains a forbidden key`);
        normalized[key]=visit(current[key],`${currentPath}.${key}`,depth+1);
      }
    }
    ancestors.delete(current);
    return normalized;
  }

  return visit(value,path,0);
}

function deepFreeze(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Strictly clone and freeze one stored history fact. */
export function normalizeHistoryEntry(entry){
  exactEntryKeys(entry);
  if(typeof entry.entityId!=='string'||!SAFE_ID.test(entry.entityId)){
    fail('entityId','safe-id','entityId must be a safe stable id');
  }
  if(!Number.isSafeInteger(entry.revision)||entry.revision<1){
    fail('revision','positive-integer','revision must be a positive safe integer');
  }
  const changedAt=normalizeTimestamp(entry.changedAt,'changedAt');
  if(!OPERATION_SET.has(entry.operation)) fail('operation','enum','operation is not supported');
  const source=normalizeText(entry.source,{path:'source',maxLength:HISTORY_LIMITS.maxSourceLength});
  const reason=normalizeText(entry.reason,{path:'reason',maxLength:HISTORY_LIMITS.maxReasonLength});
  if(entry.operation==='delete'){
    if(entry.snapshot!==null) fail('snapshot','delete-snapshot','delete entries must have a null snapshot');
  }else if(!isPlainObject(entry.snapshot)){
    fail('snapshot','dto-snapshot','non-delete entries require a complete DTO object snapshot');
  }
  const snapshot=entry.snapshot===null?null:normalizeJson(entry.snapshot);
  return deepFreeze({
    entityId:entry.entityId,
    revision:entry.revision,
    changedAt,
    operation:entry.operation,
    source,
    reason,
    snapshot,
  });
}

/** Validator shape compatible with the other pure domain modules. */
export function validateHistoryEntry(entry){
  try{
    const value=normalizeHistoryEntry(entry);
    return Object.freeze({ok:true,value,errors:Object.freeze([])});
  }catch(error){
    if(!(error instanceof HistoryValidationError)) throw error;
    return Object.freeze({ok:false,errors:error.details});
  }
}

export function normalizeHistoryEntries(entries){
  if(!Array.isArray(entries)) fail('entries','array','entries must be an array');
  const normalized=[];
  for(let index=0;index<entries.length;index+=1){
    if(!Object.hasOwn(entries,index)) fail(`entries[${index}]`,'array-hole','entries must be a dense array');
    normalized.push(normalizeHistoryEntry(entries[index]));
  }
  return deepFreeze(normalized);
}

function assertEntitySequence(entries,entityId){
  for(let index=1;index<entries.length;index+=1){
    const previous=entries[index-1];
    const current=entries[index];
    if(current.revision<=previous.revision){
      fail('entries','revision-order',`History for ${entityId} must use strictly increasing revisions`);
    }
    if(current.changedAt<previous.changedAt){
      fail('entries','timestamp-order',`History for ${entityId} must not move backwards in time`);
    }
    if(previous.operation==='delete'){
      fail('entries','after-delete',`History for ${entityId} must not continue after deletion`);
    }
  }
}

/** Return exact stored entries for one entity in deterministic revision order. */
export function historyForEntity(entries,entityId){
  if(typeof entityId!=='string'||!SAFE_ID.test(entityId)) fail('entityId','safe-id','entityId must be a safe stable id');
  const selected=normalizeHistoryEntries(entries)
    .filter(entry=>entry.entityId===entityId)
    .sort((left,right)=>left.revision-right.revision||left.changedAt.localeCompare(right.changedAt));
  assertEntitySequence(selected,entityId);
  return deepFreeze(selected);
}

/**
 * Read-only validity projection. `validTo` is never persisted or written back;
 * it is the next immutable fact's `changedAt`.
 */
export function historyTimelineForEntity(entries,entityId){
  const selected=historyForEntity(entries,entityId);
  return deepFreeze(selected.map((entry,index)=>({
    entry,
    validFrom:entry.changedAt,
    validTo:selected[index+1]?.changedAt??null,
  })));
}

function pointerSegment(value){
  return String(value).replace(/~/gu,'~0').replace(/\//gu,'~1');
}

function childPath(path,key){
  return `${path}/${pointerSegment(key)}`;
}

function sameContainer(left,right){
  return Array.isArray(left)&&Array.isArray(right)
    ||isPlainObject(left)&&isPlainObject(right);
}

function addChange(changes,path,type,beforePresent,afterPresent,before,after){
  changes.push({
    path,
    type,
    beforePresent,
    afterPresent,
    before:beforePresent?before:null,
    after:afterPresent?after:null,
  });
}

function stableSeatMap(value){
  if(!Array.isArray(value)) return null;
  const seats=new Map();
  for(const seat of value){
    if(!isPlainObject(seat)||typeof seat.id!=='string'||seat.id.length===0||seats.has(seat.id)) return null;
    seats.set(seat.id,seat);
  }
  return seats;
}

function diffSeatValues(before,after,path,changes){
  const beforeSeats=stableSeatMap(before);
  const afterSeats=stableSeatMap(after);
  if(!beforeSeats||!afterSeats) return false;
  const ids=[...new Set([...beforeSeats.keys(),...afterSeats.keys()])].sort();
  for(const id of ids){
    const beforePresent=beforeSeats.has(id);
    const afterPresent=afterSeats.has(id);
    const nextPath=childPath(path,`@${id}`);
    if(!beforePresent) addChange(changes,nextPath,'added',false,true,null,afterSeats.get(id));
    else if(!afterPresent) addChange(changes,nextPath,'removed',true,false,beforeSeats.get(id),null);
    else diffValues(beforeSeats.get(id),afterSeats.get(id),nextPath,changes);
  }
  return true;
}

function diffValues(before,after,path,changes){
  if(Object.is(before,after)) return;
  if(sameContainer(before,after)){
    if(Array.isArray(before)){
      // A real boat seat keeps its identity when capacity changes move it to a
      // different array position. Comparing /seats by index would invent trim
      // changes for another physical place; stable seat IDs are the contract.
      if(path==='/seats'&&diffSeatValues(before,after,path,changes)) return;
      const length=Math.max(before.length,after.length);
      for(let index=0;index<length;index+=1){
        const beforePresent=index<before.length;
        const afterPresent=index<after.length;
        const nextPath=childPath(path,index);
        if(!beforePresent) addChange(changes,nextPath,'added',false,true,null,after[index]);
        else if(!afterPresent) addChange(changes,nextPath,'removed',true,false,before[index],null);
        else diffValues(before[index],after[index],nextPath,changes);
      }
      return;
    }
    const keys=[...new Set([...Object.keys(before),...Object.keys(after)])].sort();
    for(const key of keys){
      const beforePresent=Object.hasOwn(before,key);
      const afterPresent=Object.hasOwn(after,key);
      const nextPath=childPath(path,key);
      if(!beforePresent) addChange(changes,nextPath,'added',false,true,null,after[key]);
      else if(!afterPresent) addChange(changes,nextPath,'removed',true,false,before[key],null);
      else diffValues(before[key],after[key],nextPath,changes);
    }
    return;
  }
  addChange(changes,path,'changed',true,true,before,after);
}

/**
 * Produce a deterministic, presentation-neutral Alt/Neu comparison.
 * Paths are RFC-6901 JSON pointers; callers must render values as text, never HTML.
 */
export function diffHistoryEntries(previous,current){
  const before=previous===null?null:normalizeHistoryEntry(previous);
  const after=normalizeHistoryEntry(current);
  if(before){
    if(before.entityId!==after.entityId) fail('entityId','entity-mismatch','History entries must describe the same entity');
    if(after.revision<=before.revision) fail('revision','revision-order','Current revision must be newer than previous revision');
    if(after.changedAt<before.changedAt) fail('changedAt','timestamp-order','Current revision must not predate previous revision');
    if(before.operation==='delete') fail('previous.operation','after-delete','A deleted entity cannot receive another revision');
  }

  const changes=[];
  let changeType='update';
  if(!before){
    if(after.snapshot===null) fail('snapshot','delete-without-before','A delete comparison requires a previous snapshot');
    changeType='create';
    addChange(changes,'','added',false,true,null,after.snapshot);
  }else if(after.operation==='delete'){
    changeType='delete';
    addChange(changes,'','removed',true,false,before.snapshot,null);
  }else{
    diffValues(before.snapshot,after.snapshot,'',changes);
    if(changes.length===0) changeType='unchanged';
  }

  return deepFreeze({
    entityId:after.entityId,
    fromRevision:before?.revision??null,
    toRevision:after.revision,
    changeType,
    changes,
  });
}
