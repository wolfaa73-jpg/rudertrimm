import {
  CATCH_MODEL,
  PRESETS,
  RANGES,
  SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
  MAX_NAME_LENGTH,
  advanceStrokeCycle,
  buildBoatDTO,
  buildCurrentConfigDTO,
  buildRowerDTO,
  buildSeatDTO,
  buildTestielComparisonDemoConfig,
  buildTestielDemoConfig,
  cycleProgressFromStrokePose,
  defaultFaForRig,
  deriveBodySegments,
  derivedGeometry,
  findHighestReachableAngle,
  hasHiddenSingleSeatProfile,
  minimizeHiddenSingleSeatProfile,
  migrateBoatToCurrent,
  migrateCurrentConfigToCurrent,
  migrateRowerToCurrent,
  planSeatLayoutByRole,
  solveInboardForRatio,
  solveNaturalCatchAngle,
  seatLabelForPosition,
  seatRoleForPosition,
  strokePoseAtCycleProgress,
  truncateCodePoints,
  validateBoat,
  validateCurrentConfig,
  validateImportObject,
  validateRower,
} from './core.mjs';
import {
  createBoatRepository,
  createEfaCandidateRepository,
  createMemoryStorage,
  createRowerRepository,
  createStableId,
  createWorkspaceRepository,
  NoSelectionError,
  STORAGE_KINDS,
  withExclusiveRepositoryWrite,
} from './storage.mjs';
import {
  collectionExchange,
  detachImportedBoatRowerReferences,
  mergeCollectionImport,
  migrateCollection,
  previewCollectionImport,
  sameCollectionImportPreview,
} from './import-adapter.mjs';
import {
  createContextualSelection,
  createObservedRevision,
  profileCommitPolicy,
  workflowGuideState,
  workspaceSaveCompletionPolicy,
  workspaceSavePolicy,
  workspaceStateLabel,
} from './ui-session.mjs';
import {buildTrimActionPlan} from './recommendations.mjs';
import {adaptLegacyV1Boats,adaptLegacyV1Workspace} from './legacy-v1.mjs';
import {diffHistoryEntries,historyForEntity} from './history.mjs';
import {
  EFA_CSV_LIMITS,
  parseEfaCsv,
  previewEfaCsv,
  suggestEfaHeaderMapping,
  validateEfaCandidate,
} from './efa-csv.mjs';

"use strict";
const BOOT_ROOT=document.documentElement;
BOOT_ROOT.dataset.rudertrimmBoot='loading';

async function bootRudertrimm(){
const $ = id => document.getElementById(id);
const rad = d => d*Math.PI/180;
const deg = r => r*180/Math.PI;
const lerp = (a,b,t) => a+(b-a)*t;
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
const smooth = x => { x=clamp(x,0,1); return x*x*(3-2*x); };
const fmt = (v,dec=1) => v.toLocaleString('de-DE',{minimumFractionDigits:0,maximumFractionDigits:dec});
const RELEASE=globalThis.RUDERTRIMM_RELEASE;
if(!RELEASE) throw new TypeError('Zentrale Release-Metadaten fehlen.');
const APP_VERSION=RELEASE.appVersion;
const APP_BUILD_DATE=RELEASE.buildDate;
const APP_BUILD_ID=RELEASE.buildId;
const APP_SHELL_REVISION=RELEASE.shellRevision;
$('buildState').textContent=RELEASE.label;
const isDirectFile=globalThis.location?.protocol==='file:';
const STORAGE_PROBE_KEY='rudertrimm:v2:capability-probe';
let storageMode='local';
let storageAdapter;
let storageFallbackReason='';
function probeStorage(candidate){
  candidate.setItem(STORAGE_PROBE_KEY,'1');
  candidate.removeItem(STORAGE_PROBE_KEY);
  return candidate;
}
try{
  if(isDirectFile){
    const error=new Error('Direktstart verwendet keinen browserübergreifend verlässlichen Dauerspeicher.');
    error.code='direct-file';
    throw error;
  }
  if(typeof navigator.locks?.request!=='function'){
    const error=new Error('Web Locks fehlen; persistente Mehrtab-Schreibvorgänge wären nicht atomar koordinierbar.');
    error.code='coordination-unavailable';
    throw error;
  }
  storageAdapter=probeStorage(window.localStorage);
}catch(localError){
  try{
    storageAdapter=probeStorage(window.sessionStorage);
    storageMode='session';
    storageFallbackReason=localError?.code==='direct-file'
      ?'Direktstart ohne verlässlichen Dauerspeicher'
      :localError?.code==='coordination-unavailable'
      ?'Web Locks fehlen'
      :'Persistenter Browser-Speicher ist nicht verfügbar';
    console.warn('Persistente, atomar koordinierte Mehrtab-Speicherung ist nicht verfügbar; V2 verwendet tabgebundenes sessionStorage.',localError);
  }catch(sessionError){
    storageAdapter=createMemoryStorage();
    storageMode='memory';
    storageFallbackReason='Browser-Speicher ist vollständig blockiert';
    console.error('Browser-Speicher ist vollständig blockiert; V2 verwendet flüchtigen Arbeitsspeicher.',{localError,sessionError});
  }
}
let dirty=false;
// Session-local mutation counter, not a repository revision. A delayed workspace
// or boat completion may adopt UI/dirty state only if no newer edit happened.
let workspaceChangeVersion=0;
let ephemeralDataPresent=false;
let workspaceViewState='new';
let workflowGuideReady=false, workflowGuideSignature='', workflowCurrentResultSignature='', workflowReviewedResultSignature='';
let renderedActionPlanSignature='';
const limitName=value=>truncateCodePoints(String(value??''),MAX_NAME_LENGTH);
const cleanName=(value,fallback='Unbenannt')=>limitName(String(value??'').replace(/\s+/g,' ').trim())||fallback;
const cleanOptionalName=value=>limitName(String(value??'').replace(/\s+/g,' ').trim())||null;
// Lange gültige Namen bleiben in Daten und SVG-Beschreibung vollständig; nur die
// knappen Zeichenflächen erhalten eine deterministische, Unicode-sichere Kurzform.
function visualName(value,fallback='Ruderer',maxLength=24){
  const name=cleanName(value,fallback);
  return [...name].length<=maxLength?name:`${truncateCodePoints(name,maxLength-1)}…`;
}
function clearErrorStatus(){ const error=$('errorStatus'); if(error){ error.textContent=''; error.hidden=true; } }
function announce(message){ $('liveStatus').textContent=''; requestAnimationFrame(()=>$('liveStatus').textContent=message); }
function cleanStateLabel(){
  return workspaceStateLabel({dirty,viewState:workspaceViewState,storageMode});
}
function markWorkspaceMutation(){ workspaceChangeVersion+=1; }
function setDirty(value=true){
  if(value) markWorkspaceMutation();
  dirty=value;
  if($('dirtyState')) $('dirtyState').textContent=cleanStateLabel();
  if(workflowGuideReady) renderWorkflowGuide();
}
function setPressed(id,on){ const button=$(id); button.classList.toggle('on',on); button.setAttribute('aria-pressed',String(on)); }
const PRESENTATION_MODES=Object.freeze(['compact','details']);
function setPresentationMode(mode,{focus=false}={}){
  if(!PRESENTATION_MODES.includes(mode)) return false;
  document.body.dataset.presentation=mode;
  const compact=$('presentationCompact'), details=$('presentationDetails');
  for(const [button,active] of [[compact,mode==='compact'],[details,mode==='details']]){
    button.setAttribute('aria-pressed',String(active));
    button.classList.toggle('on',active);
  }
  placeCompactControls(mode);
  if(focus) (mode==='compact'?compact:details).focus();
  return true;
}
function initPresentationMode(){
  $('presentationCompact').addEventListener('click',()=>setPresentationMode('compact'));
  $('presentationDetails').addEventListener('click',()=>setPresentationMode('details'));
  for(const button of document.querySelectorAll('.open-details')){
    button.addEventListener('click',()=>setPresentationMode('details',{focus:true}));
  }
  setPresentationMode(document.body.dataset.presentation==='details'?'details':'compact');
}
function updateContext(){
  if(!$('ctxBoat')) return;
  $('ctxBoat').textContent=cleanName($('boatName').value,'Ungespeichertes Boot');
  $('ctxMode').textContent=state.mode==='werkstatt'?'Werkstatt/Böcke':'Wasser/Steg';
  const seat=activeSeat(), assignment=activeAssignment();
  $('ctxSeat').textContent=seat
    ?`${seatLabel(seat)} · ${assignment?cleanName(assignment.rower.name,'Ungespeichertes Profil'):'frei · Profil erforderlich'}`
    :'Kein Bootsplatz';
  $('dirtyState').textContent=cleanStateLabel();
}
function replaceOptions(select,placeholder,items){
  const first=document.createElement('option'); first.value=''; first.textContent=placeholder;
  const options=items.map(({value,label})=>{ const option=document.createElement('option'); option.value=String(value); option.textContent=label; return option; });
  select.replaceChildren(first,...options);
}
function downloadJson(data,filename){
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const anchor=document.createElement('a'); anchor.href=url; anchor.download=filename; anchor.hidden=true;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function validationMessage(result){
  return result.errors.slice(0,5).map(error=>`${error.path}: ${error.message}`).join('\n');
}
function reportError(error,prefix='Aktion fehlgeschlagen'){
  console.error(prefix,error);
  const message=`${prefix}: ${error?.message||'Unbekannter Fehler'}`;
  const status=$('errorStatus');
  status.textContent=message;
  status.hidden=false;
}
function confirmCollectionImport(preview){
  return confirm([
    `Importvorschau für ${preview.kind}:`,
    `• vorhanden: ${preview.existing}`,
    `• Datei enthält: ${preview.incoming}`,
    `• neu: ${preview.added}`,
    `• exakte Dubletten übersprungen: ${preview.duplicatesSkipped}`,
    `• ID-Konflikte werden neu vergeben: ${preview.remapped}`,
    `• unsichere Boots-Profilreferenzen werden gelöst: ${preview.referencesDetached??0}`,
    `• Datensätze auf das aktuelle Schema migriert: ${preview.migrated}`,
    `• Ergebnis: ${preview.total} von maximal ${preview.maxRecords} Einträgen`,
    '',
    'Jetzt atomar übernehmen?',
  ].join('\n'));
}
function legacyCollectionImportMigrator(migrateRecord){
  return (envelope,{expectedKind})=>{
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)) throw new TypeError('Import muss ein Objekt sein.');
    if(Number.isSafeInteger(envelope.schemaVersion)&&envelope.schemaVersion>SCHEMA_VERSION){
      throw new UnsupportedSchemaVersionError('import',envelope.schemaVersion);
    }
    const keys=Object.keys(envelope).sort().join(',');
    if(keys!=='items,kind,schemaVersion'||envelope.kind!==expectedKind||!Array.isArray(envelope.items)){
      throw new TypeError(`Erwartet wird eine versionierte Datei vom Typ ${expectedKind}.`);
    }
    return {
      schemaVersion:SCHEMA_VERSION,
      kind:expectedKind,
      items:envelope.items.map((item,index)=>migrateRecord(item,{storage:false,path:`items[${index}]`}).value),
    };
  };
}
function approveFreshImportPreview(approved,fresh){
  if(sameCollectionImportPreview(approved,fresh)) return true;
  const error=new Error('Die bestätigte Importvorschau ist nicht mehr aktuell. Bitte den Import erneut starten und die neue Vorschau prüfen.');
  error.code='import-preview-changed';
  throw error;
}
function reportRepositoryLoad(result,label){
  if(result.ok) return;
  if(result.quarantine?.stored===true){
    announce(`${label} waren beschädigt. Die unveränderten Rohdaten wurden nachweislich gesichert; der Bereich startet leer.`);
    return;
  }
  reportError(result.error,`${label} konnten nicht sicher gelesen oder gesichert werden; Speichern und Import bleiben für diesen Bereich gesperrt`);
}
const canMigrateLegacy=result=>result.rawPresent===false||(!result.ok&&result.quarantine?.stored===true);
let legacyV1WorkspaceCache;
function legacyV1WorkspaceCandidate(){
  if(legacyV1WorkspaceCache!==undefined) return legacyV1WorkspaceCache;
  const raw=storageAdapter.getItem('rudertrimm');
  legacyV1WorkspaceCache=raw===null?null:adaptLegacyV1Workspace(raw,{seed:'stored-v1-workspace'});
  return legacyV1WorkspaceCache;
}

const PHI = { skull:{A:66,R:44}, riemen:{A:54,R:36} };

/* Ruderer-/Platz-Profil: Körpermaße UND das Rigg seines Platzes im Boot.
   Die Regler in der Seitenleiste wirken immer auf den gewählten Platz —
   Handbuch 4.1: Plätze dürfen abweichen (kürzere Ruder, kleinerer DA/IH …). */
function mkRower(name,o={}){ return Object.assign({
  name, legLen:90, torsoLen:95, wingspan:188, SB:40, weight:80,
  // Nur neue, ungespeicherte Skull-Arbeitsstände erhalten den Modellstandard;
  // geladene Profile/Workspaces behalten ihren explizit gespeicherten Fa-Wert.
  stemmX:defaultFaForRig('skull'),
  DA:159, IH:88, L:288, d:2, handGap:18,        // Hebel des Platzes
  a:15, anlage:4, aussen:0, dBB:0.5,            // Dollenhöhe/-neigung; Δ BB−StB (Skull)
  stemmW:42, rollL:75, rueh:5,                  // Stemmbrett/Rollbahn (42° = WM-2017-Median)
},o); }

const clone=value=>JSON.parse(JSON.stringify(value));
const localId=prefix=>`${prefix}-${createStableId()}`;
const seatLabel=seat=>seat?.label??`Platz ${seat?.position??'?'}`;
function presetSeatSource(presetKey,blade,position,previous={},seatCount=PRESETS[presetKey]?.seatCount??2){
  const preset=PRESETS[presetKey];
  return buildSeatDTO({
    ...previous,
    id:previous.id??localId('seat'),
    trimId:previous.trimId??localId('trim'),
    externalRef:previous.externalRef??null,
    position,
    role:seatRoleForPosition(position,seatCount),
    label:seatLabelForPosition(position,seatCount),
    rig:preset.rig,
    DA:preset.DA,
    IH:preset.IH,
    L:blade==='mac'?preset.Lmac:preset.Lbig,
    d:previous.d??2,
    handGap:previous.handGap??18,
    a:preset.a,
    anlage:previous.anlage??4,
    aussen:previous.aussen??0,
    dBB:previous.dBB??0.5,
    stemmW:previous.stemmW??42,
    rollL:previous.rollL??75,
    rueh:previous.rueh??5,
    stemmX:defaultFaForRig(preset.rig),
    rowerRef:previous.rowerRef??null,
  });
}
function initialSeats(){
  return [clone(presetSeatSource('1x','big',1,{},1))];
}

const state = {
  rig:'skull', strokeSide:1,   // Riemen: +1 = Schlagmann Steuerbord, −1 = Backbord
  phiA:66, phiR:44, t:0, recovery:false,   // Schlagbogen bootsweit (Handbuch 4.1: gleiche Ruderwinkel)
  c:8, kg:0,                    // Rollsitz über WL & Mannschaftsgewicht = Bootsebene
  mode:'werkstatt',             // 'werkstatt' (Boot auf Böcken) | 'wasser' (Steg-Kontrolle)
  heightRef:'sitz',             // Dollenhöhen-Referenz: 'sitz' (Rollsitz-Tiefpunkt) | 'schiene'
  seatOffset:5,                 // Rollsitz-Tiefpunkt über Schienenoberkante (cm)
  seats:initialSeats(),
  crew:[],
  editSeatId:null,
  referenceSeatId:null,
  db:[], dbIdx:-1,
  boats:[],                 // Boots-Datenbank (komplette Einstellungen)
};
state.editSeatId=state.seats[0].id;
state.referenceSeatId=state.seats[0].id;
const repositoryOptions=storageMode==='local'
  ?{storage:storageAdapter}
  :{storage:storageAdapter,channelFactory:false,storageEventTarget:null};
const rowerRepository=createRowerRepository({...repositoryOptions,validateRecord:validateRower,migrateRecord:migrateRowerToCurrent});
const boatRepository=createBoatRepository({...repositoryOptions,validateRecord:validateBoat,migrateRecord:migrateBoatToCurrent});
const efaCandidateRepository=createEfaCandidateRepository({...repositoryOptions,validateRecord:validateEfaCandidate});
const workspaceRepository=createWorkspaceRepository({...repositoryOptions,validateWorkspace:validateCurrentConfig,migrateWorkspace:migrateCurrentConfigToCurrent});
const repositoryWrite=(repository,action)=>withExclusiveRepositoryWrite(repository,()=>{
  // A second, older tab may publish schema-v2 bytes while this tab is already
  // running. Commit that freshly detected, validated migration inside the same
  // exclusive lock before the requested mutation; no human dialog is in scope.
  if(repository.migrationStatus().pending){
    repository.commitPendingMigration({expectedRevision:repository.snapshot().revision});
  }
  return action();
},{shared:storageMode==='local'});
let selectedBoatId='', selectedBoatRevision=null;
let boatMetadata={externalRef:null,capacityStatus:'preset',legacyRigTemplate:null};
const rowerSelection=createContextualSelection();
const workspaceRevision=createObservedRevision();

const PROFILE_KEYS=new Set(['name','legLen','torsoLen','wingspan','SB','weight']);
const SEAT_KEYS=new Set(['stemmX','DA','IH','L','d','handGap','a','anlage','aussen','dBB','stemmW','rollL','rueh']);
const profileDraftDirty=Object.create(null);
const profileDraftVersion=Object.create(null);
function ensureDraftState(seatId){
  if(!Object.hasOwn(profileDraftDirty,seatId)) profileDraftDirty[seatId]=false;
  if(!Object.hasOwn(profileDraftVersion,seatId)) profileDraftVersion[seatId]=0;
}
function markProfileDraftChanged(seatId){
  ensureDraftState(seatId);
  profileDraftDirty[seatId]=true;
  profileDraftVersion[seatId]+=1;
}
const activeSeat=()=>state.seats.find(seat=>seat.id===state.editSeatId)??state.seats[0]??null;
const assignmentFor=seatId=>state.crew.find(assignment=>assignment.seatId===seatId)??null;
const activeAssignment=()=>activeSeat()?assignmentFor(activeSeat().id):null;
const activeRower=()=>activeAssignment()?.rower??null;
function runtimeForSeat(seat){
  const assignment=seat?assignmentFor(seat.id):null;
  return assignment?{...assignment.rower,...seat,stemmX:seat.stemmX}:null;
}
const isRowerKey=k=>PROFILE_KEYS.has(k)||SEAT_KEYS.has(k);
function getVal(k){
  if(PROFILE_KEYS.has(k)) return activeRower()?.[k]??null;
  if(SEAT_KEYS.has(k)) return activeSeat()?.[k]??null;
  return state[k];
}
function setVal(k,v){
  if(PROFILE_KEYS.has(k)){
    const rower=activeRower();
    if(!rower) return;
    rower[k]=v;
    markProfileDraftChanged(state.editSeatId);
  }else if(SEAT_KEYS.has(k)){
    const seat=activeSeat();
    if(!seat) return;
    seat[k]=v;
  }else state[k]=v;
  setDirty();
}

/* ---------------- Controls ---------------- */
const CTLS = [
  {hdr:'Ruder & Rigg · gewählter Platz'},
  {k:'DA',   lab:'Dollenabstand DA', unit:'cm', step:.5, hint:{skull:'Stift–Stift', riemen:'Bootsmitte–Stift'}},
  {k:'IH',   lab:'Innenhebel IH', unit:'cm', step:.5, hint:{skull:'Faustformel: DA/2 + 8 cm', riemen:'Faustformel: DA + 30 cm'}},
  {k:'L',    lab:'Ruderlänge L', unit:'cm', step:.5},
  {k:'d',    lab:'d · Stift→Klemmring', unit:'cm', min:1, max:3, step:.25},
  {k:'handGap', lab:'Handabstand am Griff', unit:'cm', min:14, max:22, step:.5, hint:{both:'nur Riemen (~2 Handbreit)'}},
  {hdr:'Höhen & Anlage · gewählter Platz'},
  {k:'a',    lab:'Dollenhöhe über Rollsitz', unit:'cm', min:11, max:21, step:.5, hint:{both:'Referenz Schiene = Wert + Sitz-Offset'}},
  {k:'dBB', lab:'Δ Dollenhöhe BB−StB', unit:'cm', min:-2, max:3, step:.25, hint:{skull:'Ziel +0,5–1 cm (Backbord höher)', riemen:'nur Skull — Riemen: Vergleich über die Plätze'}},
  {k:'anlage', lab:'Dollen-Neigung (z. Heck)', unit:'°', min:0, max:8, step:.5, hint:{both:'Norm 4° · Big-Blades eher weniger'}},
  {k:'aussen', lab:'Außenneigung Dollenstift', unit:'°', min:0, max:3, step:.25},
  {hdr:'Rollbahn & Stemmbrett · gewählter Platz'},
  {k:'stemmX', lab:'Stemmbrett längs (Fa)', unit:'cm', min:26, max:56, step:.5, hint:{both:'Fa + Körpermaße bestimmen die modellierte Ist-Auslage · unkalibriertes Prüfmodell'}},
  {k:'stemmW', lab:'Stemmbrett-Neigung', unit:'°', min:36, max:48, step:.5, hint:{both:'Norm 45° zum Kiel, −3° · unabhängig von der Längsposition'}},
  {k:'rollL',  lab:'Rollbahnlänge', unit:'cm', min:68, max:80, step:.5},
  {k:'rueh',   lab:'Rollbahn-Überstand h. Dollenanlage', unit:'cm', min:-5, max:12, step:.5},
  {hdr:'Schlagbogen & Boot · gemeinsam'},
  {k:'phiA', lab:'Auslagewinkel Rigg-Ziel', unit:'°', min:40, max:85, step:.5, hint:{both:'Vergleichswert; die modellierte Ist-Auslage entsteht aus Fa + Körpermaßen'}},
  {k:'phiR', lab:'Rücklagewinkel', unit:'°', min:20, max:60, step:.5},
  {k:'t',    lab:'Durchzug', unit:'%', min:0, max:100, step:1},
  {k:'c',    lab:'Rollsitz über Wasserlinie', unit:'cm', min:5, max:10, step:.5},
  {k:'kg',   lab:'Gewicht vs. Auslegung', unit:'kg', min:-20, max:20, step:1, hint:{both:'1 kg ≙ 1 mm Eintauchtiefe'}},
];
// V1-Hierarchie und offizielle Grundausbildung: direkte Werkstattwerte für den typischen
// Trimmweg. Seltener Messaufbau, Diagnose und Profilpflege bleiben in Details.
const COMPACT_CONTROL_KEYS=Object.freeze([
  'IH','stemmX',
]);
const COMPACT_CONTROL_KEY_SET=new Set(COMPACT_CONTROL_KEYS);
// Ruderer-Sektion (eigenes Panel) — konkrete Körpermaße; stemmX ist pro Ruderer
const ROWER_CTLS = [
  {k:'legLen', lab:'Beinlänge', unit:'cm', min:70, max:105, step:1, hint:{both:'Sohle → Hüftgelenk'}},
  {k:'torsoLen', lab:'Rumpflänge', unit:'cm', min:75, max:110, step:1, hint:{both:'Sitzhöhe: Sitz → Scheitel'}},
  {k:'wingspan', lab:'Spannweite', unit:'cm', min:150, max:215, step:1, hint:{both:'Mittelfinger → Mittelfinger'}},
  {k:'SB',   lab:'Schulterbreite', unit:'cm', min:32, max:48, step:1, hint:{both:'Schulter → Schulter'}},
  {k:'weight', lab:'Körpergewicht', unit:'kg', min:45, max:120, step:1},
];
function numericDraftError(raw,min,max,step){
  if(String(raw).trim()==='') return 'Wert erforderlich.';
  const value=Number(raw);
  if(!Number.isFinite(value)) return 'Bitte eine gültige Zahl eingeben.';
  if(value<min||value>max) return `Erlaubter Bereich: ${fmt(min)} bis ${fmt(max)}.`;
  const ticks=(value-min)/step;
  if(Math.abs(ticks-Math.round(ticks))>1e-7) return `Erlaubte Schrittweite: ${fmt(step)}.`;
  return '';
}
function setNumericDraftError(input,error,message){
  input.setAttribute('aria-invalid',String(Boolean(message)));
  error.hidden=!message;
  error.textContent=message;
}
function restoreNumericDraft(input,error,value,unit){
  if(input.getAttribute('aria-invalid')!=='true') return false;
  input.value=String(value);
  setNumericDraftError(input,error,'');
  announce(`Ungültige Eingabe verworfen · gültiger Wert ${fmt(value)} ${unit}.`);
  return true;
}
function buildInto(list, hostId){
  const host=$(hostId);
  const grouped=hostId==='controls';
  const existingOpenGroups=new Set([...host.querySelectorAll?.('details.control-group[open]')??[]].map(group=>group.dataset.group));
  const hadGroups=!!host.querySelector?.('details.control-group');
  host.replaceChildren();
  let destination=host, groupIndex=-1;
  for(const [itemIndex,c] of list.entries()){
    if(c.hdr){
      if(!grouped){
        const h=document.createElement('div');
        h.className='slab'+(host.children.length?' grp':''); h.textContent=c.hdr;
        host.appendChild(h);
        continue;
      }
      groupIndex+=1;
      const groupKey=String(groupIndex);
      const nextHeaderOffset=list.slice(itemIndex+1).findIndex(item=>item.hdr);
      const controlCount=nextHeaderOffset<0 ? list.length-itemIndex-1 : nextHeaderOffset;
      const details=document.createElement('details'); details.className='control-group'; details.dataset.group=groupKey;
      details.open=hadGroups ? existingOpenGroups.has(groupKey) : groupIndex===0;
      const summary=document.createElement('summary');
      const title=document.createElement('span'); title.textContent=c.hdr;
      const meta=document.createElement('span'); meta.className='control-group-meta'; meta.textContent=`${controlCount} Werte`;
      summary.append(title,meta);
      destination=document.createElement('div'); destination.className='control-group-content';
      details.append(summary,destination); host.appendChild(details);
      continue;
    }
    const r=RANGES[state.rig][c.k];
    const min=r?r[0]:c.min, max=r?r[1]:c.max;
    const current=getVal(c.k);
    const unavailable=PROFILE_KEYS.has(c.k)&&current===null;
    const hint=c.hint?(c.hint.both||c.hint[state.rig]||''):'';
    const div=document.createElement('div'); div.className='ctl';
    const lab=document.createElement('div'); lab.className='lab';
    const label=document.createElement('label'); label.htmlFor=`in_${c.k}`; label.textContent=c.lab;
    const value=document.createElement('span'); value.className='val'; value.id=`v_${c.k}`;
    lab.append(label,value);
    const input=document.createElement('input'); input.type='range'; input.id=`in_${c.k}`;
    input.min=String(min); input.max=String(max); input.step=String(c.step); input.value=String(unavailable?min:current);
    input.disabled=unavailable;
    input.setAttribute('aria-valuetext',unavailable?'Profil erforderlich':`${fmt(current)} ${c.unit}`);
    const numberLabel=document.createElement('label'); numberLabel.className='sr-only'; numberLabel.htmlFor=`num_${c.k}`;
    numberLabel.textContent=`${c.lab} als Zahl in ${c.unit}`;
    const number=document.createElement('input'); number.type='number'; number.id=`num_${c.k}`; number.className='ctl-number';
    number.min=String(min); number.max=String(max); number.step=String(c.step); number.required=true; number.inputMode='decimal';
    number.value=unavailable?'':String(current); number.disabled=unavailable;
    number.placeholder=unavailable?'Profil erforderlich':'';
    const unit=document.createElement('span'); unit.className='ctl-unit'; unit.textContent=c.unit; unit.setAttribute('aria-hidden','true');
    const numberWrap=document.createElement('span'); numberWrap.className='ctl-number-wrap'; numberWrap.append(numberLabel,number,unit);
    const pair=document.createElement('div'); pair.className='ctl-input-pair'; pair.append(input,numberWrap);
    const mm=document.createElement('div'); mm.className='mm';
    const minLabel=document.createElement('span'); minLabel.textContent=fmt(min);
    const maxLabel=document.createElement('span'); maxLabel.textContent=fmt(max);
    mm.append(minLabel,maxLabel);
    const error=document.createElement('div'); error.className='ctl-error'; error.id=`err_${c.k}`; error.setAttribute('aria-live','polite'); error.hidden=true;
    div.append(lab,pair,mm);
    const descriptions=[error.id];
    if(hint){ const hintEl=document.createElement('div'); hintEl.className='hint'; hintEl.id=`hint_${c.k}`; hintEl.textContent=hint; input.setAttribute('aria-describedby',hintEl.id); descriptions.unshift(hintEl.id); div.appendChild(hintEl); }
    number.setAttribute('aria-describedby',descriptions.join(' '));
    div.appendChild(error);
    if(grouped&&COMPACT_CONTROL_KEY_SET.has(c.k)){
      const anchor=document.createElement('span');
      anchor.hidden=true; anchor.dataset.compactAnchor=c.k;
      destination.appendChild(anchor);
      div.classList.add('compact-core-control');
    }
    destination.appendChild(div);
    const commit=value=>{
      setNumericDraftError(number,error,'');
      setVal(c.k,value);
      if(c.k==='t') state.recovery=false;
      render();
    };
    input.addEventListener('input',e=>commit(Number(e.target.value)));
    number.addEventListener('input',e=>{
      const message=numericDraftError(e.target.value,min,max,c.step);
      setNumericDraftError(number,error,message);
      if(!message) commit(Number(e.target.value));
    });
    const restoreNumberDraft=()=>restoreNumericDraft(number,error,getVal(c.k),c.unit);
    number.addEventListener('change',restoreNumberDraft);
    number.addEventListener('blur',restoreNumberDraft);
    c._unit=c.unit;
  }
}
function placeCompactControls(mode){
  const host=$('compactControlHost');
  if(!host) return;
  for(const key of COMPACT_CONTROL_KEYS){
    const input=$(`in_${key}`), control=input?.closest('.ctl');
    if(!control) continue;
    if(mode==='compact'){
      if(control.parentElement!==host) host.appendChild(control);
      continue;
    }
    const anchor=document.querySelector(`[data-compact-anchor="${key}"]`);
    if(anchor) anchor.after(control);
  }
}
function buildControls(){
  $('compactControlHost')?.replaceChildren();
  buildInto(CTLS,'controls');
  buildInto(ROWER_CTLS,'rowerControls');
  placeCompactControls(document.body.dataset.presentation==='details'?'details':'compact');
}
function syncControls(){
  for(const c of [...CTLS,...ROWER_CTLS]){
    if(c.hdr) continue;
    const inp=$('in_'+c.k); if(!inp) continue;
    const current=getVal(c.k), unavailable=PROFILE_KEYS.has(c.k)&&current===null;
    inp.disabled=unavailable;
    if(!unavailable) inp.value=current;
    inp.setAttribute('aria-valuetext',unavailable?'Profil erforderlich':`${fmt(current)} ${c._unit}`);
    const number=$('num_'+c.k);
    if(number){
      number.disabled=unavailable;
      const editingInvalid=typeof document!=='undefined'&&document.activeElement===number&&number.getAttribute('aria-invalid')==='true';
      if(!editingInvalid){
        number.value=unavailable?'':String(current);
        number.placeholder=unavailable?'Profil erforderlich':'';
        if(number.getAttribute('aria-invalid')==='true') setNumericDraftError(number,$('err_'+c.k),'');
      }
    }
    $('v_'+c.k).textContent=unavailable?'Profil erforderlich':fmt(current)+' '+c._unit;
  }
}

