/**
 * Pure adapter for the two JSON values written by the original V1 app.
 *
 * This module deliberately has no DOM, storage, network, or write side effects.
 * It accepts only V1's exact localStorage shapes, then hands explicit schema-2
 * DTOs to the current Core migration. General imports remain strictly versioned.
 */

import {
  MAX_IMPORT_ITEMS,
  PRESETS,
  RANGES,
  SCHEMA_VERSION,
  migrateBoatToCurrent,
  migrateCurrentConfigToCurrent,
  migrateRowerToCurrent,
} from './core.mjs';

const V1_PRESETS=Object.freeze([
  '1x','2x','4x','2-','4-','8+','gigS','gigR',
  'wmM1x','wmW1x','wmM2x','wmW2x','wmM4x','wmW4x',
  'wmM2-','wmW2-','wmM4-','wmW4-','wmM8+','wmW8+',
]);
const BLADES=Object.freeze(['big','mac']);
const RIGS=Object.freeze(['skull','riemen']);
const MODES=Object.freeze(['werkstatt','wasser']);
const HEIGHT_REFS=Object.freeze(['sitz','schiene']);
const EDIT_SEATS=Object.freeze(['s1','s2']);
const SEED_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u;

const V1_PROFILE_FIELDS=Object.freeze([
  'name','legLen','torsoLen','wingspan','SB','weight','stemmX',
]);
const V1_SEAT_FIELDS=Object.freeze([
  'DA','IH','L','d','handGap','a','anlage','aussen','dBB','stemmW','rollL','rueh',
]);
const V1_CREW_FIELDS=Object.freeze([...V1_PROFILE_FIELDS,...V1_SEAT_FIELDS]);
const V1_BOAT_FIELDS=Object.freeze([
  'name','preset','blade','rig','strokeSide','phiA','phiR','c','seatOffset','s1','s2',
]);
const V1_STATE_FIELDS=Object.freeze([
  'rig','strokeSide','phiA','phiR','t','recovery','c','kg','mode','heightRef','seatOffset',
  'crew','editSeat','db','dbIdx','boats',
]);
const V1_WORKSPACE_FIELDS=Object.freeze(['state','preset','blade']);

export class LegacyV1ValidationError extends TypeError{
  constructor(path,message){
    super(`${path}: ${message}`);
    this.name='LegacyV1ValidationError';
    this.path=path;
  }
}

function fail(path,message){ throw new LegacyV1ValidationError(path,message); }