/* ---------------- Preset / rig ---------------- */
function applyPreset(){
  const p=PRESETS[$('preset').value];
  const presetKey=$('preset').value;
  const explicitCount=p.seatCount;
  const requested=explicitCount??Math.max(1,Math.min(8,Number.parseInt($('boatSeatCount').value,10)||state.seats.length||2));
  const prior=state.seats;
  const layout=planSeatLayoutByRole(prior,requested);
  const removed=layout.removed.filter(seat=>assignmentFor(seat.id)||seat.rowerRef);
  const moved=layout.sources.flatMap((seat,index)=>{
    if(!seat||seat.position===index+1||(!assignmentFor(seat.id)&&!seat.rowerRef)) return [];
    return [`${seatLabel(seat)} → ${seatLabelForPosition(index+1,requested)}`];
  });
  if((removed.length||moved.length)&&!confirm([
    moved.length?`Bestehende Belegung folgt ihrer Rolle: ${moved.join(', ')}.`:'',
    removed.length?`Entfernt werden: ${removed.map(seat=>seatLabel(seat)).join(', ')} samt aktueller Zuordnung.`:'',
    'Profile in der Datenbank bleiben erhalten. Fortfahren?',
  ].filter(Boolean).join('\n'))){
    return false;
  }
  state.rig=p.rig;
  boatMetadata.capacityStatus=p.seatCount===null?'confirmed':'preset';
  if(!p.single) boatMetadata.legacyRigTemplate=null;
  state.phiA=PHI[p.rig].A; state.phiR=PHI[p.rig].R;
  state.seats=Array.from({length:requested},(_,index)=>clone(presetSeatSource(
    presetKey,$('blade').value,index+1,layout.sources[index]??{},requested,
  )));
  const validIds=new Set(state.seats.map(seat=>seat.id));
  state.crew=state.crew.filter(assignment=>validIds.has(assignment.seatId)).map(assignment=>({
    ...assignment,
    trimId:state.seats.find(seat=>seat.id===assignment.seatId).trimId,
  }));
  if(!validIds.has(state.editSeatId)) state.editSeatId=state.seats[state.seats.length-1].id;
  state.referenceSeatId=state.seats[state.seats.length-1].id;
  if(!p.coxed) $('coxName').value='';
  syncSeatCountControl();
  updateCoxControl(); setDirty();
  buildControls(); updateRig(); render();
  return true;
}
let lastPreset=$('preset').value, lastBlade=$('blade').value;
function confirmOverwrite(message,hasUnsaved=dirty){ return !hasUnsaved||confirm(`${message}\n\nUngespeicherte Änderungen bleiben sonst nicht erhalten.`); }
function applyBladeLength(){
  const p=PRESETS[$('preset').value];
  for(const seat of state.seats) seat.L=$('blade').value==='big'?p.Lbig:p.Lmac;
  setDirty(); buildControls(); render();
}
function setRig(rig){
  if(state.rig===rig) return;
  if(!confirmOverwrite('Der Riggwechsel überschreibt DA, IH, Ruderlänge, Dollenhöhe und Fa aller realen Plätze sowie den gemeinsamen Schlagbogen.')) return;
  const previousPreset=lastPreset;
  $('preset').value = rig==='skull'?'1x':'4-';
  if(applyPreset()) lastPreset=$('preset').value;
  else $('preset').value=previousPreset;
}
function updateRig(){
  setPressed('rigS',state.rig==='skull');
  setPressed('rigR',state.rig==='riemen');
  $('sideWrap').style.display = state.rig==='riemen' ? '' : 'none';
  setPressed('sideB',state.strokeSide===-1);
  setPressed('sideS',state.strokeSide===1);
}
$('preset').addEventListener('change',()=>{
  if(!confirmOverwrite('Das neue Preset überschreibt DA, IH, Ruderlänge, Dollenhöhe und Fa aller realen Plätze sowie den gemeinsamen Schlagbogen.')){ $('preset').value=lastPreset; return; }
  const requestedPreset=$('preset').value;
  if(!applyPreset()){ $('preset').value=lastPreset; syncSeatCountControl(); return; }
  lastPreset=requestedPreset;
});
$('blade').addEventListener('change',()=>{
  if(!confirmOverwrite('Der Blatttyp ändert ausschließlich die Ruderlänge aller realen Plätze.')){ $('blade').value=lastBlade; return; }
  lastBlade=$('blade').value; applyBladeLength();
});
$('rigS').addEventListener('click',()=>setRig('skull'));
$('rigR').addEventListener('click',()=>setRig('riemen'));
$('sideB').addEventListener('click',()=>{ state.strokeSide=-1; setDirty(); updateRig(); render(); });
$('sideS').addEventListener('click',()=>{ state.strokeSide=1; setDirty(); updateRig(); render(); });

/* ---- Messkontext (Werkstatt/Wasser) & Dollenhöhen-Referenz ---- */
function updateMode(){
  setPressed('modeW',state.mode==='werkstatt');
  setPressed('modeX',state.mode==='wasser');
  $('refWrap').style.display = state.mode==='werkstatt' ? '' : 'none';
  setPressed('refSitz',state.heightRef==='sitz');
  setPressed('refSchiene',state.heightRef==='schiene');
  $('in_seatOffset').value=state.seatOffset;
  $('in_seatOffset').setAttribute('aria-valuetext',`${fmt(state.seatOffset)} cm`);
  const number=$('num_seatOffset');
  if(number&&!(document.activeElement===number&&number.getAttribute('aria-invalid')==='true')) number.value=String(state.seatOffset);
  $('v_seatOffset').textContent=fmt(state.seatOffset)+' cm';
}
$('modeW').addEventListener('click',()=>{ state.mode='werkstatt'; setDirty(); updateMode(); render(); });
$('modeX').addEventListener('click',()=>{ state.mode='wasser'; setDirty(); updateMode(); render(); });
$('refSitz').addEventListener('click',()=>{ state.heightRef='sitz'; setDirty(); updateMode(); render(); });
$('refSchiene').addEventListener('click',()=>{ state.heightRef='schiene'; setDirty(); updateMode(); render(); });
function commitSeatOffset(value){ state.seatOffset=value; setDirty(); updateMode(); render(); }
$('in_seatOffset').addEventListener('input',e=>commitSeatOffset(Number(e.target.value)));
$('num_seatOffset').addEventListener('input',e=>{
  const [min,max]=RANGES.boat.seatOffset, step=Number(e.target.step);
  const message=numericDraftError(e.target.value,min,max,step);
  setNumericDraftError(e.target,$('err_seatOffset'),message);
  if(!message) commitSeatOffset(Number(e.target.value));
});
const restoreSeatOffsetDraft=()=>restoreNumericDraft($('num_seatOffset'),$('err_seatOffset'),state.seatOffset,'cm');
$('num_seatOffset').addEventListener('change',restoreSeatOffsetDraft);
$('num_seatOffset').addEventListener('blur',restoreSeatOffsetDraft);

/* ---- Boots-Datenbank: komplette Boots-Einstellung benannt speichern ---- */
const BOAT_RIG_KEYS=['DA','IH','L','d','handGap','a','anlage','aussen','dBB','stemmW','rollL','rueh','stemmX'];
function updateCoxControl(){
  const coxed=PRESETS[$('preset').value]?.coxed===true;
  $('coxWrap').hidden=!coxed;
  $('coxName').disabled=!coxed;
}
function syncSeatCountControl(){
  const preset=PRESETS[$('preset').value];
  const input=$('boatSeatCount');
  const fixed=Number.isSafeInteger(preset?.seatCount);
  input.disabled=fixed;
  input.value=String(fixed?preset.seatCount:state.seats.length);
  $('boatSeatCountHint').textContent=fixed
    ?`Bootsklasse gibt ${preset.seatCount} reale${preset.seatCount===1?'n':''} Platz vor.`
    :'Gig-Boot: Platzanzahl bewusst festlegen; bestehende Belegung wird vor einer Verkleinerung bestätigt.';
}
$('boatSeatCount').addEventListener('change',event=>{
  const previous=state.seats.length;
  if(!confirmOverwrite(
    'Die neue Gig-Platzanzahl wendet das aktuelle Preset erneut an und überschreibt DA, Innenhebel, Ruderlänge, Dollenhöhe und Stemmbrettposition aller Plätze.',
    true,
  )){
    event.target.value=String(previous);
    return;
  }
  if(!applyPreset()) event.target.value=String(previous);
});
function boatOf(){
  const coxName=cleanOptionalName($('coxName').value);
  return buildBoatDTO({ name:cleanName($('boatName').value,'Boot'), preset:$('preset').value, blade:$('blade').value,
    externalRef:boatMetadata.externalRef,
    rig:state.rig, strokeSide:state.strokeSide, phiA:state.phiA, phiR:state.phiR,
    c:state.c, seatOffset:state.seatOffset,
    cox:PRESETS[$('preset').value]?.coxed&&coxName?{name:coxName}:null,
    capacityStatus:PRESETS[$('preset').value]?.seatCount===null?boatMetadata.capacityStatus:'preset',
    seats:state.seats,
    legacyRigTemplate:PRESETS[$('preset').value]?.single?boatMetadata.legacyRigTemplate:null,
  });
}
function canonicalizeBoatName(){
  const name=cleanName($('boatName').value,'Boot');
  $('boatName').value=name;
  updateContext();
  return name;
}
function resolveBoatCrew(){
  const resolved=[];
  for(const seat of state.seats){
    if(!seat.rowerRef) continue;
    const selected=rowerRepository.select(seat.rowerRef.id);
    if(!selected.ok||selected.record.revision!==seat.rowerRef.revision) continue;
    resolved.push({
      schemaVersion:SCHEMA_VERSION,kind:'crewAssignment',seatId:seat.id,trimId:seat.trimId,
      rowerRef:{...seat.rowerRef},rower:clone(selected.record.value),
    });
  }
  state.crew=resolved;
}
function applyBoat(b,{resolveCrew=true}={}){
  clearRowerSelection();
  const replacedSeatIds=new Set([...state.seats.map(seat=>seat.id),...b.seats.map(seat=>seat.id)]);
  for(const seatId of replacedSeatIds){
    ensureDraftState(seatId);
    profileDraftVersion[seatId]+=1;
  }
  $('preset').value=b.preset||'1x'; $('blade').value=b.blade||'big'; $('boatName').value=b.name||'';
  $('coxName').value=b.cox?.name??'';
  lastPreset=$('preset').value; lastBlade=$('blade').value;
  state.rig=b.rig||'skull'; state.strokeSide=b.strokeSide??1;
  state.phiA=b.phiA??state.phiA; state.phiR=b.phiR??state.phiR;
  state.c=b.c??state.c; state.seatOffset=b.seatOffset??state.seatOffset;
  boatMetadata={
    externalRef:b.externalRef?clone(b.externalRef):null,
    capacityStatus:b.capacityStatus,
    legacyRigTemplate:b.legacyRigTemplate?clone(b.legacyRigTemplate):null,
  };
  state.seats=clone(b.seats);
  if(!state.seats.some(seat=>seat.id===state.editSeatId)) state.editSeatId=state.seats[0].id;
  state.referenceSeatId=state.seats[state.seats.length-1].id;
  if(resolveCrew) resolveBoatCrew(); else state.crew=[];
  for(const seat of state.seats){ ensureDraftState(seat.id); profileDraftDirty[seat.id]=false; }
  syncSeatCountControl(); updateCoxControl();
  buildControls(); updateRig(); updateMode(); render();
}
function migrateBoatRecord(source){
  return migrateBoatToCurrent(source).value;
}
async function loadBoats(){
  try{
    await repositoryWrite(boatRepository,()=>{
      const loaded=boatRepository.load();
      reportRepositoryLoad(loaded,'V2-Bootsdaten');
      if(loaded.ok&&loaded.migration?.migrated){
        boatRepository.commitPendingMigration({expectedRevision:loaded.state.revision});
        announce(loaded.migration.recordIds.length
          ?`${loaded.migration.recordIds.length} Bootseinträge wurden atomar auf das aktuelle Sitzplatzschema migriert.`
          :'Der lokale Bootsverlauf wurde atomar initialisiert; die Bootswerte blieben unverändert.');
      }
      if(canMigrateLegacy(loaded)&&boatRepository.list().length===0){
        let candidates=[];
        const rawV2=storageAdapter.getItem('rudertrimm_boats_v2');
        if(rawV2){
          const parsed=JSON.parse(rawV2);
          if(parsed?.kind!=='rudertrimm.boats'||!Array.isArray(parsed.items)) throw new TypeError('Alte Bootsdatei hat kein gültiges Format.');
          candidates=parsed.items.map(item=>migrateBoatToCurrent(item).value);
        }else if(storageAdapter.getItem('rudertrimm_boats')!==null){
          candidates=adaptLegacyV1Boats(storageAdapter.getItem('rudertrimm_boats'),{seed:'stored-v1-boats'});
        }else{
          candidates=legacyV1WorkspaceCandidate()?.boats??[];
        }
        if(migrateCollection(boatRepository,'rudertrimm.boats',candidates,buildBoatDTO)){
          announce(`${candidates.length} Bootseinträge wurden in den versionierten V2-Speicher übernommen.`);
        }
      }
    });
  }catch(error){ console.error('Bootsdaten konnten nicht geladen werden',error); announce('Bootsdaten waren ungültig und wurden nicht geladen. Alte Speicherstände bleiben unverändert erhalten.'); }
  state.boats=boatRepository.list().map(record=>record.value);
}
function updateMasterBoatSelection(){
  const select=$('masterBoatSelect');
  if(!select) return;
  const selected=select.value?boatRepository.select(select.value):{ok:false};
  $('masterBoatUse').disabled=!selected.ok;
  $('masterBoatStatus').textContent=selected.ok
    ?`${cleanName(selected.record.value.name,'Boot')} · ${selected.record.value.seats.length} reale Plätze · Revision ${selected.record.revision} · noch nicht geladen`
    :`${boatRepository.list().length} gespeicherte Boote · Auswahl allein verändert den Arbeitsstand nicht.`;
}
function refreshMasterBoatSelect(){
  const select=$('masterBoatSelect');
  if(!select) return;
  const previous=select.value;
  const records=boatRepository.list();
  replaceOptions(select,'— Boot auswählen —',records.map(record=>({
    value:record.id,
    label:`${cleanName(record.value.name,'Boot')} · ${record.value.seats.length} Plätze · ${record.value.rig==='skull'?'Skull':'Riemen'} · r${record.revision}`,
  })));
  select.value=records.some(record=>record.id===previous)?previous:'';
  updateMasterBoatSelection();
}
const HISTORY_OPERATION_LABELS=Object.freeze({
  baseline:'Ausgangsstand',create:'angelegt',update:'geändert',import:'importiert',
  migration:'migriert',delete:'datenschutzkonform gelöscht',
});
const HISTORY_SOURCE_LABELS=Object.freeze({
  'local-ui':'lokale Bedienung','json-import':'JSON-Import','efa-csv':'eFa-CSV',
  migration:'Migration',system:'System',
});
const HISTORY_FIELD_LABELS=Object.freeze({
  '':'Gesamtdatensatz','/name':'Name','/legLen':'Beinlänge (cm)',
  '/torsoLen':'Rumpflänge (cm)','/wingspan':'Spannweite (cm)',
  '/SB':'Schulterbreite (cm)','/weight':'Gewicht (kg)',
  '/stemmX':'Stemmbrett längs (cm)','/preset':'Bootsklasse','/rig':'Rigg',
  '/blade':'Blatt','/strokeSide':'Riemenseite','/phiA':'Auslage Rigg-Ziel (°)',
  '/phiR':'Rücklagewinkel (°)','/c':'Rollsitz über Wasserlinie (cm)',
  '/seatOffset':'Sitzbezug (cm)','/externalRef':'Externe Referenz',
  '/IH':'Innenhebel (cm)','/DA':'Dollenabstand (cm)','/L':'Ruderlänge (cm)',
  '/a':'Dollenhöhe (cm)','/anlage':'Dollenneigung (°)',
  '/stemmW':'Stemmbrettwinkel (°)','/rollL':'Rollbahnlänge (cm)',
  '/rueh':'Überhöhung (cm)','/position':'Platznummer','/role':'Rolle',
  '/label':'Platzbezeichnung','/rowerRef':'Ruderer-Zuordnung','/trimId':'Trimmprofil-ID',
});
function historyRepository(){
  return $('historyKind').value==='boats'?boatRepository:rowerRepository;
}
function historyValueText(value,present=true){
  if(!present) return '—';
  if(value===null) return 'leer';
  if(typeof value==='boolean') return value?'ja':'nein';
  if(typeof value==='object'){
    const text=JSON.stringify(value);
    return [...text].length>260?truncateCodePoints(text,259)+'…':text;
  }
  return String(value);
}
function unescapePointerSegment(value){
  return String(value).replace(/~1/gu,'/').replace(/~0/gu,'~');
}
function historyPathLabel(path,beforeSnapshot=null,afterSnapshot=null){
  if(Object.hasOwn(HISTORY_FIELD_LABELS,path)) return HISTORY_FIELD_LABELS[path];
  const stableSeat=path.match(/^\/seats\/@([^/]+)(?:\/([^/]+))?$/u);
  if(stableSeat){
    const seatId=unescapePointerSegment(stableSeat[1]);
    const before=beforeSnapshot?.seats?.find?.(seat=>seat.id===seatId);
    const after=afterSnapshot?.seats?.find?.(seat=>seat.id===seatId);
    const seat=after??before;
    const place=seat?.position?`Platz ${seat.position}`:'Bootsplatz';
    if(!stableSeat[2]) return place+' · Sitzdatensatz';
    const field=unescapePointerSegment(stableSeat[2]);
    return place+' · '+(HISTORY_FIELD_LABELS['/'+field]??field);
  }
  const indexedSeat=path.match(/^\/seats\/(\d+)\/([^/]+)$/u);
  if(indexedSeat) return 'Platz '+(Number(indexedSeat[1])+1)+' · '+(HISTORY_FIELD_LABELS['/'+indexedSeat[2]]??indexedSeat[2]);
  return path||'Gesamtdatensatz';
}
function renderHistoryRevision(){
  const repository=historyRepository();
  const id=$('historyEntity').value;
  const revision=Number($('historyRevision').value);
  const entries=id?historyForEntity(repository.history(),id):[];
  const index=entries.findIndex(entry=>entry.revision===revision);
  const current=entries[index];
  const diff=$('historyDiff');
  diff.replaceChildren();
  if(!current){
    $('historyMeta').textContent='Eintrag und Revision wählen.';
    return;
  }
  const date=new Date(current.changedAt).toLocaleString('de-DE');
  const floor=(repository.historyFloors?.()??[]).find(item=>item.entityId===id);
  const retention=floor?` · Ältere Revisionen bis r${floor.throughRevision} wurden nach der Speichergrenze verworfen.`:'';
  $('historyMeta').textContent='Revision '+current.revision+' · '+(HISTORY_OPERATION_LABELS[current.operation]??current.operation)+' · '+date+' · '+(HISTORY_SOURCE_LABELS[current.source]??current.source)+' · Grund: '+current.reason+retention;
  if(current.operation==='delete'){
    const note=document.createElement('div');
    const term=document.createElement('dt'); term.textContent='Datenschutz-Löschung';
    const value=document.createElement('dd'); value.textContent='Personenbezogene Altsnapshots wurden entfernt; nur dieses datenarme Ereignis bleibt.';
    value.style.gridColumn='span 2'; note.append(term,value); diff.appendChild(note);
    return;
  }
  const previous=index>0?entries[index-1]:null;
  const comparison=diffHistoryEntries(previous,current);
  if(comparison.changes.length===0){
    const note=document.createElement('div');
    const term=document.createElement('dt'); term.textContent='Keine Feldänderung';
    const value=document.createElement('dd'); value.textContent='Der gespeicherte Fachdatensatz ist gegenüber der Vorrevision unverändert.';
    value.style.gridColumn='span 2'; note.append(term,value); diff.appendChild(note);
    return;
  }
  for(const change of comparison.changes){
    const row=document.createElement('div');
    const term=document.createElement('dt'); term.textContent=historyPathLabel(change.path,previous?.snapshot,current.snapshot);
    const before=document.createElement('dd'); before.textContent='Alt: '+historyValueText(change.before,change.beforePresent);
    const after=document.createElement('dd'); after.textContent='Neu: '+historyValueText(change.after,change.afterPresent);
    row.append(term,before,after); diff.appendChild(row);
  }
}
function refreshHistoryRevisions(){
  const id=$('historyEntity').value;
  const previous=$('historyRevision').value;
  const entries=id?historyForEntity(historyRepository().history(),id):[];
  replaceOptions($('historyRevision'),'— Revision wählen —',entries.map(entry=>({
    value:entry.revision,
    label:'r'+entry.revision+' · '+(HISTORY_OPERATION_LABELS[entry.operation]??entry.operation)+' · '+new Date(entry.changedAt).toLocaleString('de-DE'),
  })));
  const keep=entries.some(entry=>String(entry.revision)===previous);
  $('historyRevision').value=keep?previous:(entries.at(-1)?String(entries.at(-1).revision):'');
  renderHistoryRevision();
}
function refreshHistoryEntities(){
  if(!$('historyEntity')) return;
  const repository=historyRepository();
  const previous=$('historyEntity').value;
  const current=new Map(repository.list().map(record=>[record.id,record]));
  const entries=repository.history();
  const ids=[...new Set([...current.keys(),...entries.map(entry=>entry.entityId)])];
  const items=ids.map(id=>{
    const record=current.get(id);
    const lastSnapshot=[...entries].reverse().find(entry=>entry.entityId===id&&entry.snapshot)?.snapshot;
    const name=record?.value?.name??lastSnapshot?.name;
    return {
      value:id,
      label:name
        ?cleanName(name,'Eintrag')+' · r'+(record?.revision??entries.filter(entry=>entry.entityId===id).at(-1)?.revision??'?')
        :'Gelöschter Eintrag · '+id.slice(0,8),
    };
  }).sort((left,right)=>left.label.localeCompare(right.label,'de'));
  replaceOptions($('historyEntity'),'— Eintrag wählen —',items);
  $('historyEntity').value=items.some(item=>item.value===previous)?previous:'';
  refreshHistoryRevisions();
}
$('historyKind').addEventListener('change',refreshHistoryEntities);
$('historyEntity').addEventListener('change',refreshHistoryRevisions);
$('historyRevision').addEventListener('change',renderHistoryRevision);
$('historySection').addEventListener('toggle',()=>{
  if($('historySection').open) refreshHistoryEntities();
});
let efaCsvText='';
let efaParsed=null;
let efaApprovedPreview=null;
let efaApprovedContract=null;
function resetEfaPreview(message='CSV und Mapping prüfen, dann Vorschau erstellen.'){
  efaApprovedPreview=null;
  efaApprovedContract=null;
  $('efaCommit').disabled=true;
  $('efaPreviewResult').hidden=true;
  $('efaPreviewList').replaceChildren();
  $('efaImportStatus').textContent=message;
}
function setEfaMappingVisibility(){
  const person=$('efaEntityType').value==='person';
  const parts=person&&$('efaPersonNameMode').value==='parts';
  for(const element of document.querySelectorAll('.efa-person-only')) element.hidden=!person;
  for(const element of document.querySelectorAll('.efa-boat-only')) element.hidden=person;
  for(const element of document.querySelectorAll('.efa-display-only')) element.hidden=!person||parts;
  for(const element of document.querySelectorAll('.efa-parts-only')) element.hidden=!parts;
}
function setEfaColumnOptions(selectId,headers,placeholder){
  replaceOptions($(selectId),placeholder,headers.map(header=>({value:header,label:header})));
}
function populateEfaMapping(){
  if(!efaParsed) return;
  const headers=efaParsed.headers;
  for(const id of ['efaDisplayNameColumn','efaFirstNameColumn','efaLastNameColumn','efaAffixColumn','efaBoatNameColumn','efaIdColumn']){
    setEfaColumnOptions(id,headers,id==='efaAffixColumn'||id==='efaIdColumn'?'— nicht übernehmen —':'— Spalte wählen —');
  }
  const entityType=$('efaEntityType').value;
  const suggested=suggestEfaHeaderMapping(headers,{entityType});
  if(entityType==='person'){
    const useParts=!suggested.displayName&&suggested.firstName&&suggested.lastName;
    $('efaPersonNameMode').value=useParts?'parts':'display';
    $('efaDisplayNameColumn').value=suggested.displayName??'';
    $('efaFirstNameColumn').value=suggested.firstName??'';
    $('efaLastNameColumn').value=suggested.lastName??'';
    $('efaAffixColumn').value=suggested.affix??'';
    $('efaIdColumn').value=suggested.id??'';
  }else{
    $('efaBoatNameColumn').value=suggested.name??'';
    $('efaIdColumn').value=suggested.id??'';
  }
  $('efaMapping').disabled=false;
  $('efaPreview').disabled=false;
  setEfaMappingVisibility();
  resetEfaPreview('CSV gelesen · Spaltenvorschläge bewusst prüfen. Noch nichts importiert.');
}
function parseSelectedEfaText(){
  if(!efaCsvText){
    efaParsed=null;
    $('efaMapping').disabled=true;
    $('efaPreview').disabled=true;
    resetEfaPreview('Noch keine CSV gewählt.');
    return;
  }
  efaParsed=parseEfaCsv(efaCsvText,{delimiter:$('efaDelimiter').value});
  populateEfaMapping();
}
function currentEfaMapping(){
  const person=$('efaEntityType').value==='person';
  const mapping={};
  if(person&&$('efaPersonNameMode').value==='display'){
    if($('efaDisplayNameColumn').value) mapping.displayName=$('efaDisplayNameColumn').value;
  }else if(person){
    if($('efaFirstNameColumn').value) mapping.firstName=$('efaFirstNameColumn').value;
    if($('efaLastNameColumn').value) mapping.lastName=$('efaLastNameColumn').value;
    if($('efaAffixColumn').value) mapping.affix=$('efaAffixColumn').value;
  }else if($('efaBoatNameColumn').value){
    mapping.name=$('efaBoatNameColumn').value;
  }
  if($('efaIdColumn').value) mapping.id=$('efaIdColumn').value;
  return mapping;
}
function currentEfaContract(){
  const mapping=currentEfaMapping();
  return {
    text:efaCsvText,
    delimiter:$('efaDelimiter').value,
    entityType:$('efaEntityType').value,
    mapping,
    scope:mapping.id?$('efaScope').value.trim():null,
  };
}
const EFA_CLASS_LABELS=Object.freeze({
  new:'neu · unvollständig',exactDuplicate:'exakte Dublette · übersprungen',
  nameReview:'Namensgleichheit · manuell prüfen',idConflict:'ID-Konflikt · gesperrt',
  invalid:'ungültige Zeile · gesperrt',
});
function renderEfaPreview(preview){
  const list=$('efaPreviewList');
  list.replaceChildren();
  for(const item of preview.items){
    const row=document.createElement('li');
    const name=document.createElement('span');
    name.textContent='Zeile '+item.rowNumber+' · '+(item.candidate?.name??item.errors.join('; ')??'ungültig');
    const status=document.createElement('strong');
    status.textContent=EFA_CLASS_LABELS[item.classification]??item.classification;
    row.append(name,status); list.appendChild(row);
  }
  const blocked=preview.counts.invalid+preview.counts.nameReview+preview.counts.idConflict;
  const capacity=efaCandidateRepository.list().length+preview.counts.new;
  const maxRecords=efaCandidateRepository.constraints().maxRecords;
  const overCapacity=capacity>maxRecords;
  $('efaPreviewResult').hidden=false;
  $('efaImportStatus').textContent=
    'Vorschau · '+preview.counts.new+' neu · '+preview.counts.exactDuplicate+' Dublette(n) · '
    +blocked+' zu prüfen · alle gültigen Zeilen bleiben unvollständige Vormerkungen'
    +(overCapacity?' · Speichergrenze überschritten':'');
  $('efaCommit').disabled=preview.counts.new===0||blocked>0||overCapacity;
  $('efaPreviewResult').focus({preventScroll:true});
}
function refreshEfaCandidateList(){
  const list=$('efaCandidateList');
  list.replaceChildren();
  const records=efaCandidateRepository.list();
  if(records.length===0){
    const empty=document.createElement('li');
    const text=document.createElement('span');
    text.textContent='Keine lokalen eFa-Vormerkungen.';
    empty.appendChild(text); list.appendChild(empty);
    return;
  }
  for(const record of records){
    const row=document.createElement('li');
    const text=document.createElement('span');
    const type=record.value.entityType==='person'?'Person':'Boot';
    const ref=record.value.externalRef?'externe ID vorhanden':'ohne externe ID';
    text.textContent=type+' · '+record.value.name+' · unvollständig · '+ref+' · r'+record.revision;
    const remove=document.createElement('button');
    remove.type='button'; remove.textContent='Vormerkung löschen';
    remove.addEventListener('click',async()=>{
      if(!confirm('Unvollständige eFa-Vormerkung „'+record.value.name+'“ lokal löschen?')) return;
      try{
        await repositoryWrite(efaCandidateRepository,()=>{
          const fresh=efaCandidateRepository.select(record.id);
          if(!fresh.ok||fresh.record.revision!==record.revision){
            const error=new Error('Die Vormerkung wurde inzwischen geändert. Bitte Liste neu prüfen.');
            error.code='candidate-stale'; throw error;
          }
          return efaCandidateRepository.delete(record.id,{
            expectedRevision:efaCandidateRepository.snapshot().revision,
            expectedRecordRevision:record.revision,
            audit:{source:'local-ui',reason:'privacy-delete'},
          });
        });
        refreshEfaCandidateList();
        announce('eFa-Vormerkung samt personenbezogenen Altsnapshots lokal gelöscht.');
      }catch(error){ reportError(error,'eFa-Vormerkung konnte nicht gelöscht werden'); }
    });
    row.append(text,remove); list.appendChild(row);
  }
}
async function loadEfaCandidates(){
  try{
    await repositoryWrite(efaCandidateRepository,()=>{
      const loaded=efaCandidateRepository.load();
      reportRepositoryLoad(loaded,'eFa-Vormerkliste');
      if(loaded.ok&&loaded.migration?.migrated){
        efaCandidateRepository.commitPendingMigration({expectedRevision:loaded.state.revision});
        announce('Die lokale eFa-Vormerkliste wurde atomar auf den Revisionsvertrag aktualisiert.');
      }
    });
  }catch(error){
    reportError(error,'eFa-Vormerkliste konnte nicht sicher geladen werden');
  }
  refreshEfaCandidateList();
}
$('efaFile').addEventListener('change',async event=>{
  const file=event.target.files?.[0];
  if(!file){
    efaCsvText=''; parseSelectedEfaText(); return;
  }
  try{
    if(file.size>EFA_CSV_LIMITS.maxBytes) throw new RangeError('CSV überschreitet die feste Grenze von 1 MiB.');
    const bytes=await file.arrayBuffer();
    efaCsvText=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    parseSelectedEfaText();
  }catch(error){
    efaCsvText=''; efaParsed=null; $('efaMapping').disabled=true; $('efaPreview').disabled=true;
    resetEfaPreview('CSV wurde nicht übernommen · erwartet wird eine gültige UTF-8-Datei.');
    reportError(error,'eFa-CSV konnte nicht sicher gelesen werden');
  }
});
$('efaDelimiter').addEventListener('change',()=>{
  try{ parseSelectedEfaText(); }
  catch(error){ resetEfaPreview('Trennzeichen passt nicht zur CSV · nichts importiert.'); reportError(error,'eFa-CSV konnte nicht geparst werden'); }
});
$('efaEntityType').addEventListener('change',()=>{
  try{ if(efaParsed) populateEfaMapping(); else setEfaMappingVisibility(); }
  catch(error){ reportError(error,'eFa-Mapping konnte nicht vorbereitet werden'); }
});
$('efaPersonNameMode').addEventListener('change',()=>{
  setEfaMappingVisibility();
  resetEfaPreview('Namensaufbau geändert · Vorschau erneut erstellen.');
});
$('efaMapping').addEventListener('input',()=>{
  resetEfaPreview('Mapping geändert · Vorschau erneut erstellen.');
});
$('efaPreview').addEventListener('click',async()=>{
  try{
    clearErrorStatus();
    const contract=currentEfaContract();
    const preview=await previewEfaCsv({
      ...contract,
      existingCandidates:efaCandidateRepository.list().map(record=>record.value),
    });
    efaApprovedPreview=preview;
    efaApprovedContract={...contract,mapping:{...contract.mapping}};
    renderEfaPreview(preview);
  }catch(error){
    resetEfaPreview('Vorschau fehlgeschlagen · Mapping, Scope und CSV korrigieren.');
    reportError(error,'eFa-Importvorschau konnte nicht erstellt werden');
  }
});
$('efaCommit').addEventListener('click',async()=>{
  if(!efaApprovedPreview||!efaApprovedContract) return;
  const approved=efaApprovedPreview;
  const contract={...efaApprovedContract,mapping:{...efaApprovedContract.mapping}};
  try{
    const result=await repositoryWrite(efaCandidateRepository,async()=>{
      const fresh=await previewEfaCsv({
        ...contract,
        existingCandidates:efaCandidateRepository.list().map(record=>record.value),
      });
      if(fresh.planFingerprint!==approved.planFingerprint){
        const error=new Error('Die bestätigte eFa-Vorschau ist nicht mehr aktuell. Bitte neu prüfen.');
        error.code='efa-preview-changed'; throw error;
      }
      if(fresh.counts.invalid+fresh.counts.nameReview+fresh.counts.idConflict>0){
        const error=new Error('Die frische Vorschau enthält Konflikte und bleibt gesperrt.');
        error.code='efa-preview-blocked'; throw error;
      }
      const candidates=fresh.items
        .filter(item=>item.classification==='new')
        .map(item=>item.candidate);
      if(candidates.length===0) return Object.freeze({added:0,cancelled:false});
      const exchange=collectionExchange(
        STORAGE_KINDS.efaCandidates,
        candidates,
        value=>value,
        {clock:()=>new Date(fresh.importedAt)},
      );
      return mergeCollectionImport({
        repository:efaCandidateRepository,
        text:JSON.stringify(exchange),
        validateRecord:validateEfaCandidate,
        builder:value=>value,
        approve:preview=>preview.incoming===candidates.length&&preview.added===candidates.length,
        audit:{source:'efa-csv',reason:'efa-csv-import'},
      });
    });
    const imported=result.added;
    efaCsvText=''; efaParsed=null; $('efaFile').value='';
    $('efaMapping').disabled=true; $('efaPreview').disabled=true;
    resetEfaPreview(imported+' unvollständige eFa-Vormerkung(en) lokal gespeichert · keine Zuordnung und kein Sync.');
    refreshEfaCandidateList();
    announce(imported+' eFa-Vormerkung(en) lokal gespeichert; Pflichtdaten müssen bewusst ergänzt werden.');
  }catch(error){
    resetEfaPreview('Import nicht ausgeführt · Vorschau erneut prüfen.');
    reportError(error,'eFa-Vormerkungen konnten nicht atomar importiert werden');
  }
});
function refreshBoatSelect(selectedId='',adoptRevision=false){
  const records=boatRepository.list();
  state.boats=records.map(record=>record.value);
  replaceOptions($('boatSelect'),'— gespeichertes Boot laden —',records.map(record=>({
    value:record.id,label:`${cleanName(record.value.name,'Boot')} · ${record.value.rig==='skull'?'Skull':'Riemen'} · r${record.revision} · ${record.id.slice(0,6)}`,
  })));
  const selection=selectedId?boatRepository.select(selectedId):{ok:false};
  $('boatSelect').value=selection.ok?selectedId:'';
  $('boatUpdate').disabled=!selection.ok; $('boatDelete').disabled=!selection.ok;
  if(!selection.ok){ $('boatSelect').title=''; selectedBoatId=''; selectedBoatRevision=null; }
  else if(adoptRevision){ selectedBoatId=selection.record.id; selectedBoatRevision=selection.record.revision; }
  refreshMasterBoatSelect();
  refreshHistoryEntities();
}
function loadStoredBoatIntoWorkspace(id){
  const selected=boatRepository.select(id);
  $('boatUpdate').disabled=!selected.ok; $('boatDelete').disabled=!selected.ok;
  if(!selected.ok){
    refreshBoatSelect(selectedBoatId);
    announce('Das ausgewählte Boot ist nicht mehr verfügbar. Die aktuellen Arbeitswerte blieben unverändert.');
    return false;
  }
  if(dirty&&!confirmOverwrite('Das gespeicherte Boot ersetzt Boot, Sitzwerte und gespeicherte Belegungsreferenzen des aktuellen Arbeitsstands')){
    refreshBoatSelect(selectedBoatId); return false;
  }
  selectedBoatId=selected.record.id; selectedBoatRevision=selected.record.revision;
  applyBoat(selected.record.value); endDemoSession(); refreshDBSelect('',true,state.editSeatId); setDirty(true);
  refreshBoatSelect(selected.record.id,true);
  const unresolved=state.seats.filter(seat=>seat.rowerRef&&!assignmentFor(seat.id)).length;
  announce(`${cleanName(selected.record.value.name,'Boot')} mit realen Plätzen geladen · Arbeitsstand noch speichern${unresolved?` · ${unresolved} Profilreferenz(en) müssen bewusst neu zugeordnet werden`:''}.`);
  return true;
}
$('boatSelect').addEventListener('change',e=>{
  e.target.title='';
  loadStoredBoatIntoWorkspace(e.target.value);
});
$('masterBoatSelect').addEventListener('change',updateMasterBoatSelection);
$('masterBoatUse').addEventListener('click',()=>{
  if(loadStoredBoatIntoWorkspace($('masterBoatSelect').value)) $('boatSelect').focus();
});
$('masterBoatManage').addEventListener('click',()=>{
  setPresentationMode('details');
  $('boatSelect').focus();
  $('boatSelect').scrollIntoView({block:'center'});
});
$('boatSaveAs').addEventListener('click',async()=>{ try{
  const operation={changeVersion:workspaceChangeVersion,selectedId:$('boatSelect').value,selectedBoatId,selectedBoatRevision};
  canonicalizeBoatName();
  const value=boatOf();
  const record=await repositoryWrite(boatRepository,()=>repositoryWrite(rowerRepository,()=>{
    assertNoRetiredRowerReferences(value);
    return boatRepository.create(value,{expectedRevision:boatRepository.snapshot().revision});
  }));
  const unchanged=workspaceChangeVersion===operation.changeVersion
    &&$('boatSelect').value===operation.selectedId
    &&selectedBoatId===operation.selectedBoatId
    &&selectedBoatRevision===operation.selectedBoatRevision;
  refreshBoatSelect(unchanged?record.id:$('boatSelect').value,unchanged);
  announce(unchanged?'Boot versioniert gespeichert.':'Boot gespeichert; die inzwischen aktive Auswahl blieb unverändert.');
}catch(error){ reportError(error,'Boot konnte nicht gespeichert werden'); } });
$('boatUpdate').addEventListener('click',async()=>{
  const id=$('boatSelect').value, selected=boatRepository.select(id);
  if(!selected.ok||id!==selectedBoatId||selectedBoatRevision===null) return;
  const observedRecordRevision=selectedBoatRevision;
  try{
    const operation={changeVersion:workspaceChangeVersion,selectedId:id,selectedBoatId,selectedBoatRevision};
    canonicalizeBoatName();
    const value=boatOf();
    const updated=await repositoryWrite(boatRepository,()=>repositoryWrite(rowerRepository,()=>{
      assertNoRetiredRowerReferences(value);
      return boatRepository.update(id,value,{
        expectedRevision:boatRepository.snapshot().revision,
        expectedRecordRevision:observedRecordRevision,
      });
    }));
    const unchanged=workspaceChangeVersion===operation.changeVersion
      &&$('boatSelect').value===operation.selectedId
      &&selectedBoatId===operation.selectedBoatId
      &&selectedBoatRevision===operation.selectedBoatRevision;
    refreshBoatSelect(unchanged?updated.id:$('boatSelect').value,unchanged);
    announce(unchanged?'Boot als neue Revision gespeichert.':'Boot aktualisiert; die inzwischen aktive Auswahl blieb unverändert.');
  }catch(error){ reportError(error,'Boot konnte nicht überschrieben werden'); } });
$('boatDelete').addEventListener('click',async()=>{
  const id=$('boatSelect').value, selected=boatRepository.select(id);
  if(!selected.ok||id!==selectedBoatId||selectedBoatRevision===null) return;
  const observedRecordRevision=selectedBoatRevision;
  const name=cleanName(selected.record.value.name,'Boot');
  if(confirm(`„${name}“ wirklich löschen?`)){ try{
    const operation={changeVersion:workspaceChangeVersion,selectedId:id,selectedBoatId,selectedBoatRevision};
    await repositoryWrite(boatRepository,()=>boatRepository.delete(id,{
      expectedRevision:boatRepository.snapshot().revision,
      expectedRecordRevision:observedRecordRevision,
    }));
    const unchanged=workspaceChangeVersion===operation.changeVersion
      &&$('boatSelect').value===operation.selectedId
      &&selectedBoatId===operation.selectedBoatId
      &&selectedBoatRevision===operation.selectedBoatRevision;
    refreshBoatSelect(unchanged?'':$('boatSelect').value,false);
    announce(unchanged?`${name} gelöscht.`:`${name} gelöscht; die inzwischen aktive Auswahl blieb unverändert.`);
  }catch(error){ reportError(error,'Boot konnte nicht gelöscht werden'); } } });
$('boatExport').addEventListener('click',()=>downloadJson(boatRepository.exportEnvelope(),'rudertrimm-v2-boote.json'));
$('boatImport').addEventListener('click',()=>$('boatFile').click());
$('boatFile').addEventListener('change',async e=>{ const f=e.target.files[0]; e.target.value=''; if(!f) return;
  try{
    if(f.size>1_000_000) throw new RangeError('Datei ist größer als 1 MB');
    const text=await f.text();
    const importOptions={
      repository:boatRepository,text,validateRecord:validateBoat,builder:buildBoatDTO,
      migrateRecord:migrateBoatToCurrent,
      migrateLegacyImport:legacyCollectionImportMigrator(migrateBoatToCurrent),
      transformIncomingValue:detachImportedBoatRowerReferences,
    };
    const approvedPreview=previewCollectionImport(importOptions);
    if(!confirmCollectionImport(approvedPreview)){ announce('Bootsimport abgebrochen.'); return; }
    const result=await repositoryWrite(boatRepository,()=>mergeCollectionImport({
      ...importOptions,approve:fresh=>approveFreshImportPreview(approvedPreview,fresh),
    }));
    refreshBoatSelect();
    announce(`${result.added} Bootseinträge atomar importiert${result.duplicatesSkipped?` · ${result.duplicatesSkipped} Dubletten übersprungen`:''}${result.migrated?` · ${result.migrated} Datensätze auf das aktuelle Schema migriert`:''}${result.remapped?` · ${result.remapped} ID-Konflikte aufgelöst`:''}${result.referencesDetached?` · ${result.referencesDetached} unsichere Profilreferenzen gelöst`:''}.`);
  }catch(error){ reportError(error,'Bootsimport abgelehnt'); }
});

/* ---------------- Rigg: abgeleitete Größen — pro Platz/Ruderer ---------------- */
function derived(r,phiAeff){
  const s=state;
  r = r || activeRower();
  const phiA = phiAeff ?? s.phiA;               // gelöste Ist-Auslage oder klar markierte Prüfpose
  return derivedGeometry({
    rig:s.rig, DA:r.DA, IH:r.IH, L:r.L, d:r.d, a:r.a,
    phiA, phiR:s.phiR, t:s.t, c:s.c, kg:s.kg,
  });
}
function band(v,gLo,gHi,yPad){
  if(v>=gLo&&v<=gHi) return 'ok';
  if(v>=gLo-yPad&&v<=gHi+yPad) return 'warn';
  return 'bad';
}

/* ================================================================
   KÖRPERMODELL — eine Kinematik, alle Ansichten sind Projektionen.
   Koordinaten (Seitenebene): x = heckwärts +, y = über Wasserlinie.
   Dollenstift bei x=0. Constraints: Hand am Griffende (aus Rigg),
   Ferse am Stemmbrett, Hüfte auf Rollsitzhöhe.
   Bewegungsfolge Beine → Rumpf → Arme über Fahrpläne + Residual-
   verteilung; Knie-, Rumpf- und Ellbogenwinkel sind emergent.
   ================================================================ */
/* Körpersegmente aus konkreten, messbaren Maßen:
   Beinlänge  = Sohle → Hüftgelenk (OS+US)
   Rumpflänge = Sitzhöhe: Sitz → Scheitel (= T + Hals + Kopf)
   Spannweite = Mittelfinger → Mittelfinger  →  Armreichweite = (Spannweite − Schulterbreite)/2
   Standhöhe (abgeleitet) = Beinlänge + Rumpflänge. */
function SEG(r){
  return deriveBodySegments(r);
}
// Nähert sich einer harten Untergrenze mit gleicher Position und Geschwindigkeit
// an. So bleiben reale Grenzen exakt erhalten, ohne dass deren Eintritt als
// sichtbarer Rumpf-/Schulterruck in die drei Projektionen durchschlägt.
function easeFromFloor(value,floor,width){
  if(!(width>0)) return Math.max(value,floor);
  if(value<=floor) return floor;
  if(value>=floor+width) return value;
  const u=(value-floor)/width;
  return floor+width*(2*u*u-u*u*u);
}
/* Blatt-Drehung und -Höhe sind ENTKOPPELT: aufgedreht wird VOR der Auslage
   (über Wasser), dann taucht das Blatt senkrecht/rechtwinklig ein. */
function featherG(tPct, rec){       // 0 = aufgedreht (senkrecht), 1 = flach
  if(!rec) return 0;
  if(tPct>96) return 0;                    // Ausheben: erst rechtwinklig heraus
  if(tPct>84) return (96-tPct)/12;         // dann abdrehen
  if(tPct>26) return 1;                    // flach über dem Wasser
  if(tPct>10) return (tPct-10)/16;         // aufdrehen VOR der Auslage
  return 0;                                // aufgedreht, bereit zum Eintauchen
}
function bladeLiftF(tPct, rec){     // Blatthöhe: −8 = vergraben … +13 = frei
  if(!rec) return -8;
  // Gleiche Endpunkte und Zeitfenster wie zuvor, aber ohne Geschwindigkeitssprung
  // an 8/96 %. Der Griffhöhenverlauf wirkt direkt auf Schulter und Rumpflösung.
  if(tPct>96) return lerp(13,-8,smooth((tPct-96)/4));   // senkrechtes Ausheben
  if(tPct>8)  return 13;                         // frei über Wasser
  return lerp(-8,13,smooth(tPct/8));             // senkrechtes Eintauchen zur Auslage
}
// Zweigelenk-IK: Gelenk zwischen A und B, Längen l1/l2, side wählt Seite
function ik2(A,B,l1,l2,pickLower){
  let dx=B.x-A.x, dy=B.y-A.y, D=Math.hypot(dx,dy);
  const Dc=clamp(D, Math.abs(l1-l2)+0.5, l1+l2-0.2);
  if(D<1e-6){dx=1;dy=0;D=1;}
  const ux=dx/D, uy=dy/D;
  const a=(l1*l1 - l2*l2 + Dc*Dc)/(2*Dc);
  const h=Math.sqrt(Math.max(0,l1*l1-a*a));
  const J1={x:A.x+ux*a-uy*h, y:A.y+uy*a+ux*h};
  const J2={x:A.x+ux*a+uy*h, y:A.y+uy*a-ux*h};
  const J = pickLower ? (J1.y<J2.y?J1:J2) : (J1.y>J2.y?J1:J2);
  const ang=Math.acos(clamp((l1*l1+l2*l2-Dc*Dc)/(2*l1*l2),-1,1));
  return {J, ang};
}
function solveBody(dv, tPct, rec, r, phiAeff){
  const s=state, seg=SEG(r);
  const t=clamp(tPct,0,100)/100;
  const wl=s.kg*0.1, pinY=s.c+r.a;
  const g=featherG(tPct,rec), lift=bladeLiftF(tPct,rec);  // Drehung & Höhe entkoppelt (senkrechtes Eintauchen)
  // phiAeff ist die modellierte Ist-Auslage; state.phiA bleibt separat das Rigg-Ziel.
  const phiA=phiAeff ?? s.phiA;
  const SW=phiA+s.phiR, theta=rad(phiA - t*SW);
  const foot={x:r.stemmX, y:s.c-18};
  const hipY=s.c+4, dyLeg=hipY-foot.y;
  // Hand am Griffende (Blatt am Wasser bzw. ausgehoben)
  const sinB=clamp((pinY-wl-lift)/dv.outb,-0.5,1);
  const hand={x:dv.inb*Math.sin(theta), y:pinY+dv.inb*sinB};
  // Fahrpläne (nominell)
  const knee0=lerp(rad(CATCH_MODEL.kneeDeg), rad(172), smooth(t/0.97));
  const lam0 = rec
    ? rad(lerp(CATCH_MODEL.leanDeg,-23, smooth((t-0.35)/0.65)))
    : rad(lerp(CATCH_MODEL.leanDeg,-23, smooth((t-0.18)/0.72)));
  const legD=a=>Math.sqrt(seg.OS**2+seg.US**2-2*seg.OS*seg.US*Math.cos(a));
  const hipOf=a=>foot.x-Math.sqrt(Math.max(1,legD(a)**2-dyLeg*dyLeg));
  const hip0x=hipOf(knee0);
  // Arme in 3D: der Griff liegt seitlich versetzt zur Schulter (z-Achse = quer).
  // Für die Reichweite in der Seitenebene zählt nur die Sagittal-Komponente.
  const DAr=dv.DAr;
  const zW=DAr-dv.inb*Math.cos(theta);
  // Riemen: dieselbe Außen-Schulterrotation wie in solveArms statt einer 0,95-Näherung.
  // Der reale Rotationsboden bleibt −0,5; die kurze dimensionslose Bremszone
  // verhindert nur den harten Geschwindigkeitsknick beim Erreichen der Grenze.
  const rhoArm=dv.skull?0:rad(CATCH_MODEL.sweepShoulderRotationDeg)
    *easeFromFloor(deg(theta)/Math.max(dv.phiA,1),-0.5,0.1);
  const dzArm=dv.skull?Math.abs(zW-r.SB/2):Math.abs(zW+Math.cos(rhoArm)*r.SB/2);
  const armLen3=seg.OA+seg.UA;
  const armLen=Math.sqrt(Math.max((armLen3*0.55)**2, armLen3*armLen3-dzArm*dzArm));
  // Oberkörper-Flexion (BWS + Schulterblatt-Vorschub) wächst mit der Vorlage:
  // Schultergelenk wandert nach vorn-unten — sonst hängen die Arme zu steil (Abb. 4).
  const flexOf=l=>seg.T*0.42*smooth(l/rad(CATCH_MODEL.leanDeg));
  // Nominale Handposition bei gestreckten Armen
  const shOf=(hx,l)=>{const fx=flexOf(l);
    return {x:hx+seg.T*Math.sin(l)+0.35*fx, y:hipY+seg.T*Math.cos(l)-0.9*fx};};
  // Skull: die Körperlösung richtet sich am vertikal ungünstigeren realen Griff aus;
  // solveArms prüft anschließend weiterhin beide vollständigen 3D-Ziele.
  const armH=sy=>{const verticalReach=dv.skull
      ?Math.max(Math.abs(sy-(hand.y-1.5)),Math.abs(sy-(hand.y+1.5)))
      :Math.abs(sy-hand.y);
    const q=armLen*armLen-verticalReach*verticalReach; return q<=4?null:Math.sqrt(q);};
  const anatomyMin=hipOf(rad(172)), anatomyMax=hipOf(rad(45));
  // V2-Modellannahme: Hüft-/Sitzreferenz liegt 5 cm hinter dem jeweils betrachteten Schienenpunkt.
  // Dadurch begrenzen Rollbahnlänge und Überstand erstmals die Pose; die Annahme bleibt sichtbar kalibrierungspflichtig.
  const seatReferenceOffset=5;
  const trackMin=r.rueh-r.rollL+seatReferenceOffset, trackMax=r.rueh+seatReferenceOffset;
  const rawHipMin=Math.max(anatomyMin,trackMin), rawHipMax=Math.min(anatomyMax,trackMax);
  const hipMin=Math.min(rawHipMin,rawHipMax), hipMax=Math.max(rawHipMin,rawHipMax);
  // Die Hüfte folgt ausschließlich dem geglätteten Beinplan. Der frühere handabhängige
  // Restterm lief phasenweise gegen die Schienengrenze und erzeugte das sichtbare Ruckeln.
  const hipTarget=hip0x;
  // Die 4-cm-Innenzone bremst den Sitz C1-stetig an den unveränderten realen
  // Rollbahnenden ab. Außerhalb bleibt die harte Materialgrenze unangetastet.
  const trackEase=Math.min(4,Math.max(0,(hipMax-hipMin)/4));
  const lowerEased=easeFromFloor(hipTarget,hipMin,trackEase);
  const hipX=-easeFromFloor(-lowerEased,-hipMax,trackEase);
  const trackLimited=rawHipMin>rawHipMax||Math.abs(hipX-hipTarget)>0.05;
  const D=Math.hypot(foot.x-hipX, dyLeg);
  const knee=Math.acos(clamp((seg.OS**2+seg.US**2-D*D)/(2*seg.OS*seg.US),-1,1));
  const hip={x:hipX,y:hipY};
  // Rumpfwinkel exakt lösen (gestreckte Arme): F(λ) monoton steigend
  const F=l=>{const sh=shOf(hipX,l); const ah=armH(sh.y);
    return ah===null? null : sh.x+ah-hand.x;};
  let lam=lam0, elbowBent=false, overreach=false;
  let lo=rad(-38), hi=rad(50), flo=F(lo), fhi=F(hi);
  if(fhi===null || fhi<0){ lam=hi; overreach=true; }          // vertikal oder insgesamt unerreichbar
  else{
    // λ*: Torso-Winkel, bei dem gestreckte Arme den Griff exakt erreichen.
    // Hand näher als jede Streckung (flo>0): lokale lineare Fortsetzung statt eines
    // willkürlichen 30°-Sprungs; dadurch bleibt der Übergang zur Ellbogenbeugung stetig.
    let lamStar;
    if(flo!==null && flo>0){
      const epsilon=rad(0.5), fNext=F(lo+epsilon);
      const slope=fNext===null?1:(fNext-flo)/epsilon;
      lamStar=lo-flo/Math.max(slope,0.05);
    }
    else{
      for(let i=0;i<28;i++){ const mid=(lo+hi)/2, fm=F(mid);
        if(fm===null||fm>0) hi=mid; else lo=mid; }
      lamStar=(lo+hi)/2;
    }
    // STETIGE Überblendung statt harter 15°-Schwelle: je weiter λ* unter den
    // Fahrplan fällt (Hand kommt näher), desto mehr übernimmt λ0 und die
    // Ellbogen beugen sich — aber erst im hinteren Zugdrittel (Auslage: Arme GESTRECKT).
    const d=lam0-lamStar;                          // >0: Hand innerhalb der Streckreichweite
    const gate=smooth((t-0.35)/0.3);
    const bend=smooth((d-rad(3))/rad(22))*gate;
    elbowBent = bend>0.02;
    lam=clamp(lerp(lamStar,lam0,bend), rad(-35), rad(50));
  }
  const sh=shOf(hipX,lam);
  const flex=flexOf(lam);           // Rundung des GANZEN Rückens (für die Zeichnung)
  // Knie-Position (Scheitel oben); Kopf sitzt auf dem gerundeten Wirbelsäulen-Ende
  const kneeP=ik2(hip,foot,seg.OS,seg.US,false).J;
  const c7={x:hipX+seg.T*Math.sin(lam), y:hipY+seg.T*Math.cos(lam)};
  const tilt=lam+rad(22)*smooth(lam/rad(CATCH_MODEL.leanDeg));
  const headR=seg.HEAD*0.42;   // Kopf-Radius (halbe Kopfbreite), nicht volle Kopfhöhe
  const head={x:sh.x+(seg.NECK+headR)*Math.sin(tilt), y:sh.y+(seg.NECK+headR)*Math.cos(tilt), r:headR};
  const reach3=Math.hypot(sh.x-hand.x,sh.y-hand.y,dzArm);
  if(reach3>armLen3+0.05 || reach3<Math.abs(seg.OA-seg.UA)-0.05) overreach=true;
  const armAng=deg(Math.atan2(sh.y-hand.y, hand.x-sh.x));
  return {seg, foot, hip, kneeP, sh, c7, hand, head, r, SB:r.SB, flex,
          knee:deg(knee), lam:deg(lam), armAng, progress:t,
          theta:deg(theta), g, lift, wl, pinY, sinB, overreach, trackLimited, reach3};
}
/* Arme einmal in 3D lösen (x = heckwärts, y = Höhe, z = quer/Steuerbord+);
   alle drei Ansichten projizieren dieselben Gelenkpunkte. Ellbogen-
   Orientierung: früh nach unten, im Endzug nach hinten-außen am
   Körper vorbei (DRV-Griffführung). */
function solveArms(dv, b, r){
  const s=state, seg=b.seg, SB=r.SB;
  const th=rad(b.theta), DAr=dv.DAr;
  // Referenzposen und Cache-Prüfungen dürfen nicht vom momentan sichtbaren globalen t
  // abhängen; die Ellbogenorientierung gehört zur tatsächlich gelösten Körperpose.
  const w=smooth((b.progress-0.4)/0.6);
  const OA=seg.OA, UA=seg.UA, L3=OA+UA;
  const mk=(S,targetW,zside)=>{
    let W=targetW;
    const dx=W.x-S.x, dy=W.y-S.y, dz=W.z-S.z;
    const D3=Math.hypot(dx,dy,dz);
    const u={x:dx/(D3||1),y:dy/(D3||1),z:dz/(D3||1)};
    let E, ang, reachable=true;
    // Erst an der echten Streckgrenze auf die kollineare Lösung wechseln. Die
    // frühere 0,5-cm-Zeichentoleranz sprang vorzeitig um und versetzte den
    // Ellbogen je nach Rigg um rund 3 cm, obwohl Hand, Ruder und Torso stetig waren.
    if(D3>=L3){
      reachable=D3<=L3+0.05;
      W={x:S.x+u.x*L3,y:S.y+u.y*L3,z:S.z+u.z*L3};
      E={x:S.x+u.x*OA, y:S.y+u.y*OA, z:S.z+u.z*OA}; ang=180;
    } else {
      reachable=D3>=Math.abs(OA-UA)-0.05;
      const a=(OA*OA-UA*UA+D3*D3)/(2*D3);
      const h=Math.sqrt(Math.max(0,OA*OA-a*a));
      let e={x:-0.85*w, y:-(1-w)-0.2*w, z:0.5*w*zside};
      const dot=e.x*u.x+e.y*u.y+e.z*u.z;
      e={x:e.x-dot*u.x, y:e.y-dot*u.y, z:e.z-dot*u.z};
      const n=Math.hypot(e.x,e.y,e.z)||1;
      E={x:S.x+u.x*a+e.x/n*h, y:S.y+u.y*a+e.y/n*h, z:S.z+u.z*a+e.z/n*h};
      ang=deg(Math.acos(clamp((OA*OA+UA*UA-D3*D3)/(2*OA*UA),-1,1)));
    }
    return {S,E,W,targetW,ang,reachable};
  };
  const arms=[];
  if(dv.skull){
    for(const sd of [1,-1]){
      const S={x:b.sh.x, y:b.sh.y, z:sd*SB/2};
      // beim Übergriff führt eine Hand über der anderen
      const W={x:b.hand.x, y:b.hand.y+(sd<0?1.5:-1.5), z:sd*(DAr-dv.inb*Math.cos(th))};
      arms.push(mk(S,W,sd));
    }
  } else {
    // Muss dieselbe stetige Schultergrenze wie solveBody verwenden, sonst
    // springen Rumpf und Armprojektion bei Riemen zu verschiedenen Zeitpunkten.
    const rho=rad(CATCH_MODEL.sweepShoulderRotationDeg)
      *easeFromFloor(b.theta/Math.max(dv.phiA,1),-0.5,0.1);
    const zC=Math.cos(rho)*SB/2, xR=Math.sin(rho)*SB/2;
    const W1={x:b.hand.x, y:b.hand.y, z:DAr-dv.inb*Math.cos(th)};
    const P={x:0, y:b.pinY, z:DAr};
    const dW={x:P.x-W1.x, y:P.y-W1.y, z:P.z-W1.z};
    const dL=Math.hypot(dW.x,dW.y,dW.z)||1;
    const W2={x:W1.x+dW.x/dL*r.handGap, y:W1.y+dW.y/dL*r.handGap, z:W1.z+dW.z/dL*r.handGap};
    // Rotation am AUSSENARM verankert: der bleibt auf der gelösten Reichweite
    // → in der Auslage exakt gestreckt; die Innenschulter weicht zurück.
    arms.push(mk({x:b.sh.x,      y:b.sh.y, z:-zC}, W1, -1));   // Außenarm → Griffende (gestreckt)
    arms.push(mk({x:b.sh.x-2*xR, y:b.sh.y, z:+zC}, W2, +1));   // Innenarm → 2. Hand
  }
  return arms;
}
// Referenzposen (Auslage / Endzug / 90°-Stellung) für Checks & Rollweg
function bodyRefs(dv, r){
  const phiA=dv.phiA ?? state.phiA;      // dieselbe Ist-Auslage/Prüfpose wie beim Zeichnen
  const b0=solveBody(dv,0,false,r,phiA), b1=solveBody(dv,100,false,r,phiA);
  const t90=clamp(phiA/(phiA+state.phiR)*100,0,100);
  const b90=solveBody(dv,t90,false,r,phiA);
  const span=b0.hip.x-b1.hip.x;
  const rollAt=b=> span>1 ? clamp((b0.hip.x-b.hip.x)/span*100,0,100) : 0;
  return {b0,b1,b90,t90,rollAt};
}
// Natural Catch plus the 3D reachability check is configuration-bound and expensive.
// The complete key prevents work per animation frame; this FIFO limit evicts only old
// variants and never changes a solution for the current configuration.
const CATCH_CACHE_LIMIT=64;
const catchSolutionCache=new Map();
function catchCacheKey(dv,r){
  // t/recovery und das Rigg-Ziel fehlen absichtlich: Die Ist-Auslage hängt nur von
  // Fa, Körper, Rigggeometrie, Sitzhöhe und Wasserlage ab und bleibt im Schlag konstant.
  return [state.rig,dv.DA,dv.inb,dv.outb,r.a,state.c,state.kg,
    r.legLen,r.torsoLen,r.wingspan,r.SB,r.handGap,r.stemmX,r.rollL,r.rueh].join('|');
}
function resolveCatchAngle(r){
  const baseDv=derived(r);
  const key=catchCacheKey(baseDv,r);
  const cached=catchSolutionCache.get(key);
  if(cached) return cached;
  const natural=solveNaturalCatchAngle({
    rig:state.rig,DA:baseDv.DA,inboardFromPin:baseDv.inb,outboardFromPin:baseDv.outb,
    a:r.a,c:state.c,kg:state.kg,rower:r,
  });
  const isReachable=angle=>{
    const candidateDv=derived(r,angle);
    const body=solveBody(candidateDv,0,false,r,angle);
    if(body.overreach) return false;
    return solveArms(candidateDv,body,r).every(arm=>arm.reachable);
  };
  let poseAngleDeg=natural.angleDeg;
  let reachable=isReachable(poseAngleDeg);
  let limitedByReach=false;
  // V2s vollständige 3D-Prüfung bleibt das Sicherheitsnetz um Alex' sagittales Modell.
  // Nur im Fehlerfall wird die bestehende nichtmonotone Suche einmal pro Konfiguration genutzt.
  if(natural.bracketed&&!reachable&&natural.angleDeg>CATCH_MODEL.search.minDeg){
    const fallback=findHighestReachableAngle({
      minDeg:CATCH_MODEL.search.minDeg,
      maxDeg:natural.angleDeg,
      stepDeg:CATCH_MODEL.search.stepDeg,
      isReachable,
    });
    poseAngleDeg=fallback.angleDeg;
    reachable=fallback.reachable;
    limitedByReach=fallback.limited;
  }
  // Ohne Nullstellenklammer ist der finite Suchrand nur eine stabile Prüfpose. Er darf weder
  // in UI noch Export als gemessene/modellierte Ist-Auslage ausgegeben werden.
  const naturalResolved=natural.bracketed;
  const result=Object.freeze({
    poseAngleDeg,
    actualAngleDeg:naturalResolved&&reachable?poseAngleDeg:null,
    naturalAngleDeg:naturalResolved?natural.angleDeg:null,
    naturalCandidateAngleDeg:natural.angleDeg,
    naturalResolved,
    reachable,
    limitedByReach,
    trackLimited:natural.trackLimited,
    residualCm:natural.residualCm,
    evaluations:natural.evaluations,
    modelStatus:'needsCalibration',
  });
  catchSolutionCache.set(key,result);
  if(catchSolutionCache.size>CATCH_CACHE_LIMIT) catchSolutionCache.delete(catchSolutionCache.keys().next().value);
  return result;
}