function isPlainRecord(value){
  if(value===null||typeof value!=='object'||Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype||proto===null;
}

function exactRecord(value,fields,path){
  if(!isPlainRecord(value)) fail(path,'erwartet wurde ein einfaches Objekt');
  const allowed=new Set(fields);
  for(const key of Object.keys(value)) if(!allowed.has(key)) fail(`${path}.${key}`,'unbekanntes Feld');
  for(const key of fields) if(!Object.hasOwn(value,key)) fail(`${path}.${key}`,'Pflichtfeld fehlt');
  return value;
}

function finiteRange(value,range,path){
  if(typeof value!=='number'||!Number.isFinite(value)) fail(path,'erwartet wurde eine endliche Zahl');
  if(value<range[0]||value>range[1]) fail(path,`Wert muss in [${range[0]}, ${range[1]}] liegen`);
  return value;
}

function oneOf(value,allowed,path){
  if(!allowed.includes(value)) fail(path,`erwartet wurde einer von: ${allowed.join(', ')}`);
  return value;
}

function bool(value,path){
  if(typeof value!=='boolean') fail(path,'erwartet wurde ein Boolean');
  return value;
}

function safeInteger(value,min,max,path){
  if(!Number.isSafeInteger(value)||value<min||value>max) fail(path,`erwartet wurde eine Ganzzahl in [${min}, ${max}]`);
  return value;
}

function array(value,path){
  if(!Array.isArray(value)) fail(path,'erwartet wurde ein Array');
  if(value.length>MAX_IMPORT_ITEMS) fail(path,`höchstens ${MAX_IMPORT_ITEMS} Einträge sind erlaubt`);
  for(let index=0;index<value.length;index+=1){
    if(!Object.hasOwn(value,index)) fail(`${path}[${index}]`,'Array-Lücken sind nicht erlaubt');
  }
  return value;
}

function parseJsonValue(raw,path){
  if(typeof raw!=='string') return raw;
  try{ return JSON.parse(raw); }
  catch(error){ fail(path,`ungültiges JSON (${error instanceof Error?error.message:'Parsefehler'})`); }
}

function requireSeed(seed){
  if(typeof seed!=='string'||!SEED_PATTERN.test(seed)){
    fail('options.seed','erwartet wurde eine stabile Kennung aus 1–96 sicheren Zeichen');
  }
  return seed;
}

function v2Rower(profile,path){
  exactRecord(profile,V1_PROFILE_FIELDS,path);
  // Core is the authoritative name/Unicode/XSS boundary. Constructing an
  // explicit DTO also guarantees that no V1 property can become markup.
  const source={
    schemaVersion:2,
    kind:'rower',
    name:profile.name,
    legLen:finiteRange(profile.legLen,RANGES.rower.legLen,`${path}.legLen`),
    torsoLen:finiteRange(profile.torsoLen,RANGES.rower.torsoLen,`${path}.torsoLen`),
    wingspan:finiteRange(profile.wingspan,RANGES.rower.wingspan,`${path}.wingspan`),
    SB:finiteRange(profile.SB,RANGES.rower.SB,`${path}.SB`),
    weight:finiteRange(profile.weight,RANGES.rower.weight,`${path}.weight`),
    stemmX:finiteRange(profile.stemmX,RANGES.rower.stemmX,`${path}.stemmX`),
  };
  return source;
}

function currentRower(profile,path){
  return migrateRowerToCurrent(v2Rower(profile,path),{storage:false,path}).value;
}

function v2Seat(seat,rig,path){
  exactRecord(seat,V1_SEAT_FIELDS,path);
  const rigRanges=RANGES[rig];
  const source={schemaVersion:2,kind:'seat',rig};
  for(const key of V1_SEAT_FIELDS){
    const range=rigRanges[key]??RANGES.seat[key];
    source[key]=finiteRange(seat[key],range,`${path}.${key}`);
  }
  return source;
}

function v2Boat(boat,path){
  exactRecord(boat,V1_BOAT_FIELDS,path);
  const preset=oneOf(boat.preset,V1_PRESETS,`${path}.preset`);
  const rig=oneOf(boat.rig,RIGS,`${path}.rig`);
  if(PRESETS[preset]?.rig!==rig) fail(`${path}.rig`,'Rigg passt nicht zur Bootsklasse');
  if(boat.strokeSide!==-1&&boat.strokeSide!==1) fail(`${path}.strokeSide`,'erwartet wurde -1 oder 1');
  const firstSeat=v2Seat(boat.s1,rig,`${path}.s1`);
  const secondSeat=v2Seat(boat.s2,rig,`${path}.s2`);
  return {
    schemaVersion:2,
    kind:'boat',
    name:boat.name,
    preset,
    blade:oneOf(boat.blade,BLADES,`${path}.blade`),
    rig,
    strokeSide:boat.strokeSide,
    phiA:finiteRange(boat.phiA,RANGES.boat.phiA,`${path}.phiA`),
    phiR:finiteRange(boat.phiR,RANGES.boat.phiR,`${path}.phiR`),
    c:finiteRange(boat.c,RANGES.boat.c,`${path}.c`),
    seatOffset:finiteRange(boat.seatOffset,RANGES.boat.seatOffset,`${path}.seatOffset`),
    s1:firstSeat,
    // V1 kept s2 in memory even for a single. Validate the input, but never
    // preserve that non-existent person's hidden rig as a 1x domain value.
    s2:PRESETS[preset]?.single===true?firstSeat:secondSeat,
  };
}

function v1CrewMember(member,rig,path){
  exactRecord(member,V1_CREW_FIELDS,path);
  const rower=v2Rower(Object.fromEntries(V1_PROFILE_FIELDS.map(key=>[key,member[key]])),path);
  const seat=v2Seat(Object.fromEntries(V1_SEAT_FIELDS.map(key=>[key,member[key]])),rig,path);
  return {rower,seat};
}

function workspaceBoat(state,preset,blade,s1,s2){
  const single=PRESETS[preset]?.single===true;
  // Schema 2 requires both rig templates. For a single V1 only s1 was visible;
  // using it twice lets Core discard the hidden s2 template deterministically.
  const secondSeat=single?s1.seat:s2.seat;
  return {
    schemaVersion:2,
    kind:'boat',
    name:`V1-Arbeitsstand ${preset}`,
    preset,
    blade,
    rig:state.rig,
    strokeSide:state.strokeSide,
    phiA:state.phiA,
    phiR:state.phiR,
    c:state.c,
    seatOffset:state.seatOffset,
    s1:s1.seat,
    s2:secondSeat,
  };
}

function validateWorkspaceSource(value,path){
  exactRecord(value,V1_WORKSPACE_FIELDS,path);
  const state=exactRecord(value.state,V1_STATE_FIELDS,`${path}.state`);
  const preset=oneOf(value.preset,V1_PRESETS,`${path}.preset`);
  const blade=oneOf(value.blade,BLADES,`${path}.blade`);
  const rig=oneOf(state.rig,RIGS,`${path}.state.rig`);
  if(PRESETS[preset]?.rig!==rig) fail(`${path}.state.rig`,'Rigg passt nicht zur Bootsklasse');
  if(state.strokeSide!==-1&&state.strokeSide!==1) fail(`${path}.state.strokeSide`,'erwartet wurde -1 oder 1');
  finiteRange(state.phiA,RANGES.boat.phiA,`${path}.state.phiA`);
  finiteRange(state.phiR,RANGES.boat.phiR,`${path}.state.phiR`);
  finiteRange(state.t,RANGES.current.t,`${path}.state.t`);
  bool(state.recovery,`${path}.state.recovery`);
  finiteRange(state.c,RANGES.boat.c,`${path}.state.c`);
  finiteRange(state.kg,RANGES.current.kg,`${path}.state.kg`);
  oneOf(state.mode,MODES,`${path}.state.mode`);
  oneOf(state.heightRef,HEIGHT_REFS,`${path}.state.heightRef`);
  finiteRange(state.seatOffset,RANGES.boat.seatOffset,`${path}.state.seatOffset`);
  oneOf(state.editSeat,EDIT_SEATS,`${path}.state.editSeat`);
  exactRecord(state.crew,['s1','s2'],`${path}.state.crew`);
  const db=array(state.db,`${path}.state.db`);
  const boats=array(state.boats,`${path}.state.boats`);
  safeInteger(state.dbIdx,-1,Math.max(-1,db.length-1),`${path}.state.dbIdx`);
  return {state,preset,blade,rig,db,boats};
}

/**
 * Convert the bare JSON array stored under V1's `rudertrimm_boats` key.
 * The whole candidate is validated before the result is returned.
 */
export function adaptLegacyV1Boats(raw,{seed='v1-boats'}={}){
  const stableSeed=requireSeed(seed);
  const value=array(parseJsonValue(raw,'rudertrimm_boats'),'rudertrimm_boats');
  const legacy=value.map((boat,index)=>v2Boat(boat,`rudertrimm_boats[${index}]`));
  const migrated=legacy.map((boat,index)=>migrateBoatToCurrent(boat,{
    storage:false,
    path:`rudertrimm_boats[${index}]`,
    record:{id:`${stableSeed}-${index+1}`},
  }).value);
  return Object.freeze(migrated);
}

/**
 * Convert V1's `{state,preset,blade}` value into separated current DTOs.
 * Embedded databases never enter the workspace snapshot.
 */
export function adaptLegacyV1Workspace(raw,{seed='v1-workspace'}={}){
  const stableSeed=requireSeed(seed);
  const source=parseJsonValue(raw,'rudertrimm');
  const {state,preset,blade,rig,db,boats}=validateWorkspaceSource(source,'rudertrimm');
  const first=v1CrewMember(state.crew.s1,rig,'rudertrimm.state.crew.s1');
  const second=v1CrewMember(state.crew.s2,rig,'rudertrimm.state.crew.s2');
  const single=PRESETS[preset]?.single===true;
  const legacyConfig={
    schemaVersion:2,
    kind:'currentConfig',
    boat:workspaceBoat(state,preset,blade,first,second),
    crew:{s1:first.rower,s2:single?null:second.rower},
    editSeat:single?'s1':state.editSeat,
    mode:state.mode,
    heightRef:state.heightRef,
    kg:state.kg,
    t:state.t,
    recovery:state.recovery,
  };

  // Validate every embedded item first. A malformed mixed collection therefore
  // cannot yield a partially migrated workspace or database.
  const rowers=db.map((profile,index)=>currentRower(profile,`rudertrimm.state.db[${index}]`));
  const legacyBoats=boats.map((boat,index)=>v2Boat(boat,`rudertrimm.state.boats[${index}]`));
  const migratedBoats=legacyBoats.map((boat,index)=>migrateBoatToCurrent(boat,{
    storage:false,
    path:`rudertrimm.state.boats[${index}]`,
    record:{id:`${stableSeed}-boat-${index+1}`},
  }).value);
  const workspace=migrateCurrentConfigToCurrent(legacyConfig,{
    storage:false,
    path:'rudertrimm',
    record:{id:stableSeed},
  }).value;

  if(workspace.schemaVersion!==SCHEMA_VERSION) fail('rudertrimm','Core-Migration lieferte nicht das aktuelle Schema');
  return Object.freeze({
    workspace,
    rowers:Object.freeze(rowers),
    boats:Object.freeze(migratedBoats),
  });
}