/* ---------------- Statuskarten & Chips ---------------- */
const STTXT={ok:'Im Zielkorridor',warn:'Prüfen',bad:'Außerhalb',info:'Modellwert'};
const STICON={ok:'✓',warn:'!',bad:'×',info:'i'};
function statusCardElement(card){
  const root=document.createElement('article'); root.className=`scard ${card.st}`;
  const title=document.createElement('div'); title.className='ico';
  const icon=document.createElement('span'); icon.className='status-symbol'; icon.textContent=STICON[card.st]||'i'; icon.setAttribute('aria-hidden','true');
  title.append(icon,document.createTextNode(card.n));
  const value=document.createElement('div'); value.className='big'; value.textContent=card.v;
  const stateLabel=document.createElement('div'); stateLabel.className='st'; stateLabel.textContent=card.statusText??STTXT[card.st]??'Prüfwert';
  const range=document.createElement('div'); range.className='rng'; range.textContent=card.rng;
  root.append(title,value,stateLabel,range); return root;
}
function chipElement(chip){
  const root=document.createElement('div');
  root.className=`chip ${chip.st||''} ${chip.compact?'compact-critical':'details-only'}`.trim();
  if(chip.st){ const icon=document.createElement('span'); icon.className='status-symbol'; icon.textContent=STICON[chip.st]||'i'; icon.setAttribute('aria-hidden','true'); root.appendChild(icon); }
  root.append(document.createTextNode(`${chip.n} `));
  const value=document.createElement('b'); value.textContent=chip.v; root.appendChild(value); return root;
}
function actualCatchStatusCard(dv,targetDeg,catchSolution){
  const nominalRange=dv.skull?'65 – 75°':'~54° (Riemen)';
  if(catchSolution.naturalResolved===false){
    return {n:'Ist-Auslagewinkel',v:'nicht bestimmbar',st:'bad',
      rng:`Natural-Catch ohne Lösung · Suchgrenze ${fmt(catchSolution.naturalCandidateAngleDeg)}° · Restfehler ${fmt(catchSolution.residualCm)} cm · Rigg-Ziel ${fmt(targetDeg)}°`};
  }
  if(catchSolution.reachable===false){
    return {n:'Ist-Auslagewinkel',v:'nicht erreichbar',st:'bad',
      rng:`Natural-Catch ${fmt(catchSolution.naturalAngleDeg)}° · Rigg-Ziel ${fmt(targetDeg)}° · 3D-Prüfung fehlgeschlagen`};
  }
  const limited=catchSolution.limitedByReach;
  return {n:'Ist-Auslagewinkel',v:fmt(dv.phiA)+'°'+(limited?' ⚠':''),
    st:limited?'warn':'info',
    rng:`${nominalRange} · Rigg-Ziel ${fmt(targetDeg)}° · aus Fa + Körper (58°/16°-Prüfmodell, unkalibriert)`};
}
function renderStatus(dv,refs,r,catchSolution,seats=[]){
  const s=state;
  const uLo=dv.skull?18:30, uHi=dv.skull?23:34;
  const dIH=r.IH-dv.IHsoll;
  // Dollenhöhe: im Werkstatt-Modus messbar ab Rollsitz/Schiene, am Steg über Wasser
  const aNorm=dv.skull?15:17;
  let dolleCard;
  if(s.mode==='werkstatt'){
    const off=s.heightRef==='schiene'?s.seatOffset:0;
    dolleCard={n:s.heightRef==='schiene'?'Dollenhöhe ü. Schiene':'Dollenhöhe ü. Rollsitz',
      v:fmt(r.a+off)+' cm', st:band(r.a,aNorm-2,aNorm+2,2),
      rng:`Norm ${fmt(aNorm+off)} ± 2 cm`};
  } else {
    dolleCard={n:'Dollenhöhe ü. W.', v:fmt(dv.dWL)+' cm', st:band(dv.dWL,22,26,2), rng:'22 – 26 cm'};
  }
  const roll90=refs.rollAt(refs.b90);
  const kneeState=band(refs.b90.knee,160,170,6), rollState=band(roll90,70,80,5);
  const stemmState=kneeState==='ok'&&rollState==='ok'?'ok':kneeState==='bad'||rollState==='bad'?'bad':'warn';
  const cards=[
    {n:'Übergriff', v:fmt(dv.U)+' cm', st:band(dv.U,uLo,uHi,2), rng:`${uLo} – ${uHi} cm`},
    actualCatchStatusCard(dv,s.phiA,catchSolution),
    {n:'Schlagweite', v:fmt(dv.SW)+'°', st:band(dv.SW,dv.skull?105:85,dv.skull?115:95,5), rng:dv.skull?'110° (Skull)':'90° (Riemen)'},
    dolleCard,
    {n:'Dollen-Neigung', v:fmt(r.anlage)+'°', st:band(r.anlage,4,6,2), rng:'Arbeitsziel 4–6° · 2–8° nur nach Prüfung'},
    {n:'Innenhebel', v:fmt(r.IH)+' cm', st:Math.abs(dIH)<=1?'ok':Math.abs(dIH)<=2?'warn':'bad', rng:(dv.skull?'DA/2 + 8 cm':'DA + 30 cm')+` = ${fmt(dv.IHsoll)}`},
    {n:'Stemmbrett / 90°', v:`${fmt(refs.b90.knee,0)}° · ${fmt(roll90,0)} %`, st:stemmState, rng:'Beide Kriterien: Knie 160–170° und Rollweg 70–80 %'},
  ];
  $('cards').replaceChildren(...cards.map(statusCardElement));
  const chips=[
    {n:'Schulter–Hand zur Horizontalen',v:fmt(refs.b0.armAng,0)+'° · Zieldefinition vor Trainerkalibrierung offen',st:'info'},
    {n:'Anteil vor Orthogonale',v:fmt(dv.antV,0)+' %',st:band(dv.antV,55,65,5)},
    // Gegenstück zur Dollenhöhen-Karte als Info; plus BB/StB-Vergleich (euer Schienen-Messgerät)
    s.mode==='werkstatt'
      ? {n:'Dollenhöhe ü. Wasser (berechnet)',v:fmt(dv.dWL)+' cm · Soll 22–26',st:''}
      : {n:'Dollenhöhe ü. Rollsitz',v:fmt(r.a)+' cm',st:''},
    dv.skull
      ? {n:'Δ Dolle BB−StB',v:fmt(r.dBB)+' cm · derzeit Messwert, noch nicht in Körpermodell gekoppelt',st:'info'}
      : (seats.length<2? null : {n:'Δ Dolle Vergleich',v:fmt(seats[0].r.a-seats[1].r.a)+' cm (Ziel 0)',st:band(seats[0].r.a-seats[1].r.a,-0.25,0.25,0.5)}),
    {n:'Außenneigung',v:fmt(r.aussen)+'°',st:r.aussen<=2?'ok':'warn'},
    {n:'Rollbahn-Überstand',v:fmt(r.rueh)+' cm',st:band(r.rueh,3,7,3)},
    {n:'Stemmbrettwinkel',v:fmt(r.stemmW)+'°',st:band(r.stemmW,42,45,2)},
    {n:'Außenhebel',v:fmt(dv.AH)+' cm',st:''},
    {n:'Momentarmverhältnis',v:'1 : '+fmt(dv.outb/dv.inb,2),st:''},
    {n:'Ruderwinkel θ',v:fmt(dv.theta)+'°',st:''},
  ];
  const crewAnlage=state.seats.map(runtimeForSeat).filter(Boolean).map(item=>item.anlage);
  if(crewAnlage.length>1){
    const spread=Math.max(...crewAnlage)-Math.min(...crewAnlage);
    if(spread>1e-9) chips.unshift({
      n:'Crew-Anlage',
      v:`Δ ${fmt(spread)}° · platzbezogen gespeichert, als Crewwert gleich halten`,
      st:'warn',compact:true,
    });
  }
  if(catchSolution.naturalResolved===false) chips.unshift({n:'Natural Catch',v:'keine Lösung im 20–88°-Prüfbereich · Fa/Körper/Rollbahn prüfen',st:'bad',compact:true});
  if(refs.b0.overreach||catchSolution.reachable===false) chips.unshift({n:'Auslage erreichbar',v:'nein — Stemmbrett/Körpermaße prüfen',st:'bad',compact:true});
  if(refs.b0.trackLimited||refs.b1.trackLimited||catchSolution.trackLimited) chips.unshift({n:'Rollbahn-Modell',v:'Pose berührt die vorläufige Sitz-/Schienen-Grenze · kalibrieren',st:'info',compact:true});
  const visibleChips=chips.filter(Boolean), host=$('chips');
  host.replaceChildren(...visibleChips.map(chipElement));
  host.classList.toggle('compact-has-warnings',visibleChips.some(chip=>chip.compact));
}

let lastActionPlan=buildTrimActionPlan({seats:[],totalSeatCount:1});
const actionRound=(value,digits=1)=>+Number(value).toFixed(digits);
function buildActionDiagnostics(){
  return state.seats.flatMap(seat=>{
    const r=runtimeForSeat(seat);
    if(!r) return [];
    const catchSolution=resolveCatchAngle(r);
    const dv=derived(r,catchSolution.poseAngleDeg);
    const refs=bodyRefs(dv,r);
    return [{
      seatId:seat.id,position:seat.position,label:seatLabel(seat),rowerName:r.name,rig:r.rig,
      IH:actionRound(r.IH),IHsoll:actionRound(dv.IHsoll),anlage:actionRound(r.anlage),
      stemmX:actionRound(r.stemmX),knee90:actionRound(refs.b90.knee),roll90:actionRound(refs.rollAt(refs.b90)),
      naturalResolved:catchSolution.naturalResolved,reachable:catchSolution.reachable&&!refs.b0.overreach,
      trackLimited:!!(catchSolution.trackLimited||refs.b0.trackLimited||refs.b1.trackLimited),
    }];
  });
}
function formatActionMeasure(measure){
  if(!measure) return '—';
  if(Number.isFinite(measure.value)) return `${fmt(measure.value)}${measure.unit?` ${measure.unit}`:''}`;
  if(Number.isFinite(measure.min)&&Number.isFinite(measure.max)) return `${fmt(measure.min)}–${fmt(measure.max)}${measure.unit?` ${measure.unit}`:''}`;
  return measure.text||'—';
}
function formatActionTarget(target){
  if(!target) return 'prüfen';
  if(Number.isFinite(target.min)&&Number.isFinite(target.max)) return `${fmt(target.min)}–${fmt(target.max)}${target.unit?` ${target.unit}`:''}`;
  if(Number.isFinite(target.value)) return `${fmt(target.value)}${target.unit?` ${target.unit}`:''}${target.text?` · ${target.text}`:''}`;
  return target.text||'prüfen';
}
function workflowResultSignature(plan,diagnostics,totalSeatCount,referenceSeatId){
  if(plan.status==='missing') return '';
  // Die gerundeten Diagnosen sind die Eingabe derselben Empfehlungslogik. So bleibt eine
  // Prüfung bei Phase/Ansicht/Tempo gültig, aber nie bei anderem Boot, Sitz oder Fachwert.
  return JSON.stringify({diagnostics,totalSeatCount,referenceSeatId,status:plan.status,
    actionIds:plan.actions.map(action=>action.id)});
}
function renderWorkflowGuide(){
  if(!workflowGuideReady) return;
  // Ein Ergebnis ist erst erledigt, nachdem genau dieser Befund in der Sitzung fokussiert
  // wurde. Ändert sich der Befund, ist eine frühere Prüfung bewusst nicht übertragbar.
  if(workflowReviewedResultSignature&&workflowReviewedResultSignature!==workflowCurrentResultSignature){
    workflowReviewedResultSignature='';
  }
  const model=workflowGuideState({
    boatReady:!!PRESETS[$('preset').value]&&state.seats.length>0,
    seatReady:!!activeSeat(),
    profileReady:!!activeAssignment(),
    resultReady:workflowCurrentResultSignature!==''&&workflowReviewedResultSignature===workflowCurrentResultSignature,
    dirty,
    viewState:workspaceViewState,
  });
  const signature=model.steps.map(step=>`${step.id}:${step.status}`).join('|');
  if(signature===workflowGuideSignature) return;
  workflowGuideSignature=signature;
  const labels={done:'erledigt',current:'jetzt',open:'offen'};
  for(const step of model.steps){
    const item=$('workflowGuide').querySelector(`[data-guide-step="${step.id}"]`);
    const link=item.querySelector('[data-guide-target]');
    item.dataset.guideStatus=step.status;
    item.querySelector('[data-guide-state]').textContent=labels[step.status];
    if(step.status==='current') link.setAttribute('aria-current','step');
    else link.removeAttribute('aria-current');
  }
  $('workflowGuideStatus').textContent=model.currentStep
    ?`${model.completedCount} von 5 erledigt · nächster sicherer Schritt markiert`
    :`5 von 5 erledigt · ${cleanStateLabel()}`;
}
function markWorkflowResultReviewed(){
  if(workflowCurrentResultSignature==='') return false;
  workflowReviewedResultSignature=workflowCurrentResultSignature;
  workflowGuideSignature='';
  renderWorkflowGuide();
  return true;
}
function workflowGuideTarget(step){
  if(step==='seat') return [...$('seattabs').querySelectorAll('button')].find(button=>button.dataset.seat===state.editSeatId)??$('seattabs');
  return ({boat:$('preset'),profile:$('dbSelect'),result:$('actionResult'),save:$('bSave')})[step]??null;
}
function focusWorkflowGuideTarget(step){
  const target=workflowGuideTarget(step);
  if(!target) return false;
  target.focus?.();
  target.scrollIntoView?.({block:'center'});
  const messages={
    boat:'Bootsklasse und Ausgangspreset prüfen.',
    seat:'Aktiver realer Bootsplatz.',
    profile:'Profil wählen oder neu anlegen; ohne Maße bleibt die Körperrechnung aus.',
    result:'Ergebnis prüfen; kein Wert wird automatisch verändert.',
    save:'Arbeitsstand bewusst speichern.',
  };
  announce(messages[step]??'Schritt geöffnet.');
  return true;
}
function initWorkflowGuide(){
  const guide=$('workflowGuide');
  guide.addEventListener('click',event=>{
    const link=event.target.closest('a[data-guide-target]');
    if(!link||!guide.contains(link)) return;
    event.preventDefault();
    focusWorkflowGuideTarget(link.dataset.guideTarget);
  });
  $('actionResult').addEventListener('focusin',markWorkflowResultReviewed);
  guide.open=workspaceViewState==='new'&&!activeAssignment();
  workflowGuideReady=true;
  renderWorkflowGuide();
}
function renderActionPlan(){
  const diagnostics=buildActionDiagnostics();
  lastActionPlan=buildTrimActionPlan({
    seats:diagnostics,referenceSeatId:state.referenceSeatId,totalSeatCount:state.seats.length,maxActions:3,
  });
  workflowCurrentResultSignature=workflowResultSignature(lastActionPlan,diagnostics,state.seats.length,state.referenceSeatId);
  const statusText={missing:'Daten fehlen',ok:'kein akuter Handlungsbedarf',check:'prüfen',change:'ändern'};
  const badge=$('actionStatus');
  badge.dataset.status=lastActionPlan.status;
  badge.textContent=statusText[lastActionPlan.status]||'prüfen';
  $('actionResult').dataset.status=lastActionPlan.status;
  $('actionSummary').textContent=lastActionPlan.summary;
  const resultUnavailable=lastActionPlan.status==='missing';
  $('actionMissingFocus').hidden=!resultUnavailable;
  $('resultPrivacy').disabled=resultUnavailable;
  for(const id of ['resultExport','resultPrint']){
    const button=$(id); button.disabled=resultUnavailable;
    button.title=resultUnavailable?'Erst verfügbar, sobald mindestens ein vollständiges Profil ausgewertet werden kann.':'';
  }
  const renderSignature=JSON.stringify(lastActionPlan);
  if(renderSignature!==renderedActionPlanSignature){
    renderedActionPlanSignature=renderSignature;
    $('actionList').replaceChildren(...lastActionPlan.actions.map(action=>{
      const item=document.createElement('li'); item.className='action-item'; item.dataset.actionId=action.id;
      const main=document.createElement('div'); main.className='action-item-main';
      const scope=document.createElement('span'); scope.className='action-scope';
      scope.textContent=action.scope.type==='crew'?action.scope.label:`${action.scope.label} · ${cleanName(action.scope.rowerName,'Profil')}`;
      const title=document.createElement('h3'); title.textContent=action.parameter;
      const values=document.createElement('p'); values.className='action-values action-problem';
      const problemLabel=document.createElement('strong'); problemLabel.textContent='Problem: ';
      values.append(problemLabel,document.createTextNode(`${action.reason} · Ist ${formatActionMeasure(action.current)} · Ziel ${formatActionTarget(action.target)}`));
      const change=document.createElement('p'); change.className='action-change';
      const changeLabel=document.createElement('strong'); changeLabel.textContent='Jetzt ändern: ';
      change.append(changeLabel,document.createTextNode(action.direction));
      const effect=document.createElement('p'); effect.className='action-effect';
      const effectLabel=document.createElement('strong'); effectLabel.textContent='Erwartete Wirkung: ';
      effect.append(effectLabel,document.createTextNode(action.effect));
      const uncertainty=document.createElement('p'); uncertainty.className='action-uncertainty details-only'; uncertainty.textContent=`Unsicherheit: ${action.uncertainty}`;
      main.append(scope,document.createTextNode(' · '),title,values,change,effect,uncertainty);
      const focus=document.createElement('button'); focus.type='button'; focus.className='action-focus'; focus.dataset.actionId=action.id;
      focus.textContent='Zum Wert'; focus.setAttribute('aria-label',`${action.parameter} für ${action.scope.label} öffnen`);
      item.append(main,focus); return item;
    }));
  }
}
function actionPlanForExport(plan,includeNames){
  return {
    ...plan,
    actions:plan.actions.map(action=>({
      ...action,
      scope:{...action.scope,rowerName:includeNames?action.scope.rowerName:(action.scope.position?`Profil Platz ${action.scope.position}`:null)},
    })),
  };
}
function anonymizeCurrentConfig(config){
  const seats=config.boat.seats.map(seat=>({...seat,externalRef:null,rowerRef:null}));
  const crew=config.crew.map(assignment=>{
    const position=seats.find(seat=>seat.id===assignment.seatId)?.position??0;
    return {...assignment,rowerRef:null,rower:{...assignment.rower,externalRef:null,name:`Profil Platz ${position}`}};
  });
  return buildCurrentConfigDTO({
    ...config,boatRef:null,
    boat:{...config.boat,externalRef:null,name:`Boot ${config.boat.preset}`,
      cox:config.boat.cox?{name:'Steuerperson (anonymisiert)'}:null,seats},
    crew,
  });
}
function confirmResultShare(kind,includeNames){
  return confirm([
    `${kind}-Vorschau:`,
    `• ${lastActionPlan.actions.length} priorisierte Maßnahme(n)`,
    `• ${lastActionPlan.evaluatedSeats} Profil(e) ausgewertet`,
    `• Namen werden ${includeNames?'ausdrücklich mitgegeben':'anonymisiert'}`,
    '• Modellgrenzen und App-Build werden mitgegeben',
    '',
    'Jetzt fortfahren?',
  ].join('\n'));
}
function resultSnapshot(includeNames){
  const rawConfig=currentConfigOf();
  return {
    format:'rudertrimm.action-result',schemaVersion:1,domainSchemaVersion:SCHEMA_VERSION,
    appVersion:APP_VERSION,buildDate:APP_BUILD_DATE,buildId:APP_BUILD_ID,shellRevision:APP_SHELL_REVISION,
    createdAt:new Date().toISOString(),privacy:includeNames?'names-included':'anonymized',
    config:includeNames?rawConfig:anonymizeCurrentConfig(rawConfig),
    result:actionPlanForExport(lastActionPlan,includeNames),
    modelLimits:[
      'Rigg-Zielkorridore und Modellvorschläge, keine automatische Änderung.',
      'Körperkinematik, Natural Catch und 90°-Prüfung sind unkalibriert.',
      'Trainer-, Messprotokoll- und Golden-Daten-Freigabe stehen aus.',
    ],
  };
}
function renderPrintResult(snapshot){
  const host=$('printResult'); host.replaceChildren();
  const add=(tag,text)=>{ const node=document.createElement(tag); node.textContent=text; host.appendChild(node); return node; };
  add('h1','Rudertrimm · Ergebnis & Handlungsbedarf');
  add('p',`${snapshot.appVersion} · Build ${snapshot.buildDate} · ${snapshot.buildId} · ${new Date(snapshot.createdAt).toLocaleString('de-DE')}`);
  add('p',`Boot: ${snapshot.config.boat.name} · ${snapshot.config.boat.preset} · ${snapshot.config.boat.rig==='skull'?'Skull':'Riemen'} · Datenschutz: ${snapshot.privacy==='anonymized'?'anonymisiert':'Namen enthalten'}`);
  add('h2',({ok:'Kein akuter Handlungsbedarf',check:'Prüfen',change:'Ändern',missing:'Daten fehlen'})[snapshot.result.status]);
  add('p',snapshot.result.summary);
  const list=document.createElement('ol'); host.appendChild(list);
  for(const action of snapshot.result.actions){
    const item=document.createElement('li');
    const heading=document.createElement('h3'); heading.textContent=`${action.scope.label}${action.scope.rowerName?` · ${action.scope.rowerName}`:''}: ${action.parameter}`;
    const body=document.createElement('p'); body.textContent=`Ist ${formatActionMeasure(action.current)} · Ziel ${formatActionTarget(action.target)} · ${action.direction}. ${action.reason} Erwartete Wirkung: ${action.effect}`;
    const limit=document.createElement('p'); limit.textContent=`Unsicherheit: ${action.uncertainty}`;
    item.append(heading,body,limit); list.appendChild(item);
  }
  add('h2','Modellgrenzen');
  const limits=document.createElement('ul'); host.appendChild(limits);
  for(const text of snapshot.modelLimits){ const item=document.createElement('li'); item.textContent=text; limits.appendChild(item); }
}
function initActionResult(){
  $('actionMissingFocus').addEventListener('click',()=>{
    const target=activeSeat()?$('dbSelect'):$('preset');
    target.focus(); target.scrollIntoView?.({block:'center',behavior:preferredScrollBehavior()});
    announce(activeSeat()
      ?'Nächster Schritt: für den aktiven Bootsplatz ein gespeichertes Profil wählen oder ein neues Profil anlegen.'
      :'Nächster Schritt: zuerst eine gültige Bootsklasse wählen.');
  });
  $('actionList').addEventListener('click',event=>{
    const button=event.target.closest('button[data-action-id]');
    if(!button) return;
    const action=lastActionPlan.actions.find(candidate=>candidate.id===button.dataset.actionId);
    if(!action) return;
    const seatId=action.focusSeatId??action.scope.seatId??state.referenceSeatId;
    if(seatId&&state.seats.some(seat=>seat.id===seatId)&&state.editSeatId!==seatId){
      state.editSeatId=seatId; clearRowerSelection(); buildControls(); refreshDBSelect(); render();
    }
    if(!COMPACT_CONTROL_KEY_SET.has(action.field)) setPresentationMode('details');
    requestAnimationFrame(()=>{
      const input=$(`in_${action.field}`);
      if(!input){ announce('Das betroffene Eingabefeld ist im aktuellen Arbeitsstand nicht verfügbar.'); return; }
      input.focus(); input.scrollIntoView?.({block:'center',behavior:preferredScrollBehavior()});
    });
  });
  $('resultExport').addEventListener('click',()=>{
    if(lastActionPlan.status==='missing'){ announce('Ergebnisexport ist erst mit mindestens einem vollständigen Profil verfügbar.'); return; }
    const includeNames=$('resultPrivacy').value==='names';
    if(!confirmResultShare('Ergebnisexport',includeNames)) return;
    downloadJson(resultSnapshot(includeNames),`rudertrimm-ergebnis-${$('preset').value}.json`);
    announce(`Ergebnis exportiert · ${includeNames?'Namen enthalten':'Namen anonymisiert'}.`);
  });
  $('resultPrint').addEventListener('click',()=>{
    if(lastActionPlan.status==='missing'){ announce('Druckbericht ist erst mit mindestens einem vollständigen Profil verfügbar.'); return; }
    const includeNames=$('resultPrivacy').value==='names';
    if(!confirmResultShare('Druckbericht',includeNames)) return;
    renderPrintResult(resultSnapshot(includeNames));
    document.body.classList.add('print-result-mode');
    const cleanup=()=>document.body.classList.remove('print-result-mode');
    window.addEventListener('afterprint',cleanup,{once:true});
    window.print(); setTimeout(cleanup,1000);
  });
}

/* ---------------- SVG helpers ---------------- */
const NS='http://www.w3.org/2000/svg';
let visualContentWidth=0;
function visualCanvasWidth(designWidth){
  return visualContentWidth>=240?Math.min(designWidth,visualContentWidth):designWidth;
}
function recordVisualContentWidth(value){
  const next=Math.floor(Number(value));
  if(!Number.isFinite(next)||next<240||Math.abs(next-visualContentWidth)<2) return false;
  visualContentWidth=next;
  return true;
}
function initVisualSizing(){
  const container=$('viewPanels');
  recordVisualContentWidth(container.clientWidth);
  const rerenderIfWidthChanged=width=>{
    if(recordVisualContentWidth(width)&&!playing) render();
  };
  if(typeof ResizeObserver==='function'){
    const observer=new ResizeObserver(entries=>rerenderIfWidthChanged(entries[0]?.contentRect?.width));
    observer.observe(container);
  }else{
    window.addEventListener('resize',()=>rerenderIfWidthChanged(container.clientWidth),{passive:true});
  }
}
function el(svg,tag,at){const e=document.createElementNS(NS,tag);
  for(const k in at)e.setAttribute(k,at[k]); svg.appendChild(e); return e;}
function txt(svg,x,y,str,at={}){const e=el(svg,'text',{x,y,...at}); e.textContent=str; return e;}
function newSVG(host,W,H,label,description=''){host.replaceChildren();
  const svg=document.createElementNS(NS,'svg');
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  svg.setAttribute('role','img');
  const idBase=`${host.id||'rudertrimmVisual'}Svg`;
  const titleId=`${idBase}Title`;
  const title=el(svg,'title',{id:titleId}); title.textContent=label;
  svg.setAttribute('aria-labelledby',titleId);
  if(description){
    const descriptionId=`${idBase}Description`;
    const desc=el(svg,'desc',{id:descriptionId}); desc.textContent=description;
    svg.setAttribute('aria-describedby',descriptionId);
  }
  host.appendChild(svg); return svg;}
function plateLabel(svg,x,y,label,{anchor='start',leader=null,className=''}={}){
  const width=Math.max(48,[...String(label)].length*6.2+14), height=20;
  const left=anchor==='end'?x-width:anchor==='middle'?x-width/2:x;
  const lineClass=className?{class:`${className}-leader`}:{}, plateClass=className?{class:`${className}-plate`}:{};
  const textClass=className?`svg-label ${className}`:'svg-label';
  if(leader) el(svg,'line',{...lineClass,x1:leader.x,y1:leader.y,x2:x,y2:y+2,stroke:'var(--fg-mut)','stroke-width':1,'stroke-dasharray':'2 3'});
  el(svg,'rect',{...plateClass,x:left,y:y-14,width,height,rx:4,fill:'rgba(7,17,10,.9)',stroke:'var(--v2-panel-line)','stroke-width':.8});
  txt(svg,x,y,label,{'text-anchor':anchor,fill:'var(--fg)',class:textClass});
}
function dim(svg,x1,y1,x2,y2,label,opts={}){
  const col=opts.col||'#7f92ac';
  el(svg,'line',{x1,y1,x2,y2,stroke:col,'stroke-width':1.25});
  for(const [px,py,qx,qy] of [[x1,y1,x2,y2],[x2,y2,x1,y1]]){
    const ang=Math.atan2(qy-py,qx-px), s=6;
    el(svg,'path',{d:`M${px},${py} L${px+s*Math.cos(ang-0.4)},${py+s*Math.sin(ang-0.4)} L${px+s*Math.cos(ang+0.4)},${py+s*Math.sin(ang+0.4)} Z`,fill:col});
  }
  const tx=(x1+x2)/2+(opts.dx||0), ty=(y1+y2)/2+(opts.dy||-5);
  if(label){
    if(opts.plate) plateLabel(svg,tx,ty,label,{anchor:opts.anchor||'middle'});
    else txt(svg,tx,ty,label,{'text-anchor':opts.anchor||'middle',fill:opts.tcol||col});
  }
}
function arrow(svg,x1,y1,x2,y2,col,w){
  el(svg,'line',{x1,y1,x2,y2,stroke:col,'stroke-width':w,'stroke-linecap':'round'});
  const ang=Math.atan2(y2-y1,x2-x1), s=w*3.2;
  el(svg,'path',{d:`M${x2},${y2} L${x2-s*Math.cos(ang-0.45)},${y2-s*Math.sin(ang-0.45)} L${x2-s*Math.cos(ang+0.45)},${y2-s*Math.sin(ang+0.45)} Z`,fill:col});
}

/* ---------------- Blattformen (lokal: x 0..1 längs, y in Einheiten der Blattbreite BW) ----------------
   Big-Blade (Beil): Schaftachse liegt nahe der geraden OBERkante, die Fläche hängt
   fast vollständig auf einer Seite; breite, fast gerade Abschlusskante.
   Macon: symmetrische Tulpe, größte Breite bei ~60–70 %, breit gerundete Spitze. */
const BLADE_BIG=[[0,.08],[.2,.20],[.5,.26],[.85,.28],[1,.26],[1,-.55],[.93,-.70],[.55,-.66],[.2,-.42],[0,-.10]];
const BLADE_MAC=[[0,.06],[.15,.22],[.35,.38],[.6,.47],[.8,.48],[.93,.42],[1,.25],[1.03,0],
                 [1,-.25],[.93,-.42],[.8,-.48],[.6,-.47],[.35,-.38],[.15,-.22],[0,-.06]];
function bladeDims(type,skull){
  return type==='mac' ? {BL:skull?50:58, BW:skull?17:20} : {BL:skull?46:54, BW:skull?21:25};   // 46/54 = WM-2017-Median
}
function bladePts(type){ return type==='mac' ? BLADE_MAC : BLADE_BIG; }
// Blatt zeichnen: base=Blatthals (Screen), dirU=Längsachse zur Spitze, dirV=Breitenachse.
// Beide Achsen sind PROJEKTIONEN der 3D-Richtungen (Norm ≤ 1) — die Verkürzung
// steckt in der Achse selbst, das Blatt rotiert in keiner Ansicht künstlich.
function drawBlade(svg,base,dirU,len,dirV,wide,type,flip,attributes={}){
  const f=flip?-1:1;
  const d=bladePts(type).map((p,i)=>{
    const gx=base.x+dirU.x*p[0]*len+dirV.x*p[1]*wide*f;
    const gy=base.y+dirU.y*p[0]*len+dirV.y*p[1]*wide*f;
    return (i?'L':'M')+gx.toFixed(1)+','+gy.toFixed(1);
  }).join(' ')+' Z';
  el(svg,'path',{...attributes,d,fill:'var(--blade)',stroke:'#a87b28','stroke-width':1.1,opacity:.95});
}

/* ================= Draufsicht (Boot horizontal, Bug links) ================= */
function renderTop(dv,seats,primary){
  const s=state, W=visualCanvasWidth(1180), body=primary.b;
  const DAr=dv.DAr;                      // Referenz-Platz (Bögen, Keil, Maße)
  const K=0.55;                          // Außenhebel-Verkürzung (nur Darstellung)
  const rOut=dv.outb*K, rIn=dv.inb;
  // Ausschnitt über die größten Hebel aller Plätze
  const DArMax=Math.max(...seats.map(x=>x.dv.DAr)), outMax=Math.max(...seats.map(x=>x.dv.outb))*K;
  const phiAmax=Math.max(s.phiA,...seats.map(seat=>seat.dv.phiA));
  // Der Schlag kreuzt zwischen Aus- und Rücklage die Orthogonale (cos θ = 1).
  // Endpunkt-Cosinus unterschätzte deshalb die Querhülle und schnitt bei gültigen
  // Grenzwinkeln phasenweise Blatt/Ruderspitze ab. Die Hülle bleibt nun phasenfest.
  const latMax=DArMax+outMax+34;
  const lat=Math.max(latMax,DArMax+rIn*0.4+60,150);
  const sc=Math.min((W-40)/560, 250/lat);
  const plotH=2*lat*sc+46, compactLegend=W<700;
  const H=plotH+(compactLegend?118:0);
  const cx=W/2, cy=plotH/2+8;
  const X=u=>cx+u*sc, Y=v=>cy-v*sc;     // u: heckwärts + (Bug links), v: quer
  const fullNames=seats.map(seat=>cleanName(seat.name,'Ruderer')).join(' und ');
  const svg=newSVG($('vTop'),W,H,`Draufsicht des Ruderriggs für ${cleanName(primary.name,'Ruderer')}`,
    `${dv.skull?'Skull':'Riemen'}, Phase ${PHASES[currentPhase()].n}. Dargestellte Profile: ${fullNames}. Freie Bootsplätze werden nicht simuliert.`);
  const th=rad(body.theta), g=body.g;
  const blade=$('blade').value;
  const {BL,BW}=bladeDims(blade,dv.skull);

  // Zugbereich
  el(svg,'rect',{x:X(-240),y:Y(body.SB/2),width:480*sc,height:body.SB*sc,fill:'rgba(46,204,113,.07)',stroke:'rgba(46,204,113,.3)','stroke-dasharray':'3 4'});
  el(svg,'line',{x1:X(-275),y1:cy,x2:X(275),y2:cy,stroke:'var(--fg-mut)','stroke-dasharray':'6 5'});
  txt(svg,cx,16,'ORTHOGONALSTELLUNG',{class:'cap','text-anchor':'middle',fill:'var(--fg)'});
  txt(svg,X(-272),cy-6,'Bug',{class:'cap'}); txt(svg,X(244),cy-6,'Heck',{class:'cap','text-anchor':'end'});

  // Rumpf
  const hw=13;
  el(svg,'path',{d:`M${X(-250)},${cy} Q${X(-150)},${Y(hw)} ${X(0)},${Y(hw+1)} Q${X(150)},${Y(hw)} ${X(250)},${cy} Q${X(150)},${Y(-hw)} ${X(0)},${Y(-hw-1)} Q${X(-150)},${Y(-hw)} ${X(-250)},${cy} Z`,
    fill:'var(--hull)',stroke:'#42597a','stroke-width':1});
  el(svg,'rect',{x:X(-65),y:Y(9),width:120*sc,height:18*sc,rx:8,fill:'#0b1420',stroke:'#42597a','stroke-width':.8});

  const RS=dv.skull?1:primary.side;                     // Referenzseite (Schlagmann)

  // Ampel-Zonen für den Auslagewinkel (identische Schwellen wie die Statuskarte oben),
  // je Sitz an dessen eigener Dolle gespiegelt — macht die Winkel zwischen den Plätzen vergleichbar.
  const angBand = dv.skull ? {lo:65,hi:75,pad:5} : {lo:50,hi:60,pad:5};
  const zoneMax = Math.max(angBand.hi+angBand.pad+6, phiAmax+6);
  const zones = [
    [0, Math.max(0,angBand.lo-angBand.pad), 'rgba(248,81,73,.09)','rgba(248,81,73,.3)'],
    [Math.max(0,angBand.lo-angBand.pad), angBand.lo, 'rgba(240,169,46,.12)','rgba(240,169,46,.4)'],
    [angBand.lo, angBand.hi, 'rgba(46,204,113,.14)','rgba(46,204,113,.5)'],
    [angBand.hi, angBand.hi+angBand.pad, 'rgba(240,169,46,.12)','rgba(240,169,46,.4)'],
    [angBand.hi+angBand.pad, zoneMax, 'rgba(248,81,73,.09)','rgba(248,81,73,.3)'],
  ];
  function sectorPath(ox,pv,sd,rk,aLoDeg,aHiDeg){
    const N=16; let d=`M${X(ox)},${Y(pv)} `;
    for(let i=0;i<=N;i++){ const a=rad(lerp(aLoDeg,aHiDeg,i/N));
      d+=`L${X(-rk*Math.sin(a)+ox)},${Y(pv+sd*rk*Math.cos(a))} `; }
    return d+'Z';
  }
  // ---- pro Sitz: Ampelzonen, Schlagbogen, Auslage/Rücklage-Grenzen, eigene Orthogonale ----
  function drawSeatArcs(seat,isRef){
    const ox=seat.ox, sdv=seat.dv, sOut=sdv.outb*K, sIn=sdv.inb, sDAr=sdv.DAr;
    const seatSides=dv.skull?[1,-1]:[seat.side];
    const rk=sOut*0.92;
    const phiASeat=sdv.phiA;                 // Ist-Auslage oder klar markierte finite Prüfpose
    el(svg,'line',{x1:X(ox),y1:Y(lat-4),x2:X(ox),y2:Y(-lat+4),stroke:'#fff','stroke-dasharray':'5 5',opacity:isRef?.45:.28});
    for(const sd of seatSides){
      const pv=sd*sDAr;
      for(const [aLo,aHi,fill,stroke] of zones){
        if(aHi<=aLo) continue;
        el(svg,'path',{d:sectorPath(ox,pv,sd,rk,aLo,aHi),fill,stroke,'stroke-width':1});
      }
      for(const [r,col,sgn] of [[sOut,'rgba(63,162,255,.55)',1],[sIn,'rgba(232,176,75,.5)',-1]]){
        let dstr='';
        for(let i=0;i<=44;i++){ const a=rad(lerp(phiASeat,-s.phiR,i/44));
          dstr+=(i?'L':'M')+X(-sgn*r*Math.sin(a)+ox)+','+Y(pv+sd*sgn*r*Math.cos(a))+' '; }
        el(svg,'path',{d:dstr,fill:'none',stroke:col,'stroke-width':1.6,'stroke-dasharray':'5 4'});
      }
      for(const A of [phiASeat,-s.phiR]){ const a=rad(A);
        el(svg,'line',{x1:X(ox),y1:Y(pv),x2:X(-rk*Math.sin(a)+ox),y2:Y(pv+sd*rk*Math.cos(a)),stroke:'var(--fg-mut)','stroke-width':1,'stroke-dasharray':'2 4'}); }
    }
    const lblSide=seatSides[0], pvLbl=lblSide*sDAr;
    const targetDiffers=Math.abs(phiASeat-s.phiA)>1.5;
    const naturalMissing=seat.catchSolution.naturalResolved===false;
    const actualMissing=seat.catchSolution.actualAngleDeg===null;
    const modelTxt=compactLegend
      ?'' // vollständige Ziel-/Modellwarnung bleibt in Statuskarten und SVG-Beschreibung
      : naturalMissing
      ? ` (keine Natural-Catch-Lösung · Rigg-Ziel ${fmt(s.phiA)}°)`
      : seat.reachAvailable===false
      ? ` (3D nicht erreichbar; Natural ${fmt(seat.catchSolution.naturalAngleDeg)}°)`
      : seat.catchSolution.limitedByReach
      ? ` (3D-Limit; Natural ${fmt(seat.catchSolution.naturalAngleDeg)}° · Ziel ${fmt(s.phiA)}°)`
      : targetDiffers?` (Rigg-Ziel ${fmt(s.phiA)}°)`:'';
    const angleLabel=compactLegend
      ? `${actualMissing?'Prüf':'Ist'} ${fmt(phiASeat)}°`
      : actualMissing
      ? (seats.length>1?`${visualName(seat.name)}: Prüfpose ${fmt(phiASeat)}°`:`Prüfpose ${fmt(phiASeat)}°`)
      : (seats.length>1?`${visualName(seat.name)}: Ist ${fmt(phiASeat)}°`:`Ist-Auslage ${fmt(phiASeat)}°`);
    const lblText=angleLabel+modelTxt;
    txt(svg,X(-rk*0.7*Math.sin(rad(phiASeat))+ox)-8,Y(pvLbl+lblSide*rk*0.75*Math.cos(rad(phiASeat)))-6,
      lblText,{fill:actualMissing?'var(--bad)':targetDiffers?'var(--warn)':'var(--fg)',class:'cap','text-anchor':'end'});
    txt(svg,X(ox)+8,Y(pvLbl)-8,'Dolle',{class:'cap'});
  }

  // ---- ein Sitz: Dollen + Ruder + Ruderer, längs um ox versetzt ----
  function drawSeatTop(seat,isRef){
    const b=seat.b, ox=seat.ox, th=rad(b.theta), g=b.g, zf=dv.skull?1:seat.side;
    const sdv=seat.dv;                                   // Rigg DIESES Platzes
    const sOut=sdv.outb*K, sIn=sdv.inb, sDAr=sdv.DAr;
    const XL=u=>X(u+ox), YZ=z=>Y(zf*z);
    const seatSides=dv.skull?[1,-1]:[seat.side];
    const bodyCol=isRef?'var(--body)':'var(--accent2)', jointCol=isRef?'var(--accent2)':'var(--accent)';
    for(const sd of seatSides){
      const pv=sd*sDAr;
      const tip={x:XL(-sOut*Math.sin(th)), y:Y(pv+sd*sOut*Math.cos(th))};
      const neckR=sOut-BL*K, neck={x:XL(-neckR*Math.sin(th)), y:Y(pv+sd*neckR*Math.cos(th))};
      const hnd={x:XL(sIn*Math.sin(th)), y:Y(pv-sd*sIn*Math.cos(th))};
      el(svg,'line',{class:'top-oar-shaft','data-oar-side':sd,x1:hnd.x,y1:hnd.y,x2:neck.x,y2:neck.y,stroke:'var(--wood)','stroke-width':3,'stroke-linecap':'round'});
      const dir={x:(tip.x-neck.x)/(BL*K*sc), y:(tip.y-neck.y)/(BL*K*sc)};
      drawBlade(svg,neck,dir,BL*K*sc,{x:-dir.y,y:dir.x},BW*sc*K*lerp(0.16,1,g),blade,sd>0,
        {class:'top-oar-blade','data-oar-side':sd});
      el(svg,'circle',{cx:hnd.x,cy:hnd.y,r:4,fill:jointCol});
      el(svg,'circle',{cx:XL(0),cy:Y(pv),r:4.5,fill:'#e4ecf7',stroke:'#42597a'});
    }
    // Körper (Projektion x→längs, z→quer; z gespiegelt je nach Seite)
    const S1=b.arms[0].S, S2=b.arms[b.arms.length-1].S;
    el(svg,'path',{d:`M${XL(b.hip.x)},${Y(11)} L${XL(S1.x)},${YZ(S1.z)} L${XL(S2.x)},${YZ(S2.z)} L${XL(b.hip.x)},${Y(-11)} Z`,fill:bodyCol,opacity:.28});
    el(svg,'line',{x1:XL(S1.x),y1:YZ(S1.z),x2:XL(S2.x),y2:YZ(S2.z),stroke:bodyCol,'stroke-width':5,'stroke-linecap':'round',opacity:.85});
    el(svg,'circle',{cx:XL(b.head.x),cy:cy,r:b.head.r*sc,fill:bodyCol});
    for(const A of b.arms){
      el(svg,'path',{d:`M${XL(A.S.x)},${YZ(A.S.z)} L${XL(A.E.x)},${YZ(A.E.z)} L${XL(A.W.x)},${YZ(A.W.z)}`,fill:'none',stroke:bodyCol,'stroke-width':3,'stroke-linecap':'round','stroke-linejoin':'round',opacity:.85});
      el(svg,'circle',{cx:XL(A.W.x),cy:YZ(A.W.z),r:3.4,fill:jointCol});
    }
    if(seats.length>1) txt(svg,XL(b.head.x),cy-b.head.r*sc-4,visualName(seat.name,'Ruderer',18),{'text-anchor':'middle',fill:bodyCol,class:'cap'});
  }
  const sortedSeats=[...seats].sort((a,b)=>a.ox-b.ox);
  sortedSeats.forEach(seat=>drawSeatArcs(seat,seat===primary));
  sortedSeats.forEach(seat=>drawSeatTop(seat,seat===primary));

  // Übergriff-Maß
  if(dv.U>0){
    const y1=Y(dv.skull?DAr-dv.inb:0), y2=Y(dv.skull?-(DAr-dv.inb):RS*(DAr-dv.inb));
    dim(svg,X(95),y1,X(95),y2,`Ü = ${fmt(dv.U)} cm`,{col:'var(--accent2)',tcol:'var(--accent2)',anchor:'start',dx:8,dy:3});
  }
  const strokeSummary=compactLegend
    ?`SW ${fmt(dv.SW)}° · θ ${fmt(body.theta,0)}° · ${body.g>0.5?'flach':'auf'}`
    :`Schlagweite ${fmt(dv.SW)}°  ·  θ = ${fmt(body.theta)}°  ·  Blatt ${body.g>0.5?'flach (abgedreht)':'aufgedreht'}`;
  txt(svg,X(-255),Y(-lat+14),strokeSummary,{class:'big'});

  const lx=compactLegend?16:W-208, ly=compactLegend?plotH+20:26;
  const leg=[['rgba(63,162,255,.8)','Schlagbogen (Blattweg)','5 4'],['rgba(232,176,75,.8)','Griffweg','5 4'],
             ['rgba(46,204,113,.8)','Zugbereich','3 4'],['#ffffff88','Orthogonalstellung','5 5']];
  leg.forEach((L,i)=>{
    el(svg,'line',{x1:lx,y1:ly+i*17,x2:lx+26,y2:ly+i*17,stroke:L[0],'stroke-width':2,'stroke-dasharray':L[2]});
    txt(svg,lx+33,ly+i*17+4,L[1],{});
  });
  const legZ=[['rgba(46,204,113,.6)','Rigg-Zielkorridor'],['rgba(240,169,46,.6)','… Toleranz'],['rgba(248,81,73,.6)','… außerhalb']];
  const zy=ly+leg.length*17+6;
  legZ.forEach((L,i)=>{
    el(svg,'rect',{x:lx,y:zy+i*15-6,width:14,height:9,fill:L[0],stroke:'none'});
    txt(svg,lx+21,zy+i*15+1,L[1],{});
  });
}

/* ================= Querschnitt ================= */
function renderCross(dv,primary){
  const s=state, W=visualCanvasWidth(560), body=primary.b, r=primary.r;
  const RS=dv.skull?1:primary.side;          // Seite des bearbeiteten Ruderers
  const DAr=dv.DAr;
  const wl=body.wl, pinY=body.pinY;
  const {top:topY,bottom:botY}=stableVerticalViewBounds([primary]);
  // Phasenstabile Maximalhülle: Im Querschnitt erreicht die Ruderprojektion
  // bei cos(theta)=1 den vollständigen Außenhebel. DAr+50 schnitt deshalb
  // in jeder Pflichtphase Blatt und Schaft ab.
  const extX=DAr+dv.outb+12;
  const sc=(W-24)/(2*extX);
  // DA/Neigung liegen in einer festen oberen Labelzone; die eigentliche
  // Körper-/Ruderhülle beginnt darunter und bleibt phasenunabhängig.
  const labelTop=54, labelBottom=14;
  const H=labelTop+(topY-botY)*sc+labelBottom;
  const cx=W/2, oy=labelTop+topY*sc;
  const X=x=>cx+x*sc, Y=y=>oy-y*sc, XZ=z=>X(RS*z);   // XZ spiegelt die Querachse auf die Ruderer-Seite
  const svg=newSVG($('vCross'),W,H,`Querschnitt des Ruderriggs für ${cleanName(primary.name,'Ruderer')}`,
    `${dv.skull?'Skull mit zwei sichtbaren Rudern':'Riemen mit einem sichtbaren Ruder'}, Phase ${PHASES[currentPhase()].n}. Dollenhöhe und Neigung sind als Prüfwerte beschriftet.`);
  const blade=$('blade').value;
  const {BL,BW}=bladeDims(blade,dv.skull);
  const g=body.g;

  if(s.mode==='wasser'){
    el(svg,'rect',{x:0,y:Y(wl),width:W,height:H-Y(wl),fill:'var(--water)',opacity:.6});
    el(svg,'line',{x1:0,y1:Y(wl),x2:W,y2:Y(wl),stroke:'var(--waterline)','stroke-width':1.5,opacity:.8});
    txt(svg,8,Y(wl)+14,s.kg?`Wasserlinie (${s.kg>0?'+':''}${s.kg} kg → ${s.kg>0?'+':''}${fmt(s.kg,0)} mm)`:'Wasserlinie',{fill:'var(--waterline)'});
  } else {
    // Werkstatt: Bock unter dem Rumpf
    el(svg,'path',{d:`M${X(0)},${Y(-13)} L${X(-30)},${Y(-30)} M${X(0)},${Y(-13)} L${X(30)},${Y(-30)} M${X(-19)},${Y(-24)} L${X(19)},${Y(-24)}`,stroke:'#7a6a4f','stroke-width':4,fill:'none','stroke-linecap':'round'});
    txt(svg,8,16,'Werkstatt-Modus · Boot auf Böcken',{class:'cap',fill:'var(--fg-dim)'});
  }

  const hb=s.c+6.5;
  el(svg,'path',{d:`M${X(-27)},${Y(hb)} Q${X(-25)},${Y(-14)} ${X(0)},${Y(-14.5)} Q${X(25)},${Y(-14)} ${X(27)},${Y(hb)} L${X(-27)},${Y(hb)} Z`,
    fill:'var(--hull)',stroke:'#42597a'});
  el(svg,'rect',{x:X(-14),y:Y(s.c),width:28*sc,height:3.2*sc,rx:2,fill:'#9aa7b5'});

  const sides=dv.skull?[1,-1]:[1];           // kanonische +z-Seite(n); XZ spiegelt bei Riemen
  const cosT=Math.cos(rad(body.theta));      // Längs-Auslenkung verkürzt die Frontalprojektion
  const tipY=wl+body.lift;
  for(const sd of sides){
    el(svg,'line',{class:'cross-rigger',x1:XZ(sd*26),y1:Y(hb),x2:XZ(sd*DAr),y2:Y(pinY),stroke:'#6d83a0','stroke-width':2});
    el(svg,'line',{class:'cross-rigger',x1:XZ(sd*17),y1:Y(hb-4),x2:XZ(sd*DAr),y2:Y(pinY-1.5),stroke:'#6d83a0','stroke-width':1.1});
    const tilt=rad(r.aussen*4)*sd*RS;
    el(svg,'line',{x1:XZ(sd*DAr),y1:Y(pinY-2),x2:XZ(sd*DAr)+Math.sin(tilt)*10,y2:Y(pinY+7),stroke:'#e4ecf7','stroke-width':3});
    // Ruder als Projektion desselben 3D-Zustands wie in Drauf-/Seitenansicht
    const arm=body.arms[dv.skull?(sd>0?0:1):0];
    const zN=sd*(DAr+(dv.outb-BL)*cosT), zTip=sd*(DAr+dv.outb*cosT);
    const yN=lerp(pinY,tipY,(dv.outb-BL)/dv.outb);
    el(svg,'line',{class:'cross-oar-shaft', 'data-oar-side':sd,x1:XZ(arm.W.z),y1:Y(arm.W.y),x2:XZ(sd*DAr),y2:Y(pinY),stroke:'var(--wood)','stroke-width':2.5,'stroke-linecap':'round'});
    el(svg,'line',{class:'cross-oar-shaft', 'data-oar-side':sd,x1:XZ(sd*DAr),y1:Y(pinY),x2:XZ(zN),y2:Y(yN),stroke:'var(--wood)','stroke-width':2.5,'stroke-linecap':'round'});
    // Dieselbe Big-/Macon-Silhouette wie in Drauf- und Seitenansicht, nur als
    // Frontalprojektion. Die Achse behält exakt Hals/Spitze; die Blattbreite
    // wird beim Abdrehen perspektivisch schmal statt zur fachfremden Ellipse.
    const neck={x:XZ(zN),y:Y(yN)}, tip={x:XZ(zTip),y:Y(tipY)};
    const projectedLength=BL*sc;
    const dirU={x:(tip.x-neck.x)/projectedLength,y:(tip.y-neck.y)/projectedLength};
    drawBlade(svg,neck,dirU,projectedLength,{x:0,y:-1},BW*sc*lerp(1,.16,g),blade,false,{
      class:'cross-oar-blade','data-oar-side':sd,
    });
    el(svg,'circle',{class:'cross-oar-pin','data-oar-side':sd,cx:XZ(sd*DAr),cy:Y(pinY),r:4,fill:'#e4ecf7',stroke:'#42597a'});
  }
  // Ruderer frontal: Beine, Torso, Kopf, Arme — alles Projektion des Körpermodells (z gespiegelt via XZ)
  {
    for(const sd of [1,-1])
      el(svg,'path',{d:`M${X(sd*6)},${Y(body.hip.y)} L${X(sd*9)},${Y(body.kneeP.y)} L${X(sd*11)},${Y(body.foot.y)}`,
        fill:'none',stroke:'var(--body)','stroke-width':4,opacity:.45,'stroke-linecap':'round','stroke-linejoin':'round'});
    const S1=body.arms[0].S, S2=body.arms[body.arms.length-1].S;
    el(svg,'path',{d:`M${X(-10)},${Y(s.c+3)} L${XZ(S2.z)},${Y(S2.y)} Q${X(0)},${Y(body.sh.y+5)} ${XZ(S1.z)},${Y(S1.y)} L${X(10)},${Y(s.c+3)} Z`,
      fill:'var(--body)',opacity:.30});
    el(svg,'circle',{cx:X(0),cy:Y(body.head.y),r:body.head.r*sc,fill:'var(--body)',opacity:.75});
    for(const A of body.arms){
      el(svg,'path',{d:`M${XZ(A.S.z)},${Y(A.S.y)} L${XZ(A.E.z)},${Y(A.E.y)} L${XZ(A.W.z)},${Y(A.W.y)}`,
        fill:'none',stroke:'var(--body)','stroke-width':3,'stroke-linecap':'round','stroke-linejoin':'round',opacity:.75});
      el(svg,'circle',{cx:XZ(A.W.z),cy:Y(A.W.y),r:3.2,fill:'var(--accent2)'});
    }
  }
  if(r.aussen>0) txt(svg,XZ(DAr),Y(pinY+10),W<460
    ?`Außen ${fmt(r.aussen)}° · 4×`
    :`Außenneigung ${fmt(r.aussen)}° (4× überhöht)`,{'text-anchor':RS>0?'end':'start'});

  const mx=dv.skull? X(-DAr-16) : XZ(DAr+16);
  if(s.mode==='werkstatt'){
    const baseY=s.heightRef==='schiene'? s.c-s.seatOffset : s.c;   // Schiene liegt unter dem Sitz-Tiefpunkt
    const off=s.heightRef==='schiene'?s.seatOffset:0;
    dim(svg,mx,Y(baseY),mx,Y(pinY),`${fmt(r.a+off)} cm`,{col:'var(--ok)',tcol:'var(--ok)',anchor:'middle',dy:-7});
    txt(svg,mx,Y(pinY)-20,'Dollenhöhe',{'text-anchor':'middle',fill:'var(--ok)',class:'cap'});
    txt(svg,mx,Y(baseY)+16,s.heightRef==='schiene'?'über Schiene':'über Rollsitz',{'text-anchor':'middle',fill:'var(--ok)'});
  } else {
    dim(svg,mx,Y(wl),mx,Y(pinY),`${fmt(dv.dWL)} cm`,{col:'var(--ok)',tcol:'var(--ok)',anchor:'middle',dy:-7});
    txt(svg,mx,Y(pinY)-20,'Dollenhöhe',{'text-anchor':'middle',fill:'var(--ok)',class:'cap'});
    txt(svg,mx,Y(wl)+16,'über Wasser',{'text-anchor':'middle',fill:'var(--ok)'});
  }
  const m3=Y(pinY+13);
  const daStart=dv.skull?X(-DAr):X(0), daEnd=dv.skull?X(DAr):XZ(DAr);
  dim(svg,daStart,m3,daEnd,m3,'');
  plateLabel(svg,24,42,`DA ${fmt(dv.DA)} cm`,{leader:{x:(daStart+daEnd)/2,y:m3},className:'cross-da-label'});
  const pinScreen={x:XZ(DAr),y:Y(pinY)};
  plateLabel(svg,W-24,42,`Neigung ${fmt(r.anlage)}°`,{anchor:'end',leader:pinScreen,className:'cross-pitch-label'});
}

/* ================= Seitenansicht ================= */
function stableVerticalViewBounds(seats,mode=state.mode,seatHeight=state.c){
  let top=seatHeight+32;
  for(const seat of seats){
    const seg=SEG(seat.r), headRadius=seg.HEAD*0.42;
    const pinY=seatHeight+seat.r.a;
    // Phasenunabhängige Maximalhülle: Der Kopf kann geometrisch nie höher
    // als aufrechter Rumpf + Hals + Kopfdurchmesser liegen. So ändern rAF
    // und Direktphasen nur interne Koordinaten, nie die SVG-/Dokumenthöhe.
    const headTop=seatHeight+4+seg.T+seg.NECK+2*headRadius+12;
    top=Math.max(top,pinY+20,headTop);
  }
  // Werkstattböcke reichen bis -30 cm; 4 cm Reserve halten Strich und Text
  // vollständig im Viewport. Wasser benötigt keine zusätzliche Tiefe.
  return Object.freeze({top,bottom:mode==='werkstatt'?-34:-22});
}
function renderSide(dv,seats,primary,refs){
  const s=state, W=visualCanvasWidth(760);
  const {BL,BW}=bladeDims($('blade').value,dv.skull);
  const blade=$('blade').value;
  // Horizontaler Ausschnitt über alle Sitze; vertikal gilt eine feste,
  // aus den Körpermaßen abgeleitete Hülle über den gesamten Schlag.
  let x0=-115, x1=140;
  for(const seat of seats){ const b=seat.b, ox=seat.ox;
    x0=Math.min(x0, ox-seat.dv.outb*Math.sin(rad(Math.max(s.phiA,seat.dv.phiA)))-14);
    x1=Math.max(x1, ox+b.foot.x+70, ox+seat.dv.outb*Math.sin(rad(s.phiR))+14);
  }
  const vertical=stableVerticalViewBounds(seats);
  const ext={x0,x1,y0:vertical.bottom,y1:vertical.top};
  const sc=(W-20)/(ext.x1-ext.x0);
  // Feste Beschriftungszonen liegen außerhalb der Körper-/Bootshülle. Dadurch
  // bleiben Annotationen auch bei schmalen Ansichten kollisionsarm und die Hülle
  // weiterhin über alle Phasen konstant.
  const narrowLabels=W<740, labelTop=narrowLabels?86:38, labelBottom=36;
  const H=labelTop+(ext.y1-ext.y0)*sc+labelBottom;
  const X=x=>10+(x-ext.x0)*sc, Y=y=>labelTop+(ext.y1-y)*sc;
  const sideNames=seats.map(seat=>cleanName(seat.name,'Ruderer')).join(' und ');
  const svg=newSVG($('vSide'),W,H,`Seitenansicht und Körpermodell für ${cleanName(primary.name,'Ruderer')}`,
    `Phase ${PHASES[currentPhase()].n}. Sitz, Beine, Rumpf, Arme und Ruder der dargestellten Profile ${sideNames} verwenden denselben Schlagzustand.`);
  const wl=primary.b.wl;

  if(s.mode==='wasser'){
    el(svg,'rect',{x:0,y:Y(wl),width:W,height:H-Y(wl),fill:'var(--water)',opacity:.6});
    el(svg,'line',{x1:0,y1:Y(wl),x2:W,y2:Y(wl),stroke:'var(--waterline)','stroke-width':1.5,opacity:.8});
  } else {
    for(const bx of [ext.x0+45, ext.x1-55]){
      el(svg,'path',{d:`M${X(bx)},${Y(-11)} L${X(bx-16)},${Y(-30)} M${X(bx)},${Y(-11)} L${X(bx+16)},${Y(-30)} M${X(bx-10)},${Y(-25)} L${X(bx+10)},${Y(-25)}`,stroke:'#7a6a4f','stroke-width':4,fill:'none','stroke-linecap':'round'});
    }
    txt(svg,X(ext.x0+8),Y(-26),'Werkstatt-Modus · Bewegung simuliert',{class:'cap',fill:'var(--fg-dim)'});
  }
  const hb=s.c+6.5;
  el(svg,'path',{d:`M${X(ext.x0+2)},${Y(hb)} L${X(ext.x1-18)},${Y(hb)} Q${X(ext.x1-4)},${Y(hb-4)} ${X(ext.x1-9)},${Y(-7)} L${X(ext.x0+16)},${Y(-12)} Q${X(ext.x0+2)},${Y(-11)} ${X(ext.x0+2)},${Y(hb)} Z`,
    fill:'var(--hull)',opacity:.55,stroke:'#42597a'});
  txt(svg,X(ext.x0+6),Y(hb)-6,'← Bug',{class:'cap'}); txt(svg,X(ext.x1-20),Y(hb)-6,'Heck →',{class:'cap','text-anchor':'end'});

  // ---- ein Sitz (Rig + Ruder + Ruderer), um ox längs versetzt ----
  function drawSeat(seat,isRef){
    const b=seat.b, ox=seat.ox, th=rad(b.theta), rr=seat.r, sdv=seat.dv;
    const XL=x=>X(x+ox);
    const pinY=b.pinY, bladeX=-sdv.outb*Math.sin(th), bladeY=wl+b.lift;
    const bodyCol = isRef ? '#dbe4ee' : 'var(--accent2)';
    const jointCol = isRef ? 'var(--accent2)' : 'var(--accent)';
    const trackEnd=rr.rueh, track0=trackEnd-rr.rollL;
    // Rollbahn
    el(svg,'line',{x1:XL(track0),y1:Y(s.c-4),x2:XL(trackEnd),y2:Y(s.c-4),stroke:'#9aa7b5','stroke-width':3});
    for(const e of [track0,trackEnd]) el(svg,'line',{x1:XL(e),y1:Y(s.c-6.5),x2:XL(e),y2:Y(s.c-1.5),stroke:'#9aa7b5','stroke-width':2});
    // Dollenanlage + Stift
    const tA=rad(rr.anlage*4);
    el(svg,'line',{x1:XL(0),y1:Y(pinY-3),x2:XL(Math.sin(tA)*10),y2:Y(pinY+7),stroke:'#e4ecf7','stroke-width':3});
    el(svg,'circle',{cx:XL(0),cy:Y(pinY),r:4,fill:'#e4ecf7',stroke:'#42597a'});
    if(isRef){
      el(svg,'line',{x1:XL(0),y1:Y(-8),x2:XL(0),y2:Y(pinY+14),stroke:'#fff','stroke-dasharray':'4 5',opacity:.4});
      plateLabel(svg,W-16,narrowLabels?50:24,'Dollenlot',{anchor:'end',leader:{x:XL(0),y:Y(-8)},className:'side-dollenlot-label'});
      plateLabel(svg,W/2,24,`Anlage ${fmt(rr.anlage)}° · 4× dargestellt`,{anchor:'middle',leader:{x:XL(0),y:Y(pinY)}});
      dim(svg,XL(0),Y(s.c-10),XL(trackEnd),Y(s.c-10),'');
      plateLabel(svg,W-16,H-14,`Überstand ${fmt(rr.rueh)} cm`,{anchor:'end',leader:{x:(XL(0)+XL(trackEnd))/2,y:Y(s.c-10)},className:'side-track-label'});
    }
    // Stemmbrett + Ferse
    const bw=rad(rr.stemmW), bTop={x:b.foot.x+30*Math.cos(bw), y:b.foot.y+30*Math.sin(bw)};
    el(svg,'line',{x1:XL(b.foot.x),y1:Y(b.foot.y),x2:XL(bTop.x),y2:Y(bTop.y),stroke:'var(--wood)','stroke-width':4,'stroke-linecap':'round'});
    if(isRef){
      txt(svg,XL(bTop.x)+6,Y(bTop.y)+2,`Stemmbrett ${fmt(rr.stemmW)}°`,{});
      dim(svg,XL(0),Y(b.foot.y-4),XL(b.foot.x),Y(b.foot.y-4),'');
      plateLabel(svg,16,H-14,`Fa ${fmt(b.r.stemmX)} cm`,{leader:{x:(XL(0)+XL(b.foot.x))/2,y:Y(b.foot.y-4)},className:'side-fa-label'});
    }
    // Ruder + Blatt
    el(svg,'line',{x1:XL(b.hand.x),y1:Y(b.hand.y),x2:XL(0),y2:Y(pinY),stroke:'var(--wood)','stroke-width':2.6});
    const neckF=(sdv.outb-BL)/sdv.outb;
    const neck={x:XL(bladeX*neckF), y:Y(lerp(pinY,bladeY,neckF))};
    el(svg,'line',{x1:XL(0),y1:Y(pinY),x2:neck.x,y2:neck.y,stroke:'var(--wood)','stroke-width':2.6});
    const cosB=Math.sqrt(Math.max(0,1-b.sinB*b.sinB));
    drawBlade(svg,neck,{x:-Math.sin(th)*cosB,y:b.sinB},BL*sc,{x:-b.g*Math.cos(th),y:-(1-b.g)},BW*sc,blade,false);
    // Kraftpfeil (nur Referenz, eingetauchtes Blatt)
    if(isRef && s.mode==='wasser' && !state.recovery && s.t>4 && s.t<98){
      const len=16+34*Math.sin(Math.PI*s.t/100);
      arrow(svg,XL(bladeX),Y(bladeY),XL(bladeX-len*0.9),Y(bladeY-len*0.4),'var(--accent)',3);
      txt(svg,XL(bladeX-len)-4,Y(bladeY-len*0.45)-6,'Blattdruck (schematisch)',{fill:'var(--accent2)',class:'cap','text-anchor':'end'});
    }
    // Rollsitz + Körper
    el(svg,'rect',{x:XL(b.hip.x-11),y:Y(s.c),width:22*sc,height:3.2*sc,rx:2,fill:'#9aa7b5'});
    const st={stroke:bodyCol,'stroke-width':3.4,'stroke-linecap':'round','stroke-linejoin':'round',fill:'none'};
    el(svg,'path',{d:`M${XL(b.hip.x)},${Y(b.hip.y)} L${XL(b.kneeP.x)},${Y(b.kneeP.y)} L${XL(b.foot.x)},${Y(b.foot.y)}`,...st});
    // Rumpf: GANZER Rücken rundet — Wölbung bugwärts, proportional zur Flexion
    {
      const dxs=b.sh.x-b.hip.x, dys=b.sh.y-b.hip.y, dl=Math.hypot(dxs,dys)||1;
      let nx=-dys/dl, ny=dxs/dl; if(nx>0){nx=-nx; ny=-ny;}   // Normale zeigt bugwärts
      const bulge=(b.flex||0)*0.6;
      const mxp=(b.hip.x+b.sh.x)/2+nx*bulge, myp=(b.hip.y+b.sh.y)/2+ny*bulge;
      el(svg,'path',{d:`M${XL(b.hip.x)},${Y(b.hip.y)} Q${XL(mxp)},${Y(myp)} ${XL(b.sh.x)},${Y(b.sh.y)}`,...st,'stroke-width':4});
    }
    b.arms.forEach((A,i)=>{
      const op=i===0?1:0.6;
      el(svg,'path',{d:`M${XL(A.S.x)},${Y(A.S.y)} L${XL(A.E.x)},${Y(A.E.y)} L${XL(A.W.x)},${Y(A.W.y)}`,...st,'stroke-width':2.6,opacity:op});
      el(svg,'circle',{cx:XL(A.E.x),cy:Y(A.E.y),r:2.4,fill:jointCol,opacity:op});
      el(svg,'circle',{cx:XL(A.W.x),cy:Y(A.W.y),r:3.4,fill:jointCol,opacity:op});
    });
    for(const p of [b.hip,b.kneeP,b.sh]) el(svg,'circle',{cx:XL(p.x),cy:Y(p.y),r:2.6,fill:jointCol});
    el(svg,'circle',{cx:XL(b.head.x),cy:Y(b.head.y),r:b.head.r*sc,fill:'none',stroke:bodyCol,'stroke-width':2.8});
    // Sitz-Label am Kopf
    if(seats.length>1) txt(svg,XL(b.head.x),Y(b.head.y+b.head.r+3),visualName(seat.name,'Ruderer',18),{'text-anchor':'middle',fill:bodyCol,class:'cap'});
    // Unkalibrierte 6°-Prüfreferenz: bewusst keine grüne Ziel-/Freigabeaussage.
    if(isRef && s.t<10 && !state.recovery){
      el(svg,'line',{x1:XL(b.sh.x),y1:Y(b.sh.y),x2:XL(b.sh.x+70),y2:Y(b.sh.y-70*Math.tan(rad(6))),stroke:'#70b9e8','stroke-dasharray':'4 4','stroke-width':1.4});
      const armLabel=narrowLabels
        ?`Arme ${fmt(b.armAng,0)}° · Ref. 6° offen`
        :`Armmodell ${fmt(b.armAng,0)}° · Referenz 6° offen`;
      plateLabel(svg,12,narrowLabels?76:24,armLabel,{leader:{x:XL(b.sh.x),y:Y(b.sh.y)}});
    }
  }
  // Bug-seitigen Ruderer zuerst zeichnen, Schlagmann (ox=0) oben
  [...seats].sort((a,b)=>a.ox-b.ox).forEach(seat=>drawSeat(seat,seat===primary));

  // Körperdaten des bearbeiteten (primären) Ruderers + Vergleich mit Schlagmann
  const b=primary.b, ref=seats.find(x=>x.ref)||seats[0], rb=ref.b;
  const dcmp=(a,c,u='')=>{const dd=a-c; return seats.length>1&&!primary.ref ? ` (${dd>=0?'+':''}${fmt(dd,0)}${u})`:'';};
  const rows=[
    ['Körperwinkel',fmt(b.lam,0)+'° '+(b.lam>2?'Vorlage':b.lam<-2?'Rücklage':'aufrecht')],
    ['Kniewinkel',fmt(b.knee,0)+'°'+dcmp(b.knee,rb.knee,'°')],
    ['Ellbogen',fmt(b.arms[0].ang,0)+'°'],
    ['Griffhöhe ü. W.',fmt(b.hand.y-wl,0)+' cm'],
    ['Reichweite Auslage',fmt(refs.b0.hand.x,0)+' cm'+dcmp(refs.b0.hand.x, bodyRefs(ref.dv,ref.r).b0.hand.x,'')],
    ['Rollweg',fmt(refs.rollAt(b),0)+' %'],
    ['Blatt',b.g>0.5?'flach':'aufgedreht'],
  ];
  const table=$('bodyTab'), caption=table.querySelector('caption');
  const body=document.createElement('tbody');
  for(const [label,value] of rows){
    const tr=document.createElement('tr');
    const th=document.createElement('th'); th.scope='row'; th.textContent=label;
    const td=document.createElement('td'); td.className='v'; td.textContent=value;
    tr.append(th,td); body.appendChild(tr);
  }
  table.replaceChildren(caption,body);
}

/* ================= Phasen ================= */
const PHASES=[
  {n:'Auslage',t:0,rec:false},{n:'Vord. Zug',t:25,rec:false},{n:'Zugmitte',t:50,rec:false},
  {n:'Hinterer Zug',t:75,rec:false},{n:'Ausheben',t:100,rec:false},{n:'Rückführung',t:50,rec:true},
];
function currentPhase(){
  if(state.recovery) return 5;
  const t=state.t;
  return t<=10?0 : t<40?1 : t<62?2 : t<92?3 : 4;
}
function renderPhases(){
  const cur=currentPhase();
  const host=$('phases');
  if(host.children.length!==PHASES.length){
    host.replaceChildren(...PHASES.map((p,i)=>{
      const button=document.createElement('button'); button.type='button'; button.className='phase';
      button.dataset.i=String(i);
      const number=document.createElement('span'); number.className='n'; number.textContent=String(i+1);
      const title=document.createElement('span'); title.className='t'; title.textContent=p.n;
      button.append(number,title);
      button.addEventListener('click',()=>{
        stopPlay(); state.t=p.t; state.recovery=p.rec; setDirty(); render();
      });
      return button;
    }));
  }
  for(const [index,button] of [...host.children].entries()){
    button.classList.toggle('on',index===cur);
    button.setAttribute('aria-pressed',String(index===cur));
  }
  $('phN').textContent=(cur+1)+'/6';
  $('phName').textContent=PHASES[cur].n;
}

/* ================= Zugänglicher Ansichtsumschalter ================= */
const VISUAL_VIEWS=Object.freeze(['top','side','cross']);
let activeVisualView='top';
function visualViewFromKey(current,key){
  const index=VISUAL_VIEWS.indexOf(current);
  if(index<0) return null;
  if(key==='Home') return VISUAL_VIEWS[0];
  if(key==='End') return VISUAL_VIEWS.at(-1);
  if(key==='ArrowRight') return VISUAL_VIEWS[(index+1)%VISUAL_VIEWS.length];
  if(key==='ArrowLeft') return VISUAL_VIEWS[(index-1+VISUAL_VIEWS.length)%VISUAL_VIEWS.length];
  return null;
}
function activateVisualView(view,{focus=false}={}){
  if(!VISUAL_VIEWS.includes(view)) return false;
  activeVisualView=view;
  for(const candidate of VISUAL_VIEWS){
    const selected=candidate===view;
    const tab=$(`viewTab${candidate[0].toUpperCase()}${candidate.slice(1)}`);
    const panel=$(`viewPanel${candidate[0].toUpperCase()}${candidate.slice(1)}`);
    tab.setAttribute('aria-selected',String(selected));
    tab.tabIndex=selected?0:-1;
    panel.hidden=!selected;
  }
  if(focus) $(`viewTab${view[0].toUpperCase()}${view.slice(1)}`).focus();
  return true;
}
function initVisualViewTabs(){
  for(const view of VISUAL_VIEWS){
    const tab=$(`viewTab${view[0].toUpperCase()}${view.slice(1)}`);
    tab.addEventListener('click',()=>activateVisualView(view));
    tab.addEventListener('keydown',event=>{
      const target=visualViewFromKey(view,event.key);
      if(!target) return;
      event.preventDefault();
      activateVisualView(target,{focus:true});
    });
  }
  activateVisualView(activeVisualView);
}

/* ================= Einklappbare Karten (Fokus-Modus) ================= */
const FOLD_STORAGE_KEY='rudertrimm:v2:fold';
let foldState={};
try{ const parsed=JSON.parse(storageAdapter.getItem(FOLD_STORAGE_KEY)||'{}'); foldState=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{}; }catch(e){ foldState={}; }
const isFolded=id=>!!foldState[id];
function initFold(){
  for(const card of document.querySelectorAll('.card[data-fold]')){
    const id=card.dataset.fold;
    card.classList.toggle('closed', isFolded(id));
    const heading=card.querySelector('h2');
    const button=document.createElement('button');
    button.type='button'; button.className='fold-toggle';
    button.setAttribute('aria-expanded',String(!isFolded(id)));
    button.append(...heading.childNodes); heading.appendChild(button);
    const toggle=()=>{
      foldState[id]=!isFolded(id);
      storageAdapter.setItem(FOLD_STORAGE_KEY,JSON.stringify(foldState));
      card.classList.toggle('closed', foldState[id]);
      button.setAttribute('aria-expanded',String(!foldState[id]));
      render();   // beim Aufklappen frisch zeichnen
    };
    button.addEventListener('click',toggle);
  }
}

/* ================= Ruderer-Sektion: Sitze, Name, Datenbank, Vitruv ================= */
function isSingle(){ return state.seats.length===1; }
function assignmentResolution(seat){
  const assignment=assignmentFor(seat.id);
  if(!assignment) return seat.rowerRef?'missing':'free';
  if(!assignment.rowerRef) return 'unsaved';
  const selected=rowerRepository.select(assignment.rowerRef.id);
  if(!selected.ok) return 'snapshot-missing';
  return selected.record.revision===assignment.rowerRef.revision?'resolved':'stale';
}
function crewScopeLabel(presetKey){
  const boatClass=String(presetKey).replace(/^wm[MW]/u,'');
  const occupied=state.seats.filter(seat=>assignmentFor(seat.id)).length;
  const unresolved=state.seats.filter(seat=>seat.rowerRef&&!assignmentFor(seat.id)).length;
  return `${occupied}/${state.seats.length} belegt · ${boatClass}${unresolved?` · ${unresolved} Referenz${unresolved===1?'':'en'} ungeklärt`:''}`;
}
function compactDollenSummary(dv,r){
  if(state.mode==='wasser') return `Dollenhöhe ü. Wasser ${fmt(dv.dWL)} cm`;
  const fromTrack=state.heightRef==='schiene';
  const reference=fromTrack?'Schiene':'Rollsitz';
  const height=r.a+(fromTrack?state.seatOffset:0);
  return `Dollenhöhe ü. ${reference} ${fmt(height)} cm`;
}
function renderCompactSummaries(dv,r,catchSolution,modelSeat=activeSeat()){
  const seat=seatLabel(modelSeat);
  const preview=modelSeat?.id!==activeSeat()?.id;
  const rig=dv.skull?'Skull':'Riemen';
  const dolle=compactDollenSummary(dv,r);
  const catchText=catchSolution.actualAngleDeg!==null
    ?`Auslage Ist ${fmt(dv.phiA)}°`
    :`${catchSolution.naturalResolved?'Auslage 3D nicht erreichbar':'Auslage nicht bestimmbar'} · Prüfpose ${fmt(dv.phiA)}°`;
  $('compactRigSummary').textContent=`${preview?'Referenzvorschau: ':''}${seat} · ${rig} · DA ${fmt(r.DA)} cm · IH ${fmt(r.IH)} cm · ${dolle} · Fa ${fmt(r.stemmX)} cm · ${catchText} / Rigg-Ziel ${fmt(state.phiA)}°.`;
  $('compactProfileSummary').textContent=`${cleanName(r.name,seat)} · ${fmt(SEG(r).height,0)} cm · Spannweite ${fmt(r.wingspan,0)} cm · ${fmt(r.weight,0)} kg`;
}
function renderAssignmentStatus(){
  const seat=activeSeat(), assignment=activeAssignment();
  const status=$('seatAssignmentStatus');
  if(!seat){
    if(status.textContent!=='Kein Bootsplatz verfügbar. Zuerst eine gültige Bootsklasse wählen.') status.textContent='Kein Bootsplatz verfügbar. Zuerst eine gültige Bootsklasse wählen.';
    $('seatCreateDraft').disabled=true; $('quickEditPerson').disabled=true; $('seatUnassign').disabled=true;
    $('quickEditBoat').disabled=true;
    return;
  }
  $('seatCreateDraft').disabled=false;
  $('quickEditPerson').disabled=!assignment;
  $('quickEditBoat').disabled=false;
  $('seatUnassign').disabled=!assignment&&!seat.rowerRef;
  const resolution=assignmentResolution(seat);
  let message;
  if(resolution==='free'){
    message=`${seatLabel(seat)} ist frei. Ohne Körperprofil bleibt die Körperrechnung aus; jetzt ein gespeichertes Profil wählen oder „Neues Profil“ anlegen.`;
  }else if(resolution==='missing'){
    message=`${seatLabel(seat)} verweist auf ein nicht verfügbares Profil. Die Körperrechnung bleibt aus; Profil bewusst neu zuordnen oder den Platz freigeben.`;
  }else if(resolution==='snapshot-missing'){
    message=`${seatLabel(seat)} zeigt den gespeicherten Snapshot von „${cleanName(assignment.rower.name,'Profil')}“. Der verknüpfte Datenbankeintrag fehlt; Rechnung ist möglich, aber die Zuordnung muss bewusst repariert oder freigegeben werden.`;
  }else if(resolution==='stale'){
    message=`${seatLabel(seat)} nutzt den gespeicherten Snapshot von „${cleanName(assignment.rower.name,'Profil')}“. Die Datenbank hat eine andere Revision; neu auswählen, um sie bewusst zu übernehmen.`;
  }else if(resolution==='unsaved'){
    message=`${seatLabel(seat)}: „${cleanName(assignment.rower.name,'Ungespeichertes Profil')}“ ist nur im Arbeitsstand zugeordnet und noch nicht als Profil gespeichert.`;
  }else{
    message=`${seatLabel(seat)}: „${cleanName(assignment.rower.name,'Profil')}“ ist mit der gespeicherten Profilrevision verbunden.`;
  }
  if(status.textContent!==message) status.textContent=message;
  const externalStatus=$('externalLinkStatus');
  if(externalStatus){
    const profileRef=assignment?.rower?.externalRef;
    const boatRef=boatMetadata.externalRef;
    const parts=[];
    if(boatRef) parts.push(`Boot: ${boatRef.system} · ${boatRef.scope} · ${boatRef.id}`);
    if(profileRef) parts.push(`Profil: ${profileRef.system} · ${profileRef.scope} · ${profileRef.id}`);
    externalStatus.textContent=parts.length
      ?`${parts.join(' · ')} · schreibgeschützte Herkunft; kein Rückschreiben in V2.`
      :'Keine externe Verknüpfung · eFa-Leseadapter noch nicht angebunden.';
  }
}
function renderSeatTabs(){
  if(!state.seats.some(seat=>seat.id===state.editSeatId)) state.editSeatId=state.seats[0]?.id??null;
  if(rowerSelection.snapshot().id&&!rowerSelection.isFor(state.editSeatId)) clearRowerSelection();
  const tabs=state.seats.map(seat=>[seat.id,seatLabel(seat)]);
  const host=$('seattabs');
  const existing=[...host.children].map(button=>button.dataset.seat);
  if(existing.length!==tabs.length||tabs.some(([id],index)=>existing[index]!==id)){
    host.replaceChildren(...tabs.map(([id,sub])=>{
      const button=document.createElement('button'); button.type='button'; button.dataset.seat=id;
      button.append(document.createTextNode(''));
      const detail=document.createElement('span'); detail.className='sub'; detail.textContent=sub; button.appendChild(detail);
      button.addEventListener('click',()=>{
        if(state.editSeatId===button.dataset.seat) return;
        state.editSeatId=button.dataset.seat;
        clearRowerSelection();
        buildControls(); refreshDBSelect(); render();
      });
      return button;
    }));
  }
  for(const [index,[id,sub]] of tabs.entries()){
    const button=host.children[index];
    const seat=state.seats[index], assignment=assignmentFor(id), resolution=assignmentResolution(seat);
    const status=assignment?resolution:(seat.rowerRef?'missing':'free');
    const problematic=status==='missing'||status==='snapshot-missing'||status==='stale';
    button.className=`${state.editSeatId===id?'on is-active':''} ${problematic?'is-missing':assignment?'is-occupied':'is-free'}`;
    button.dataset.seatStatus=status==='free'?'':status==='missing'?'Referenz fehlt':status==='snapshot-missing'?'Snapshot · Profil fehlt':status==='stale'?'Snapshot · Stand veraltet':status==='unsaved'?'ungespeichert':'belegt';
    button.setAttribute('aria-pressed',String(state.editSeatId===id));
    button.setAttribute('aria-label',`${sub}: ${assignment?cleanName(assignment.rower.name,'Profil'):'frei'}${state.editSeatId===id?' · aktiv':''}`);
    button.firstChild.nodeValue=assignment?cleanName(assignment.rower.name,'Ungespeichertes Profil'):sub;
    button.querySelector('.sub').textContent=assignment?sub:`frei${state.editSeatId===id?' · aktiv':''}`;
  }
  $('stepper').hidden=!activeAssignment();
  $('stepper').setAttribute('aria-hidden',String($('stepper').hidden));
  $('rowerName').disabled=!activeAssignment();
  $('rowerName').value = activeRower()?.name??'';
  $('rowerName').placeholder=activeAssignment()?'Name oder Pseudonym':'Zuerst Profil zuordnen oder neu anlegen';
  $('stepLbl').textContent = state.dbIdx>=0 && state.db[state.dbIdx] ? state.db[state.dbIdx].name : 'Datenbank';
  renderAssignmentStatus();
  renderBMI();
}
function renderBMI(){
  const r=activeRower(), el=$('bmiBadge');
  if(!r){
    el.className='bmi';
    el.textContent='Körperrechnung aus · Profil erforderlich';
    el.title='Ohne zugeordnetes Körperprofil wird keine Körperrechnung ausgeführt.';
    return;
  }
  const h=SEG(r).height/100, bmi=r.weight/(h*h);
  const cat = bmi<18.5?['lo','schlank'] : bmi<25?['ok','normal'] : bmi<30?['hi','kräftig'] : ['vhi','schwer'];
  el.className='bmi '+cat[0];
  const strong=document.createElement('b'); strong.textContent=fmt(bmi,1);
  el.replaceChildren(document.createTextNode('BMI '),strong,document.createTextNode(` · ${cat[1]}`));
  el.title=`Body-Mass-Index = ${fmt(r.weight,0)} kg / (${fmt(SEG(r).height/100,2)} m)²`;
}
$('rowerName').addEventListener('input',e=>{
  const rower=activeRower();
  if(!rower) return;
  const name=limitName(e.target.value); e.target.value=name; rower.name=name;
  markProfileDraftChanged(state.editSeatId); setDirty(); renderSeatTabs(); render();
});

/* ---- Kraftvergleich: Hebelverhältnis (Außenhebel/Innenhebel) zwischen Referenz- und aktivem Vergleichsplatz.
   Bei gleichem Blattwiderstand ist die nötige Griffkraft ∝ Außenhebel/Innenhebel (Drehmoment-
   gleichgewicht um den Dollenstift) — gleiches Verhältnis = rechnerisch gleiche Kraft am Griff. ---- */
function renderForceCompare(seats){
  const box=$('forceCmp');
  if(seats.length<2){ box.style.display='none'; return; }
  box.style.display='';
  const ref=seats.find(x=>x.ref), other=seats.find(x=>!x.ref);
  const ratio=seat=>seat.dv.outb/seat.dv.inb;
  const rRef=ratio(ref), rOther=ratio(other);
  const d=rOther-rRef;
  for(const [host,seat,value] of [[$('fcS1'),ref,rRef],[$('fcS2'),other,rOther]]){
    const strong=document.createElement('b'); strong.textContent=`1 : ${fmt(value,2)}`;
    host.replaceChildren(document.createTextNode(`${cleanName(seat.name,'Ruderer')} `),strong);
  }
  const dEl=$('fcDelta');
  const closeEnough=Math.abs(d)<=0.03;
  const solution=solveInboardForRatio({
    L:other.r.L,d:other.r.d,targetRatio:rRef,range:RANGES[state.rig].IH,step:0.5,
  });
  const noFurtherChange=Math.abs(other.r.IH-solution.IH)<1e-9;
  dEl.textContent=closeEnough ? '✓ angeglichen' : `Δ ${d>0?'+':''}${fmt(d,2)}`;
  dEl.className='fc-delta '+(closeEnough?'':Math.abs(d)<=0.1?'warn':'bad');
  const equalize=$('fcEqualize'), status=$('fcEqualizeStatus');
  equalize.disabled=closeEnough||noFurtherChange;
  const explanation=closeEnough
    ? 'Hebelverhältnisse stimmen bereits überein'
    :noFurtherChange&&solution.clamped
      ?`Zielverhältnis liegt außerhalb des zulässigen Innenhebelbereichs; Grenze ${fmt(solution.IH)} cm, verbleibendes Δ ${fmt(solution.delta,2)}`
    :noFurtherChange
      ?`Mit 0,5-cm-Schritten nicht genauer erreichbar; verbleibendes Δ ${fmt(solution.delta,2)}`
    :'';
  equalize.title=explanation||`Innenhebel von ${other.name} so anpassen, dass sein Hebelverhältnis dem von ${ref.name} entspricht (Ruderlänge bleibt)`;
  if(status.textContent!==explanation) status.textContent=explanation;
  status.hidden=!explanation;
}
$('fcEqualize').addEventListener('click',()=>{
  const seats=buildSeats(), ref=seats.find(x=>x.ref), other=seats.find(x=>!x.ref);
  if(!ref||!other) return;
  const targetRatio=ref.dv.outb/ref.dv.inb;
  const solution=solveInboardForRatio({
    L:other.r.L,d:other.r.d,targetRatio,range:RANGES[state.rig].IH,step:0.5,
  });
  const targetSeat=state.seats.find(seat=>seat.id===other.seatId);
  if(!targetSeat) return;
  targetSeat.IH=solution.IH;
  setDirty();
  if(state.editSeatId===targetSeat.id) buildControls();
  render();
  announce(solution.clamped
    ?`Innenhebel auf ${fmt(solution.IH)} cm begrenzt; Zielverhältnis nicht vollständig erreichbar, verbleibendes Δ ${fmt(solution.delta,2)}.`
    :`Innenhebel auf ${fmt(solution.IH)} cm gesetzt; erreichtes Verhältnis 1 : ${fmt(solution.achievedRatio,2)}.`);
});

/* ---- Vitruv-Figur: Doppelpose in Kreis+Quadrat, Proportionen nach Ruderer-Profil ---- */
function renderVitruv(r){
  const W=220,Hd=224,cx=110,cy=112;
  const seg=SEG(r), col = state.editSeatId===state.referenceSeatId ? '#f2e9d8' : 'var(--accent2)';
  const guideCol='#8f7255', secondaryCol='#c9925a';
  const height=seg.height;                 // Standhöhe = Beinlänge + Rumpflänge
  const rawScale=Math.max(seg.height, r.wingspan)*(160/215);
  const S=Math.min(160,rawScale);                         // datengetrieben, an der sicheren ViewBox-Hülle begrenzt
  const half=S/2, sqTop=cy-half, sqBot=cy+half;
  const navelY=sqBot-0.615*S, R=S*0.575;   // Kreis um den Nabel (Da-Vinci-Verhältnis)
  const svg=newSVG($('vitruv'),W,Hd,`Proportionsgrafik für ${cleanName(r.name,'Ruderer')}: ${fmt(seg.height,0)} cm Größe, ${fmt(r.wingspan,0)} cm Spannweite und ${fmt(r.weight,0)} kg`);
  const description=el(svg,'desc',{id:'vitruvSvgDescription'});
  description.textContent=`Technische Proportions-Doppelpose von ${cleanName(r.name,'Ruderer')}. Die helle Primärpose zeigt Körpergröße und Spannweite; die bronzefarbene Sekundärpose dient als Konstruktionsreferenz.`;
  svg.setAttribute('aria-describedby','vitruvSvgDescription');
  const guides=el(svg,'g',{class:'vitruv-guides','aria-hidden':'true'});
  el(guides,'circle',{cx,cy:navelY,r:R,fill:'none',stroke:guideCol,'stroke-width':.85,opacity:.42,'stroke-dasharray':'5 5'});
  el(guides,'rect',{x:cx-half,y:sqTop,width:S,height:S,fill:'none',stroke:guideCol,'stroke-width':.75,opacity:.34,'stroke-dasharray':'3 5'});
  // Vertikale Gelenkhöhen aus Segmenten (Ferse → Scheitel); Figur füllt die reale Standhöhe
  const sw=S/Math.max(seg.height,r.wingspan);
  const figTop=sqBot-height*sw;                 // Standhöhe kann kleiner als Quadrat sein
  const yAt=v=>sqBot - v*sw;                     // v = cm ab Ferse
  const yFoot=sqBot, yKnee=yAt(seg.US), yHip=yAt(seg.US+seg.OS),
        ySh=yAt(seg.US+seg.OS+seg.T), yNeck=yAt(seg.US+seg.OS+seg.T+seg.NECK), yCrown=figTop;
  const shH=r.SB/2*sw, hipH=shH*0.7, arm=(seg.OA+seg.UA)*sw;
  const primary=el(svg,'g',{class:'vitruv-primary','aria-hidden':'true'});
  const secondary=el(svg,'g',{class:'vitruv-secondary','aria-hidden':'true'});
  const ink={stroke:col,fill:'none','stroke-linecap':'round','stroke-linejoin':'round'};
  const faint={stroke:secondaryCol,fill:'none','stroke-linecap':'round','stroke-linejoin':'round','stroke-width':1.15,opacity:.38};
  const limb={...ink,'stroke-width':4.2};
  const joint={fill:col,opacity:.92};
  // Rumpf-Silhouette (Schultern → Taille → Hüfte)
  const waistY=lerp(ySh,yHip,0.55), waistH=hipH*0.76;
  el(primary,'path',{class:'vitruv-torso',d:`M${cx-shH},${ySh} C${cx-shH*.92},${ySh+7} ${cx-waistH},${waistY} ${cx-hipH},${yHip}`
     +` Q${cx},${yHip+5} ${cx+hipH},${yHip} C${cx+waistH},${waistY} ${cx+shH*.92},${ySh+7} ${cx+shH},${ySh}`
     +` Q${cx},${ySh+3} ${cx-shH},${ySh} Z`,
     fill:col,opacity:.24,stroke:col,'stroke-width':2.15,'stroke-linejoin':'round'});
  // Hals + Kopf
  el(primary,'path',{class:'vitruv-neck',d:`M${cx-shH*.28},${ySh+1} L${cx-shH*.18},${yNeck} M${cx+shH*.28},${ySh+1} L${cx+shH*.18},${yNeck}`,...ink,'stroke-width':2.2});
  const headRy=Math.max(6,(yNeck-yCrown)/2), headRx=headRy*.78;
  el(primary,'ellipse',{class:'vitruv-head',cx,cy:(yNeck+yCrown)/2,rx:headRx,ry:headRy,fill:col,opacity:.16,stroke:col,'stroke-width':2.3});
  el(primary,'path',{class:'vitruv-pelvis',d:`M${cx-hipH},${yHip} Q${cx},${yHip+5} ${cx+hipH},${yHip}`,...ink,'stroke-width':2.4});
  // --- ZWEITE Pose (dünn): Beine gespreizt auf den Kreis, Arme angehoben auf den Kreis ---
  const legSpread=rad(23), footR={x:cx+R*Math.sin(legSpread), y:navelY+R*Math.cos(legSpread)};
  const footL={x:cx-R*Math.sin(legSpread), y:navelY+R*Math.cos(legSpread)};
  for(const F of [footR,footL]){ const sgn=Math.sign(F.x-cx)||1;
    const knee={x:(cx+F.x)/2+sgn*4,y:(yHip+F.y)/2};
    el(secondary,'path',{d:`M${cx+sgn*hipH*.58},${yHip} Q${knee.x},${knee.y-2} ${knee.x},${knee.y} Q${F.x-sgn*3},${F.y-3} ${F.x},${F.y}`,...faint});
    el(secondary,'circle',{cx:knee.x,cy:knee.y,r:1.25,fill:secondaryCol,opacity:.42}); }
  const armRaise=rad(38);
  for(const sgn of [1,-1]){
    const H2={x:cx+sgn*R*Math.sin(armRaise), y:navelY-R*Math.cos(armRaise)};
    const elbow={x:cx+sgn*(shH+arm*.5),y:ySh-arm*.35};
    el(secondary,'path',{d:`M${cx+sgn*shH},${ySh} Q${elbow.x-sgn*3},${elbow.y+2} ${elbow.x},${elbow.y} Q${H2.x-sgn*2},${H2.y+2} ${H2.x},${H2.y}`,...faint});
    el(secondary,'circle',{cx:elbow.x,cy:elbow.y,r:1.2,fill:secondaryCol,opacity:.42}); }
  // --- HAUPT-Pose (kräftig): Beine geschlossen zur Standlinie, Arme waagerecht zu den Quadratseiten ---
  for(const sgn of [1,-1]){
    const hipX=cx+sgn*hipH*.58, kneeX=cx+sgn*S*.045, ankleX=cx+sgn*S*.052, footX=cx+sgn*S*.075;
    el(primary,'path',{class:'vitruv-limb',d:`M${hipX},${yHip} Q${kneeX-sgn*2},${yKnee-2} ${kneeX},${yKnee} Q${ankleX},${yFoot-8} ${ankleX},${yFoot}`,...limb});
    el(primary,'line',{class:'vitruv-foot',x1:ankleX,y1:yFoot,x2:footX,y2:yFoot,...ink,'stroke-width':3.5});
    el(primary,'circle',{class:'vitruv-joint',cx:kneeX,cy:yKnee,r:1.75,...joint});
  }
  const elbowY=ySh+arm*0.06, handX=(r.wingspan/2)*sw;   // waagerechte Hand = halbe Spannweite
  for(const sgn of [1,-1]){
    const shoulderX=cx+sgn*shH, elbowX=cx+sgn*(shH+arm*0.5), handPosX=cx+sgn*handX;
    el(primary,'path',{class:'vitruv-limb',d:`M${shoulderX},${ySh} Q${elbowX-sgn*2},${elbowY-1} ${elbowX},${elbowY} Q${handPosX-sgn*2},${ySh+1} ${handPosX},${ySh}`,...limb});
    el(primary,'circle',{class:'vitruv-joint',cx:elbowX,cy:elbowY,r:1.75,...joint});
    el(primary,'line',{class:'vitruv-hand',x1:handPosX-sgn*3,y1:ySh,x2:handPosX+sgn*2,y2:ySh,...ink,'stroke-width':3.4});
  }
  // Label: abgeleitete Standhöhe + gemessene Spannweite
  txt(svg,cx,Hd-6,`${fmt(seg.height,0)} cm · Spannweite ${fmt(r.wingspan,0)} cm · ${fmt(r.weight,0)} kg`,{'text-anchor':'middle',fill:col,class:'vitruv-caption'});
}

/* ---- Datenbank (versioniertes Repository + Datei) ---- */
async function loadDB(){
  try{
    await repositoryWrite(rowerRepository,()=>{
      const loaded=rowerRepository.load();
      reportRepositoryLoad(loaded,'V2-Rudererdaten');
      if(loaded.ok&&loaded.migration?.migrated){
        rowerRepository.commitPendingMigration({expectedRevision:loaded.state.revision});
        announce(loaded.migration.recordIds.length
          ?`${loaded.migration.recordIds.length} Rudererprofile wurden atomar auf das aktuelle Schema migriert.`
          :'Der lokale Personenverlauf wurde atomar initialisiert; die Profilwerte blieben unverändert.');
      }
      if(canMigrateLegacy(loaded)&&rowerRepository.list().length===0){
        let candidates=[];
        const rawV2=storageAdapter.getItem('rudertrimm_rowers_v2');
        if(rawV2){
          const parsed=JSON.parse(rawV2);
          if(parsed?.kind!=='rudertrimm.rowers'||!Array.isArray(parsed.items)) throw new TypeError('Alte Profildatei hat kein gültiges Format.');
          candidates=parsed.items.map(item=>migrateRowerToCurrent(item).value);
        }else if(storageAdapter.getItem('rudertrimm_db')!==null){
          const legacy=JSON.parse(storageAdapter.getItem('rudertrimm_db'));
          if(Array.isArray(legacy)){
            const rejected=[];
            candidates=legacy.flatMap((item,index)=>{ try{ return [profileOf(migrate(item))]; }catch(error){ rejected.push({index,error:error.message}); return []; } });
            if(rejected.length) announce(`${rejected.length} ungültige alte Rudererprofile wurden übersprungen.`);
          }
        }else{
          candidates=legacyV1WorkspaceCandidate()?.rowers??[];
        }
        if(migrateCollection(rowerRepository,'rudertrimm.rowers',candidates,buildRowerDTO)){
          announce(`${candidates.length} Rudererprofile wurden in den versionierten V2-Speicher übernommen.`);
        }
      }
    });
  }catch(error){ console.error('Rudererprofile konnten nicht geladen werden',error); announce('Rudererprofile waren ungültig und wurden nicht geladen. Alte Speicherstände bleiben unverändert erhalten.'); }
  state.db=rowerRepository.list().map(record=>record.value);
}
function profileOf(r){
  return buildRowerDTO({
    externalRef:r.externalRef??null,
    name:cleanName(r.name,'Profil'),legLen:r.legLen,torsoLen:r.torsoLen,
    wingspan:r.wingspan,SB:r.SB,weight:r.weight,stemmX:r.stemmX,
  });
}
// Migration: alte Profile (Körpergröße + Feinjustage) → konkrete Maße
function migrate(p){
  if(!p||typeof p!=='object'||Array.isArray(p)) throw new TypeError('Profil muss ein Objekt sein');
  if(p.schemaVersion!=null) return migrateRowerToCurrent(p).value;
  if(p.legLen!=null) return buildRowerDTO({...p,externalRef:null});
  const H=p.hgt||185;
  return buildRowerDTO({externalRef:null,name:p.name||'Profil', legLen:Math.round(0.49*H), torsoLen:Math.round(0.51*H),
          wingspan:Math.round(H*1.01), SB:p.SB||40, weight:p.weight||80, stemmX:p.stemmX||42});
}
function applyProfile(seatId,p,{rowerRef=null,draftDirty=false}={}){
  const seat=state.seats.find(candidate=>candidate.id===seatId);
  if(!seat) throw new RangeError('Bootsplatz existiert nicht');
  const profile=profileOf(migrate(p));
  if(rowerRef&&state.seats.some(item=>item.id!==seatId&&item.rowerRef?.id===rowerRef.id)){
    throw new RangeError('Dieses Rudererprofil ist bereits einem anderen Platz zugeordnet.');
  }
  const assignment={
    schemaVersion:SCHEMA_VERSION,kind:'crewAssignment',seatId,trimId:seat.trimId,
    rowerRef:rowerRef?{...rowerRef}:null,rower:clone(profile),
  };
  seat.rowerRef=assignment.rowerRef?{...assignment.rowerRef}:null;
  state.crew=state.crew.filter(item=>item.seatId!==seatId);
  state.crew.push(assignment);
  state.crew.sort((left,right)=>state.seats.find(seat=>seat.id===left.seatId).position-state.seats.find(seat=>seat.id===right.seatId).position);
  ensureDraftState(seatId);
  profileDraftVersion[seatId]+=1;
  profileDraftDirty[seatId]=draftDirty;
  return assignment;
}
function canonicalizeRowerName(seatId){
  const assignment=assignmentFor(seatId);
  if(!assignment) return null;
  const seat=state.seats.find(candidate=>candidate.id===seatId);
  const previous=assignment.rower.name;
  assignment.rower.name=cleanName(previous,seat?.role==='stroke'?'Schlagprofil':`Ruderer Platz ${seat?.position??''}`);
  if(assignment.rower.name!==previous) markProfileDraftChanged(seatId);
  if(state.editSeatId===seatId) $('rowerName').value=assignment.rower.name;
  return assignment.rower.name;
}
function confirmProfileReplacement(seatId,message){
  return !profileDraftDirty[seatId]||confirm(`${message}\n\nUngespeicherte Rudererwerte dieses Platzes gehen sonst verloren.`);
}
function clearRowerSelection(){
  rowerSelection.clear();
  state.dbIdx=-1;
  const select=$('dbSelect');
  if(select){ select.value=''; select.title=''; }
  if($('dbUpdate')) $('dbUpdate').disabled=true;
  if($('dbDelete')) $('dbDelete').disabled=true;
}
function updateMasterPersonSelection(){
  const select=$('masterPersonSelect');
  if(!select) return;
  const selected=select.value?rowerRepository.select(select.value):{ok:false};
  $('masterPersonUse').disabled=!selected.ok||!activeSeat();
  $('masterPersonDelete').disabled=!selected.ok;
  $('masterPersonStatus').textContent=selected.ok
    ?`${cleanName(selected.record.value.name,'Profil')} · ${fmt(selected.record.value.legLen+selected.record.value.torsoLen,0)} cm · Revision ${selected.record.revision} · noch nicht zugeordnet`
    :`${rowerRepository.list().length} gespeicherte Personenprofile · Auswahl allein verändert keine Bootsbelegung.`;
}
function refreshMasterPersonSelect(){
  const select=$('masterPersonSelect');
  if(!select) return;
  const previous=select.value;
  const records=rowerRepository.list();
  replaceOptions(select,'— Person auswählen —',records.map(record=>({
    value:record.id,
    label:`${cleanName(record.value.name,'Profil')} · ${fmt(record.value.legLen+record.value.torsoLen,0)} cm · r${record.revision}`,
  })));
  select.value=records.some(record=>record.id===previous)?previous:'';
  updateMasterPersonSelection();
}
function refreshDBSelect(selectedId='',adoptRevision=false,selectionSeat=state.editSeatId){
  const records=rowerRepository.list();
  state.db=records.map(record=>record.value);
  replaceOptions($('dbSelect'),'— Datenbank wählen —',records.map(record=>({
    value:record.id,label:`${cleanName(record.value.name,'Profil')} · ${fmt(record.value.legLen+record.value.torsoLen,0)} cm · r${record.revision} · ${record.id.slice(0,6)}`,
  })));
  const assignedId=activeAssignment()?.rowerRef?.id??'';
  if(!selectedId) selectedId=assignedId;
  const selection=selectedId?rowerRepository.select(selectedId):{ok:false};
  $('dbSelect').value=selection.ok?selectedId:'';
  if(!selection.ok) clearRowerSelection();
  else if(adoptRevision&&assignmentFor(selectionSeat)?.rowerRef?.id===selection.record.id
      &&assignmentFor(selectionSeat)?.rowerRef?.revision===selection.record.revision){
    rowerSelection.adopt({id:selection.record.id,revision:selection.record.revision,context:selectionSeat});
    state.dbIdx=records.findIndex(record=>record.id===selection.record.id);
  }else if(adoptRevision){
    rowerSelection.clear();
    state.dbIdx=records.findIndex(record=>record.id===selection.record.id);
  }
  const writable=selection.ok&&rowerSelection.matches({
    id:selection.record.id,revision:selection.record.revision,context:state.editSeatId,
  });
  $('dbUpdate').disabled=!writable; $('dbDelete').disabled=!writable;
  refreshMasterPersonSelect();
  refreshHistoryEntities();
}
function sameRowerSelection(left,right){
  return left.id===right.id&&left.revision===right.revision&&left.context===right.context;
}
function applyCurrentConfig(config,{draftsDirty=false}={}){
  markWorkspaceMutation();
  applyBoat(config.boat,{resolveCrew:false});
  state.crew=clone(config.crew);
  state.editSeatId=state.seats.some(seat=>seat.id===config.editSeatId)?config.editSeatId:state.seats[0].id;
  state.referenceSeatId=state.seats.some(seat=>seat.id===config.referenceSeatId)?config.referenceSeatId:state.seats[0].id;
  state.mode=config.mode; state.heightRef=config.heightRef; state.kg=config.kg; state.t=config.t; state.recovery=config.recovery;
  for(const seat of state.seats){
    ensureDraftState(seat.id);
    const assignment=assignmentFor(seat.id);
    const linked=assignment?.rowerRef?rowerRepository.select(assignment.rowerRef.id):{ok:false};
    const exactStored=linked.ok
      &&linked.record.revision===assignment.rowerRef.revision
      &&JSON.stringify(profileOf(assignment.rower))===JSON.stringify(linked.record.value);
    profileDraftDirty[seat.id]=!!assignment&&(draftsDirty||!exactStored);
  }
}
function anyProfileDraftDirty(){ return Object.values(profileDraftDirty).some(Boolean); }
let demoRestorePoint=null;
// Capture once per demo session: switching between demos must not replace the
// original user draft with another demo. The snapshot stays in memory only.
function captureDemoRestorePoint(){
  if(demoRestorePoint) return demoRestorePoint;
  demoRestorePoint={
    config:currentConfigOf(),dirty,workspaceRevision:workspaceRevision.snapshot(),
    presentationMode:document.body.dataset.presentation==='details'?'details':'compact',
    activeVisualView,wasPlaying:playing,speed:$('speed').value,
    selectedBoatId,selectedBoatRevision,boatSelect:$('boatSelect').value,
    rowerSelection:rowerSelection.snapshot(),dbIdx:state.dbIdx,
    profileDraftDirty:{...profileDraftDirty},profileDraftVersion:{...profileDraftVersion},
  };
  return demoRestorePoint;
}
function showDemoIndicator(label){
  $('demoBadge').hidden=false; $('demoBadge').textContent=`Synthetische Demo · ${label}`;
  $('removeDemo').hidden=false; document.body.dataset.demo='synthetic';
}
function clearDemoIndicator(){
  $('demoBadge').hidden=true; $('demoBadge').textContent='Synthetische Demo';
  $('removeDemo').hidden=true; delete document.body.dataset.demo;
}
function endDemoSession(){
  if(!demoRestorePoint) return false;
  demoRestorePoint=null; clearDemoIndicator(); return true;
}
function loadTestielDemo(){
  const hasUnsaved=dirty||anyProfileDraftDirty();
  if(!confirmOverwrite('Die synthetische Demo „Testiel“ ersetzt die aktuellen Boot-, Ruderer- und Arbeitswerte.',hasUnsaved)) return false;
  captureDemoRestorePoint();
  const config=buildTestielDemoConfig();
  stopPlay();
  clearRowerSelection();
  refreshBoatSelect();
  applyCurrentConfig(config,{draftsDirty:true});
  lastPreset=config.boat.preset; lastBlade=config.boat.blade;
  buildControls(); updateRig(); updateMode(); setDirty(true); render();
  $('loadTestielDemo').focus();
  showDemoIndicator('Testiel · Einer');
  $('testielDemoNote').textContent='Demo „Testiel“ geladen – synthetisch; nichts wurde automatisch gespeichert.';
  return true;
}
$('loadTestielDemo').addEventListener('click',loadTestielDemo);
function loadComparisonDemo(){
  const hasUnsaved=dirty||anyProfileDraftDirty();
  if(!confirmOverwrite('Die synthetische Vergleichsdemo ersetzt die aktuellen Boot-, Ruderer- und Arbeitswerte.',hasUnsaved)) return false;
  captureDemoRestorePoint();
  const config=buildTestielComparisonDemoConfig();
  stopPlay();
  clearRowerSelection();
  refreshBoatSelect();
  applyCurrentConfig(config,{draftsDirty:true});
  lastPreset=config.boat.preset; lastBlade=config.boat.blade;
  buildControls(); updateRig(); updateMode(); setDirty(true); render();
  $('loadComparisonDemo').focus();
  showDemoIndicator('Testiel + Testiel 2 · 4x');
  $('testielDemoNote').textContent='Synthetische Vergleichsdemo geladen – noch nicht gespeichert.';
  return true;
}
$('loadComparisonDemo').addEventListener('click',loadComparisonDemo);
function restoreBeforeDemo(){
  if(!demoRestorePoint) return false;
  const previous=demoRestorePoint;
  try{
    const currentWorkspaceRevision=workspaceRevision.snapshot();
    const persistenceUnchanged=currentWorkspaceRevision.observedRevision===previous.workspaceRevision.observedRevision
      &&currentWorkspaceRevision.externalRevision===previous.workspaceRevision.externalRevision
      &&currentWorkspaceRevision.stale===previous.workspaceRevision.stale;
    stopPlay(); clearRowerSelection();
    applyCurrentConfig(previous.config,{draftsDirty:false});
    lastPreset=previous.config.boat.preset; lastBlade=previous.config.boat.blade;
    for(const key of Object.keys(profileDraftDirty)) delete profileDraftDirty[key];
    Object.assign(profileDraftDirty,previous.profileDraftDirty);
    for(const [seatId,version] of Object.entries(previous.profileDraftVersion)){
      profileDraftVersion[seatId]=Math.max(profileDraftVersion[seatId]??0,version+1);
    }
    const selected=previous.selectedBoatId?boatRepository.select(previous.selectedBoatId):{ok:false};
    const boatSelectionCurrent=selected.ok&&selected.record.revision===previous.selectedBoatRevision;
    refreshBoatSelect(boatSelectionCurrent?previous.boatSelect:'',boatSelectionCurrent);
    state.dbIdx=previous.dbIdx;
    buildControls(); updateRig(); updateMode(); updateCoxControl();
    $('speed').value=previous.speed; updateSpeed();
    setPresentationMode(previous.presentationMode);
    activateVisualView(previous.activeVisualView);
    render();
    if(previous.rowerSelection.id){
      refreshDBSelect(previous.rowerSelection.id,true,previous.rowerSelection.context);
    }else clearRowerSelection();
    dirty=persistenceUnchanged?previous.dirty:true;
    demoRestorePoint=null; clearDemoIndicator(); updateWorkspaceSaveState(); updateContext();
    if(previous.wasPlaying) startPlay({markDirty:false});
    dirty=persistenceUnchanged?previous.dirty:true; updateContext();
    $('loadComparisonDemo').focus();
    announce(!persistenceUnchanged
      ?'Synthetische Demo entfernt · vorherige Werte wiederhergestellt; ein externer Arbeitsstandkonflikt bleibt gesperrt und ungespeichert.'
      :boatSelectionCurrent||!previous.selectedBoatId
      ?'Synthetische Demo entfernt · vorheriger Arbeitsstand vollständig wiederhergestellt.'
      :'Synthetische Demo entfernt · vorherige Werte wiederhergestellt; die damalige Bootsdatenbank-Revision ist inzwischen veraltet.');
    return true;
  }catch(error){ reportError(error,'Vorheriger Arbeitsstand konnte nach der Demo nicht wiederhergestellt werden'); return false; }
}
$('removeDemo').addEventListener('click',restoreBeforeDemo);
// A profile write may finish after seat, selection or draft changed. Bind its
// result and clear dirty state only while every captured context still matches.
function finishProfileCommit(record,{saveSeat,draftVersion,selectionAtStart}){
  const selectionBeforeFinish=rowerSelection.snapshot();
  const selectedIdBeforeFinish=$('dbSelect').value;
  const policy=profileCommitPolicy({
    savedContext:saveSeat,
    activeContext:state.editSeatId,
    selectionUnchanged:sameRowerSelection(selectionAtStart,selectionBeforeFinish),
    savedVersion:draftVersion,
    currentVersion:profileDraftVersion[saveSeat],
  });
  if(policy.adoptSelection){
    applyProfile(saveSeat,record.value,{rowerRef:{id:record.id,revision:record.revision},draftDirty:false});
    refreshDBSelect(record.id,true,saveSeat);
    state.dbIdx=rowerRepository.list().findIndex(entry=>entry.id===record.id);
    setDirty(true);
  }else{
    refreshDBSelect(selectedIdBeforeFinish);
  }
  if(policy.clearDraft) profileDraftDirty[saveSeat]=false;
  renderSeatTabs();
  updateContext();
  return policy;
}
function assignStoredProfileToSeat(id,seatId=state.editSeatId){
  const selected=rowerRepository.select(id);
  if(!selected.ok){
    refreshDBSelect(activeAssignment()?.rowerRef?.id??'');
    announce('Zum Freigeben bitte „Platz freigeben“ verwenden; die Leerauswahl überschreibt nichts.');
    return false;
  }
  const seat=state.seats.find(candidate=>candidate.id===seatId);
  if(!seat||seat.id!==state.editSeatId){
    announce('Der Zielplatz hat sich geändert. Profil bitte für den jetzt aktiven Platz erneut auswählen.');
    return false;
  }
  const previous=rowerSelection.snapshot();
  if(!confirmProfileReplacement(seat.id,'Das gewählte Profil ersetzt Name und Körpermaße des aktiven Platzes; sein Trimmprofil bleibt erhalten')){
    refreshDBSelect(previous.id);
    return false;
  }
  try{
    applyProfile(seat.id,selected.record.value,{rowerRef:{id:selected.record.id,revision:selected.record.revision}});
    refreshDBSelect(selected.record.id,true,seat.id);
    state.dbIdx=rowerRepository.list().findIndex(record=>record.id===selected.record.id);
    buildControls(); renderSeatTabs(); setDirty(); render();
    announce(`${cleanName(selected.record.value.name,'Profil')} wurde ${seatLabel(seat)} zugeordnet · Arbeitsstand noch speichern.`);
    return true;
  }catch(error){
    refreshDBSelect(previous.id||(activeAssignment()?.rowerRef?.id??''));
    reportError(error,'Rudererprofil konnte dem Platz nicht zugeordnet werden');
    return false;
  }
}
$('dbSelect').addEventListener('change',e=>{
  e.target.title='';
  assignStoredProfileToSeat(e.target.value);
});
$('masterPersonSelect').addEventListener('change',updateMasterPersonSelection);
$('masterPersonUse').addEventListener('click',()=>{
  if(assignStoredProfileToSeat($('masterPersonSelect').value)) $('dbSelect').focus();
});
$('masterPersonManage').addEventListener('click',()=>{
  setPresentationMode('details');
  $('dbSelect').focus();
  $('dbSelect').scrollIntoView({block:'center'});
});
$('masterPersonDelete').addEventListener('click',async event=>{
  const selected=rowerRepository.select($('masterPersonSelect').value);
  if(!selected.ok){ updateMasterPersonSelection(); return; }
  await deleteStoredRowerProfile({
    id:selected.record.id,
    expectedRecordRevision:selected.record.revision,
    trigger:event.currentTarget,
  });
});
$('seatCreateDraft').addEventListener('click',()=>{
  const seat=activeSeat();
  if(!seat) return;
  if(!confirmProfileReplacement(seat.id,'Ein neues ungespeichertes Profil ersetzt die aktuelle Zuordnung dieses Platzes')) return;
  const position=seat.position;
  applyProfile(seat.id,mkRower(`Neues Profil Platz ${position}`,{stemmX:seat.stemmX}),{draftDirty:true});
  clearRowerSelection();
  setDirty(); setPresentationMode('details'); buildControls(); render();
  $('rowerName').focus(); $('rowerName').select();
  announce(`${seatLabel(seat)}: neues Profil angelegt · Maße prüfen und bewusst speichern.`);
});
$('seatUnassign').addEventListener('click',()=>{
  const seat=activeSeat(), assignment=activeAssignment();
  if(!seat||(!assignment&&!seat.rowerRef)) return;
  ensureDraftState(seat.id);
  if(profileDraftDirty[seat.id]&&!confirm('Ungespeicherte Profiländerungen dieses Platzes verwerfen und den Platz freigeben?')) return;
  state.crew=state.crew.filter(item=>item.seatId!==seat.id);
  seat.rowerRef=null;
  profileDraftDirty[seat.id]=false; profileDraftVersion[seat.id]+=1;
  if(!state.seats.some(candidate=>assignmentFor(candidate.id))) stopPlay();
  clearRowerSelection(); setDirty(); buildControls(); render();
  announce(`${seatLabel(seat)} ist frei. Das gespeicherte Körperprofil wurde nicht gelöscht.`);
});
$('dbSaveAs').addEventListener('click',async()=>{ try{
  const saveSeat=state.editSeatId;
  canonicalizeRowerName(saveSeat);
  const assignment=assignmentFor(saveSeat);
  if(!assignment) throw new TypeError('Zuerst ein Profil für den aktiven Platz anlegen.');
  const value=profileOf(assignment.rower);
  const draftVersion=profileDraftVersion[saveSeat];
  const selectionAtStart=rowerSelection.snapshot();
  const record=await repositoryWrite(rowerRepository,()=>rowerRepository.create(value,{expectedRevision:rowerRepository.snapshot().revision}));
  const policy=finishProfileCommit(record,{saveSeat,draftVersion,selectionAtStart});
  announce(policy.adoptSelection?'Rudererprofil versioniert gespeichert.':'Rudererprofil gespeichert; die inzwischen aktive Auswahl blieb unverändert.');
}catch(error){ reportError(error,'Rudererprofil konnte nicht gespeichert werden'); } });
$('dbUpdate').addEventListener('click',async()=>{
  const id=$('dbSelect').value, selected=rowerRepository.select(id);
  if(!selected.ok||!rowerSelection.matches({id,revision:selected.record.revision,context:state.editSeatId})) return;
  const observed=rowerSelection.snapshot();
  try{
    const saveSeat=state.editSeatId;
    canonicalizeRowerName(saveSeat);
    const assignment=assignmentFor(saveSeat);
    if(!assignment) throw new TypeError('Aktiver Platz hat kein Profil.');
    const value=profileOf(assignment.rower);
    const draftVersion=profileDraftVersion[saveSeat];
    const selectionAtStart=observed;
    const updated=await repositoryWrite(rowerRepository,()=>rowerRepository.update(id,value,{
      expectedRevision:rowerRepository.snapshot().revision,
      expectedRecordRevision:observed.revision,
    }));
    const policy=finishProfileCommit(updated,{saveSeat,draftVersion,selectionAtStart});
    announce(policy.adoptSelection?'Rudererprofil als neue Revision gespeichert.':'Rudererprofil aktualisiert; die inzwischen aktive Auswahl blieb unverändert.');
  }catch(error){ reportError(error,'Rudererprofil konnte nicht überschrieben werden'); } });
function storedRowerReferences(id){
  const savedWorkspace=workspaceRepository.get();
  return [...new Set([
    ...state.seats.filter(seat=>seat.rowerRef?.id===id).map(seat=>`aktueller ${seatLabel(seat)}`),
    ...(savedWorkspace?.boat?.seats??[]).filter(seat=>seat.rowerRef?.id===id)
      .map(seat=>`gespeicherter Arbeitsstand, ${seatLabel(seat)}`),
    ...boatRepository.list().flatMap(record=>record.value.seats
      .filter(seat=>seat.rowerRef?.id===id)
      .map(seat=>`Boot „${cleanName(record.value.name,'Boot')}“, ${seatLabel(seat)}`)),
  ])];
}
// Call only inside the owning workspace/boat → rower lock order. A waiting save
// must recheck tombstoned ids under the same locks so it cannot reintroduce a
// reference to a profile that privacy deletion has already retired.
function assertNoRetiredRowerReferences(subject){
  const seats=Array.isArray(subject?.boat?.seats)
    ?subject.boat.seats
    :Array.isArray(subject?.seats)?subject.seats:[];
  const retiredIds=new Set(rowerRepository.reservedIds()
    .filter(recordId=>!rowerRepository.select(recordId).ok));
  const retiredReference=seats.find(seat=>seat.rowerRef&&retiredIds.has(seat.rowerRef.id));
  if(!retiredReference) return;
  const error=new Error(`${seatLabel(retiredReference)} verweist auf ein inzwischen datenschutzkonform gelöschtes Profil. Platz freigeben oder ein aktuelles Profil zuordnen.`);
  error.code='profile-reference-retired';
  throw error;
}
async function deleteStoredRowerProfile({id,expectedRecordRevision,trigger=null}){
  const selected=rowerRepository.select(id);
  if(!selected.ok||selected.record.revision!==expectedRecordRevision) return false;
  const name=cleanName(selected.record.value.name,'Profil');
  const references=storedRowerReferences(id);
  if(references.length){
    const message=`Profil ist noch zugeordnet: ${references.slice(0,3).join('; ')}. Erst Plätze freigeben, dann löschen.`;
    announce(message);
    if($('masterPersonSelect').value===id) $('masterPersonStatus').textContent=message;
    return false;
  }
  // Human confirmation is deliberately outside every repository lock.
  if(!confirm(`Profil „${name}“ wirklich datenschutzkonform löschen?`)) return false;
  const focusAtStart=document.activeElement===trigger;
  try{
    // Fixed lock order: workspace, boats, then rowers. Holding every source of
    // rower references closes the check/delete gap without keeping confirmation in a lock.
    await repositoryWrite(workspaceRepository,()=>repositoryWrite(boatRepository,()=>repositoryWrite(rowerRepository,()=>{
      const live=rowerRepository.select(id);
      if(!live.ok) throw new NoSelectionError('Profil wurde inzwischen gelöscht.');
      const liveReferences=storedRowerReferences(id);
      if(liveReferences.length){
        const error=new Error('Profil wurde inzwischen einem Bootsplatz zugeordnet. Zuordnung zuerst lösen.');
        error.code='profile-in-use';
        throw error;
      }
      return rowerRepository.delete(id,{
        expectedRevision:rowerRepository.snapshot().revision,
        expectedRecordRevision,
      });
    })));
    const dbSelection=$('dbSelect').value;
    const masterSelection=$('masterPersonSelect').value;
    if(dbSelection===id) state.dbIdx=-1;
    refreshDBSelect(dbSelection===id?'':dbSelection);
    if(focusAtStart&&document.activeElement===trigger&&masterSelection===id){
      $('masterPersonSelect').focus();
    }
    announce(`${name} datenschutzkonform gelöscht.`);
    return true;
  }catch(error){
    reportError(error,'Rudererprofil konnte nicht gelöscht werden');
    return false;
  }
}
$('dbDelete').addEventListener('click',async()=>{
  const id=$('dbSelect').value, selected=rowerRepository.select(id);
  if(!selected.ok||!rowerSelection.matches({id,revision:selected.record.revision,context:state.editSeatId})) return;
  await deleteStoredRowerProfile({id,expectedRecordRevision:selected.record.revision,trigger:$('dbDelete')});
});
$('dbExport').addEventListener('click',()=>downloadJson(rowerRepository.exportEnvelope(),'rudertrimm-v2-rudererprofile.json'));
$('dbImport').addEventListener('click',()=>$('dbFile').click());
$('dbFile').addEventListener('change',async e=>{ const f=e.target.files[0]; e.target.value=''; if(!f) return;
  try{
    if(f.size>1_000_000) throw new RangeError('Datei ist größer als 1 MB');
    const text=await f.text();
    const importOptions={
      repository:rowerRepository,text,validateRecord:validateRower,builder:buildRowerDTO,
      migrateRecord:migrateRowerToCurrent,
      migrateLegacyImport:legacyCollectionImportMigrator(migrateRowerToCurrent),
    };
    const approvedPreview=previewCollectionImport(importOptions);
    if(!confirmCollectionImport(approvedPreview)){ announce('Profilimport abgebrochen.'); return; }
    const result=await repositoryWrite(rowerRepository,()=>mergeCollectionImport({
      ...importOptions,approve:fresh=>approveFreshImportPreview(approvedPreview,fresh),
    }));
    state.dbIdx=-1; refreshDBSelect();
    announce(`${result.added} Rudererprofile atomar importiert${result.duplicatesSkipped?` · ${result.duplicatesSkipped} Dubletten übersprungen`:''}${result.migrated?` · ${result.migrated} Datensätze auf das aktuelle Schema migriert`:''}${result.remapped?` · ${result.remapped} ID-Konflikte aufgelöst`:''}.`);
  }catch(error){ reportError(error,'Profilimport abgelehnt'); }
});

const QUICK_PERSON_FIELDS=Object.freeze([
  {id:'quickPersonLegLen',key:'legLen',min:RANGES.rower.legLen[0],max:RANGES.rower.legLen[1],step:1},
  {id:'quickPersonTorsoLen',key:'torsoLen',min:RANGES.rower.torsoLen[0],max:RANGES.rower.torsoLen[1],step:1},
  {id:'quickPersonWingspan',key:'wingspan',min:RANGES.rower.wingspan[0],max:RANGES.rower.wingspan[1],step:1},
  {id:'quickPersonShoulder',key:'SB',min:RANGES.rower.SB[0],max:RANGES.rower.SB[1],step:1},
  {id:'quickPersonWeight',key:'weight',min:RANGES.rower.weight[0],max:RANGES.rower.weight[1],step:1},
]);
let personQuickEditContext=null, boatQuickEditContext=null;
function setQuickEditError(id,message=''){
  const error=$(id);
  error.hidden=!message;
  error.textContent=message;
}
function readQuickNumber(field){
  const input=$(field.id);
  const message=numericDraftError(input.value,field.min,field.max,field.step);
  input.setAttribute('aria-invalid',String(Boolean(message)));
  return message?{ok:false,message}:{ok:true,value:Number(input.value)};
}
function clearQuickFieldErrors(ids){
  for(const id of ids) $(id).setAttribute('aria-invalid','false');
}
function updateQuickPersonHeight(){
  const leg=Number($('quickPersonLegLen').value), torso=Number($('quickPersonTorsoLen').value);
  $('quickPersonHeight').textContent=Number.isFinite(leg)&&Number.isFinite(torso)
    ?`Abgeleitete Körpergröße: ${fmt(leg+torso,0)} cm (Bein- + Rumpflänge)`
    :'Abgeleitete Körpergröße: gültige Bein- und Rumpflänge erforderlich.';
}
function openPersonQuickEdit(){
  const seat=activeSeat(), assignment=activeAssignment();
  if(!seat||!assignment){ announce('Zuerst dem aktiven Platz ein Profil zuordnen oder neu anlegen.'); return false; }
  ensureDraftState(seat.id);
  personQuickEditContext={
    seatId:seat.id,trimId:seat.trimId,assignment,
    draftVersion:profileDraftVersion[seat.id],changeVersion:workspaceChangeVersion,
    opener:document.activeElement,
  };
  $('quickPersonName').value=assignment.rower.name;
  for(const field of QUICK_PERSON_FIELDS) $(field.id).value=String(assignment.rower[field.key]);
  clearQuickFieldErrors(['quickPersonName',...QUICK_PERSON_FIELDS.map(field=>field.id)]);
  setQuickEditError('personQuickEditError');
  updateQuickPersonHeight();
  $('personQuickEditDialog').showModal();
  $('quickPersonName').focus();
  return true;
}
function applyPersonQuickEdit(){
  const context=personQuickEditContext;
  const seat=context?state.seats.find(candidate=>candidate.id===context.seatId):null;
  const assignment=context?assignmentFor(context.seatId):null;
  if(!context||!seat||seat.id!==state.editSeatId||seat.trimId!==context.trimId
      ||assignment!==context.assignment||profileDraftVersion[context.seatId]!==context.draftVersion
      ||workspaceChangeVersion!==context.changeVersion){
    setQuickEditError('personQuickEditError','Der aktive Platz oder Arbeitsstand hat sich geändert. Dialog schließen und die Bearbeitung neu starten.');
    return false;
  }
  const name=cleanOptionalName($('quickPersonName').value);
  $('quickPersonName').setAttribute('aria-invalid',String(!name));
  const values={}, errors=[];
  if(!name) errors.push('Name oder Pseudonym ist erforderlich.');
  for(const field of QUICK_PERSON_FIELDS){
    const result=readQuickNumber(field);
    if(result.ok) values[field.key]=result.value;
    else errors.push(`${$(`${field.id}`).labels?.[0]?.firstChild?.textContent?.trim()||field.key}: ${result.message}`);
  }
  if(errors.length){ setQuickEditError('personQuickEditError',errors.join(' ')); return false; }
  try{
    const candidate=profileOf({...assignment.rower,name,...values});
    applyProfile(context.seatId,candidate,{rowerRef:assignment.rowerRef,draftDirty:true});
    setDirty(); buildControls(); render();
    $('personQuickEditDialog').close('apply');
    announce(`${name} im Arbeitsstand geändert · gespeicherte Stammdaten bleiben bis zum bewussten Überschreiben unverändert.`);
    return true;
  }catch(error){ setQuickEditError('personQuickEditError',`Eingaben konnten nicht übernommen werden: ${error.message}`); return false; }
}
function openBoatQuickEdit(){
  const seat=activeSeat();
  if(!seat){ announce('Zuerst ein Boot mit realem Platz wählen.'); return false; }
  boatQuickEditContext={
    seatId:seat.id,trimId:seat.trimId,seat,
    changeVersion:workspaceChangeVersion,selectedBoatId,selectedBoatRevision,
    opener:document.activeElement,
  };
  const [ihMin,ihMax]=RANGES[state.rig].IH;
  $('quickBoatName').value=cleanName($('boatName').value,'Ungespeichertes Boot');
  $('quickBoatInboard').min=String(ihMin); $('quickBoatInboard').max=String(ihMax);
  $('quickBoatInboard').value=String(seat.IH);
  $('quickBoatFootboard').value=String(seat.stemmX);
  clearQuickFieldErrors(['quickBoatName','quickBoatInboard','quickBoatFootboard']);
  setQuickEditError('boatQuickEditError');
  $('boatQuickEditDialog').showModal();
  $('quickBoatName').focus();
  return true;
}
function applyBoatQuickEdit(){
  const context=boatQuickEditContext;
  const seat=context?state.seats.find(candidate=>candidate.id===context.seatId):null;
  if(!context||!seat||seat!==context.seat||seat.id!==state.editSeatId||seat.trimId!==context.trimId
      ||workspaceChangeVersion!==context.changeVersion||selectedBoatId!==context.selectedBoatId
      ||selectedBoatRevision!==context.selectedBoatRevision){
    setQuickEditError('boatQuickEditError','Boot, Platz oder Arbeitsstand hat sich geändert. Dialog schließen und die Bearbeitung neu starten.');
    return false;
  }
  const name=cleanOptionalName($('quickBoatName').value);
  $('quickBoatName').setAttribute('aria-invalid',String(!name));
  const [ihMin,ihMax]=RANGES[state.rig].IH;
  const ih=readQuickNumber({id:'quickBoatInboard',min:ihMin,max:ihMax,step:.5});
  const fa=readQuickNumber({id:'quickBoatFootboard',min:RANGES.rower.stemmX[0],max:RANGES.rower.stemmX[1],step:.5});
  const errors=[];
  if(!name) errors.push('Bootsname ist erforderlich.');
  if(!ih.ok) errors.push(`Innenhebel: ${ih.message}`);
  if(!fa.ok) errors.push(`Stemmbrettposition: ${fa.message}`);
  if(errors.length){ setQuickEditError('boatQuickEditError',errors.join(' ')); return false; }
  try{
    const current=boatOf();
    const candidate=buildBoatDTO({...current,name,seats:current.seats.map(item=>item.id===seat.id?{...item,IH:ih.value,stemmX:fa.value}:item)});
    const validatedSeat=candidate.seats.find(item=>item.id===seat.id);
    $('boatName').value=candidate.name;
    seat.IH=validatedSeat.IH; seat.stemmX=validatedSeat.stemmX;
    setDirty(); buildControls(); render();
    $('boatQuickEditDialog').close('apply');
    announce(`${candidate.name}, ${seatLabel(seat)} im Arbeitsstand geändert · gespeicherte Bootsrevision bleibt bis zum bewussten Überschreiben unverändert.`);
    return true;
  }catch(error){ setQuickEditError('boatQuickEditError',`Eingaben konnten nicht übernommen werden: ${error.message}`); return false; }
}
function restoreDialogFocus(context){
  const opener=context?.opener;
  if(opener&&typeof opener.focus==='function'&&opener.isConnected!==false) opener.focus();
}
$('quickEditPerson').addEventListener('click',openPersonQuickEdit);
$('quickPersonLegLen').addEventListener('input',updateQuickPersonHeight);
$('quickPersonTorsoLen').addEventListener('input',updateQuickPersonHeight);
$('quickPersonApply').addEventListener('click',applyPersonQuickEdit);
$('quickPersonCancel').addEventListener('click',()=>$('personQuickEditDialog').close('cancel'));
$('personQuickEditDialog').addEventListener('close',()=>{ const context=personQuickEditContext; personQuickEditContext=null; restoreDialogFocus(context); });
$('quickEditBoat').addEventListener('click',openBoatQuickEdit);
$('quickBoatApply').addEventListener('click',applyBoatQuickEdit);
$('quickBoatCancel').addEventListener('click',()=>$('boatQuickEditDialog').close('cancel'));
$('boatQuickEditDialog').addEventListener('close',()=>{ const context=boatQuickEditContext; boatQuickEditContext=null; restoreDialogFocus(context); });
// „Weiterschalten": Profil am aktiven realen Bootsplatz durch die Datenbank blättern.
function stepActiveRower(dir){
  const records=rowerRepository.list();
  if(!records.length){ alert('Datenbank ist leer — erst Profile speichern.'); return; }
  const seat=activeSeat();
  if(!seat||!confirmProfileReplacement(seat.id,'Das nächste Datenbankprofil ersetzt Name und Körpermaße des aktiven Platzes')) return;
  const base=state.dbIdx<0?(dir>0?-1:0):state.dbIdx;
  const nextIndex=(base+dir+records.length)%records.length;
  const record=records[nextIndex];
  applyProfile(seat.id,record.value,{rowerRef:{id:record.id,revision:record.revision}});
  refreshDBSelect(record.id,true,seat.id);
  state.dbIdx=nextIndex;
  setDirty(); buildControls(); renderSeatTabs(); render();
}
$('rPrev').addEventListener('click',()=>stepActiveRower(-1));
$('rNext').addEventListener('click',()=>stepActiveRower(1));

/* ================= Render & Animation ================= */
const SEATGAP=128;   // Riggerabstand der Sitze (cm), Darstellung
function buildSeats(){
  const ss=state.strokeSide;
  const reference=state.seats.find(seat=>seat.id===state.referenceSeatId&&runtimeForSeat(seat));
  const active=state.seats.find(seat=>seat.id===state.editSeatId&&runtimeForSeat(seat));
  const fallbackOther=state.seats.find(seat=>seat.id!==reference?.id&&runtimeForSeat(seat));
  const chosen=[];
  for(const seat of [reference,active,active?.id===reference?.id?fallbackOther:null]){
    if(seat&&!chosen.some(candidate=>candidate.id===seat.id)) chosen.push(seat);
    if(chosen.length===2) break;
  }
  if(!chosen.length){
    const first=state.seats.find(seat=>runtimeForSeat(seat));
    if(first) chosen.push(first);
  }
  const defs=chosen.map(seat=>{
    const r=runtimeForSeat(seat);
    return {
      seatId:seat.id,position:seat.position,r,
      ox:-(state.seats.length-seat.position)*SEATGAP,
      ref:seat.id===state.referenceSeatId,
      side:ss*((state.seats.length-seat.position)%2===0?1:-1),
      name:r.name,
      resolution:assignmentResolution(seat),
    };
  });
  // Jeder Platz nutzt sein Rigg, aber dieselbe Kausalität: Rigg-Ziel bleibt Vergleichswert;
  // Fa + Körper bestimmen die gecachte Ist-Auslage, die 3D-Prüfung bleibt Sicherheitsnetz.
  return defs.map(d=>{
    const catchSolution=resolveCatchAngle(d.r);
    const effPhiA=catchSolution.poseAngleDeg;
    const dv=derived(d.r,effPhiA);
    const b=solveBody(dv,state.t,state.recovery,d.r,effPhiA); b.arms=solveArms(dv,b,d.r);
    if(b.arms.some(arm=>!arm.reachable)) b.overreach=true;
    return {...d,dv,b,catchSolution,reachAvailable:catchSolution.reachable,
      capped:!catchSolution.naturalResolved||catchSolution.limitedByReach||Math.abs(effPhiA-state.phiA)>1.5}; });
}
function render(){
  const seats=buildSeats();
  const primary=seats.find(x=>x.seatId===state.editSeatId) || seats.find(x=>x.ref) || seats[0];
  syncControls(); renderSeatTabs();
  if(seats.length===0&&playing) stopPlay();
  $('play').disabled=seats.length===0;
  if(!primary){
    renderEmptyModelState();
    renderActionPlan();
    renderWorkflowGuide();
    renderPhases();
    $('crewScope').textContent=crewScopeLabel($('preset').value);
    updateContext();
    return;
  }
  const dv=primary.dv;
  const refs=bodyRefs(dv,primary.r);
  renderStatus(dv,refs,primary.r,primary.catchSolution,seats);
  renderActionPlan();
  renderWorkflowGuide();
  renderCompactSummaries(dv,primary.r,primary.catchSolution,state.seats.find(seat=>seat.id===primary.seatId));
  if(!activeAssignment()){
    $('compactProfileSummary').textContent=`${seatLabel(activeSeat())} ist frei · Körperrechnung aus · Visualisierung zeigt ${seatLabel(state.seats.find(seat=>seat.id===primary.seatId))}.`;
    $('cards').prepend(statusCardElement({n:'Aktiver Platz',v:'Profil erforderlich',st:'info',statusText:'Nicht berechenbar',rng:'Profil wählen oder neu anlegen; keine Ersatzperson wird berechnet'}));
  }
  if(primary.resolution==='snapshot-missing'||primary.resolution==='stale'){
    $('cards').prepend(statusCardElement({
      n:'Profilverknüpfung',
      v:primary.resolution==='stale'?'Snapshot veraltet':'Datenbankeintrag fehlt',
      st:'bad',
      rng:'Berechnung nutzt den gespeicherten Snapshot · Profil bewusst neu zuordnen oder Platz freigeben',
    }));
  }
  renderForceCompare(seats);
  if(!isFolded('rower')){
    if(activeRower()) renderVitruv(activeRower());
    else $('vitruv').replaceChildren(Object.assign(document.createElement('p'),{className:'hint',textContent:'Für diesen freien Platz gibt es noch keine Proportionsgrafik.'}));
  }
  renderTop(dv,seats,primary);
  renderCross(dv,primary);
  renderSide(dv,seats,primary,refs);
  renderPhases();
  $('crewScope').textContent=crewScopeLabel($('preset').value);
  updateContext();
}
function renderEmptyModelState(){
  $('cards').replaceChildren(statusCardElement({
    n:'Körperrechnung',v:'Profil erforderlich',st:'info',statusText:'Nicht berechenbar',
    rng:'Ursache: kein belegter Platz · nächster Schritt: Profil wählen oder neu anlegen',
  }));
  $('chips').replaceChildren(chipElement({n:'Datenqualität',v:'Keine Person erfunden · Visualisierung bleibt bis zur bewussten Zuordnung leer',st:'info'}));
  $('compactProfileSummary').textContent=`${seatLabel(activeSeat())} ist frei · Körpermaße fehlen.`;
  $('compactRigSummary').textContent='Boot und Trimmplatz sind angelegt; Körper-, Reichweiten- und Mannschaftsvergleich starten erst nach einer Profilzuordnung.';
  $('forceCmp').style.display='none';
  $('vitruv').replaceChildren(Object.assign(document.createElement('p'),{className:'hint',textContent:'Profil zuordnen, um die Proportionsgrafik zu sehen.'}));
  for(const [hostId,label] of [['vTop','Draufsicht'],['vSide','Seitenansicht'],['vCross','Querschnitt']]){
    const svg=newSVG($(hostId),900,260,`${label}: Profil erforderlich`,`Leerer ${label}-Prüfstand ohne erfundene Person.`);
    txt(svg,450,118,label,{'text-anchor':'middle',fill:'#f2e9d8','font-size':18,'font-weight':750});
    txt(svg,450,148,'Profil wählen oder neu anlegen · Körperrechnung bleibt bis dahin aus',{'text-anchor':'middle',fill:'#a8b6ae','font-size':12});
  }
}
let playing=false, raf=null, animationProgress=0, lastAnimationFrameTime=null;
function stopPlay(){
  if(!playing) return;
  playing=false; cancelAnimationFrame(raf);
  lastAnimationFrameTime=null;
  $('play').classList.remove('on'); $('play').textContent='▶ Durchzug starten';
  $('play').setAttribute('aria-pressed','false');
}
function startPlay({markDirty=true}={}){
  if(playing) return true;
  if(motionPreference.matches){ announce('Animation ist wegen „Bewegung reduzieren“ deaktiviert.'); return; }
  if($('play').disabled) return false;
  if(markDirty) setDirty();
  // Start/Resume übernimmt die sichtbare manuelle oder gespeicherte Pose. Danach
  // zählt nur die verstrichene Framezeit; Tempoänderungen verschieben die Zeitbasis nicht.
  animationProgress=cycleProgressFromStrokePose({t:state.t,recovery:state.recovery});
  lastAnimationFrameTime=performance.now();
  playing=true;
  $('play').classList.add('on'); $('play').textContent='⏸ Stopp';
  $('play').setAttribute('aria-pressed','true');
  raf=requestAnimationFrame(step);
  return true;
}
$('play').addEventListener('click',()=>{
  if(playing){ stopPlay(); return; }
  startPlay();
});
const motionPreference=window.matchMedia('(prefers-reduced-motion: reduce)');
function preferredScrollBehavior(){ return motionPreference.matches?'auto':'smooth'; }
const handleMotionPreference=event=>{ if(event.matches) stopPlay(); };
if(typeof motionPreference.addEventListener==='function') motionPreference.addEventListener('change',handleMotionPreference);
else motionPreference.addListener?.(handleMotionPreference);
function updateSpeed(){
  const speed=parseFloat($('speed').value);
  $('speedV').textContent=fmt(speed,2)+'×';
  $('speed').setAttribute('aria-valuetext',`${fmt(speed,2)}-fache Geschwindigkeit`);
}
$('speed').addEventListener('input',updateSpeed);
updateSpeed();
$('boatName').addEventListener('input',e=>{ e.target.value=limitName(e.target.value); setDirty(); updateContext(); });
$('coxName').addEventListener('input',e=>{ e.target.value=limitName(e.target.value); setDirty(); });
function step(now){
  if(!playing) return;
  const elapsed=lastAnimationFrameTime===null?0:Math.max(0,now-lastAnimationFrameTime);
  lastAnimationFrameTime=now;
  animationProgress=advanceStrokeCycle(animationProgress,elapsed,parseFloat($('speed').value));
  const pose=strokePoseAtCycleProgress(animationProgress);
  state.t=pose.t; state.recovery=pose.recovery;
  render();
  raf=requestAnimationFrame(step);
}

/* ================= Speichern / Laden / Export / Reset ================= */
function currentConfigOf(){
  return buildCurrentConfigDTO({
    boat:boatOf(),
    boatRef:selectedBoatId&&selectedBoatRevision!==null?{id:selectedBoatId,revision:selectedBoatRevision}:null,
    crew:state.crew.map(assignment=>({
      seatId:assignment.seatId,trimId:assignment.trimId,
      rowerRef:assignment.rowerRef?{...assignment.rowerRef}:null,
      rower:profileOf(assignment.rower),
    })),
    editSeatId:state.editSeatId,referenceSeatId:state.referenceSeatId,
    mode:state.mode,heightRef:state.heightRef,
    kg:state.kg,t:state.t,recovery:state.recovery,
  });
}
function scrubSingleSeatWorkspaceInLock(){
  const stored=workspaceRepository.get();
  const beforeRevision=workspaceRepository.snapshot().revision;
  if(!hasHiddenSingleSeatProfile(stored)) return Object.freeze({changed:false,revision:beforeRevision});
  const minimized=minimizeHiddenSingleSeatProfile(stored);
  workspaceRepository.save(minimized.config,{expectedRevision:beforeRevision});
  return Object.freeze({changed:true,revision:workspaceRepository.snapshot().revision});
}
async function loadWorkspaceStore(){
  try{
    await repositoryWrite(workspaceRepository,()=>{
      const loaded=workspaceRepository.load();
      reportRepositoryLoad(loaded,'Der V2-Arbeitsstand');
      if(loaded.ok&&loaded.migration?.migrated){
        workspaceRepository.commitPendingMigration({expectedRevision:loaded.state.revision});
        announce(loaded.migration.workspace
          ?'Der Arbeitsstand wurde atomar auf reale Sitzplätze migriert; zusätzliche Plätze bleiben bewusst frei.'
          :'Der lokale Speichervertrag des Arbeitsstands wurde atomar aktualisiert; Fachwerte blieben unverändert.');
      }
      const allowLegacyMigration=canMigrateLegacy(loaded);
      const scrubbed=scrubSingleSeatWorkspaceInLock();
      if(scrubbed.changed){
        announce('Veraltete versteckte Zweitplatzdaten wurden aus dem gespeicherten Einer-Arbeitsstand entfernt.');
      }
      if(allowLegacyMigration&&workspaceRepository.get()===null){
        const legacyRaw=storageAdapter.getItem('rudertrimm_current_v2');
        if(legacyRaw){
          const parsed=JSON.parse(legacyRaw);
          if(parsed?.kind!=='rudertrimm.current-config'||!parsed.config) throw new TypeError('Alter Arbeitsstand hat kein gültiges Format.');
          const canonicalLegacy=migrateCurrentConfigToCurrent(parsed.config).value;
          workspaceRepository.save(canonicalLegacy,{expectedRevision:workspaceRepository.snapshot().revision});
          announce('Der bisherige V2-Arbeitsstand wurde kanonisch und datenminimiert in den getrennten Workspace-Speicher übernommen.');
        }else{
          const candidate=legacyV1WorkspaceCandidate();
          if(candidate){
            workspaceRepository.save(candidate.workspace,{expectedRevision:workspaceRepository.snapshot().revision});
            announce('Der V1-Arbeitsstand wurde atomar auf reale Sitzplätze migriert; eingebettete Datenbanken bleiben strikt getrennt.');
          }
        }
      }
    });
  }catch(error){
    console.error('Arbeitsstand konnte nicht initialisiert werden',error);
    reportError(error,'Arbeitsstand konnte nicht vollständig initialisiert oder datenminimiert werden');
  }
  workspaceViewState=workspaceRepository.get()===null?'new':'available';
  workspaceRevision.adopt(workspaceRepository.snapshot().revision);
  updateWorkspaceSaveState();
}
function updateWorkspaceSaveState(){
  const policy=workspaceSavePolicy({viewState:workspaceViewState,canCommit:workspaceRevision.snapshot().canCommit});
  const button=$('bSave'), notice=$('workspaceNotice');
  button.setAttribute('aria-disabled',String(!policy.canAttempt));
  button.title=policy.message;
  notice.hidden=!policy.message;
  notice.textContent=policy.message;
}
$('bSave').addEventListener('click',async()=>{
  const observed=workspaceRevision.snapshot();
  const policy=workspaceSavePolicy({viewState:workspaceViewState,canCommit:observed.canCommit});
  if(!policy.canAttempt){ announce(policy.message); return; }
  if(policy.requiresConfirmation&&!confirm(`${policy.message}\n\nMit Speichern wird er durch die aktuell sichtbaren Eingaben ersetzt. Fortfahren?`)) return;
  try{
    canonicalizeBoatName();
    for(const assignment of state.crew) canonicalizeRowerName(assignment.seatId);
    const config=currentConfigOf();
    const savedChangeVersion=workspaceChangeVersion;
    const demoAtSave=demoRestorePoint;
    await repositoryWrite(workspaceRepository,()=>repositoryWrite(rowerRepository,()=>{
      assertNoRetiredRowerReferences(config);
      return workspaceRepository.save(config,{expectedRevision:observed.observedRevision});
    }));
    const completion=workspaceSaveCompletionPolicy({
      savedChangeVersion,currentChangeVersion:workspaceChangeVersion,
      demoAtStart:demoAtSave,currentDemo:demoRestorePoint,playing,
    });
    workspaceRevision.adopt(workspaceRepository.snapshot().revision);
    workspaceViewState='synced';
    if(completion.clearDemo) endDemoSession();
    updateWorkspaceSaveState();
    render();
    if(storageMode!=='local') ephemeralDataPresent=true;
    setDirty(completion.dirty);
    announce(storageMode==='local'
      ?'Arbeitsstand persistent gespeichert.'
      :storageMode==='session'
        ?'Arbeitsstand nur in diesem Tab gespeichert. Vor dem Schließen bitte exportieren.'
        :'Arbeitsstand nur flüchtig gespeichert. Er geht bereits bei einem Reload verloren; bitte jetzt exportieren.');
    const sp=$('bSave').querySelector('span');
    sp.textContent=storageMode==='local'?'Gespeichert ✓':storageMode==='session'?'Nur Tab ✓':'Flüchtig ✓';
    setTimeout(()=>sp.textContent='Arbeitsstand speichern',1400);
  }catch(error){
    if(error?.code==='revision-conflict'){
      workspaceRepository.reloadFromExternal('save-conflict');
      workspaceRevision.markExternal(workspaceRepository.snapshot().revision);
      updateWorkspaceSaveState();
      setDirty();
    }
    reportError(error,'Arbeitsstand konnte nicht gespeichert werden');
  }
});
$('bLoad').addEventListener('click',()=>{
  try{
    const config=workspaceRepository.get();
    if(!config){
      if(workspaceRevision.snapshot().stale){
        if(!confirm('Der Arbeitsstand wurde in einem anderen Tab entfernt oder war dort nicht mehr gültig. Lokale Eingaben beibehalten und als neuen Stand freigeben?')) return;
        workspaceRevision.adopt(workspaceRepository.snapshot().revision); workspaceViewState='new'; updateWorkspaceSaveState(); setDirty();
        announce('Die externe Entfernung wurde übernommen. Lokale Eingaben bleiben ungespeichert und können jetzt als neuer Arbeitsstand gespeichert werden.');
      }else announce('Kein V2-Arbeitsstand vorhanden.');
      return;
    }
    if(dirty&&!confirmOverwrite('Der gespeicherte Arbeitsstand ersetzt alle aktuellen Eingaben')) return;
    stopPlay();
    applyCurrentConfig(config);
    const linkedBoat=config.boatRef?boatRepository.select(config.boatRef.id):{ok:false};
    const linkIsCurrent=linkedBoat.ok&&linkedBoat.record.revision===config.boatRef.revision;
    refreshBoatSelect(linkIsCurrent?config.boatRef.id:'',linkIsCurrent);
    refreshDBSelect();
    lastPreset=config.boat.preset; lastBlade=config.boat.blade;
    endDemoSession(); workspaceRevision.adopt(workspaceRepository.snapshot().revision); workspaceViewState='synced'; updateWorkspaceSaveState();
    buildControls(); updateRig(); updateMode(); render(); setDirty(false);
    announce(linkedBoat.ok&&!linkIsCurrent
      ?'Arbeitsstand geladen · die gespeicherte Bootsbasis hat inzwischen eine andere Revision; der Snapshot bleibt unverändert.'
      :'Arbeitsstand geladen.');
  }catch(error){ reportError(error,'Arbeitsstand konnte nicht geladen werden'); }
});
$('bExport').addEventListener('click',()=>{
  try{
    const includeNames=$('resultPrivacy').value==='names';
    if(!confirmResultShare('Messbericht',includeNames)) return;
    const rawConfig=currentConfigOf();
    const config=includeNames?rawConfig:anonymizeCurrentConfig(rawConfig);
    const results={};
    for(const seat of state.seats){
      const assignment=assignmentFor(seat.id);
      if(!assignment){
        results[seat.id]={
          position:seat.position,label:seatLabel(seat),
          status:seat.rowerRef?'profile-reference-unresolved':'free',
          rowerRef:includeNames?seat.rowerRef:null,
          modelStatus:'notCalculated',
        };
        continue;
      }
      const r=runtimeForSeat(seat), catchSolution=resolveCatchAngle(r), poseAngle=catchSolution.poseAngleDeg,
            dv=derived(r,poseAngle), refs=bodyRefs(dv,r),
            catchBody=solveBody(dv,0,false,r,poseAngle), catchArms=solveArms(dv,catchBody,r);
      const actualAngle=catchSolution.actualAngleDeg;
      results[seat.id]={position:seat.position,label:seatLabel(seat),name:includeNames?assignment.rower.name:`Profil Platz ${seat.position}`,
        rowerRef:includeNames?assignment.rowerRef:null,resolution:assignmentResolution(seat),
        uebergriff_cm:+dv.U.toFixed(1),
        momentarmverhaeltnis:+(dv.outb/dv.inb).toFixed(3),schlagweite_grad:+dv.SW.toFixed(1),
        dollenhoehe_ueber_wasser_cm:+dv.dWL.toFixed(1),knie_bei_90grad:+refs.b90.knee.toFixed(1),
        rollweg_bei_90grad_prozent:+refs.rollAt(refs.b90).toFixed(1),armwinkel_modell_grad:+refs.b0.armAng.toFixed(1),
        auslage_rigg_ziel_grad:+state.phiA.toFixed(1),auslage_ist_grad:actualAngle===null?null:+actualAngle.toFixed(1),
        auslage_natural_catch_grad:catchSolution.naturalResolved?+catchSolution.naturalAngleDeg.toFixed(1):null,
        auslage_modell_pose_grad:+poseAngle.toFixed(1),natural_catch_aufgeloest:catchSolution.naturalResolved,
        natural_catch_restfehler_cm:+catchSolution.residualCm.toFixed(3),
        // Rückwärtskompatible Berichtsschlüssel; ihre Ziel-/Ist-Bedeutung ist oben explizit.
        auslage_angefordert_grad:+state.phiA.toFixed(1),auslage_effektiv_grad:actualAngle===null?null:+actualAngle.toFixed(1),
        auslage_reichweitenbegrenzt:catchSolution.limitedByReach,auslage_reichweite_verfuegbar:catchSolution.reachable,
        griffziele_bei_auslage_erreichbar:catchArms.every(arm=>arm.reachable),
        auslage_limit_grund:!catchSolution.naturalResolved?'Natural-Catch-Gleichung ohne Nullstelle im 20-88-Grad-Pruefbereich':catchSolution.limitedByReach?'3D-Griffreichweite des unkalibrierten Modells':'keines',
        natural_catch_modell:'Fa + Koerper; Knie 58 Grad; Vorlage 16 Grad; unkalibriert',
        modelStatus:'needsCalibration'};
    }
    const report={format:'rudertrimm-report',schemaVersion:SCHEMA_VERSION,appVersion:APP_VERSION,
      buildDate:APP_BUILD_DATE,buildId:APP_BUILD_ID,shellRevision:APP_SHELL_REVISION,
      exportedAt:new Date().toISOString(),privacy:includeNames?'names-included':'anonymized',config,results,
      result:actionPlanForExport(lastActionPlan,includeNames),
      sourceStatus:{worldRowing2017Presets:'verified',bodyKinematics:'needsCalibration',armAngle:'needsCalibration'},
      privacyNotice:'Enthält nur den aktuellen Arbeitsstand; keine lokalen Boots- oder Rudererdatenbanken.'};
    downloadJson(report,`rudertrimm-v2-bericht-${$('preset').value}.json`); announce('Messbericht exportiert.');
  }catch(error){ reportError(error,'Messbericht konnte nicht exportiert werden'); }
});
$('bReset').addEventListener('click',()=>{ if(confirm('Aktuelles Preset erneut auf alle realen Plätze anwenden?')){ if(applyPreset()) announce('Presetwerte für alle Plätze wiederhergestellt.'); } });

await loadDB(); refreshDBSelect(); await loadBoats(); refreshBoatSelect(); await loadEfaCandidates(); await loadWorkspaceStore();
if(storageMode!=='local'&&(rowerRepository.list().length>0||boatRepository.list().length>0
    ||efaCandidateRepository.list().length>0||workspaceRepository.get()!==null)){
  ephemeralDataPresent=true;
}
$('storageState').textContent=storageMode==='local'
  ?'Persistenter lokaler Speicher · atomare Mehrtab-Schreibvorgänge aktiv'
  :storageMode==='session'
    ?`Tab-Sitzungsspeicher · ${storageFallbackReason} · Export vor dem Schließen`
    :'Flüchtiger Speicher · Verlust bei Reload';
$('storageState').classList.toggle('storage-warning',storageMode!=='local');
if(storageMode!=='local') announce(storageMode==='session'
  ?`Daten bleiben nur in diesem Tab erhalten (${storageFallbackReason}). Vor dem Schließen bitte exportieren.`
  :'Browser-Speicher ist blockiert. Daten gehen bei Reload oder Schließen verloren; bitte sofort exportieren.');
rowerRepository.subscribe(event=>{
  if(event.type==='commit'&&storageMode!=='local') ephemeralDataPresent=true;
  if(event.type==='external-sync-error'){ reportError(event.error,'Ruderer-Datenbank konnte extern nicht gelesen werden'); return; }
  if(event.type!=='external-sync') return;
  const selectedId=$('dbSelect').value;
  const current=selectedId?rowerRepository.select(selectedId):{ok:false};
  const observed=rowerSelection.snapshot();
  const stale=current.ok&&observed.id===selectedId&&current.record.revision!==observed.revision;
  refreshDBSelect(selectedId);
  state.dbIdx=selectedId?rowerRepository.list().findIndex(record=>record.id===selectedId):-1;
  if(stale){
    $('dbUpdate').disabled=true; $('dbDelete').disabled=true;
    $('dbSelect').title='Datensatz wurde in einem anderen Tab geändert · bitte neu auswählen';
  }
  if(event.result?.ok===false){ reportRepositoryLoad(event.result,'Externe Rudererdaten'); return; }
  announce(stale
    ?'Das gewählte Rudererprofil wurde in einem anderen Tab geändert. Zum Übernehmen bitte neu auswählen.'
    :'Ruderer-Datenbank wurde aus einem anderen Tab synchronisiert.');
});
boatRepository.subscribe(event=>{
  if(event.type==='commit'&&storageMode!=='local') ephemeralDataPresent=true;
  if(event.type==='external-sync-error'){ reportError(event.error,'Boots-Datenbank konnte extern nicht gelesen werden'); return; }
  if(event.type!=='external-sync') return;
  const selectedId=$('boatSelect').value;
  const current=selectedId?boatRepository.select(selectedId):{ok:false};
  const stale=current.ok&&selectedBoatRevision!==null&&current.record.revision!==selectedBoatRevision;
  refreshBoatSelect(selectedId);
  if(stale){
    $('boatUpdate').disabled=true; $('boatDelete').disabled=true;
    $('boatSelect').title='Datensatz wurde in einem anderen Tab geändert · bitte neu auswählen';
  }
  if(event.result?.ok===false){ reportRepositoryLoad(event.result,'Externe Bootsdaten'); return; }
  announce(stale
    ?'Das gewählte Boot wurde in einem anderen Tab geändert. Zum Übernehmen bitte neu auswählen.'
    :'Boots-Datenbank wurde aus einem anderen Tab synchronisiert.');
});
efaCandidateRepository.subscribe(event=>{
  if(event.type==='commit'&&storageMode!=='local') ephemeralDataPresent=true;
  if(event.type==='external-sync-error'){
    reportError(event.error,'eFa-Vormerkliste konnte extern nicht gelesen werden');
    return;
  }
  if(event.type!=='external-sync') return;
  refreshEfaCandidateList();
  resetEfaPreview('eFa-Vormerkliste wurde in einem anderen Tab geändert · Vorschau erneut erstellen.');
  if(event.result?.ok===false){
    reportRepositoryLoad(event.result,'Externe eFa-Vormerkliste');
    return;
  }
  announce('Lokale eFa-Vormerkliste wurde aus einem anderen Tab synchronisiert.');
});
workspaceRepository.subscribe(async event=>{
  if(event.type==='commit'&&storageMode!=='local') ephemeralDataPresent=true;
  if(event.type==='external-sync-error'){ reportError(event.error,'Arbeitsstand konnte extern nicht gelesen werden'); return; }
  if(event.type==='external-sync'){
    workspaceViewState=workspaceRepository.get()===null?'new':'available';
    workspaceRevision.markExternal(event.revision);
    updateWorkspaceSaveState();
    setDirty();
    if(event.result?.ok===false){ reportRepositoryLoad(event.result,'Der externe Arbeitsstand'); return; }
    try{
      const scrubbed=await repositoryWrite(workspaceRepository,scrubSingleSeatWorkspaceInLock);
      if(scrubbed.changed){
        workspaceRevision.markExternal(scrubbed.revision);
        updateWorkspaceSaveState();
        announce('Externe versteckte Zweitplatzdaten wurden aus dem Einer-Arbeitsstand entfernt. Der neue Stand bleibt bis zum bewussten Laden gesperrt.');
        return;
      }
      announce('Der gespeicherte Arbeitsstand wurde in einem anderen Tab geändert. Speichern ist gesperrt; lokale Eingaben zuerst exportieren oder den neuen Stand laden.');
    }catch(error){
      reportError(error,'Externe Einer-Daten konnten nicht minimiert werden; der Arbeitsstand bleibt gesperrt');
    }
  }
});
window.addEventListener('beforeunload',event=>{
  if(!dirty&&!(storageMode!=='local'&&ephemeralDataPresent)) return;
  event.preventDefault();
  event.returnValue='';
});
setEfaMappingVisibility();
buildControls(); updateRig(); updateMode(); updateCoxControl(); initPresentationMode(); initFold(); initVisualViewTabs(); initVisualSizing(); initActionResult(); initWorkflowGuide(); render(); setDirty(false);

function updateNetworkStatus(){
  if(isDirectFile){
    $('offlineState').textContent='Direktstart · PWA/Offline-Cache nicht verfügbar';
    return;
  }
  $('offlineState').textContent=navigator.onLine?'Online · Offline-Cache wird geprüft':'Offline · lokale Funktionen verfügbar';
}
window.addEventListener('online',updateNetworkStatus);
window.addEventListener('offline',updateNetworkStatus);
updateNetworkStatus();

function serviceWorkerMode(protocol,supported){
  if(protocol==='file:') return 'direct-file';
  if((protocol==='http:'||protocol==='https:')&&supported) return 'register';
  return 'unsupported';
}
function scheduleServiceWorkerRegistration(task){
  if(document.readyState==='complete'){
    void task();
    return;
  }
  window.addEventListener('load',()=>void task(),{once:true});
}
async function registerServiceWorker(){
  try{
    const registration=await navigator.serviceWorker.register('sw.js',{scope:'./'});
    $('offlineState').textContent=navigator.onLine?'Online · PWA registriert':'Offline · PWA aktiv';
    registration.addEventListener('updatefound',()=>{
      const worker=registration.installing;
      worker?.addEventListener('statechange',()=>{
        if(worker.state==='installed'&&navigator.serviceWorker.controller){
          $('offlineState').textContent='Update bereit · beim nächsten Start aktiv';
          announce('Eine neue App-Version ist für den nächsten Start bereit.');
        }
      });
    });
  }catch(error){
    console.error('Service Worker konnte nicht registriert werden',error);
    $('offlineState').textContent='Online · Offline-Modus nicht bereit';
  }
}
const swMode=serviceWorkerMode(globalThis.location?.protocol,'serviceWorker' in navigator);
if(swMode==='register') scheduleServiceWorkerRegistration(registerServiceWorker);
else if(swMode==='direct-file') $('offlineState').textContent='Direktstart · PWA/Offline-Cache nicht verfügbar';
else $('offlineState').textContent='Offline-Modus nicht unterstützt';
}

function reportBootFailure(error){
  BOOT_ROOT.dataset.rudertrimmBoot='failed';
  console.error('Rudertrimm konnte nicht initialisiert werden',error);
  const release=globalThis.RUDERTRIMM_RELEASE;
  const buildState=document.getElementById('buildState');
  if(buildState) buildState.textContent=`Startfehler · ${release?.appVersion??'Version unbekannt'}`;
  const status=document.getElementById('errorStatus');
  if(status){
    status.hidden=false;
    status.textContent='Rudertrimm konnte nicht initialisiert werden. Bitte den App-Ordner vollständig entpacken und erneut öffnen.';
  }
}

globalThis.RUDERTRIMM_BOOT_PROMISE=bootRudertrimm().then(()=>{
  BOOT_ROOT.dataset.rudertrimmBoot='ready';
  const status=document.getElementById('errorStatus');
  if(status?.dataset.bootFallback==='true'){
    status.hidden=true;
    status.textContent='';
    delete status.dataset.bootFallback;
  }
}).catch(reportBootFailure);
