import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

import {
  CATCH_MODEL,
  PRESETS,
  buildSeatDTO,
  buildTestielComparisonDemoConfig,
  buildTestielDemoConfig,
  advanceStrokeCycle,
  defaultFaForRig,
  deriveBodySegments,
  derivedGeometry,
  findHighestReachableAngle,
  planSeatLayoutByRole,
  seatLabelForPosition,
  seatRoleForPosition,
  solveNaturalCatchAngle,
  strokePoseAtCycleProgress,
} from '../js/core.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>readFileSync(resolve(ROOT,path),'utf8');
const index=read('index.html');
const app=read('js/app.mjs');
const serviceWorker=read('sw.js');
const releaseSource=read('version.js');

function evaluateRelease(){
  const context={};
  vm.createContext(context);
  vm.runInContext(releaseSource,context,{filename:'version.js'});
  return context.RUDERTRIMM_RELEASE;
}
const release=evaluateRelease();
function runServiceWorker(context){
  context.importScripts=path=>assert.equal(path,'./version.js');
  vm.createContext(context);
  vm.runInContext(releaseSource,context,{filename:'version.js'});
  vm.runInContext(serviceWorker,context,{filename:'sw.js'});
}
const baseCss=read('css/base.css');
const v2Css=read('css/v2.css');
const v1Index=read('../source/index.html');

function serviceWorkerVersionForScope(scope){
  const listeners={};
  let reply;
  const context={
    URL,Request,Response,Headers,Map,Object,Promise,TypeError,
    fetch:async()=>{ throw new Error('unused'); },
    caches:{},
    self:{
      registration:{scope},
      location:{origin:new URL(scope).origin},
      clients:{async matchAll(){ return []; },async claim(){}},
      async skipWaiting(){},
      addEventListener(type,handler){ listeners[type]=handler; },
    },
  };
  runServiceWorker(context);
  listeners.message({
    data:{type:'RUDERTRIMM_GET_VERSION'},
    source:{postMessage(value){ reply=value; }},
  });
  return reply;
}

test('HTML has a restrictive application CSP and no inline executable code',()=>{
  const csp=index.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u)?.[1];
  assert.ok(csp,'CSP meta element is required for the static preview');
  for(const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]) assert.ok(csp.includes(directive),`missing CSP directive: ${directive}`);
  assert.equal(csp.includes("'unsafe-eval'"),false);

  const scripts=[...index.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)];
  assert.ok(scripts.length>0);
  for(const [,attributes,body] of scripts){
    assert.match(attributes,/\bsrc="[^"]+"/u);
    assert.equal(body.trim(),'');
  }
  assert.doesNotMatch(index,/\son[a-z]+\s*=/iu);
});

test('application code avoids executable HTML sinks and gates browser storage',()=>{
  for(const pattern of [
    /\.innerHTML\s*=/u,
    /\.outerHTML\s*=/u,
    /insertAdjacentHTML\s*\(/u,
    /document\.write\s*\(/u,
    /\beval\s*\(/u,
    /new\s+Function\s*\(/u,
  ]) assert.doesNotMatch(app,pattern);

  assert.equal((app.match(/window\.localStorage/gu)??[]).length,1,'only the guarded capability probe may access localStorage directly');
  assert.match(app,/storageAdapter=probeStorage\(window\.localStorage\)/u);
  assert.match(app,/storageAdapter=probeStorage\(window\.sessionStorage\)/u);
  assert.match(app,/storageAdapter=createMemoryStorage\(\)/u);
  assert.match(app,/typeof navigator\.locks\?\.request!==['"]function['"]/u);
  assert.match(app,/withExclusiveRepositoryWrite/u);
  assert.match(app,/shared:storageMode===['"]local['"]/u);
  assert.match(app,/Web Locks fehlen/u);
  assert.match(app,/Flüchtiger Speicher · Verlust bei Reload/u);
});

test('storage repositories are wired into the UI with observed record revisions',()=>{
  for(const token of [
    'createRowerRepository',
    'createBoatRepository',
    'createWorkspaceRepository',
    'createContextualSelection',
    'createObservedRevision',
    'workspaceStateLabel',
    'workspaceSavePolicy',
    'selectedBoatRevision',
    'rowerSelection.matches',
    'expectedRecordRevision:observedRecordRevision',
    'expectedRecordRevision:observed.revision',
    'workspaceRepository.save',
    'workspaceRepository.get',
    'profileCommitPolicy',
    'profileDraftVersion',
    'finishProfileCommit',
    'selectionUnchanged:sameRowerSelection',
    'currentVersion:profileDraftVersion[saveSeat]',
    'if(policy.clearDraft) profileDraftDirty[saveSeat]=false',
  ]) assert.ok(app.includes(token),`missing integration token: ${token}`);
  for(const token of [
    'await repositoryWrite(boatRepository',
    'await repositoryWrite(rowerRepository',
    'await repositoryWrite(workspaceRepository',
    'await loadDB()',
    'await loadBoats()',
    'await loadWorkspaceStore()',
  ]) assert.ok(app.includes(token),`missing coordinated write token: ${token}`);
  assert.match(app,/if\(dirty&&!confirmOverwrite\('Der gespeicherte Arbeitsstand ersetzt alle aktuellen Eingaben'\)\) return;/u);
  assert.match(app,/applyBoat\(selected\.record\.value\); endDemoSession\(\); refreshDBSelect\('',true,state\.editSeatId\); setDirty\(true\);/u);
  assert.match(app,/window\.addEventListener\('beforeunload'/u);
  assert.doesNotMatch(app,/profileDraftDirty\[state\.editSeat\]=false/u);
});

test('human import confirmation stays outside the exclusive write lock and stale previews abort',()=>{
  for(const [start,end] of [
    ["$('boatFile').addEventListener","/* ---------------- Rigg:"],
    ["$('dbFile').addEventListener",'// „Weiterschalten"'],
  ]){
    const handler=app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
    const preview=handler.indexOf('previewCollectionImport(importOptions)');
    const confirmation=handler.indexOf('confirmCollectionImport(approvedPreview)');
    const lock=handler.indexOf('await repositoryWrite(');
    assert.ok(preview>=0&&confirmation>preview&&lock>confirmation,`${start} must preview and confirm before locking`);
    assert.equal(handler.slice(lock).includes('confirmCollectionImport('),false,`${start} must not wait for a human inside the lock`);
    assert.ok(handler.slice(lock).includes('approveFreshImportPreview(approvedPreview,fresh)'));
  }
  assert.match(app,/sameCollectionImportPreview\(approved,fresh\)/u);
  assert.match(app,/error\.code='import-preview-changed'/u);
});

test('blade changes mutate only every real seat oar length and announce that scope',()=>{
  const functionSource=app.slice(
    app.indexOf('function applyBladeLength()'),
    app.indexOf('function setRig('),
  );
  assert.ok(functionSource.startsWith('function applyBladeLength()'));

  const state={
    t:37,
    recovery:true,
    mode:'wasser',
    seats:[
      {id:'seat-1',position:1,L:288,IH:88},
      {id:'seat-2',position:2,L:289,IH:87.5},
      {id:'seat-3',position:3,L:290,IH:87},
      {id:'seat-4',position:4,L:291,IH:86.5},
    ],
    crew:[
      {seatId:'seat-1',rower:{name:'Schlagmann'}},
      {seatId:'seat-2',rower:{name:'Ruderer 2'}},
    ],
  };
  const expected=JSON.parse(JSON.stringify(state));
  for(const seat of expected.seats) seat.L=298;
  const effects={dirty:0,controls:0,render:0};
  const elements={preset:{value:'4x'},blade:{value:'mac'}};
  const context={
    PRESETS:{'4x':{Lbig:288,Lmac:298}},
    state,
    $:id=>elements[id],
    setDirty(){ effects.dirty+=1; },
    buildControls(){ effects.controls+=1; },
    render(){ effects.render+=1; },
  };
  vm.createContext(context);
  vm.runInContext(`${functionSource}\napplyBladeLength();`,context);

  assert.deepEqual(state,expected);
  assert.deepEqual(effects,{dirty:1,controls:1,render:1});
  const bladeHandler=app.slice(app.indexOf("$('blade').addEventListener"),app.indexOf("$('rigS').addEventListener"));
  assert.match(bladeHandler,/ändert ausschließlich die Ruderlänge aller realen Plätze/u);
});

test('visible 1x to 8+ preset change is atomic on accept and byte-stable on cancel',()=>{
  const seatSource=app.slice(app.indexOf('function presetSeatSource('),app.indexOf('function initialSeats('));
  const applySource=app.slice(app.indexOf('function applyPreset()'),app.indexOf('let lastPreset=',app.indexOf('function applyPreset()')));
  const handlerSource=app.slice(app.indexOf("$('preset').addEventListener('change'"),app.indexOf("$('blade').addEventListener",app.indexOf("$('preset').addEventListener('change'")));
  const initialConfig=buildTestielDemoConfig();

  const setup=allow=>{
    let idCounter=0;
    const snapshots=[];
    const elements={
      preset:{value:'8+',listeners:{},addEventListener(type,listener){ this.listeners[type]=listener; }},
      blade:{value:'big'},boatSeatCount:{value:'1',disabled:false},coxName:{value:''},
    };
    const state={
      rig:'skull',phiA:66,phiR:44,seats:structuredClone(initialConfig.boat.seats),crew:[],
      editSeatId:initialConfig.boat.seats[0].id,referenceSeatId:initialConfig.boat.seats[0].id,
    };
    const context={
      PRESETS,PHI:{skull:{A:66,R:44},riemen:{A:54,R:36}},state,elements,
      boatMetadata:{externalRef:null,capacityStatus:'preset',legacyRigTemplate:null},
      lastPreset:'1x',lastBlade:'big',dirty:true,
      buildSeatDTO,defaultFaForRig,planSeatLayoutByRole,seatLabelForPosition,seatRoleForPosition,
      clone:value=>structuredClone(value),localId:prefix=>`${prefix}-ui-${++idCounter}`,
      assignmentFor:seatId=>state.crew.find(item=>item.seatId===seatId)??null,
      seatLabel:seat=>seat.label,
      confirmOverwrite(){ return allow; },confirm(){ return allow; },
      syncSeatCountControl(){
        const fixed=PRESETS[elements.preset.value].seatCount;
        elements.boatSeatCount.disabled=Number.isSafeInteger(fixed);
        elements.boatSeatCount.value=String(fixed??state.seats.length);
      },
      updateCoxControl(){},setDirty(){},buildControls(){},updateRig(){},
      render(){ snapshots.push({
        preset:elements.preset.value,seatCount:state.seats.length,countControl:elements.boatSeatCount.value,
        roles:state.seats.map(seat=>seat.role),labels:state.seats.map(seat=>seat.label),
        ids:state.seats.map(seat=>seat.id),rig:state.rig,
        defaults:state.seats.map(seat=>[seat.DA,seat.IH,seat.L,seat.stemmX]),
        crewScope:`${state.crew.length}/${state.seats.length}`,
      }); },
      $:id=>elements[id],
    };
    vm.createContext(context);
    vm.runInContext(`${seatSource}\n${applySource}\n${handlerSource}`,context);
    return {context,state,elements,snapshots};
  };

  const cancelled=setup(false);
  const before=structuredClone(cancelled.state);
  cancelled.elements.preset.listeners.change();
  assert.deepEqual(cancelled.state,before,'cancel leaves every working value and stable id unchanged');
  assert.equal(cancelled.elements.preset.value,'1x');
  assert.equal(cancelled.elements.boatSeatCount.value,'1');
  assert.deepEqual(cancelled.snapshots,[],'cancel never renders a mixed preset state');

  const accepted=setup(true);
  accepted.elements.preset.listeners.change();
  assert.equal(accepted.snapshots.length,1,'accepted transaction renders only after all seat/default mutations');
  const visible=accepted.snapshots[0];
  assert.equal(visible.preset,'8+');
  assert.equal(visible.seatCount,8);
  assert.equal(visible.countControl,'8');
  assert.equal(accepted.elements.boatSeatCount.disabled,true);
  assert.deepEqual(Array.from(visible.roles),['bow','crew','crew','crew','crew','crew','crew','stroke']);
  assert.equal(visible.labels[0],'Platz 1 · Bug');
  assert.equal(visible.labels[7],'Platz 8 · Schlag');
  assert.equal(new Set(visible.ids).size,8);
  assert.equal(visible.rig,'riemen');
  assert.equal(visible.crewScope,'0/8');
  assert.equal(visible.defaults.every(values=>JSON.stringify(values)===JSON.stringify([83,113.5,375,50])),true,
    'no 1x Skull DA/IH/L/Fa values survive the accepted 8+ transaction');
  assert.equal(accepted.state.referenceSeatId,accepted.state.seats[7].id);
  assert.equal(accepted.state.editSeatId,accepted.state.seats[7].id);
});

test('editable Gig capacity never reapplies seat defaults without an explicit overwrite decision',()=>{
  const handlerSource=app.slice(
    app.indexOf("$('boatSeatCount').addEventListener"),
    app.indexOf('function boatOf()',app.indexOf("$('boatSeatCount').addEventListener")),
  );
  const setup=allow=>{
    const calls=[];
    const input={value:'5',listeners:{},addEventListener(type,listener){ this.listeners[type]=listener; }};
    const context={
      state:{seats:[{id:'seat-1'},{id:'seat-2'},{id:'seat-3'}]},
      $:id=>{ assert.equal(id,'boatSeatCount'); return input; },
      confirmOverwrite(message,forced){ calls.push({message,forced}); return allow; },
      applyPreset(){ calls.push('apply'); return true; },
    };
    vm.createContext(context);
    vm.runInContext(handlerSource,context);
    input.listeners.change({target:input});
    return {calls,input};
  };

  const cancelled=setup(false);
  assert.equal(cancelled.input.value,'3','cancel restores the visible capacity');
  assert.equal(cancelled.calls.includes('apply'),false,'cancel prevents every preset mutation');
  assert.equal(cancelled.calls[0].forced,true,'the overwrite decision is required even for a clean workspace');
  assert.match(cancelled.calls[0].message,/Gig-Platzanzahl[\s\S]*Innenhebel[\s\S]*aller Plätze/u);

  const accepted=setup(true);
  assert.equal(accepted.calls.filter(call=>call==='apply').length,1,'accept performs one coherent preset transaction');
});

test('Testiel demo respects both dirty guards, stays unpersisted, and loads the complete editor state',()=>{
  assert.match(index,/id="loadTestielDemo"[^>]*type="button"|type="button"[^>]*id="loadTestielDemo"/u);
  assert.match(index,/id="loadTestielDemo"[^>]*aria-describedby="testielDemoNote"/u);
  assert.match(index,/id="testielDemoNote" class="demo-note" role="status" aria-live="polite">Synthetische Referenzdaten[^<]*speichert nichts automatisch\.<\/span>/u);
  assert.match(v2Css,/\.demo-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,[\s\S]*?flex:\s*1 1 100%/u);
  assert.match(v2Css,/#loadTestielDemo,\s*#loadComparisonDemo,\s*#removeDemo\s*\{[\s\S]*?border-color:\s*var\(--accent2\)/u);

  const start=app.indexOf('function loadTestielDemo()');
  const end=app.indexOf("$('loadTestielDemo').addEventListener",start);
  const functionSource=app.slice(start,end);
  assert.ok(functionSource.startsWith('function loadTestielDemo()'));
  for(const forbidden of ['repositoryWrite','storageAdapter','localStorage','.create(','.save(','.update(','requestAnimationFrame','playing=true','clearErrorStatus','announce(']){
    assert.equal(functionSource.includes(forbidden),false,`demo loader must not use ${forbidden}`);
  }
  assert.equal((app.match(/\$\('loadTestielDemo'\)\.addEventListener\('click',loadTestielDemo\)/gu)??[]).length,1);

  const makeContext=({dirty=false,draftDirty=false,confirmed=true}={})=>{
    const calls=[];
    const button={focus(){ calls.push('focus'); }};
    const note={textContent:''};
    const context={
      dirty,
      anyProfileDraftDirty(){ return draftDirty; },
      confirmOverwrite(message,hasUnsaved){ calls.push(`confirm:${hasUnsaved}`); return !hasUnsaved||confirmed; },
      captureDemoRestorePoint(){ calls.push('capture'); },
      showDemoIndicator(label){ calls.push(`badge:${label}`); },
      buildTestielDemoConfig(){ calls.push('build'); return buildTestielDemoConfig(); },
      stopPlay(){ calls.push('stop'); },
      clearRowerSelection(){ calls.push('clear-rower-selection'); },
      refreshBoatSelect(){ calls.push('clear-boat-selection'); },
      applyCurrentConfig(config,options){
        calls.push(`config:${config.boat.preset}/${config.boat.blade}:${config.boat.seats.length}/${config.crew.length}`);
        context.loadedConfig=config; context.applyOptions=options;
      },
      state:{},
      lastPreset:'old',
      lastBlade:'mac',
      buildControls(){ calls.push('controls'); },
      updateRig(){ calls.push('rig'); },
      updateMode(){ calls.push('mode'); },
      setDirty(value){ calls.push(`dirty:${value}`); context.dirty=value; },
      render(){ calls.push('render'); },
      $(id){
        if(id==='loadTestielDemo') return button;
        if(id==='testielDemoNote') return note;
        throw new Error(`unexpected element ${id}`);
      },
    };
    vm.createContext(context);
    vm.runInContext(functionSource,context);
    return {context,calls};
  };

  for(const options of [
    {dirty:true,confirmed:false},
    {dirty:false,draftDirty:true,confirmed:false},
  ]){
    const attempt=makeContext(options);
    assert.equal(vm.runInContext('loadTestielDemo()',attempt.context),false);
    assert.deepEqual(attempt.calls,['confirm:true']);
  }

  const clean=makeContext({confirmed:false});
  assert.equal(vm.runInContext('loadTestielDemo()',clean.context),true,'clean editor must load without a dialog');
  assert.equal(clean.calls[0],'confirm:false');

  const success=makeContext({dirty:true,confirmed:true});
  assert.equal(vm.runInContext('loadTestielDemo()',success.context),true);
  assert.equal(success.calls[0],'confirm:true');
  assert.ok(success.calls.indexOf('capture')<success.calls.indexOf('stop'));
  assert.ok(success.calls.indexOf('stop')<success.calls.indexOf('config:1x/big:1/1'));
  assert.ok(success.calls.includes('clear-rower-selection'));
  assert.ok(success.calls.includes('clear-boat-selection'));
  assert.ok(success.calls.includes('dirty:true'));
  assert.ok(success.calls.includes('focus'));
  assert.ok(success.calls.includes('badge:Testiel · Einer'));
  assert.equal(success.context.$('testielDemoNote').textContent,'Demo „Testiel“ geladen – synthetisch; nichts wurde automatisch gespeichert.');
  assert.equal(success.context.loadedConfig.boat.seats.length,1);
  assert.equal(success.context.loadedConfig.crew.length,1);
  assert.equal(success.context.loadedConfig.crew[0].rower.name,'Testiel');
  assert.equal(success.context.loadedConfig.crew[0].seatId,success.context.loadedConfig.boat.seats[0].id);
  assert.equal(success.context.loadedConfig.editSeatId,success.context.loadedConfig.boat.seats[0].id);
  assert.equal(success.context.loadedConfig.referenceSeatId,success.context.loadedConfig.boat.seats[0].id);
  assert.equal(success.context.applyOptions.draftsDirty,true);
  assert.equal(success.context.lastPreset,'1x');
  assert.equal(success.context.lastBlade,'big');
});

test('comparison demo loads Testiel and Testiel 2 into 4x without persistence or autoplay',()=>{
  assert.match(index,/id="loadComparisonDemo"[^>]*type="button"|type="button"[^>]*id="loadComparisonDemo"/u);
  assert.match(index,/id="loadComparisonDemo"[^>]*aria-describedby="testielDemoNote"/u);
  assert.match(index,/class="demo-actions" role="group" aria-label="Synthetische Demonstrationen"/u);

  const start=app.indexOf('function loadComparisonDemo()');
  const end=app.indexOf("$('loadComparisonDemo').addEventListener",start);
  const functionSource=app.slice(start,end);
  assert.ok(functionSource.startsWith('function loadComparisonDemo()'));
  for(const forbidden of ['repositoryWrite','storageAdapter','localStorage','.create(','.save(','.update(','requestAnimationFrame','playing=true','clearErrorStatus','announce(']){
    assert.equal(functionSource.includes(forbidden),false,`comparison loader must not use ${forbidden}`);
  }

  const makeContext=({dirty=false,draftDirty=false,confirmed=true}={})=>{
    const calls=[];
    const button={focus(){ calls.push('focus'); }};
    const note={textContent:''};
    const context={
      dirty,
      anyProfileDraftDirty(){ return draftDirty; },
      confirmOverwrite(message,hasUnsaved){ calls.push(`confirm:${hasUnsaved}`); return !hasUnsaved||confirmed; },
      captureDemoRestorePoint(){ calls.push('capture'); },
      showDemoIndicator(label){ calls.push(`badge:${label}`); },
      buildTestielComparisonDemoConfig(){ calls.push('build'); return buildTestielComparisonDemoConfig(); },
      stopPlay(){ calls.push('stop'); },
      clearRowerSelection(){ calls.push('clear-rower-selection'); },
      refreshBoatSelect(){ calls.push('clear-boat-selection'); },
      applyCurrentConfig(config,options){
        calls.push(`config:${config.boat.preset}/${config.boat.blade}:${config.boat.seats.length}/${config.crew.length}`);
        context.loadedConfig=config; context.applyOptions=options;
      },
      state:{},
      lastPreset:'old',
      lastBlade:'mac',
      buildControls(){ calls.push('controls'); },
      updateRig(){ calls.push('rig'); },
      updateMode(){ calls.push('mode'); },
      setDirty(value){ calls.push(`dirty:${value}`); context.dirty=value; },
      render(){ calls.push('render'); },
      $(id){
        if(id==='loadComparisonDemo') return button;
        if(id==='testielDemoNote') return note;
        throw new Error(`unexpected element ${id}`);
      },
    };
    vm.createContext(context);
    vm.runInContext(functionSource,context);
    return {context,calls};
  };

  for(const options of [
    {dirty:true,confirmed:false},
    {dirty:false,draftDirty:true,confirmed:false},
  ]){
    const attempt=makeContext(options);
    assert.equal(vm.runInContext('loadComparisonDemo()',attempt.context),false);
    assert.deepEqual(attempt.calls,['confirm:true']);
  }

  const success=makeContext({dirty:true,confirmed:true});
  assert.equal(vm.runInContext('loadComparisonDemo()',success.context),true);
  assert.equal(success.calls[0],'confirm:true');
  assert.ok(success.calls.indexOf('capture')<success.calls.indexOf('stop'));
  assert.ok(success.calls.indexOf('stop')<success.calls.indexOf('config:4x/big:4/2'));
  assert.ok(success.calls.includes('clear-rower-selection'));
  assert.ok(success.calls.includes('clear-boat-selection'));
  assert.ok(success.calls.includes('dirty:true'));
  assert.ok(success.calls.includes('focus'));
  assert.ok(success.calls.includes('badge:Testiel + Testiel 2 · 4x'));
  assert.equal(success.context.$('testielDemoNote').textContent,'Synthetische Vergleichsdemo geladen – noch nicht gespeichert.');
  assert.equal(success.context.loadedConfig.boat.seats.length,4);
  assert.deepEqual(success.context.loadedConfig.crew.map(assignment=>assignment.rower.name),['Testiel 2','Testiel']);
  assert.deepEqual(success.context.loadedConfig.crew.map(assignment=>assignment.seatId),
    success.context.loadedConfig.boat.seats.slice(-2).map(seat=>seat.id));
  assert.equal(success.context.loadedConfig.boat.seats.slice(0,2).every(seat=>
    success.context.loadedConfig.crew.every(assignment=>assignment.seatId!==seat.id)),true,
  'comparison demo keeps two real seats free');
  assert.equal(success.context.applyOptions.draftsDirty,true);
  assert.equal(success.context.lastPreset,'4x');
  assert.equal(success.context.lastBlade,'big');
  assert.equal((app.match(/\$\('loadComparisonDemo'\)\.addEventListener\('click',loadComparisonDemo\)/gu)??[]).length,1);
});

test('demo removal restores visible state without rewinding mutation tokens or external conflicts',()=>{
  const captureSource=app.slice(app.indexOf('function captureDemoRestorePoint()'),app.indexOf('function showDemoIndicator('));
  const restoreSource=app.slice(app.indexOf('function restoreBeforeDemo()'),app.indexOf("$('removeDemo').addEventListener",app.indexOf('function restoreBeforeDemo()')));
  assert.match(captureSource,/workspaceRevision:workspaceRevision\.snapshot\(\)/u);
  assert.doesNotMatch(captureSource,/workspaceChangeVersion|workspaceViewState/u);
  assert.doesNotMatch(restoreSource,/workspaceChangeVersion\s*=|workspaceViewState\s*=|Object\.assign\(profileDraftVersion/u);

  const run=({external=false}={})=>{
    const calls=[];
    const previousRevision={observedRevision:4,externalRevision:null,stale:false,canCommit:true};
    const context={
      demoRestorePoint:{
        config:{boat:{preset:'4x',blade:'big'}},dirty:false,workspaceRevision:previousRevision,
        presentationMode:'details',activeVisualView:'side',wasPlaying:true,speed:'1.5',
        selectedBoatId:'',selectedBoatRevision:null,boatSelect:'',rowerSelection:{id:'',revision:null,context:null},dbIdx:2,
        profileDraftDirty:{'seat-old':true},profileDraftVersion:{'seat-old':4},
      },
      workspaceRevision:{snapshot(){ return external
        ?{observedRevision:4,externalRevision:5,stale:true,canCommit:false}
        :previousRevision; }},
      workspaceChangeVersion:11,workspaceViewState:'available',dirty:true,
      profileDraftDirty:{'seat-demo':true},profileDraftVersion:{'seat-old':4,'seat-demo':1},
      state:{dbIdx:-1},lastPreset:'1x',lastBlade:'mac',
      stopPlay(){ calls.push('stop'); },clearRowerSelection(){ calls.push('clear-selection'); },
      applyCurrentConfig(config){ context.restoredConfig=config; context.workspaceChangeVersion+=1; },
      boatRepository:{select(){ throw new Error('no boat selection expected'); }},
      refreshBoatSelect(value,adopt){ calls.push(`boat:${value}:${adopt}`); },
      buildControls(){ calls.push('controls'); },updateRig(){},updateMode(){},updateCoxControl(){},
      updateSpeed(){ calls.push(`speed:${elements.speed.value}`); },
      setPresentationMode(value){ calls.push(`mode:${value}`); },activateVisualView(value){ calls.push(`view:${value}`); },
      render(){ calls.push('render'); },refreshDBSelect(){ throw new Error('no rower selection expected'); },
      clearDemoIndicator(){ calls.push('clear-demo'); },updateWorkspaceSaveState(){ calls.push('save-state'); },updateContext(){},
      startPlay(options){ calls.push(`play:${options.markDirty}`); },
      announce(message){ calls.push(`announce:${message}`); },reportError(error){ throw error; },
    };
    const elements={speed:{value:'1'},loadComparisonDemo:{focus(){ calls.push('focus'); }}};
    context.$=id=>elements[id]??(()=>{ throw new Error(`unexpected ${id}`); })();
    vm.createContext(context); vm.runInContext(restoreSource,context);
    assert.equal(vm.runInContext('restoreBeforeDemo()',context),true);
    return {context,calls};
  };

  const unchanged=run();
  assert.equal(unchanged.context.workspaceChangeVersion,12,'restore remains a newer mutation for pending-save guards');
  assert.equal(unchanged.context.workspaceViewState,'available','visible restore never rewinds repository truth');
  assert.equal(unchanged.context.profileDraftVersion['seat-old'],5,'profile token advances past a pending save');
  assert.equal(unchanged.context.profileDraftDirty['seat-old'],true);
  assert.equal(unchanged.context.dirty,false);
  assert.ok(unchanged.calls.includes('mode:details'));
  assert.ok(unchanged.calls.includes('view:side'));
  assert.ok(unchanged.calls.includes('speed:1.5'));
  assert.ok(unchanged.calls.includes('play:false'));

  const conflicted=run({external:true});
  assert.equal(conflicted.context.dirty,true,'external conflict remains dirty after removing a demo');
  assert.ok(conflicted.calls.some(call=>call.includes('externer Arbeitsstandkonflikt')));
  assert.match(app,/applyBoat\(selected\.record\.value\); endDemoSession\(\);/u);
  assert.match(app,/workspaceViewState='synced';\s*if\(completion\.clearDemo\) endDemoSession\(\);\s*updateWorkspaceSaveState/u);
  assert.match(app,/endDemoSession\(\); workspaceRevision\.adopt/u);
});

test('missing result is compact, focusable and cannot be exported or printed',()=>{
  assert.match(index,/id="actionMissingFocus"[^>]*aria-describedby="actionSummary"/u);
  for(const id of ['resultPrivacy','resultExport','resultPrint']){
    assert.match(index,new RegExp(`id="${id}"[^>]*\\bdisabled\\b`,'u'));
  }
  assert.match(v2Css,/body\[data-presentation="compact"\] \.action-result\[data-status="missing"\][\s\S]*?\.action-share[\s\S]*?display:\s*none/u);
  const renderSource=app.slice(app.indexOf('function renderActionPlan()'),app.indexOf('function actionPlanForExport('));
  const signatureSource=app.slice(app.indexOf('function workflowResultSignature('),app.indexOf('function renderWorkflowGuide()'));
  let actionListRenders=0;
  const elements={
    actionStatus:{dataset:{},textContent:''},actionResult:{dataset:{}},actionSummary:{textContent:''},
    actionMissingFocus:{hidden:true},resultPrivacy:{disabled:false},resultExport:{disabled:false,title:''},
    resultPrint:{disabled:false,title:''},actionList:{replaceChildren(){ actionListRenders+=1; }},
  };
  const context={
    lastActionPlan:null,workflowCurrentResultSignature:'',renderedActionPlanSignature:'',state:{referenceSeatId:'seat-1',seats:[{id:'seat-1'}]},
    buildActionDiagnostics:()=>[],plan:{status:'missing',summary:'Profil fehlt',actions:[],evaluatedSeats:0,unavailableSeats:1},
    buildTrimActionPlan(){ return context.plan; },$:id=>elements[id],document:{createElement(){ throw new Error('no action nodes expected'); }},
  };
  vm.createContext(context); vm.runInContext(signatureSource,context); vm.runInContext(renderSource,context); vm.runInContext('renderActionPlan()',context);
  assert.equal(elements.actionResult.dataset.status,'missing');
  assert.equal(elements.actionMissingFocus.hidden,false);
  assert.equal(elements.resultPrivacy.disabled,true);
  assert.equal(elements.resultExport.disabled,true);
  assert.equal(elements.resultPrint.disabled,true);
  vm.runInContext('renderActionPlan()',context);
  assert.equal(actionListRenders,1,'unchanged animation renders preserve existing result controls and focus');
  context.plan={status:'ok',summary:'Kein akuter Handlungsbedarf',actions:[],evaluatedSeats:1,unavailableSeats:0};
  vm.runInContext('renderActionPlan()',context);
  assert.equal(actionListRenders,2,'a changed result replaces its controls exactly once');
  assert.equal(elements.actionMissingFocus.hidden,true);
  assert.equal(elements.resultPrivacy.disabled,false);
  assert.equal(elements.resultExport.disabled,false);
  assert.equal(elements.resultPrint.disabled,false);
  assert.match(app,/if\(lastActionPlan\.status==='missing'\)\{ announce\('Ergebnisexport ist erst/u);
  assert.match(app,/if\(lastActionPlan\.status==='missing'\)\{ announce\('Druckbericht ist erst/u);
  assert.match(app,/const seatId=action\.focusSeatId\?\?action\.scope\.seatId\?\?state\.referenceSeatId/u,
    'crew-wide result actions focus their deterministic deviating seat');
  assert.match(app,/statusText:'Nicht berechenbar'/u);
});

test('visual tabs provide roving keyboard focus without changing stroke state',()=>{
  const start=app.indexOf("const VISUAL_VIEWS=Object.freeze(['top','side','cross'])");
  const end=app.indexOf('/* ================= Einklappbare Karten',start);
  const source=app.slice(start,end);
  assert.ok(source.startsWith("const VISUAL_VIEWS=Object.freeze(['top','side','cross'])"));

  const elements={};
  for(const view of ['Top','Side','Cross']){
    elements[`viewTab${view}`]={
      attributes:new Map(),tabIndex:99,focused:false,listeners:{},
      setAttribute(name,value){ this.attributes.set(name,value); },
      addEventListener(type,handler){ this.listeners[type]=handler; },
      focus(){ this.focused=true; },
    };
    elements[`viewPanel${view}`]={hidden:false};
  }
  const strokeState={t:37,recovery:true,playing:true,speed:1.25};
  const context={Object,strokeState,$:id=>elements[id]};
  vm.createContext(context);
  vm.runInContext(source,context);
  vm.runInContext('initVisualViewTabs()',context);

  const snapshot=()=>({
    selected:['Top','Side','Cross'].map(view=>elements[`viewTab${view}`].attributes.get('aria-selected')),
    tabIndex:['Top','Side','Cross'].map(view=>elements[`viewTab${view}`].tabIndex),
    hidden:['Top','Side','Cross'].map(view=>elements[`viewPanel${view}`].hidden),
  });
  assert.deepEqual(snapshot(),{
    selected:['true','false','false'],tabIndex:[0,-1,-1],hidden:[false,true,true],
  });

  elements.viewTabSide.listeners.click();
  assert.deepEqual(snapshot(),{
    selected:['false','true','false'],tabIndex:[-1,0,-1],hidden:[true,false,true],
  });

  const key=(view,keyName)=>{
    let prevented=0;
    elements[`viewTab${view}`].listeners.keydown({key:keyName,preventDefault(){ prevented+=1; }});
    return prevented;
  };
  assert.equal(key('Side','ArrowRight'),1);
  assert.equal(elements.viewTabCross.focused,true);
  assert.equal(key('Cross','ArrowRight'),1);
  assert.equal(elements.viewTabTop.focused,true);
  assert.equal(key('Top','ArrowLeft'),1);
  assert.equal(key('Cross','Home'),1);
  assert.equal(key('Top','End'),1);
  const beforeUnknown=snapshot();
  assert.equal(key('Cross','PageDown'),0);
  assert.deepEqual(snapshot(),beforeUnknown);
  assert.deepEqual(strokeState,{t:37,recovery:true,playing:true,speed:1.25});
  assert.doesNotMatch(source,/setDirty|stopPlay|state\.|requestAnimationFrame|playing\s*=/u);
});

test('presentation mode is reversible, focus-safe, and neutral to the working state',()=>{
  const start=app.indexOf("const PRESENTATION_MODES=Object.freeze(['compact','details'])");
  const end=app.indexOf('function updateContext',start);
  const source=app.slice(start,end);
  assert.ok(source.startsWith("const PRESENTATION_MODES=Object.freeze(['compact','details'])"));
  for(const forbidden of ['setDirty','render(','stopPlay','requestAnimationFrame','storageAdapter','localStorage','sessionStorage']){
    assert.equal(source.includes(forbidden),false,'presentation mode must not use '+forbidden);
  }
  assert.doesNotMatch(source,/\bstate\b|\bplaying\b|activeVisualView/u);

  const makeButton=()=>{
    const classes=new Set();
    return {
      attributes:new Map(),listeners:{},focused:false,classes,
      classList:{toggle(name,on){ if(on) classes.add(name); else classes.delete(name); }},
      setAttribute(name,value){ this.attributes.set(name,String(value)); },
      addEventListener(type,handler){ (this.listeners[type]??=[]).push(handler); },
      focus(){ this.focused=true; },
    };
  };
  const compact=makeButton(), details=makeButton(), cta=makeButton(), moves=[];
  const document={
    body:{dataset:{presentation:'compact'}},
    querySelectorAll(selector){
      assert.equal(selector,'.open-details');
      return [cta];
    },
  };
  const domainState={
    dirty:true,t:63,recovery:true,playing:true,speed:1.5,activeVisualView:'cross',selection:'rower-17',
    state:{
      editSeatId:'seat-4',referenceSeatId:'seat-1',
      seats:[{id:'seat-1',L:288},{id:'seat-4',L:289}],
      crew:[{seatId:'seat-1',rower:{name:'Testiel'}},{seatId:'seat-4',rower:{name:'Testiel 2'}}],
    },
  };
  const before=JSON.parse(JSON.stringify(domainState));
  const context={Object,document,domainState,placeCompactControls:mode=>moves.push(mode),
    $:id=>id==='presentationCompact'?compact:id==='presentationDetails'?details:null};
  vm.createContext(context);
  vm.runInContext(source,context);
  vm.runInContext('initPresentationMode()',context);

  assert.equal(document.body.dataset.presentation,'compact');
  assert.equal(compact.attributes.get('aria-pressed'),'true');
  assert.equal(details.attributes.get('aria-pressed'),'false');
  assert.equal(compact.classes.has('on'),true);
  assert.equal(details.classes.has('on'),false);
  for(const button of [compact,details,cta]) assert.equal(button.listeners.click.length,1);
  assert.deepEqual(moves,['compact']);

  details.listeners.click[0]();
  assert.equal(document.body.dataset.presentation,'details');
  assert.equal(compact.attributes.get('aria-pressed'),'false');
  assert.equal(details.attributes.get('aria-pressed'),'true');
  compact.listeners.click[0]();
  assert.equal(document.body.dataset.presentation,'compact');
  cta.listeners.click[0]();
  assert.equal(document.body.dataset.presentation,'details');
  assert.equal(details.focused,true,'focus moves to the visible details toggle when the CTA disappears');
  assert.equal(vm.runInContext("setPresentationMode('unknown')",context),false);
  assert.equal(document.body.dataset.presentation,'details');
  assert.deepEqual(moves,['compact','details','compact','details']);
  assert.deepEqual(domainState,before);
});

test('animation clock resumes the visible pose and applies tempo only to future frame time',()=>{
  const source=app.slice(app.indexOf('let playing=false'),app.indexOf('/* ================= Speichern / Laden'));
  assert.match(source,/animationProgress=cycleProgressFromStrokePose\(\{t:state\.t,recovery:state\.recovery\}\)/u);
  assert.match(source,/const elapsed=lastAnimationFrameTime===null\?0:Math\.max\(0,now-lastAnimationFrameTime\)/u);
  assert.match(source,/advanceStrokeCycle\(animationProgress,elapsed,parseFloat\(\$\('speed'\)\.value\)\)/u);
  assert.match(source,/strokePoseAtCycleProgress\(animationProgress\)/u);
  assert.doesNotMatch(source,/\bt0\b|2800\s*\/|\(now-t0\)|%period/u);
});

test('compact mode keeps warnings, core workflow, demos and saving while details retain every control',()=>{
  assert.match(index,/<body data-presentation="compact">/u);
  assert.match(index,/class="presentation-switch" role="group" aria-label="Darstellungsumfang" aria-describedby="presentationHint"/u);
  for(const [id,label] of [['presentationCompact','Kompakt'],['presentationDetails','Details']]){
    assert.match(index,new RegExp(`<button type="button" id="${id}"[^>]*>${label}<\\/button>`,'u'));
  }
  assert.doesNotMatch(index,/Trainer-Details|presentationTrainer|open-trainer-details/u);
  assert.equal((index.match(/\bopen-details\b/gu)??[]).length,1);
  assert.match(index,/class="open-details">Details öffnen<\/button>/u);
  assert.match(index,/class="compact-only">Visualisierung &amp; Kernwerte · schnelle Trimmarbeit<\/span>/u);
  assert.match(index,/class="details-only">Vollständige Mess- und Datenbearbeitung<\/span>/u);
  for(const id of ['compactRigSummary','compactProfileSummary','compactControlHost']) assert.match(index,new RegExp(`id="${id}"`,'u'));
  assert.match(app,/function renderCompactSummaries\(dv,r,catchSolution,modelSeat=activeSeat\(\)\)/u);
  assert.match(app,/renderCompactSummaries\(dv,primary\.r,primary\.catchSolution,state\.seats\.find\(seat=>seat\.id===primary\.seatId\)\)/u);
  assert.match(app,/SEG\(r\)\.height/u);

  const tagFor=id=>index.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`,'u'))?.[0]??'';
  for(const id of ['controls','bExport','bReset','rowerControls','boatSaveAs','boatUpdate','boatDelete','boatExport','boatImport','boatFile','dbSaveAs','dbUpdate','dbDelete','dbExport','dbImport','dbFile']){
    assert.match(tagFor(id),/details-only/u,id+' is exposed by Details');
  }
  assert.match(index,/<div class="namerow details-only"[^>]*>[\s\S]*?id="boatName"/u);
  assert.match(index,/<div class="namerow details-only">[\s\S]*?id="rowerName"/u);
  assert.match(index,/<details class="foot details-only">/u);
  for(const id of ['boatSelect','dbSelect','bSave','bLoad','loadTestielDemo','loadComparisonDemo','visualWorkbench','cards','chips','errorStatus','storageState','workspaceNotice']){
    assert.doesNotMatch(tagFor(id),/details-only/u,id+' remains in compact mode');
  }
  const notice=index.slice(index.indexOf('<section class="model-notice"'),index.indexOf('</section>',index.indexOf('<section class="model-notice"'))+10);
  assert.doesNotMatch(notice,/details-only/u);

  assert.match(v2Css,/body\[data-presentation="compact"\] \.details-only\s*\{\s*display:\s*none !important/u);
  assert.match(v2Css,/body\[data-presentation="details"\] \.compact-only\s*\{\s*display:\s*none !important/u);
  assert.doesNotMatch(v2Css,/trainer-details-only|compact-trainer-link/u);
  assert.match(v2Css,/\.presentation-switch\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/u);
  assert.match(v2Css,/\.presentation-switch button\s*\{[\s\S]*?min-block-size:\s*var\(--v2-touch\)[\s\S]*?min-inline-size:\s*0[\s\S]*?overflow-wrap:\s*anywhere/u);
  assert.match(v2Css,/@media \(forced-colors: active\)[\s\S]*?\.presentation-switch button\[aria-pressed="true"\][\s\S]*?background:\s*Highlight/u);
  assert.match(v2Css,/@media print[\s\S]*?body\[data-presentation\] \.details-only\s*\{\s*display:\s*revert !important/u);
  assert.match(v2Css,/body\[data-presentation="compact"\] #chips:not\(\.compact-has-warnings\)/u);
  assert.match(app,/chip\.compact\?'compact-critical':'details-only'/u);
  assert.match(app,/compact-has-warnings/u);
  assert.match(app,/const actualMissing=seat\.catchSolution\.actualAngleDeg===null/u);
  assert.match(app,/const angleLabel=compactLegend/u);
  const compactKeysSource=app.match(/const COMPACT_CONTROL_KEYS=Object\.freeze\(\[([\s\S]*?)\]\);/u)?.[1]??'';
  const compactKeys=[...compactKeysSource.matchAll(/'([^']+)'/gu)].map(match=>match[1]);
  assert.deepEqual(compactKeys,['IH','stemmX']);
  assert.equal(new Set(compactKeys).size,compactKeys.length,'compact controls remain unique');
  assert.equal((app.match(/\$\('presentationCompact'\)\.addEventListener\('click'/gu)??[]).length,1);
  assert.equal((app.match(/\$\('presentationDetails'\)\.addEventListener\('click'/gu)??[]).length,1);
});

test('compact rig summary follows the active height reference and water mode',()=>{
  assert.match(index,/id="compactRigTitle">Riggwerte zusammengefasst</u);
  assert.doesNotMatch(v2Css,/^\s*\+\s*[.#\[]/mu,'no patch marker may invalidate a selector list');

  const source=app.slice(
    app.indexOf('function compactDollenSummary('),
    app.indexOf('function renderSeatTabs('),
  );
  assert.ok(source.startsWith('function compactDollenSummary('));
  const state={
    mode:'werkstatt',heightRef:'sitz',seatOffset:5,editSeatId:'seat-3',phiA:66,
    seats:[{id:'seat-3',position:3}],
  };
  const outputs={};
  const context={
    state,
    fmt:value=>Number(value).toLocaleString('de-DE',{maximumFractionDigits:2}),
    cleanName:value=>value,
    SEG:()=>({height:185}),
    activeSeat:()=>state.seats.find(seat=>seat.id===state.editSeatId),
    seatLabel:seat=>seat.position===1?'Platz 1 · Bug':seat.position===4?'Platz 4 · Schlag':`Platz ${seat.position}`,
    $:id=>outputs[id]??=( {textContent:''} ),
  };
  vm.createContext(context);
  vm.runInContext(source,context);
  context.__dv={skull:true,dWL:23.75,phiA:65.5};
  context.__r={name:'Testiel',DA:159,IH:88,a:15,stemmX:48,wingspan:188,weight:80};
  context.__catch={naturalResolved:true,actualAngleDeg:66};

  vm.runInContext('renderCompactSummaries(__dv,__r,__catch)',context);
  assert.match(outputs.compactRigSummary.textContent,/^Platz 3 · Skull/u);
  assert.match(outputs.compactRigSummary.textContent,/Dollenhöhe ü\. Rollsitz 15 cm/u);
  assert.match(outputs.compactRigSummary.textContent,/Auslage Ist/u);

  state.heightRef='schiene';
  vm.runInContext('renderCompactSummaries(__dv,__r,__catch)',context);
  assert.match(outputs.compactRigSummary.textContent,/Dollenhöhe ü\. Schiene 20 cm/u);

  state.mode='wasser';
  vm.runInContext('renderCompactSummaries(__dv,__r,__catch)',context);
  assert.match(outputs.compactRigSummary.textContent,/Dollenhöhe ü\. Wasser 23,75 cm/u);
  assert.doesNotMatch(outputs.compactRigSummary.textContent,/Schiene|Rollsitz/u);
  Object.assign(context.__catch,{naturalResolved:false,actualAngleDeg:null});
  vm.runInContext('renderCompactSummaries(__dv,__r,__catch)',context);
  assert.match(outputs.compactRigSummary.textContent,/Auslage nicht bestimmbar · Prüfpose/u);
  assert.doesNotMatch(outputs.compactRigSummary.textContent,/Auslage Ist/u);
  Object.assign(context.__catch,{naturalResolved:true,actualAngleDeg:null});
  vm.runInContext('renderCompactSummaries(__dv,__r,__catch)',context);
  assert.match(outputs.compactRigSummary.textContent,/Auslage 3D nicht erreichbar · Prüfpose/u);
  assert.doesNotMatch(outputs.compactRigSummary.textContent,/Auslage Ist/u);
});

test('stable visual bounds contain all six poses and never depend on the active phase',()=>{
  const kinematics=app.slice(app.indexOf('function SEG('),app.indexOf('/* ---------------- Statuskarten'));
  const boundsSource=app.slice(
    app.indexOf('function stableVerticalViewBounds('),
    app.indexOf('function renderSide('),
  );
  assert.ok(boundsSource.startsWith('function stableVerticalViewBounds('));
  assert.doesNotMatch(boundsSource,/\.b\.|head\.y|state\.t|recovery|getBBox|scrollHeight/u);

  const rower={
    name:'Testiel',legLen:90,torsoLen:95,wingspan:188,SB:40,weight:80,stemmX:48,
    DA:159,IH:88,L:288,d:2,handGap:18,a:15,anlage:4,aussen:0,dBB:.5,stemmW:42,rollL:75,rueh:5,
  };
  const state={
    rig:'skull',strokeSide:1,phiA:66,phiR:44,t:0,recovery:false,c:8,kg:0,
    mode:'werkstatt',heightRef:'sitz',seatOffset:5,crew:{s1:rower,s2:rower},editSeat:'s1',
  };
  const context={
    Object,state,CATCH_MODEL,deriveBodySegments,findHighestReachableAngle,solveNaturalCatchAngle,
    rad:value=>value*Math.PI/180,
    deg:value=>value*180/Math.PI,
    lerp:(left,right,weight)=>left+(right-left)*weight,
    clamp:(value,min,max)=>Math.max(min,Math.min(max,value)),
  };
  context.smooth=value=>{
    value=context.clamp(value,0,1);
    return value*value*(3-2*value);
  };
  context.easeFromFloor=(value,floor,width)=>{
    if(!(width>0)) return Math.max(value,floor);
    if(value<=floor) return floor;
    if(value>=floor+width) return value;
    const u=(value-floor)/width;
    return floor+width*(2*u*u-u*u*u);
  };
  vm.createContext(context);
  vm.runInContext(kinematics+boundsSource,context);
  const dv=derivedGeometry({
    rig:'skull',DA:rower.DA,IH:rower.IH,L:rower.L,d:rower.d,a:rower.a,
    phiA:state.phiA,phiR:state.phiR,t:0,c:state.c,kg:state.kg,
  });
  context.__dv=dv; context.__rower=rower;
  const phases=[
    {t:0,rec:false},{t:25,rec:false},{t:50,rec:false},
    {t:75,rec:false},{t:100,rec:false},{t:50,rec:true},
  ];
  const heights=[];
  for(const phase of phases){
    state.t=phase.t; state.recovery=phase.rec;
    context.__t=phase.t; context.__rec=phase.rec;
    const body=vm.runInContext('solveBody(__dv,__t,__rec,__rower,state.phiA)',context);
    context.__seats=[{r:rower,dv,b:body,ox:0}];
    const bounds=vm.runInContext('stableVerticalViewBounds(__seats)',context);
    assert.ok(bounds.bottom<=-34,'Werkstattbock at -30 plus stroke reserve');
    assert.ok(body.head.y+body.head.r<bounds.top,'head and radius stay inside fixed top bound');
    assert.ok(body.foot.y>bounds.bottom,'feet stay inside fixed bottom bound');
    const x0=Math.min(-115,-dv.outb*Math.sin(context.rad(state.phiA))-14);
    const x1=Math.max(140,body.foot.x+70,dv.outb*Math.sin(context.rad(state.phiR))+14);
    const scale=(760-20)/(x1-x0);
    heights.push((bounds.top-bounds.bottom)*scale+24);
  }
  assert.ok(heights.every(Number.isFinite));
  assert.equal(new Set(heights.map(value=>value.toFixed(9))).size,1,'side SVG height is phase-invariant');

  state.mode='wasser';
  context.__seats=[{r:rower,dv,b:null,ox:0}];
  const water=vm.runInContext('stableVerticalViewBounds(__seats)',context);
  assert.equal(water.bottom,-22);
  assert.equal(Number.isFinite(water.top),true);

  const renderSideSource=app.slice(app.indexOf('function renderSide('),app.indexOf('/* ================= Phasen'));
  const renderCrossSource=app.slice(app.indexOf('function renderCross('),app.indexOf('/* ================= Seitenansicht'));
  assert.match(renderSideSource,/const vertical=stableVerticalViewBounds\(seats\)/u);
  assert.doesNotMatch(renderSideSource,/ytop=Math\.max\(ytop,\s*b\.head\.y/u);
  assert.match(renderCrossSource,/stableVerticalViewBounds\(\[primary\]\)/u);
  assert.doesNotMatch(renderCrossSource,/Math\.max\(pinY,body\.head\.y\)/u);
});

test('body and elbow motion stays closed and continuous through the automatic cycle',()=>{
  const kinematics=app.slice(app.indexOf('function SEG('),app.indexOf('/* ---------------- Statuskarten'));
  const state={
    rig:'skull',strokeSide:1,phiA:66,phiR:44,t:0,recovery:false,c:8,kg:0,
    mode:'werkstatt',heightRef:'sitz',seatOffset:5,
  };
  const context={
    Object,Math,state,CATCH_MODEL,deriveBodySegments,findHighestReachableAngle,solveNaturalCatchAngle,
    rad:value=>value*Math.PI/180,
    deg:value=>value*180/Math.PI,
    lerp:(left,right,weight)=>left+(right-left)*weight,
    clamp:(value,min,max)=>Math.max(min,Math.min(max,value)),
  };
  context.smooth=value=>{
    value=context.clamp(value,0,1);
    return value*value*(3-2*value);
  };
  vm.createContext(context);
  vm.runInContext(kinematics+';globalThis.motionPose=(dv,rower,t,recovery)=>{const body=solveBody(dv,t,recovery,rower,state.phiA);body.arms=solveArms(dv,body,rower);return body;};',context);

  const pointVector=body=>[
    body.hip.x,body.hip.y,body.kneeP.x,body.kneeP.y,body.sh.x,body.sh.y,
    body.head.x,body.head.y,body.hand.x,body.hand.y,
    ...body.arms.flatMap(arm=>[arm.S.x,arm.S.y,arm.S.z,arm.E.x,arm.E.y,arm.E.z,arm.W.x,arm.W.y,arm.W.z]),
  ];
  const maxDelta=(left,right)=>Math.max(...pointVector(left).map((value,index)=>Math.abs(value-pointVector(right)[index])));
  const elbowVector=body=>body.arms.flatMap(arm=>[arm.E.x,arm.E.y,arm.E.z]);
  const elbowDelta=(left,right)=>Math.max(...elbowVector(left).map((value,index)=>Math.abs(value-elbowVector(right)[index])));
  const torsoVector=body=>[
    body.hip.x,body.hip.y,body.sh.x,body.sh.y,body.c7.x,body.c7.y,
    ...body.arms.flatMap(arm=>[arm.S.x,arm.S.y,arm.S.z]),
  ];
  const rowerFor=(presetName,overrides={})=>{
    const preset=PRESETS[presetName];
    return {
      name:'Testiel',legLen:90,torsoLen:95,wingspan:188,SB:40,weight:80,
      stemmX:defaultFaForRig(preset.rig),DA:preset.DA,IH:preset.IH,L:preset.Lbig,
      d:2,handGap:18,a:preset.a,anlage:4,aussen:0,dBB:.5,stemmW:42,rollL:75,rueh:5,
      ...overrides,
    };
  };
  const poseAt=(dv,rower,progress)=>{
    const pose=strokePoseAtCycleProgress(progress);
    state.t=pose.t; state.recovery=pose.recovery;
    return context.motionPose(dv,rower,pose.t,pose.recovery);
  };
  const maximumMotionSteps=(dv,rower,steps)=>{
    let previous=poseAt(dv,rower,0), previousTorsoDelta=null;
    let elbow=0,torsoFirst=0,torsoSecond=0;
    for(let index=1;index<=steps;index+=1){
      const current=poseAt(dv,rower,index/steps);
      elbow=Math.max(elbow,elbowDelta(previous,current));
      const left=torsoVector(previous),right=torsoVector(current);
      const torsoDelta=right.map((value,coordinate)=>value-left[coordinate]);
      torsoFirst=Math.max(torsoFirst,...torsoDelta.map(Math.abs));
      if(previousTorsoDelta){
        torsoSecond=Math.max(torsoSecond,...torsoDelta.map((value,coordinate)=>Math.abs(value-previousTorsoDelta[coordinate])));
      }
      previousTorsoDelta=torsoDelta;
      previous=current;
    }
    return {elbow,torsoFirst,torsoSecond};
  };

  const cases=[
    ['1x',rowerFor('1x')],
    ['4x',rowerFor('4x')],
    ['4x · Testiel 2',rowerFor('4x',{name:'Testiel 2',legLen:84,torsoLen:91,wingspan:180,SB:38,weight:72})],
    ['4-',rowerFor('4-')],
  ];
  for(const [label,rower] of cases){
    const preset=PRESETS[label.startsWith('4x')?'4x':label];
    state.rig=preset.rig;
    state.phiA=preset.rig==='skull'?66:54;
    state.phiR=preset.rig==='skull'?44:36;
    const dv=derivedGeometry({
      rig:preset.rig,DA:rower.DA,IH:rower.IH,L:rower.L,d:rower.d,a:rower.a,
      phiA:state.phiA,phiR:state.phiR,t:0,c:state.c,kg:state.kg,
    });

    const recoveryCatch=context.motionPose(dv,rower,0,true);
    const driveCatch=context.motionPose(dv,rower,0,false);
    assert.ok(maxDelta(recoveryCatch,driveCatch)<1e-9,label+' has an identical start/end body pose');
    for(const speed of [.5,1,1.5]){
      const before=1-8.333*speed/2800;
      const after=advanceStrokeCycle(before,16.666,speed);
      assert.ok(maxDelta(poseAt(dv,rower,before),poseAt(dv,rower,after))<0.1,
        `${label} stays continuous across wrap at ${speed}x`);
    }

    // A true two-link singularity converges under refinement. The former
    // D3>=L3-0.5 shortcut retained a finite 2.8–3.4 cm elbow jump instead.
    const coarse=maximumMotionSteps(dv,rower,4000);
    const fine=maximumMotionSteps(dv,rower,16000);
    assert.ok(fine.elbow<1,`${label} maximum fine elbow step is ${fine.elbow.toFixed(3)} cm`);
    assert.ok(fine.elbow<coarse.elbow*.72,`${label} elbow step converges under refinement`);
    // Vierfach feinere Abtastung muss die erste Differenz ungefähr auf 1/4
    // und die zweite auf 1/16 senken. Harte Rollbahn-/Schulter-/Lift-Knicke
    // behalten dagegen eine endliche Beschleunigungsspitze und fallen hier auf.
    assert.ok(fine.torsoFirst<coarse.torsoFirst*.3,
      `${label} torso/shoulder position steps converge under refinement`);
    assert.ok(fine.torsoSecond<coarse.torsoSecond*.15,
      `${label} torso/shoulder acceleration stays continuous over the full cycle`);
  }
});

test('cross-section keeps the complete oar set inside stable bounds for skull and sweep',()=>{
  const kinematics=app.slice(app.indexOf('function SEG('),app.indexOf('/* ---------------- Statuskarten'));
  const svgHelpers=app.slice(app.indexOf("const NS='http://www.w3.org/2000/svg'"),app.indexOf('/* ================= Draufsicht'));
  const crossSource=app.slice(app.indexOf('function renderCross('),app.indexOf('function renderSide('));
  assert.match(crossSource,/const extX=DAr\+dv\.outb\+12/u);
  const extentLine=crossSource.match(/const extX=[^;]+;/u)?.[0]??'';
  assert.doesNotMatch(extentLine,/body|theta|state\.t|recovery|getBBox|scrollHeight/u);
  assert.doesNotMatch(crossSource,/clipPath|opacity:\s*0/u);
  assert.doesNotMatch(crossSource,/el\(svg,'ellipse',\{class:'cross-oar-blade'/u);

  class FakeNode{
    constructor(tag){ this.tag=tag; this.attributes=new Map(); this.children=[]; this.textContent=''; }
    setAttribute(name,value){ this.attributes.set(name,String(value)); }
    appendChild(child){ this.children.push(child); return child; }
    replaceChildren(...children){ this.children=[...children]; }
  }
  const host=new FakeNode('div');
  const bladeControl={value:'big'};
  const state={
    rig:'skull',strokeSide:1,phiA:66,phiR:44,t:0,recovery:false,c:8,kg:0,
    mode:'werkstatt',heightRef:'sitz',seatOffset:5,editSeat:'s1',
  };
  const context={
    Object,Math,String,state,CATCH_MODEL,deriveBodySegments,findHighestReachableAngle,solveNaturalCatchAngle,
    PHASES:[{n:'Auslage'}],currentPhase:()=>0,
    document:{createElementNS(_namespace,tag){ return new FakeNode(tag); }},
    $:id=>id==='vCross'?host:id==='blade'?bladeControl:null,
    cleanName:(value,fallback)=>String(value||fallback),
    fmt:(value,digits=1)=>Number(value).toFixed(digits).replace(/\.0$/u,''),
    rad:value=>value*Math.PI/180,
    deg:value=>value*180/Math.PI,
    lerp:(left,right,weight)=>left+(right-left)*weight,
    clamp:(value,min,max)=>Math.max(min,Math.min(max,value)),
  };
  context.smooth=value=>{
    value=context.clamp(value,0,1);
    return value*value*(3-2*value);
  };
  vm.createContext(context);
  vm.runInContext(kinematics+svgHelpers+crossSource,context);
  vm.runInContext('visualContentWidth=278',context);

  const frames=[];
  for(let t=0;t<=100;t+=5){
    frames.push({t,recovery:false});
    frames.push({t,recovery:true});
  }
  const flatten=node=>[node,...node.children.flatMap(flatten)];
  const hasClass=(node,name)=>(node.attributes.get('class')??'').split(/\s+/u).includes(name);

  for(const [presetName,expectedOars] of [['1x',2],['4x',2],['4-',1]]){
    const preset=PRESETS[presetName];
    bladeControl.value=presetName==='1x'?'big':'mac';
    const rower={
      name:'Testiel',legLen:90,torsoLen:95,wingspan:188,SB:40,weight:80,
      stemmX:defaultFaForRig(preset.rig),
      DA:preset.DA,IH:preset.IH,L:preset.Lbig,d:2,handGap:18,a:preset.a,
      anlage:4,aussen:0,dBB:.5,stemmW:42,rollL:75,rueh:5,
    };
    state.rig=preset.rig;
    state.phiA=preset.rig==='skull'?66:54;
    state.phiR=preset.rig==='skull'?44:36;
    const dv=derivedGeometry({
      rig:preset.rig,DA:rower.DA,IH:rower.IH,L:rower.L,d:rower.d,a:rower.a,
      phiA:state.phiA,phiR:state.phiR,t:0,c:state.c,kg:state.kg,
    });
    context.__dv=dv;
    context.__rower=rower;
    const viewBoxes=new Set();
    for(const frame of frames){
      state.t=frame.t;
      state.recovery=frame.recovery;
      context.__t=frame.t;
      context.__recovery=frame.recovery;
      const body=vm.runInContext('solveBody(__dv,__t,__recovery,__rower,state.phiA)',context);
      context.__body=body;
      body.arms=vm.runInContext('solveArms(__dv,__body,__rower)',context);
      context.__primary={b:body,r:rower,side:1,name:rower.name};
      vm.runInContext('renderCross(__dv,__primary)',context);
      assert.equal(host.children.length,1,presetName+' renders exactly one SVG');
      const svg=host.children[0];
      const viewBox=svg.attributes.get('viewBox');
      viewBoxes.add(viewBox);
      const [, , width, height]=viewBox.split(/\s+/u).map(Number);
      assert.equal(width,278,'cross-section uses the 320px viewport inner width');
      assert.ok(Number.isFinite(height)&&height>0);
      const nodes=flatten(svg);
      const shafts=nodes.filter(node=>hasClass(node,'cross-oar-shaft'));
      const blades=nodes.filter(node=>hasClass(node,'cross-oar-blade'));
      const pins=nodes.filter(node=>hasClass(node,'cross-oar-pin'));
      const labelPlates=nodes.filter(node=>hasClass(node,'cross-da-label-plate')||hasClass(node,'cross-pitch-label-plate'));
      assert.equal(shafts.length,expectedOars*2,presetName+' shaft count');
      assert.equal(blades.length,expectedOars,presetName+' blade count');
      assert.equal(pins.length,expectedOars,presetName+' pin count');
      assert.equal(labelPlates.length,2,presetName+' fixed cross-section label zones');
      const plateBounds=labelPlates.map(plate=>({
        left:Number(plate.attributes.get('x')),
        right:Number(plate.attributes.get('x'))+Number(plate.attributes.get('width')),
      })).sort((left,right)=>left.left-right.left);
      assert.ok(plateBounds.every(bounds=>bounds.left>=0&&bounds.right<=width),presetName+' label plates stay inside');
      assert.ok(plateBounds[0].right<=plateBounds[1].left,presetName+' DA and pitch plates do not overlap');
      assert.deepEqual(
        [...new Set(blades.map(node=>Number(node.attributes.get('data-oar-side'))))].sort((a,b)=>a-b),
        expectedOars===2?[-1,1]:[1],
        presetName+' visible oar sides',
      );
      for(const shaft of shafts){
        for(const key of ['x1','x2','y1','y2']){
          const value=Number(shaft.attributes.get(key));
          assert.ok(Number.isFinite(value),presetName+' finite '+key);
          const limit=key.startsWith('x')?width:height;
          assert.ok(value>=-1e-7&&value<=limit+1e-7,presetName+' '+key+' inside viewBox');
        }
      }
      for(const blade of blades){
        assert.equal(blade.tag,'path',presetName+' uses the shared Big/Macon silhouette');
        const coordinates=(blade.attributes.get('d')?.match(/-?\d+(?:\.\d+)?/gu)??[]).map(Number);
        assert.ok(coordinates.length>=12&&coordinates.length%2===0,presetName+' finite blade path');
        for(let index=0;index<coordinates.length;index+=2){
          const [x,y]=coordinates.slice(index,index+2);
          assert.ok(Number.isFinite(x)&&Number.isFinite(y),presetName+' finite blade point');
          assert.ok(x>=-1e-7&&x<=width+1e-7,presetName+' full blade width visible');
          assert.ok(y>=-1e-7&&y<=height+1e-7,presetName+' full blade height visible');
        }
        assert.notEqual(blade.attributes.get('opacity'),'0');
      }
      if(expectedOars===2){
        const pointsBySide=new Map(blades.map(blade=>[
          Number(blade.attributes.get('data-oar-side')),
          (blade.attributes.get('d')?.match(/-?\d+(?:\.\d+)?/gu)??[]).map(Number),
        ]));
        const left=pointsBySide.get(-1),right=pointsBySide.get(1);
        assert.equal(left.length,right.length,presetName+' paired blade point count');
        for(let index=0;index<left.length;index+=2){
          assert.ok(Math.abs((left[index]+right[index])-width)<=.21,
            presetName+' blade contours are mirrored horizontally');
          assert.ok(Math.abs(left[index+1]-right[index+1])<=.11,
            presetName+' blade contours share the same vertical projection');
        }
      }
    }
    assert.equal(viewBoxes.size,1,presetName+' viewBox stays phase-invariant over drive and recovery');
  }
});

test('top view keeps complete skull and sweep oars inside a responsive stable viewBox',()=>{
  const kinematics=app.slice(app.indexOf('function SEG('),app.indexOf('/* ---------------- Statuskarten'));
  const svgHelpers=app.slice(app.indexOf("const NS='http://www.w3.org/2000/svg'"),app.indexOf('/* ================= Draufsicht'));
  const topSource=app.slice(app.indexOf('function renderTop('),app.indexOf('/* ================= Querschnitt'));
  assert.match(topSource,/const latMax=DArMax\+outMax\+34/u);
  assert.doesNotMatch(topSource,/outMax\*Math\.max\(Math\.cos/u);

  class FakeNode{
    constructor(tag,id=''){ this.tag=tag; this.id=id; this.attributes=new Map(); this.children=[]; this.textContent=''; }
    setAttribute(name,value){ this.attributes.set(name,String(value)); }
    appendChild(child){ this.children.push(child); return child; }
    replaceChildren(...children){ this.children=[...children]; }
  }
  const host=new FakeNode('div','vTop');
  const bladeControl={value:'big'};
  const state={
    rig:'skull',strokeSide:1,phiA:85,phiR:60,t:0,recovery:false,c:8,kg:0,
    mode:'werkstatt',heightRef:'sitz',seatOffset:5,editSeat:'s1',
  };
  const cleanName=(value,fallback)=>String(value||fallback);
  const visualName=(value,fallback='Ruderer',maxLength=24)=>{
    const name=cleanName(value,fallback);
    return [...name].length<=maxLength?name:[...name].slice(0,maxLength-1).join('')+'…';
  };
  const phaseNames=['Auslage','Vord. Zug','Zugmitte','Hinterer Zug','Ausheben','Rückführung'];
  const context={
    Object,Math,String,Number,state,CATCH_MODEL,deriveBodySegments,findHighestReachableAngle,solveNaturalCatchAngle,
    PHASES:phaseNames.map(n=>({n})),currentPhase:()=>state.recovery?5:Math.min(4,Math.round(state.t/25)),
    document:{createElementNS(_namespace,tag){ return new FakeNode(tag); }},
    $:id=>id==='vTop'?host:id==='blade'?bladeControl:null,
    cleanName,visualName,
    fmt:(value,digits=1)=>Number(value).toFixed(digits).replace(/\.0$/u,''),
    rad:value=>value*Math.PI/180,
    deg:value=>value*180/Math.PI,
    lerp:(left,right,weight)=>left+(right-left)*weight,
    clamp:(value,min,max)=>Math.max(min,Math.min(max,value)),
  };
  context.smooth=value=>{
    value=context.clamp(value,0,1);
    return value*value*(3-2*value);
  };
  vm.createContext(context);
  vm.runInContext(kinematics+svgHelpers+topSource,context);
  vm.runInContext('visualContentWidth=278',context);

  const frames=[
    {t:0,recovery:false},{t:25,recovery:false},{t:50,recovery:false},
    {t:75,recovery:false},{t:100,recovery:false},{t:50,recovery:true},
  ];
  const flatten=node=>[node,...node.children.flatMap(flatten)];
  const hasClass=(node,name)=>(node.attributes.get('class')??'').split(/\s+/u).includes(name);
  const cases=[['1x',1,2],['4x',2,4],['4-',2,2]];
  for(const [presetName,profileCount,expectedOars] of cases){
    const preset=PRESETS[presetName];
    state.rig=preset.rig;
    state.phiA=presetName==='1x'?85:preset.rig==='skull'?66:54;
    state.phiR=presetName==='1x'?60:preset.rig==='skull'?44:36;
    const viewBoxes=new Set();
    for(const frame of frames){
      state.t=frame.t; state.recovery=frame.recovery;
      const seats=[];
      for(let index=0;index<profileCount;index+=1){
        const rower={
          name:index===0?'A'.repeat(80):'Testiel 2',legLen:index===0?90:84,torsoLen:index===0?95:90,
          wingspan:index===0?188:176,SB:index===0?40:38,weight:index===0?80:72,
          stemmX:defaultFaForRig(preset.rig),DA:preset.DA,IH:preset.IH,L:preset.Lbig,d:2,
          handGap:18,a:preset.a,anlage:4,aussen:0,dBB:.5,stemmW:42,rollL:75,rueh:5,
        };
        const actualCatch=preset.rig==='skull'?65:54;
        const dv=derivedGeometry({
          rig:preset.rig,DA:rower.DA,IH:rower.IH,L:rower.L,d:rower.d,a:rower.a,
          phiA:actualCatch,phiR:state.phiR,t:0,c:state.c,kg:state.kg,
        });
        context.__dv=dv; context.__rower=rower; context.__t=frame.t; context.__recovery=frame.recovery;
        const body=vm.runInContext('solveBody(__dv,__t,__recovery,__rower,__dv.phiA)',context);
        context.__body=body;
        body.arms=vm.runInContext('solveArms(__dv,__body,__rower)',context);
        seats.push({
          r:rower,dv,b:body,ox:index===0?0:-128,ref:index===0,side:index===0?1:-1,name:rower.name,
          catchSolution:{naturalResolved:true,actualAngleDeg:actualCatch,naturalAngleDeg:actualCatch,limitedByReach:false},
          reachAvailable:true,
        });
      }
      context.__dv=seats[0].dv; context.__seats=seats; context.__primary=seats[0];
      vm.runInContext('renderTop(__dv,__seats,__primary)',context);
      const svg=host.children[0];
      const viewBox=svg.attributes.get('viewBox');
      viewBoxes.add(viewBox);
      const [, , width, height]=viewBox.split(/\s+/u).map(Number);
      assert.equal(width,278,presetName+' uses the 320px viewport inner width as SVG user width');
      assert.ok(Number.isFinite(height)&&height>0);
      const nodes=flatten(svg);
      const shafts=nodes.filter(node=>hasClass(node,'top-oar-shaft'));
      const blades=nodes.filter(node=>hasClass(node,'top-oar-blade'));
      assert.equal(shafts.length,expectedOars,presetName+' shaft count');
      assert.equal(blades.length,expectedOars,presetName+' blade count');
      for(const shaft of shafts){
        for(const key of ['x1','x2','y1','y2']){
          const value=Number(shaft.attributes.get(key));
          const limit=key.startsWith('x')?width:height;
          assert.ok(Number.isFinite(value)&&value>=-1e-7&&value<=limit+1e-7,`${presetName} shaft ${key} inside viewBox`);
        }
      }
      for(const blade of blades){
        const pairs=[...String(blade.attributes.get('d')).matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/gu)];
        assert.ok(pairs.length>=3,presetName+' blade path has finite vertices');
        for(const pair of pairs){
          const x=Number(pair[1]), y=Number(pair[2]);
          assert.ok(x>=-1e-7&&x<=width+1e-7,`${presetName} blade x inside viewBox`);
          assert.ok(y>=-1e-7&&y<=height+1e-7,`${presetName} blade y inside viewBox`);
        }
      }
      const title=nodes.find(node=>node.tag==='title');
      const description=nodes.find(node=>node.tag==='desc');
      assert.ok(title?.textContent.includes('A'.repeat(80)),'full valid name remains in accessible title');
      assert.ok(description?.textContent.includes('A'.repeat(80)),'full valid name remains in accessible description');
      const visibleTexts=nodes.filter(node=>node.tag==='text').map(node=>node.textContent);
      assert.equal(visibleTexts.some(text=>text.includes('A'.repeat(80))),false,'visible SVG labels use bounded names');
      for(const textNode of nodes.filter(node=>node.tag==='text')){
        const x=Number(textNode.attributes.get('x'));
        const fontSize=hasClass(textNode,'big')?15:hasClass(textNode,'cap')?11.5:12.5;
        const estimatedWidth=[...textNode.textContent].length*fontSize*0.56;
        const anchor=textNode.attributes.get('text-anchor')??'start';
        const left=anchor==='end'?x-estimatedWidth:anchor==='middle'?x-estimatedWidth/2:x;
        const right=anchor==='end'?x:anchor==='middle'?x+estimatedWidth/2:x+estimatedWidth;
        assert.ok(left>=-2&&right<=width+2,`${presetName} compact SVG text stays within the 320px viewBox: ${textNode.textContent}`);
      }
    }
    assert.equal(viewBoxes.size,1,presetName+' responsive viewBox remains phase-invariant');
  }
});

test('the workbench preserves every V1 id and every full visual behind one accessible action',()=>{
  const ids=html=>[...html.matchAll(/\bid="([^"]+)"/gu)]
    .map(match=>match[1])
    .filter(id=>!/[\${}]/u.test(id));
  const v1Ids=ids(v1Index), v2Ids=ids(index);
  assert.ok(v1Ids.length>=62);
  assert.match(v1Index,/id="v_\$\{c\.k\}"/u);
  assert.match(v1Index,/id="in_\$\{c\.k\}"/u);
  assert.match(app,/value\.id=`v_\$\{c\.k\}`/u);
  assert.match(app,/input\.id=`in_\$\{c\.k\}`/u);
  for(const id of new Set(v1Ids)){
    assert.equal(v2Ids.filter(candidate=>candidate===id).length,1,`V1 id ${id} must exist exactly once in V2`);
  }
  for(const id of new Set(v2Ids)){
    assert.equal(v2Ids.filter(candidate=>candidate===id).length,1,`V2 id ${id} must be unique`);
  }

  assert.equal((index.match(/role="tab"/gu)??[]).length,3);
  assert.equal((index.match(/role="tabpanel"/gu)??[]).length,3);
  for(const view of ['Top','Side','Cross']){
    assert.match(index,new RegExp(`id="viewTab${view}"[^>]*aria-controls="viewPanel${view}"`,'u'));
    assert.match(index,new RegExp(`id="viewPanel${view}"[^>]*aria-labelledby="viewTab${view}"`,'u'));
  }
  const workbench=index.slice(index.indexOf('id="visualWorkbench"'),index.indexOf('<section class="status-rail"'));
  for(const id of ['vTop','vSide','vCross','play','speed','speedV','phases','phN','phName','bodyTab']){
    assert.ok(workbench.includes(`id="${id}"`),`${id} stays inside the visual workbench`);
  }
  assert.ok(index.indexOf('id="visualWorkbench"')<index.indexOf('id="rowerSection"'));
  assert.match(index,/id="vTop"><\/div>/u);
  assert.match(index,/id="vSide"><\/div>/u);
  assert.match(index,/id="vCross"><\/div>/u);
  assert.match(app,/svg\.setAttribute\('role','img'\)/u);
  assert.match(app,/renderTop\(dv,seats,primary\);\s*renderCross\(dv,primary\);\s*renderSide\(dv,seats,primary,refs\);/u);
  assert.match(v2Css,/\.visual-tabs\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/u);
  assert.match(v2Css,/@media print[\s\S]*?\.view-panel\[hidden\]\s*\{\s*display:\s*block !important/u);
  assert.match(v2Css,/@media \(max-width: 560px\)[\s\S]*?\.visual-controls\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/u);
});

test('crew scope reports honest occupied and total real seats without inventing a crew',()=>{
  const start=app.indexOf('function crewScopeLabel(');
  const end=app.indexOf('function compactDollenSummary(',start);
  const source=app.slice(start,end);
  const state={seats:[],crew:[]};
  const context={String,state,assignmentFor:seatId=>state.crew.find(assignment=>assignment.seatId===seatId)??null};
  vm.createContext(context);
  vm.runInContext(source,context);
  for(const [preset,total,occupied,expected] of [
    ['1x',1,1,'1/1 belegt · 1x'],
    ['wmM1x',1,1,'1/1 belegt · 1x'],
    ['4x',4,2,'2/4 belegt · 4x'],
    ['8+',8,0,'0/8 belegt · 8+'],
    ['wmW8+',8,2,'2/8 belegt · 8+'],
    ['gigR',3,2,'2/3 belegt · gigR'],
  ]){
    state.seats=Array.from({length:total},(_,index)=>({id:`seat-${index+1}`,position:index+1,rowerRef:null}));
    state.crew=state.seats.slice(0,occupied).map(seat=>({seatId:seat.id,rower:{name:`Profil ${seat.position}`}}));
    assert.equal(vm.runInContext(`crewScopeLabel('${preset}')`,context),expected);
  }
  state.seats=[{id:'seat-1',position:1,rowerRef:null},{id:'seat-2',position:2,rowerRef:{id:'missing',revision:1}}];
  state.crew=[{seatId:'seat-1',rower:{name:'Testiel'}}];
  assert.equal(vm.runInContext("crewScopeLabel('2x')",context),'1/2 belegt · 2x · 1 Referenz ungeklärt');
  assert.match(index,/id="crewScope">1\/1 belegt · 1x/u);
  assert.doesNotMatch(app,/\bdefaultSecond\b|state\.crew\.s[12]\b|crew\.s3|crew\.s4|crew\.s8/iu);
});

test('active seat assignment status distinguishes free, missing, stale, unsaved and resolved profiles',()=>{
  const resolutionSource=app.slice(app.indexOf('function assignmentResolution('),app.indexOf('function crewScopeLabel('));
  const statusSource=app.slice(app.indexOf('function renderAssignmentStatus('),app.indexOf('function renderSeatTabs('));
  assert.ok(resolutionSource.startsWith('function assignmentResolution('));
  assert.ok(statusSource.startsWith('function renderAssignmentStatus('));

  const state={seats:[],crew:[]};
  const records=new Map();
  const elements={
    seatAssignmentStatus:{textContent:''},
    seatCreateDraft:{disabled:false},
    quickEditPerson:{disabled:false},
    quickEditBoat:{disabled:false},
    seatUnassign:{disabled:false},
  };
  const context={
    state,
    rowerRepository:{select(id){ return records.get(id)??{ok:false,record:null}; }},
    assignmentFor:seatId=>state.crew.find(assignment=>assignment.seatId===seatId)??null,
    activeSeat:()=>state.seats.find(seat=>seat.id===state.editSeatId)??state.seats[0]??null,
    activeAssignment:()=>{
      const seat=state.seats.find(candidate=>candidate.id===state.editSeatId)??state.seats[0]??null;
      return seat?state.crew.find(assignment=>assignment.seatId===seat.id)??null:null;
    },
    seatLabel:seat=>seat.position===1?'Platz 1 · Schlagmann':`Platz ${seat.position}`,
    cleanName:(value,fallback)=>value||fallback,
    $:id=>elements[id],
  };
  vm.createContext(context);
  vm.runInContext(resolutionSource+statusSource,context);
  const render=()=>vm.runInContext('renderAssignmentStatus()',context);

  render();
  assert.match(elements.seatAssignmentStatus.textContent,/Kein Bootsplatz/u);
  assert.equal(elements.seatCreateDraft.disabled,true);
  assert.equal(elements.seatUnassign.disabled,true);

  const seat={id:'seat-2',position:2,rowerRef:null};
  state.seats=[seat]; state.editSeatId=seat.id; state.crew=[];
  render();
  assert.match(elements.seatAssignmentStatus.textContent,/ist frei.*Körperrechnung aus/u);
  assert.equal(elements.seatCreateDraft.disabled,false);
  assert.equal(elements.seatUnassign.disabled,true);

  seat.rowerRef={id:'missing-profile',revision:1};
  render();
  assert.match(elements.seatAssignmentStatus.textContent,/nicht verfügbares Profil/u);
  assert.equal(elements.seatUnassign.disabled,false);

  seat.rowerRef=null;
  state.crew=[{seatId:seat.id,rowerRef:null,rower:{name:'Entwurf'}}];
  render();
  assert.match(elements.seatAssignmentStatus.textContent,/nur im Arbeitsstand.*noch nicht als Profil gespeichert/u);

  const linked={id:'profile-1',revision:1};
  seat.rowerRef=linked; state.crew=[{seatId:seat.id,rowerRef:linked,rower:{name:'Gespeichert'}}];
  records.set(linked.id,{ok:true,record:{id:linked.id,revision:1}});
  render();
  assert.match(elements.seatAssignmentStatus.textContent,/mit der gespeicherten Profilrevision verbunden/u);

  records.set(linked.id,{ok:true,record:{id:linked.id,revision:2}});
  render();
  assert.match(elements.seatAssignmentStatus.textContent,/gespeicherten Snapshot.*andere Revision/u);
});

test('visual comparison renders at most the stable reference and active occupied seats',()=>{
  const source=app.slice(app.indexOf('function buildSeats()'),app.indexOf('function render(){',app.indexOf('function buildSeats()')));
  assert.ok(source.startsWith('function buildSeats()'));
  const state={
    strokeSide:1,referenceSeatId:'seat-1',editSeatId:'seat-4',t:50,recovery:false,phiA:66,
    seats:Array.from({length:4},(_,index)=>({id:`seat-${index+1}`,position:index+1})),
  };
  const occupied=new Set(['seat-1','seat-2','seat-4']);
  const context={
    Math,state,SEATGAP:128,
    runtimeForSeat:seat=>occupied.has(seat.id)?{name:`Profil ${seat.position}`} : null,
    assignmentResolution:()=> 'resolved',
    resolveCatchAngle:()=>({poseAngleDeg:66,reachable:true,naturalResolved:true,limitedByReach:false}),
    derived:()=>({}),
    solveBody:()=>({arms:[],overreach:false}),
    solveArms:()=>[],
  };
  vm.createContext(context);
  vm.runInContext(source,context);
  const ids=()=>Array.from(vm.runInContext('buildSeats()',context),seat=>seat.seatId);
  assert.deepEqual(ids(),['seat-1','seat-4']);
  state.editSeatId='seat-1';
  assert.deepEqual(ids(),['seat-1','seat-2'],'reference=active adds at most one occupied comparison');
  state.referenceSeatId='seat-3'; state.editSeatId='seat-4';
  assert.deepEqual(ids(),['seat-4'],'a free reference is never replaced by an invented person');
  occupied.clear();
  assert.deepEqual(ids(),[],'an entirely free boat renders no synthetic rower');
});

test('profile deletion blocks current and saved-boat references, while reports retain free seats',()=>{
  const deleteHandler=app.slice(app.indexOf('function storedRowerReferences'),app.indexOf("$('dbExport').addEventListener"));
  assert.match(deleteHandler,/state\.seats\.filter\(seat=>seat\.rowerRef\?\.id===id\)/u);
  assert.match(deleteHandler,/workspaceRepository\.get\(\)/u);
  assert.match(deleteHandler,/boatRepository\.list\(\)\.flatMap\(record=>record\.value\.seats\s*\.filter\(seat=>seat\.rowerRef\?\.id===id\)/u);
  const referenceBlock=deleteHandler.indexOf('if(references.length)');
  const destructiveWrite=deleteHandler.indexOf('rowerRepository.delete(');
  assert.ok(referenceBlock>=0&&destructiveWrite>referenceBlock,'reference check precedes profile deletion');
  assert.match(deleteHandler,/Erst Plätze freigeben, dann löschen/u);
  assert.ok(deleteHandler.indexOf('confirm(`Profil')<deleteHandler.indexOf('repositoryWrite(workspaceRepository'),
    'human confirmation must happen before the first repository lock');
  assert.ok(deleteHandler.indexOf('repositoryWrite(workspaceRepository')<deleteHandler.indexOf('repositoryWrite(boatRepository')
    &&deleteHandler.indexOf('repositoryWrite(boatRepository')<deleteHandler.indexOf('repositoryWrite(rowerRepository'),
    'the nested delete lock order is workspace, boats, then rowers');
  assert.match(deleteHandler,/assertNoRetiredRowerReferences/u);
  assert.match(index,/id="masterPersonDelete"[^>]*aria-describedby="masterPersonStatus"[^>]*disabled/u);

  const exportHandler=app.slice(app.indexOf("$('bExport').addEventListener"),app.indexOf("$('bReset').addEventListener"));
  assert.match(exportHandler,/for\(const seat of state\.seats\)/u);
  assert.match(exportHandler,/if\(!assignment\)\{[\s\S]*?results\[seat\.id\]=\{[\s\S]*?status:seat\.rowerRef\?'profile-reference-unresolved':'free'[\s\S]*?modelStatus:'notCalculated'[\s\S]*?continue;/u);
  assert.doesNotMatch(exportHandler,/config\.crew\[seat\]|defaultSecond|state\.crew\.s[12]/u);
  assert.match(exportHandler,/privacy:includeNames\?'names-included':'anonymized'/u);
  assert.match(exportHandler,/privacyNotice:'Enthält nur den aktuellen Arbeitsstand/u);
  assert.match(exportHandler,/rowerRef:includeNames\?seat\.rowerRef:null/u);
  assert.match(exportHandler,/rowerRef:includeNames\?assignment\.rowerRef:null/u);
  const reportBlock=exportHandler.slice(exportHandler.indexOf('const report={'),exportHandler.indexOf('downloadJson(report'));
  assert.equal((reportBlock.match(/\bprivacy:/gu)??[]).length,1,'machine-readable privacy mode must not be overwritten');
});

test('actual catch stays separate from the rig target and never turns the uncalibrated model green',()=>{
  const functionSource=app.slice(
    app.indexOf('function actualCatchStatusCard('),
    app.indexOf('function renderStatus('),
  );
  assert.ok(functionSource.startsWith('function actualCatchStatusCard('));
  const context={
    fmt:value=>String(value).replace('.',','),
  };
  vm.createContext(context);
  vm.runInContext(functionSource,context);

  context.__geometry={skull:true,phiA:30};
  context.__unresolved={naturalResolved:false,naturalCandidateAngleDeg:87.999,residualCm:-3.839,reachable:true};
  const unresolved=vm.runInContext('actualCatchStatusCard(__geometry,66,__unresolved)',context);
  assert.equal(unresolved.v,'nicht bestimmbar');
  assert.equal(unresolved.st,'bad');
  assert.match(unresolved.rng,/Suchgrenze 87,999° · Restfehler -3,839 cm · Rigg-Ziel 66°/u);

  context.__unreachable={naturalResolved:true,reachable:false,naturalAngleDeg:31.25,limitedByReach:false};
  const unavailable=vm.runInContext('actualCatchStatusCard(__geometry,66,__unreachable)',context);
  assert.equal(unavailable.v,'nicht erreichbar');
  assert.equal(unavailable.st,'bad');
  assert.match(unavailable.rng,/Natural-Catch 31,25° · Rigg-Ziel 66°/u);

  context.__geometry={skull:true,phiA:51.25};
  context.__limited={naturalResolved:true,reachable:true,naturalAngleDeg:54,limitedByReach:true};
  const limited=vm.runInContext('actualCatchStatusCard(__geometry,66,__limited)',context);
  assert.match(limited.rng,/Rigg-Ziel 66°/u);
  assert.equal(limited.st,'warn');

  context.__geometry={skull:true,phiA:66};
  context.__available={naturalResolved:true,reachable:true,naturalAngleDeg:66,limitedByReach:false};
  const available=vm.runInContext('actualCatchStatusCard(__geometry,66,__available)',context);
  assert.equal(available.v,'66°');
  assert.equal(available.st,'info');
  assert.match(available.rng,/58°\/16°-Prüfmodell, unkalibriert/u);
});

test('new preset poses use a cached modelled catch and retain both real grip targets',()=>{
  const derivedSource=app.slice(app.indexOf('function derived('),app.indexOf('function band('));
  const kinematicsSource=app.slice(app.indexOf('function SEG('),app.indexOf('/* ---------------- Statuskarten'));
  assert.ok(derivedSource.startsWith('function derived('));
  assert.ok(kinematicsSource.startsWith('function SEG('));

  for(const [presetName,preset] of Object.entries(PRESETS)){
    for(const blade of ['big','mac']){
      const requestedAngle=preset.rig==='skull'?66:54;
      const rower={
        name:'Schlagmann',legLen:90,torsoLen:95,wingspan:188,SB:40,weight:80,
        stemmX:defaultFaForRig(preset.rig),
        DA:preset.DA,IH:preset.IH,L:blade==='big'?preset.Lbig:preset.Lmac,d:2,
        handGap:18,a:preset.a,anlage:4,aussen:0,dBB:0.5,stemmW:42,rollL:75,rueh:5,
      };
      const state={
        rig:preset.rig,strokeSide:1,phiA:requestedAngle,phiR:preset.rig==='skull'?44:36,
        t:0,recovery:false,c:8,kg:0,mode:'werkstatt',heightRef:'sitz',seatOffset:5,
        crew:{s1:rower,s2:rower},editSeat:'s1',
      };
      const context={
        state,CATCH_MODEL,deriveBodySegments,derivedGeometry,findHighestReachableAngle,
        solveNaturalCatchAngle,activeRower:()=>rower,
        rad:value=>value*Math.PI/180,
        deg:value=>value*180/Math.PI,
        lerp:(left,right,weight)=>left+(right-left)*weight,
        clamp:(value,min,max)=>Math.max(min,Math.min(max,value)),
      };
      context.smooth=value=>{
        value=context.clamp(value,0,1);
        return value*value*(3-2*value);
      };
      vm.createContext(context);
      vm.runInContext(derivedSource+kinematicsSource,context);
      context.__rower=rower;
      const result=vm.runInContext('resolveCatchAngle(__rower)',context);
      const geometry=vm.runInContext('derived(__rower,__catch.poseAngleDeg)',Object.assign(context,{__catch:result}));
      context.__geometry=geometry;
      const body=vm.runInContext('solveBody(__geometry,0,false,__rower,__catch.poseAngleDeg)',context);
      context.__body=body;
      const arms=vm.runInContext('solveArms(__geometry,__body,__rower)',context);
      const label=`${presetName}/${blade}`;

      assert.ok(result.actualAngleDeg>=CATCH_MODEL.search.minDeg&&result.actualAngleDeg<=CATCH_MODEL.search.maxDeg,`${label}: finite actual catch`);
      assert.equal(result.naturalResolved,true,`${label}: natural catch has a root`);
      assert.equal(result.reachable,true,`${label}: reach available`);
      assert.equal(result.modelStatus,'needsCalibration',`${label}: no trainer approval`);
      state.t=73;
      assert.equal(vm.runInContext('resolveCatchAngle(__rower)===__catch',context),true,`${label}: phase-neutral cache`);
      assert.equal(body.overreach,false,`${label}: body target reachable`);
      assert.equal(arms.length,2,`${label}: both grip targets`);
      for(const arm of arms){
        const targetDistance=Math.hypot(
          arm.targetW.x-arm.S.x,
          arm.targetW.y-arm.S.y,
          arm.targetW.z-arm.S.z,
        );
        assert.equal(Number.isFinite(targetDistance),true,`${label}: finite target distance`);
        assert.equal(arm.reachable,true,`${label}: actual grip reachable`);
        assert.ok(targetDistance<=body.seg.OA+body.seg.UA+0.05+1e-9,`${label}: unchanged segment limit`);
      }
    }
  }
});

test('an unbracketed Natural Catch remains a labelled model pose instead of an actual angle',()=>{
  const preset=PRESETS['4x'];
  const rower={name:'Grenzprofil',legLen:105,torsoLen:110,wingspan:215,SB:48,weight:80,
    stemmX:56,DA:preset.DA,IH:preset.IH,L:preset.Lbig,d:2,handGap:18,a:preset.a,
    anlage:4,aussen:0,dBB:.5,stemmW:42,rollL:75,rueh:5};
  const state={rig:'skull',strokeSide:1,phiA:66,phiR:44,t:0,recovery:false,c:8,kg:0,
    mode:'werkstatt',heightRef:'sitz',seatOffset:5,crew:{s1:rower,s2:rower},editSeat:'s1'};
  const context={state,CATCH_MODEL,deriveBodySegments,derivedGeometry,findHighestReachableAngle,
    solveNaturalCatchAngle,activeRower:()=>rower,rad:value=>value*Math.PI/180,
    deg:value=>value*180/Math.PI,lerp:(a,b,t)=>a+(b-a)*t,
    clamp:(value,min,max)=>Math.max(min,Math.min(max,value))};
  context.smooth=value=>{ value=context.clamp(value,0,1); return value*value*(3-2*value); };
  vm.createContext(context);
  const derivedSource=app.slice(app.indexOf('function derived('),app.indexOf('function band('));
  const kinematicsSource=app.slice(app.indexOf('function SEG('),app.indexOf('/* ---------------- Statuskarten'));
  vm.runInContext(derivedSource+kinematicsSource,context);
  context.__rower=rower;
  const result=vm.runInContext('resolveCatchAngle(__rower)',context);
  assert.equal(result.naturalResolved,false);
  assert.equal(result.actualAngleDeg,null);
  assert.ok(result.poseAngleDeg>87.9&&Number.isFinite(result.poseAngleDeg));
  assert.equal(result.reachable,true,'3D reach does not turn a missing Natural-Catch root into an actual angle');

  const sweepPreset=PRESETS['2-'];
  const sweepRower={name:'3D-Grenzprofil',legLen:70,torsoLen:75,wingspan:150,SB:32,weight:50,
    stemmX:26,DA:sweepPreset.DA,IH:sweepPreset.IH,L:sweepPreset.Lbig,d:2,handGap:14,a:11,
    anlage:4,aussen:0,dBB:.5,stemmW:42,rollL:68,rueh:12};
  Object.assign(state,{rig:'riemen',phiA:54,phiR:36,c:5,kg:-20,crew:{s1:sweepRower,s2:sweepRower}});
  context.__rower=sweepRower;
  const unreachable=vm.runInContext('resolveCatchAngle(__rower)',context);
  assert.equal(unreachable.naturalResolved,true);
  assert.equal(unreachable.reachable,false);
  assert.equal(unreachable.actualAngleDeg,null);
  assert.equal(unreachable.poseAngleDeg,CATCH_MODEL.search.minDeg);
});

test('skull and sweep kinematics stay finite and continuous across all six phases and two body profiles',()=>{
  const derivedSource=app.slice(app.indexOf('function derived('),app.indexOf('function band('));
  const kinematicsSource=app.slice(app.indexOf('function SEG('),app.indexOf('/* ---------------- Statuskarten'));
  for(const presetName of ['1x','4-']){
    const preset=PRESETS[presetName];
    const profiles=[
      {name:'Testiel',legLen:90,torsoLen:95,wingspan:188,SB:40,weight:80},
      {name:'Testiel 2',legLen:84,torsoLen:90,wingspan:176,SB:38,weight:72},
    ];
    for(const profile of profiles){
      const rower={...profile,stemmX:defaultFaForRig(preset.rig),DA:preset.DA,IH:preset.IH,
        L:preset.Lbig,d:2,handGap:18,a:preset.a,anlage:4,aussen:0,dBB:.5,stemmW:42,rollL:75,rueh:5};
      const state={rig:preset.rig,strokeSide:1,phiA:preset.rig==='skull'?66:54,
        phiR:preset.rig==='skull'?44:36,t:0,recovery:false,c:8,kg:0,mode:'werkstatt',
        heightRef:'sitz',seatOffset:5,crew:{s1:rower,s2:rower},editSeat:'s1'};
      const context={state,CATCH_MODEL,deriveBodySegments,derivedGeometry,findHighestReachableAngle,
        solveNaturalCatchAngle,activeRower:()=>rower,rad:value=>value*Math.PI/180,
        deg:value=>value*180/Math.PI,lerp:(a,b,t)=>a+(b-a)*t,
        clamp:(value,min,max)=>Math.max(min,Math.min(max,value))};
      context.smooth=value=>{ value=context.clamp(value,0,1); return value*value*(3-2*value); };
      vm.createContext(context);
      vm.runInContext(derivedSource+kinematicsSource,context);
      context.__rower=rower;
      context.__catch=vm.runInContext('resolveCatchAngle(__rower)',context);
      context.__geometry=vm.runInContext('derived(__rower,__catch.poseAngleDeg)',context);
      for(const recovery of [false,true]){
        let previous=null;
        for(let t=0;t<=100;t+=1){
          state.t=t; state.recovery=recovery;
          context.__t=t; context.__recovery=recovery;
          const body=vm.runInContext('solveBody(__geometry,__t,__recovery,__rower,__catch.poseAngleDeg)',context);
          context.__body=body;
          const arms=vm.runInContext('solveArms(__geometry,__body,__rower)',context);
          const numeric=[body.hip.x,body.hip.y,body.knee,body.lam,body.hand.x,body.hand.y,
            body.head.x,body.head.y,...arms.flatMap(arm=>[arm.S.x,arm.S.y,arm.S.z,arm.E.x,arm.E.y,arm.E.z,arm.W.x,arm.W.y,arm.W.z])];
          assert.ok(numeric.every(Number.isFinite),`${presetName}/${profile.name}/${recovery?'recovery':'drive'} t=${t}: finite`);
          assert.equal(arms.length,2,`${presetName}/${profile.name}/${recovery?'recovery':'drive'} t=${t}: both arm paths remain present`);
          assert.ok(arms.every(arm=>typeof arm.reachable==='boolean'&&arm.targetW),
            `${presetName}/${profile.name}/${recovery?'recovery':'drive'} t=${t}: 3D diagnostics remain explicit`);
          if(previous){
            assert.ok(Math.abs(body.hip.x-previous.body.hip.x)<3,'hip path has no per-step jump');
            assert.ok(Math.abs(body.knee-previous.body.knee)<4,'knee path has no per-step jump');
            assert.ok(Math.abs(body.lam-previous.body.lam)<6,'torso/elbow transition has no per-step jump');
            for(let index=0;index<arms.length;index+=1){
              const a=arms[index].E, b=previous.arms[index].E;
              assert.ok(Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<8,'elbow path has no per-step jump');
            }
          }
          previous={body,arms};
        }
      }
    }
  }
});

test('range and numeric measurement inputs share one validated state path',()=>{
  const numericSource=app.slice(
    app.indexOf('function numericDraftError('),
    app.indexOf('function placeCompactControls('),
  );
  assert.ok(numericSource.startsWith('function numericDraftError('));

  class FakeNode{
    constructor(tag){
      this.tag=tag;
      this.attributes=new Map();
      this.children=[];
      this.listeners=new Map();
      this.classList={add:()=>{}};
      this.value='';
      this.textContent='';
      this.hidden=false;
      this.disabled=false;
    }
    setAttribute(name,value){ this.attributes.set(name,String(value)); }
    getAttribute(name){ return this.attributes.get(name)??null; }
    append(...children){ this.children.push(...children); }
    appendChild(child){ this.children.push(child); return child; }
    replaceChildren(...children){ this.children=[...children]; }
    addEventListener(type,handler){ this.listeners.set(type,handler); }
    querySelectorAll(){ return []; }
    querySelector(){ return null; }
  }
  const findById=(node,id)=>{
    if(node.id===id) return node;
    for(const child of node.children??[]){
      const found=findById(child,id);
      if(found) return found;
    }
    return null;
  };
  const host=new FakeNode('div');
  let canonical=88;
  const writes=[];
  let renders=0;
  const announcements=[];
  const context={
    console,Math,Number,String,Set,
    state:{rig:'skull',recovery:true},
    RANGES:{skull:{}},
    PROFILE_KEYS:new Set(),
    COMPACT_CONTROL_KEY_SET:new Set(),
    document:{createElement:tag=>new FakeNode(tag)},
    $:id=>id==='rowerControls'?host:null,
    getVal:()=>canonical,
    setVal:(_key,value)=>{ canonical=value; writes.push(value); },
    render:()=>{ renders+=1; },
    announce:message=>announcements.push(message),
    fmt:value=>String(value).replace('.',','),
  };
  vm.createContext(context);
  vm.runInContext(`${numericSource}; globalThis.buildTestControls=buildInto; globalThis.testNumericDraftError=numericDraftError;`,context);

  assert.equal(context.testNumericDraftError('',80,100,.5),'Wert erforderlich.');
  assert.equal(context.testNumericDraftError('abc',80,100,.5),'Bitte eine gültige Zahl eingeben.');
  assert.match(context.testNumericDraftError('79.5',80,100,.5),/Erlaubter Bereich/u);
  assert.match(context.testNumericDraftError('88.25',80,100,.5),/Schrittweite/u);
  assert.equal(context.testNumericDraftError('88.5',80,100,.5),'');

  context.buildTestControls([{k:'IH',lab:'Innenhebel',unit:'cm',min:80,max:100,step:.5}],'rowerControls');
  const range=findById(host,'in_IH');
  const number=findById(host,'num_IH');
  const error=findById(host,'err_IH');
  assert.ok(range&&number&&error);
  assert.deepEqual([number.min,number.max,number.step],[range.min,range.max,range.step]);
  assert.equal(number.inputMode,'decimal');
  assert.equal(number.required,true);
  assert.equal(number.attributes.get('aria-describedby'),'err_IH');

  range.value='89';
  range.listeners.get('input')({target:range});
  assert.equal(canonical,89);
  number.value='89.5';
  number.listeners.get('input')({target:number});
  assert.equal(canonical,89.5);
  assert.deepEqual(writes,[89,89.5]);
  assert.equal(renders,2);

  number.value='89.25';
  number.listeners.get('input')({target:number});
  assert.deepEqual(writes,[89,89.5],'invalid number drafts must not mutate the working state');
  assert.equal(renders,2);
  assert.equal(number.getAttribute('aria-invalid'),'true');
  assert.equal(error.hidden,false);
  number.listeners.get('blur')();
  assert.equal(number.value,'89.5');
  assert.equal(number.getAttribute('aria-invalid'),'false');
  assert.equal(error.hidden,true);
  assert.equal(announcements.length,1);

  const syncSource=app.slice(app.indexOf('function syncControls()'),app.indexOf('/* ---------------- Preset / rig'));
  const valueLabel={textContent:''};
  const syncElements={in_IH:range,num_IH:number,err_IH:error,v_IH:valueLabel};
  context.CTLS=[{k:'IH',_unit:'cm'}];
  context.ROWER_CTLS=[];
  context.document.activeElement=number;
  context.$=id=>syncElements[id]??null;
  number.value='89.25';
  number.setAttribute('aria-invalid','true');
  error.hidden=false; error.textContent='Schrittweite';
  vm.runInContext(`${syncSource}; globalThis.runSyncControls=syncControls;`,context);
  context.runSyncControls();
  assert.equal(number.value,'89.25','focused invalid draft survives animation renders');
  assert.equal(error.textContent,'Schrittweite');
  context.document.activeElement=null;
  context.runSyncControls();
  assert.equal(number.value,'89.5','unfocused stale draft returns to canonical state');
  assert.equal(number.getAttribute('aria-invalid'),'false');
  assert.equal(error.hidden,true);

  canonical=90;
  context.runSyncControls();
  assert.equal(range.value,90);
  assert.equal(number.value,'90','canonical range state must propagate to the number input');
  number.value='91';
  number.listeners.get('input')({target:number});
  context.runSyncControls();
  assert.equal(range.value,91,'valid number input must propagate through canonical state to the range');

  context.PROFILE_KEYS=new Set(['IH']);
  context.getVal=()=>null;
  context.runSyncControls();
  assert.equal(range.disabled,true);
  assert.equal(number.disabled,true);
  assert.equal(number.value,'','missing profiles must not display a plausible phantom minimum');
  assert.equal(number.placeholder,'Profil erforderlich');

  const seatNumber=new FakeNode('input'); seatNumber.step='0.25'; seatNumber.value='5';
  const seatError=new FakeNode('div');
  const seatElements={num_seatOffset:seatNumber,err_seatOffset:seatError};
  let seatOffset=5,seatWrites=0;
  context.$=id=>seatElements[id]??null;
  context.RANGES.boat={seatOffset:[3,8]};
  context.state.seatOffset=seatOffset;
  context.commitSeatOffset=value=>{ seatOffset=value; context.state.seatOffset=value; seatWrites+=1; };
  const seatSource=app.slice(
    app.indexOf("$('num_seatOffset').addEventListener('input'"),
    app.indexOf('/* ---- Boots-Datenbank',app.indexOf("$('num_seatOffset').addEventListener('input'")),
  );
  vm.runInContext(seatSource,context);
  seatNumber.value='4.1';
  seatNumber.listeners.get('input')({target:seatNumber});
  assert.equal(seatWrites,0);
  assert.equal(seatNumber.getAttribute('aria-invalid'),'true');
  seatNumber.listeners.get('blur')();
  assert.equal(seatNumber.value,'5');
  seatNumber.value='5.25';
  seatNumber.listeners.get('input')({target:seatNumber});
  assert.equal(seatOffset,5.25);
  assert.equal(seatWrites,1);

  assert.match(index,/id="num_seatOffset"[^>]*min="3"[^>]*max="8"[^>]*step="0\.25"/u);
  assert.match(app,/number\.disabled=unavailable/u);
  assert.match(app,/document\.activeElement===number&&number\.getAttribute\('aria-invalid'\)===['"]true['"]/u);
  assert.match(app,/\$\('num_seatOffset'\)\.addEventListener\('blur',restoreSeatOffsetDraft\)/u);
  assert.match(v2Css,/@media \(max-width: 560px\)[\s\S]*?\.ctl-number\s*\{[\s\S]*?font-size:\s*1rem/u);
  assert.match(v2Css,/@media \(forced-colors: active\)[\s\S]*?\.ctl-number-wrap/u);
});

test('static form controls are labelled and interaction regressions stay fixed',()=>{
  const controls=[...index.matchAll(/<(input|select|textarea)\b([^>]*)>/giu)];
  assert.ok(controls.length>0);
  for(const [,tag,attributes] of controls){
    const id=attributes.match(/\bid="([^"]+)"/u)?.[1];
    if(!id) continue;
    const labelled=new RegExp(`\\bfor="${id.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')}"`,'u').test(index)
      || /\baria-label(?:ledby)?="[^"]+"/u.test(attributes);
    assert.ok(labelled,`${tag}#${id} must have an explicit label`);
  }
  assert.match(index,/id="rPrev"\s+aria-label="Vorheriges Rudererprofil"/u);
  assert.match(index,/id="rNext"\s+aria-label="Nächstes Rudererprofil"/u);
  assert.match(app,/button\.className='fold-toggle'/u);
  assert.doesNotMatch(app,/heading\.setAttribute\('role','button'\)/u);
  assert.match(app,/if\(host\.children\.length!==PHASES\.length\)/u);
  assert.match(app,/const rower=activeRower\(\);\s*if\(!rower\) return;\s*const name=limitName\(e\.target\.value\); e\.target\.value=name; rower\.name=name;\s*markProfileDraftChanged\(state\.editSeatId\)/u);
  assert.match(app,/truncateCodePoints\(String\(value\?\?''\),MAX_NAME_LENGTH\)/u);
  assert.doesNotMatch(app,/\.slice\(0,MAX_NAME_LENGTH\)/u);
  assert.match(app,/if\(!validIds\.has\(state\.editSeatId\)\) state\.editSeatId=state\.seats\[state\.seats\.length-1\]\.id/u);
  assert.match(app,/if\(existing\.length!==tabs\.length\|\|tabs\.some/u);
  assert.match(app,/rowerSelection\.snapshot\(\)\.id&&!rowerSelection\.isFor\(state\.editSeatId\)\) clearRowerSelection\(\)/u);
  const seatTabsSource=app.slice(app.indexOf('function renderSeatTabs()'),app.indexOf('function renderBMI()',app.indexOf('function renderSeatTabs()')));
  assert.doesNotMatch(seatTabsSource,/'Freier Platz'/u);
  assert.match(seatTabsSource,/button\.firstChild\.nodeValue=assignment\?[^:]+:sub/u);
  assert.match(seatTabsSource,/button\.querySelector\('\.sub'\)\.textContent=assignment\?sub:`frei/u);
  const seatNavigation=seatTabsSource.slice(seatTabsSource.indexOf("button.addEventListener('click'"),seatTabsSource.indexOf('return button;',seatTabsSource.indexOf("button.addEventListener('click'")));
  assert.match(seatNavigation,/state\.editSeatId=button\.dataset\.seat;\s*clearRowerSelection\(\);\s*buildControls\(\); refreshDBSelect\(\); render\(\);/u);
  assert.doesNotMatch(seatNavigation,/setDirty|state\.t|state\.recovery|playing/u,'seat navigation is state-neutral');
  assert.match(app,/refreshDBSelect\(record\.id,true,saveSeat\)/u);
  for(const id of ['boatSeatCount','seatCreateDraft','seatUnassign','dbSelect']){
    assert.equal((index.match(new RegExp(`\\bid="${id}"`,'gu'))??[]).length,1,`${id} exists exactly once`);
  }
  const saveHandler=app.slice(app.indexOf("$('bSave').addEventListener"),app.indexOf("$('bLoad').addEventListener"));
  assert.match(saveHandler,/repositoryWrite\(workspaceRepository,[\s\S]*?repositoryWrite\(rowerRepository,[\s\S]*?assertNoRetiredRowerReferences\(config\)/u,
    'workspace save rechecks retired profile ids behind the rower lock');
  const boatSaveHandlers=app.slice(app.indexOf("$('boatSaveAs').addEventListener"),app.indexOf("$('boatDelete').addEventListener"));
  assert.equal((boatSaveHandlers.match(/assertNoRetiredRowerReferences\(value\)/gu)??[]).length,2,
    'boat create and update both reject a retired profile id behind boat→rower locks');
  assert.doesNotMatch(saveHandler,/stopPlay\(\)/u,'saving preserves the active phase and animation');
  assert.match(saveHandler,/const savedChangeVersion=workspaceChangeVersion/u);
  assert.match(saveHandler,/const demoAtSave=demoRestorePoint/u);
  assert.match(saveHandler,/workspaceSaveCompletionPolicy\(\{[\s\S]*?demoAtStart:demoAtSave,currentDemo:demoRestorePoint,playing/u);
  assert.match(saveHandler,/setDirty\(completion\.dirty\)/u,
    'saving keeps dirty truth when edits or animation continue during the write');
  assert.match(app,/if\(dirty&&!confirmOverwrite\('Der gespeicherte Arbeitsstand ersetzt alle aktuellen Eingaben'\)\) return;\s*stopPlay\(\);/u);
  assert.match(app,/expectedRevision:observed\.observedRevision/u);
  assert.match(app,/workspaceRevision\.markExternal\(event\.revision\)/u);
  assert.match(app,/let workspaceViewState='new'/u);
  assert.match(app,/workspaceViewState=workspaceRepository\.get\(\)===null\?'new':'available'/u);
  assert.match(app,/workspaceViewState='synced'/u);
  assert.match(index,/id="bSave" aria-describedby="workspaceNotice"/u);
  assert.match(index,/id="workspaceNotice" class="workspace-notice" role="status"/u);
  assert.doesNotMatch(app,/\$\('bSave'\)\.disabled=/u);
  assert.match(app,/policy\.requiresConfirmation&&!confirm/u);
  assert.match(app,/function scrubSingleSeatWorkspaceInLock\(\)/u);
  assert.match(app,/hasHiddenSingleSeatProfile\(stored\)/u);
  assert.match(app,/const minimized=minimizeHiddenSingleSeatProfile\(stored\)/u);
  assert.match(app,/workspaceRepository\.save\(minimized\.config,\{expectedRevision:beforeRevision\}\)/u);
  assert.match(app,/await repositoryWrite\(workspaceRepository,scrubSingleSeatWorkspaceInLock\)/u);
  assert.match(app,/const canonicalLegacy=migrateCurrentConfigToCurrent\(parsed\.config\)\.value/u);
  assert.doesNotMatch(app,/canonicalLegacyText|storageAdapter\.setItem\(['"]rudertrimm_current_v2/u,
    'legacy workspace source bytes remain untouched after migration');
  assert.match(app,/adaptLegacyV1Workspace\(raw,\{seed:'stored-v1-workspace'\}\)/u);
  assert.match(app,/adaptLegacyV1Boats\(storageAdapter\.getItem\('rudertrimm_boats'\),\{seed:'stored-v1-boats'\}\)/u);
  const workspaceLoader=app.slice(app.indexOf('function loadWorkspaceStore'),app.indexOf('function updateWorkspaceSaveState'));
  assert.ok(workspaceLoader.indexOf('const scrubbed=scrubSingleSeatWorkspaceInLock()')>=0);
  assert.ok(workspaceLoader.indexOf('const scrubbed=scrubSingleSeatWorkspaceInLock()')<workspaceLoader.indexOf("const legacyRaw=storageAdapter.getItem('rudertrimm_current_v2')"));
  const exportHandler=app.slice(app.indexOf("$('bExport').addEventListener"),app.indexOf("$('bReset').addEventListener"));
  assert.match(exportHandler,/const rawConfig=currentConfigOf\(\)/u);
  assert.match(exportHandler,/const config=includeNames\?rawConfig:anonymizeCurrentConfig\(rawConfig\)/u);
  assert.match(exportHandler,/name:includeNames\?assignment\.rower\.name:`Profil Platz \$\{seat\.position\}`/u);
  assert.match(exportHandler,/result:actionPlanForExport\(lastActionPlan,includeNames\)/u);
  assert.match(exportHandler,/status:seat\.rowerRef\?'profile-reference-unresolved':'free'/u);
  assert.match(exportHandler,/modelStatus:'notCalculated'/u);
  assert.match(exportHandler,/for\(const seat of state\.seats\)/u);
  for(const token of [
    'auslage_rigg_ziel_grad',
    'auslage_ist_grad',
    'auslage_natural_catch_grad',
    'auslage_modell_pose_grad',
    'natural_catch_aufgeloest',
    'natural_catch_restfehler_cm',
    'auslage_angefordert_grad',
    'auslage_effektiv_grad',
    'auslage_reichweitenbegrenzt',
    'auslage_reichweite_verfuegbar',
    'griffziele_bei_auslage_erreichbar',
  ]) assert.ok(exportHandler.includes(token),`missing honest reach export: ${token}`);
  assert.match(exportHandler,/natural_catch_modell:'Fa \+ Koerper; Knie 58 Grad; Vorlage 16 Grad; unkalibriert'/u);
  assert.match(exportHandler,/modelStatus:'needsCalibration'/u);
  assert.match(exportHandler,/bodyKinematics:'needsCalibration',armAngle:'needsCalibration'/u);
  assert.doesNotMatch(exportHandler,/modelStatus:'ok'/u);
  assert.match(index,/Körperkinematik, 90°-Rollweg und Armziel: unkalibriertes Prüfmodell, keine Trainerfreigabe/u);
  assert.doesNotMatch(exportHandler,/config:currentConfigOf\(\)/u);
  assert.match(app,/await loadDB\(\); refreshDBSelect\(\); await loadBoats\(\); refreshBoatSelect\(\); await loadEfaCandidates\(\); await loadWorkspaceStore\(\);/u,
    'each repository is refreshed after its own load before the workspace binds references');
  assert.match(app,/if\(!selection\.ok\)\{ \$\('boatSelect'\)\.title=''; selectedBoatId=''; selectedBoatRevision=null; \}/u);
  assert.doesNotMatch(app,/\bdefaultSecond\b|state\.crew\.s[12]\b|config\.crew\[["']s[12]["']\]/u);
  assert.match(app,/profileDraftDirty\[seatId\]\|\|confirm/u);
  assert.match(app,/solveInboardForRatio\(\{/u);
  assert.match(app,/findHighestReachableAngle\(\{/u);
  assert.match(app,/solveArms\(candidateDv,body,r\)\.every\(arm=>arm\.reachable\)/u);
  assert.doesNotMatch(app,/Bisektion auf dem Overreach-Flag/u);
  assert.doesNotMatch(app,/other\.r\.L\/\(targetRatio\+1\)-other\.r\.d/u);
  assert.match(app,/ephemeralDataPresent=true;/u);
  assert.match(app,/in_seatOffset'\)\.setAttribute\('aria-valuetext'/u);
  assert.match(app,/speed'\)\.setAttribute\('aria-valuetext'/u);
  assert.match(app,/svg\.setAttribute\('aria-labelledby',titleId\)/u);
  assert.match(app,/svg\.setAttribute\('aria-describedby',descriptionId\)/u);
  assert.match(index,/id="errorStatus" class="v2-error" role="alert"/u);
  const announceBody=app.slice(app.indexOf('function announce'),app.indexOf('function cleanStateLabel'));
  assert.doesNotMatch(announceBody,/clearErrorStatus/u);
  assert.match(app,/result\.quarantine\?\.stored===true/u);
  assert.match(app,/const canMigrateLegacy=result=>result\.rawPresent===false\|\|\(!result\.ok&&result\.quarantine\?\.stored===true\)/u);
  assert.match(app,/Speichern und Import bleiben für diesen Bereich gesperrt/u);
  assert.match(index,/id="fcEqualize" aria-describedby="fcEqualizeStatus"/u);
  assert.match(index,/id="fcEqualizeStatus" class="fc-status" role="status"/u);
  assert.match(index,/Kniewinkel 160–170° und genutzter Rollweg 70–80 % gleichzeitig erfüllt/u);
  assert.doesNotMatch(index,/Stemmbrett richtig, wenn/u);
  assert.doesNotMatch(app,/announce\(message\);\s*alert\(message\)/u);
});

test('responsive CSS keeps required breakpoints, touch targets and motion safeguards',()=>{
  for(const [name,css] of [['base.css',baseCss],['v2.css',v2Css]]){
    const withoutComments=css.replace(/\/\*[\s\S]*?\*\//gu,'');
    assert.equal((withoutComments.match(/\{/gu)??[]).length,(withoutComments.match(/\}/gu)??[]).length,`${name} has unbalanced blocks`);
  }
  for(const token of [
    '@media (max-width: 1000px)',
    '@media (max-width: 820px)',
    '@media (max-width: 560px)',
    '@media (max-width: 390px)',
    '@media (prefers-reduced-motion: reduce)',
    '@media (forced-colors: active)',
    '@media print',
    '--v2-touch: 44px',
    'env(safe-area-inset-bottom)',
  ]) assert.ok(v2Css.includes(token),`missing responsive contract: ${token}`);

  assert.match(index,/id="viewPanels"/u);
  for(const id of ['cards','visualWorkbench','rowerSection']){
    assert.match(index,new RegExp(`(?:id="${id}"[^>]*tabindex="-1"|tabindex="-1"[^>]*id="${id}")`,'u'));
  }
  assert.match(v2Css,/#cards,\s*#visualWorkbench,\s*#rowerSection,\s*#actionResult,\s*#setupBoatTitle,\s*#seattabs,\s*#seatAssignmentPanel,\s*#bSave\s*\{\s*scroll-margin-block-start:/u);
  assert.match(v2Css,/\.seat-assignment-controls\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)[\s\S]*?\.seat-assignment-controls select\s*\{\s*grid-column:\s*1 \/ -1/u);
  assert.match(v2Css,/@media \(max-width: 560px\)[\s\S]*?\.seat-assignment-controls\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)[\s\S]*?\.seat-assignment-controls select\s*\{\s*grid-column:\s*1 \/ -1/u);
  assert.match(v2Css,/#viewPanelSide > \.sideinfo\s*\{[\s\S]*?position:\s*static/u);
  assert.match(v2Css,/#bodyTab tbody\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit, minmax\(12rem, 1fr\)\)/u);

  const visualHelperSource=app.slice(app.indexOf("const NS='http://www.w3.org/2000/svg'"),app.indexOf('function plateLabel('));
  const nameSource=app.slice(app.indexOf('const limitName='),app.indexOf('function clearErrorStatus'));
  class FakeNode{
    constructor(tag,id=''){ this.tag=tag; this.id=id; this.attributes=new Map(); this.children=[]; this.textContent=''; }
    setAttribute(name,value){ this.attributes.set(name,String(value)); }
    appendChild(child){ this.children.push(child); return child; }
    replaceChildren(...children){ this.children=[...children]; }
  }
  const context={
    Number,String,Math,MAX_NAME_LENGTH:80,truncateCodePoints:(value,max)=>[...value].slice(0,max).join(''),
    document:{createElementNS(_namespace,tag){ return new FakeNode(tag); }},
  };
  vm.createContext(context);
  vm.runInContext(nameSource+visualHelperSource,context);
  assert.equal(vm.runInContext('recordVisualContentWidth(278); visualCanvasWidth(1180)',context),278,
    '320px viewport keeps its real inner SVG width');
  assert.equal(vm.runInContext('recordVisualContentWidth(348); visualCanvasWidth(1180)',context),348);
  assert.equal(vm.runInContext('visualCanvasWidth(560)',context),348);
  context.__long='Ä'.repeat(80);
  assert.equal([...vm.runInContext('visualName(__long)',context)].length,24);
  assert.ok(vm.runInContext('visualName(__long)',context).endsWith('…'));
  context.__host=new FakeNode('div','testVisual');
  vm.runInContext("newSVG(__host,348,220,'Vollständiger Name','Dynamische Beschreibung')",context);
  const svg=context.__host.children[0];
  assert.equal(svg.attributes.get('aria-labelledby'),'testVisualSvgTitle');
  assert.equal(svg.attributes.get('aria-describedby'),'testVisualSvgDescription');
  assert.equal(svg.children.find(node=>node.tag==='title').textContent,'Vollständiger Name');
  assert.equal(svg.children.find(node=>node.tag==='desc').textContent,'Dynamische Beschreibung');

  const plateWidth=label=>Math.max(48,[...label].length*6.2+14);
  for(const width of [658,714,760]){
    const narrow=width<740;
    const armLabel=narrow?'Arme 26° · Ref. 6° offen':'Armmodell 26° · Referenz 6° offen';
    const arm={left:12,right:12+plateWidth(armLabel),y:narrow?76:24};
    const pitchWidth=plateWidth('Anlage 4° · 4× dargestellt');
    const pitch={left:width/2-pitchWidth/2,right:width/2+pitchWidth/2,y:24};
    assert.ok(arm.y!==pitch.y||arm.right<=pitch.left||pitch.right<=arm.left,
      `side annotation plates do not overlap at ${width}px`);
  }
});

test('visual polish keeps V1 content visible and improves measured legibility without overlap',()=>{
  assert.match(index,/class="v2-purpose"/u);
  assert.match(index,/<details class="foot details-only">[\s\S]*?<summary>Richtwerte, Quellen &amp; Modellgrenzen<\/summary>/u);
  assert.match(index,/class="slab action-group details-only">Profile &amp; Dateien · Arbeitsstand &amp; Bericht/u);
  assert.match(v2Css,/\.filebtns\s*\{\s*grid-template-columns:\s*repeat\(2,/u);
  assert.match(v2Css,/\.filebtns button span\s*\{[\s\S]*?overflow-wrap:\s*anywhere/u);
  assert.match(v2Css,/:is\(#vTop, #vCross, #vSide, #vitruv\) svg \[stroke\][\s\S]*?vector-effect:\s*non-scaling-stroke/u);
  assert.match(v2Css,/button:disabled\s*\{[\s\S]*?opacity:\s*1/u);
  assert.match(v2Css,/\.forcecmp button:disabled,\s*\.dbrow button:disabled\s*\{[\s\S]*?opacity:\s*1[\s\S]*?filter:\s*none/u);
  assert.match(v2Css,/\.dbrow button:disabled:hover,\s*\.forcecmp button:disabled:hover\s*\{[\s\S]*?border-color:\s*var\(--v2-disabled-line\)/u);
  assert.match(v2Css,/:where\(\.seg, \.stepper\) button:focus-visible\s*\{[\s\S]*?outline-offset:\s*-4px[\s\S]*?box-shadow:\s*none/u);
  assert.match(v2Css,/details\.foot summary::before\s*\{[\s\S]*?content:\s*'▸'/u);
  assert.match(v2Css,/details\.foot > \.foot-content\s*\{[\s\S]*?display:\s*block !important/u);
  assert.match(v2Css,/#bSave\[aria-disabled="false"\]\s*\{[\s\S]*?background:\s*var\(--accent\)/u);
  assert.match(v2Css,/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.speed\s*\{\s*display:\s*none !important/u);
  assert.match(v2Css,/@media print[\s\S]*?\.model-notice\s*\{[\s\S]*?background:\s*#fff !important/u);
  assert.match(app,/const FOLD_STORAGE_KEY='rudertrimm:v2:fold'/u);
  assert.doesNotMatch(app,/getItem\('rudertrimm_fold'/u);
  assert.doesNotMatch(app,/setItem\('rudertrimm_fold'/u);
  assert.match(app,/Armmodell \$\{fmt\(b\.armAng,0\)\}° · Referenz 6° offen/u);
  assert.doesNotMatch(app,/Ziel ~6°/u);

  const rootBlock=css=>css.match(/:root\s*\{([\s\S]*?)\}/u)?.[1]??'';
  const readHexVars=css=>Object.fromEntries(
    [...rootBlock(css).matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/giu)].map(match=>[match[1],match[2]]),
  );
  const colors={...readHexVars(baseCss),...readHexVars(v2Css)};
  const luminance=hex=>{
    const channels=hex.slice(1).match(/../gu).map(value=>parseInt(value,16)/255)
      .map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4);
    return 0.2126*channels[0]+0.7152*channels[1]+0.0722*channels[2];
  };
  const contrast=(left,right)=>{
    const values=[luminance(left),luminance(right)].sort((a,b)=>b-a);
    return (values[0]+0.05)/(values[1]+0.05);
  };
  assert.ok(contrast(colors['fg-dim'],colors.card)>=4.5,'small secondary text must meet WCAG AA');
  assert.ok(contrast(colors['fg-mut'],colors.card)>=4.5,'muted helper text must meet WCAG AA');
  assert.ok(contrast(colors['v2-disabled-fg'],colors['v2-disabled-bg'])>=4.5,'disabled labels stay readable');
  assert.ok(contrast(colors.line,colors.panel2)>=3,'active control boundaries remain distinguishable');
});

test('Vitruvian profile graphic preserves data-driven proportions with a refined accessible hierarchy',()=>{
  const segmentSource=app.slice(app.indexOf('function SEG('),app.indexOf('function featherG('));
  const helperSource=app.slice(app.indexOf("const NS='http://www.w3.org/2000/svg'"),app.indexOf('function dim('));
  const renderSource=app.slice(app.indexOf('function renderVitruv('),app.indexOf('/* ---- Datenbank',app.indexOf('function renderVitruv(')));
  assert.match(renderSource,/rawScale=Math\.max\(seg\.height, r\.wingspan\)\*\(160\/215\)/u);
  assert.match(renderSource,/const S=Math\.min\(160,rawScale\)/u);
  assert.match(renderSource,/const yAt=v=>sqBot - v\*sw/u);
  assert.match(renderSource,/handX=\(r\.wingspan\/2\)\*sw/u);
  for(const className of ['vitruv-guides','vitruv-secondary','vitruv-primary']) assert.ok(renderSource.includes(className));
  assert.match(renderSource,/aria-describedby','vitruvSvgDescription'/u);
  assert.doesNotMatch(renderSource,/addEventListener|onclick|onpointer|ondrag/u);

  class FakeNode{
    constructor(tag){ this.tag=tag; this.attributes=new Map(); this.children=[]; this.textContent=''; }
    setAttribute(name,value){ this.attributes.set(name,String(value)); }
    appendChild(child){ this.children.push(child); return child; }
    replaceChildren(...children){ this.children=[...children]; }
  }
  const root=new FakeNode('div');
  const context={
    console,
    Math,
    deriveBodySegments,
    document:{createElementNS(_namespace,tag){ return new FakeNode(tag); }},
    $:id=>id==='vitruv'?root:null,
    state:{editSeat:'s1'},
    cleanName:(value,fallback)=>String(value||fallback),
    fmt:(value,digits=1)=>Number(value).toFixed(digits).replace(/\.0$/u,''),
    rad:value=>value*Math.PI/180,
    lerp:(left,right,t)=>left+(right-left)*t,
  };
  vm.createContext(context);
  vm.runInContext(segmentSource+helperSource+renderSource+'; globalThis.runVitruv=renderVitruv;',context);
  const profiles=[
    {name:'Minimum',legLen:65,torsoLen:70,wingspan:150,SB:30,weight:45},
    {name:'Testiel',legLen:90,torsoLen:95,wingspan:188,SB:40,weight:80},
    {name:'Maximum',legLen:115,torsoLen:120,wingspan:225,SB:55,weight:145},
  ];
  for(const profile of profiles){
    root.replaceChildren();
    context.runVitruv(profile);
    assert.equal(root.children.length,1);
    const svg=root.children[0];
    assert.equal(svg.attributes.get('viewBox'),'0 0 220 224');
    assert.equal(svg.attributes.get('role'),'img');
    assert.equal(svg.attributes.get('aria-describedby'),'vitruvSvgDescription');
    assert.equal(svg.children.filter(node=>node.tag==='desc').length,1);
    assert.equal(svg.children.at(-1).textContent,(profile.legLen+profile.torsoLen)+' cm · Spannweite '+profile.wingspan+' cm · '+profile.weight+' kg');
    const classes=svg.children.map(node=>node.attributes.get('class')).filter(Boolean);
    for(const className of ['vitruv-guides','vitruv-secondary','vitruv-primary']) assert.ok(classes.includes(className));
    const serialized=JSON.stringify(svg,(_key,value)=>value instanceof Map?Object.fromEntries(value):value);
    assert.doesNotMatch(serialized,/NaN|Infinity/u);
    const guides=svg.children.find(node=>node.attributes.get('class')==='vitruv-guides');
    for(const guide of guides.children){
      const attrs=Object.fromEntries(guide.attributes);
      if(guide.tag==='circle'){
        const cx=Number(attrs.cx), cy=Number(attrs.cy), radius=Number(attrs.r);
        assert.ok(cx-radius>=0&&cx+radius<=220&&cy-radius>=0&&cy+radius<=224);
      }else if(guide.tag==='rect'){
        assert.ok(Number(attrs.x)>=0&&Number(attrs.y)>=0&&Number(attrs.x)+Number(attrs.width)<=220&&Number(attrs.y)+Number(attrs.height)<=224);
      }
    }
  }
  assert.match(v2Css,/\.vitruv-wrap\s*\{\s*align-self:\s*start/u);
  assert.match(v2Css,/@media \(forced-colors: active\)[\s\S]*?#vitruv \.vitruv-guides/u);
});

test('final visual annotations use stable concise label plates and compact default groups',()=>{
  assert.match(app,/function plateLabel\(/u);
  for(const label of ['Dollenlot','Anlage ','Armmodell ','Neigung ']) assert.ok(app.includes(label));
  for(const oldLabel of ['Senkrechte (Dollenanlage)','Dolle · Anlage','Prüfreferenz 6°, Ziel offen']) assert.equal(app.includes(oldLabel),false);
  assert.match(app,/plateLabel\(svg,24,42,`DA \$\{fmt\(dv\.DA\)\} cm`,\{leader:\{x:\(daStart\+daEnd\)\/2,y:m3\},className:'cross-da-label'\}\)/u);
  assert.match(app,/plateLabel\(svg,W-24,42,`Neigung \$\{fmt\(r\.anlage\)\}°`,\{anchor:'end',leader:pinScreen,className:'cross-pitch-label'\}\)/u);
  for(const className of ['side-dollenlot-label','side-track-label','side-fa-label']) assert.ok(app.includes(className));
  assert.match(app,/details\.open=hadGroups \? existingOpenGroups\.has\(groupKey\) : groupIndex===0/u);
  assert.doesNotMatch(app,/groupIndex===0\|\|groupIndex===3/u);
  assert.match(app,/n:'Stemmbrett \/ 90°'/u);
  assert.doesNotMatch(app,/\{n:'Rollweg bei 90°'/u);
  assert.match(v2Css,/\.visual-host svg text:not\(\.svg-label\)\s*\{\s*font-size:\s*12\.5px/u);
});

test('manifest references real correctly sized PNGs and makes no false maskable claim',()=>{
  const manifest=JSON.parse(read('manifest.json'));
  assert.equal(manifest.scope,'./');
  assert.equal(manifest.start_url,'./index.html');
  assert.equal(manifest.display,'standalone');
  assert.ok(Array.isArray(manifest.icons)&&manifest.icons.length>=2);
  assert.equal(manifest.icons.some(icon=>String(icon.purpose).split(/\s+/u).includes('maskable')),false);

  for(const icon of manifest.icons){
    const path=resolve(ROOT,icon.src.replace(/^\.\//u,''));
    assert.ok(existsSync(path),`missing icon ${icon.src}`);
    const bytes=readFileSync(path);
    assert.equal(bytes.subarray(1,4).toString('ascii'),'PNG');
    const [width,height]=icon.sizes.split('x').map(Number);
    assert.equal(bytes.readUInt32BE(16),width);
    assert.equal(bytes.readUInt32BE(20),height);
  }
});

test('service-worker shell revision equals the content hash of every precached asset',()=>{
  const block=serviceWorker.match(/const PRECACHE_PATHS = Object\.freeze\(\[([\s\S]*?)\]\);/u)?.[1];
  assert.ok(block);
  const paths=[...block.matchAll(/'(\.\/[^']+)'/gu)].map(match=>match[1]);
  assert.ok(paths.length>=8);
  assert.ok(paths.includes('./js/app.bundle.js'),'the delivered runtime bundle must be precached');
  assert.ok(paths.includes('./js/history.mjs'),'the native history source must stay available offline');
  assert.ok(paths.includes('./js/efa-csv.mjs'),'the native eFa staging source must stay available offline');
  const hash=createHash('sha256');
  for(const path of paths){
    const local=resolve(ROOT,path.replace(/^\.\//u,''));
    assert.ok(existsSync(local),`missing precache asset ${path}`);
    let bytes=readFileSync(local);
    if(path==='./version.js'){
      const source=bytes.toString('utf8');
      const matches=source.match(/const shellRevision = 'sha256-[0-9a-f]{64}'/gu);
      const canonical=source.replace(
        /const shellRevision = 'sha256-[0-9a-f]{64}'/u,
        `const shellRevision = 'sha256-${'0'.repeat(64)}'`,
      );
      assert.equal(matches?.length,1,'version.js must expose one canonical shellRevision field');
      bytes=Buffer.from(canonical);
    }
    hash.update(path); hash.update('\0'); hash.update(bytes); hash.update('\0');
  }
  const expected=`sha256-${hash.digest('hex')}`;
  assert.equal(release.shellRevision,expected,'update the canonical shellRevision whenever a shell asset changes');

  const packageData=JSON.parse(read('package.json'));
  const packageLock=JSON.parse(read('package-lock.json'));
  const packageVersion=packageData.version;
  assert.equal(release.appVersion,packageVersion);
  assert.equal(packageLock.version,packageVersion);
  assert.equal(packageLock.packages[''].version,packageVersion);
  assert.equal(packageData.devDependencies.esbuild,'0.28.1');
  assert.equal(packageLock.packages[''].devDependencies.esbuild,'0.28.1');
  assert.equal(release.buildId,`shell-${release.shellRevision.slice(7,23)}`);
  assert.equal(release.label,`Rudertrimm V2 · ${packageVersion} · Build ${release.buildDate} · ${release.buildId}`);
  assert.match(index,/id="buildState">Build wird geprüft<\/span>/u);
  assert.match(index,/<script src="version\.js"><\/script>[\s\S]*?<script src="js\/app\.bundle\.js"><\/script>/u);
  assert.doesNotMatch(index,/<script[^>]+type="module"/u);
  assert.match(app,/const RELEASE=globalThis\.RUDERTRIMM_RELEASE/u);
  assert.match(serviceWorker,/importScripts\('\.\/version\.js'\)/u);
  assert.doesNotMatch(app,/\b[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+\b/u);
  assert.doesNotMatch(serviceWorker,/\b[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+\b/u);
  for(const path of [
    'README.md',
    'docs/ARCHITECTURE.md',
    'docs/SOURCES.md',
    'docs/UX-ACCEPTANCE.md',
    'docs/PRODUCTION-READINESS.md',
    '../START-HIER.md',
    '../START-HIER-FUER-ALEX.md',
    '../UEBERGABE-MANIFEST.md',
    '../V2-UEBERGABE.md',
    '../ARBEITSSTAND-10-10-PASS.md',
    '../ALEX-RUDERAPP-CODEX-PRUEFBERICHT-2026-07-15.md',
    '../ALEX-RUDERAPP-KI-SUPERPROMPT.md',
    '../AGENTS.md',
    '../CHANGELOG.md',
  ]){
    const documentText=read(path);
    assert.ok(documentText.includes(release.label),`${path} must use the canonical visible release label`);
    assert.ok(documentText.includes(release.shellRevision),`${path} must use the canonical shell revision`);
  }
});

test('service worker deletes only its own old caches and never poisons the shell with arbitrary HTML',async()=>{
  const listeners={};
  const deleted=[];
  const putCalls=[];
  let fetchImplementation=async()=>{ throw new Error('offline'); };
  const cache={
    async put(request,response){ putCalls.push({request,response}); },
    async match(){ return undefined; },
  };
  const appPrefix=`rudertrimm-v2::scope::${encodeURIComponent('https://example.test/app/')}::`;
  const siblingPrefix=`rudertrimm-v2::scope::${encodeURIComponent('https://example.test/other/')}::`;
  const sameScopeOld=`${appPrefix}shell::old`;
  const siblingScopeOld=`${siblingPrefix}shell::old`;
  const context={
    URL,Request,Response,Headers,Map,Object,Promise,TypeError,
    fetch:request=>fetchImplementation(request),
    caches:{
      async keys(){ return ['foreign-cache','rudertrimm-v2::legacy',sameScopeOld,siblingScopeOld]; },
      async delete(key){ deleted.push(key); return true; },
      async open(){ return cache; },
    },
    self:{
      registration:{scope:'https://example.test/app/'},
      location:{origin:'https://example.test'},
      clients:{async matchAll(){ return []; },async claim(){}},
      async skipWaiting(){},
      addEventListener(type,handler){ listeners[type]=handler; },
    },
  };
  runServiceWorker(context);

  let activation;
  listeners.activate({waitUntil(promise){ activation=promise; }});
  await activation;
  assert.deepEqual(deleted,[sameScopeOld]);

  const appVersion=serviceWorkerVersionForScope('https://example.test/app/');
  const siblingVersion=serviceWorkerVersionForScope('https://example.test/other/');
  assert.ok(appVersion.cacheName.startsWith(appPrefix));
  assert.ok(siblingVersion.cacheName.startsWith(siblingPrefix));
  assert.notEqual(appVersion.cacheName,siblingVersion.cacheName);

  fetchImplementation=async request=>({
    ok:true,
    type:'basic',
    url:typeof request==='string'?request:request.url,
    headers:{get:name=>name.toLowerCase()==='content-type'?'text/html; charset=utf-8':null},
    clone(){ return this; },
  });
  let responsePromise;
  listeners.fetch({
    request:{method:'GET',mode:'navigate',url:'https://example.test/app/privacy.html'},
    respondWith(promise){ responsePromise=promise; },
  });
  const response=await responsePromise;
  assert.equal(response.status,503);
  assert.equal(putCalls.length,0,'an arbitrary HTML page must never replace the cached app shell');

  let foreignResponded=false;
  listeners.fetch({
    request:{method:'GET',mode:'cors',url:'https://other.example/app.js'},
    respondWith(){ foreignResponded=true; },
  });
  assert.equal(foreignResponded,false);

  let queryResponded=false;
  listeners.fetch({
    request:{method:'GET',mode:'cors',url:'https://example.test/app/js/app.bundle.js?variant=untrusted'},
    respondWith(){ queryResponded=true; },
  });
  assert.equal(queryResponded,false,'query variants must never replace a canonical shell asset');
});

test('active service worker serves one immutable cached release instead of mixing origin N+1',async()=>{
  const listeners={};
  let fetchCalls=0;
  const entries=new Map([
    ['https://example.test/app/index.html',new Response('old-index',{status:200,headers:{'content-type':'text/html'}})],
    ['https://example.test/app/js/app.bundle.js',new Response('old-app',{status:200,headers:{'content-type':'text/javascript'}})],
  ]);
  const cache={
    async match(request){ return entries.get(typeof request==='string'?request:request.url); },
    async put(){ throw new Error('active release must never be mutated'); },
  };
  const context={
    URL,Request,Response,Headers,Map,Object,Promise,TypeError,
    async fetch(){ fetchCalls+=1; return new Response('origin-n-plus-one'); },
    caches:{async open(){ return cache; },async keys(){ return []; },async delete(){ return true; }},
    self:{
      registration:{scope:'https://example.test/app/'},
      location:{origin:'https://example.test'},
      clients:{async matchAll(){ return []; },async claim(){}},
      async skipWaiting(){},
      addEventListener(type,handler){ listeners[type]=handler; },
    },
  };
  runServiceWorker(context);

  let navigationPromise;
  listeners.fetch({
    request:{method:'GET',mode:'navigate',url:'https://example.test/app/'},
    respondWith(promise){ navigationPromise=promise; },
  });
  assert.equal(await (await navigationPromise).text(),'old-index');

  let assetPromise;
  listeners.fetch({
    request:{method:'GET',mode:'cors',url:'https://example.test/app/js/app.bundle.js'},
    respondWith(promise){ assetPromise=promise; },
  });
  assert.equal(await (await assetPromise).text(),'old-app');
  assert.equal(fetchCalls,0,'an active worker must not combine a new index with old cached assets');
});

test('precache rejects query-altered and redirected canonical responses',async()=>{
  async function attempt({query=false,redirected=false}){
    const listeners={};
    let putCalls=0;
    const contentType=url=>{
      const path=new URL(url).pathname;
      if(path.endsWith('.html')) return 'text/html';
      if(path.endsWith('.json')) return 'application/manifest+json';
      if(path.endsWith('.css')) return 'text/css';
      if(path.endsWith('.mjs')||path.endsWith('.js')) return 'text/javascript';
      return 'image/png';
    };
    const context={
      URL,Request,Response,Headers,Map,Object,Promise,TypeError,
      async fetch(request){
        const canonical=typeof request==='string'?request:request.url;
        const target=canonical.endsWith('/js/app.bundle.js');
        return {
          ok:true,type:'basic',redirected:target&&redirected,
          url:target&&query?`${canonical}?variant=untrusted`:canonical,
          headers:{get:name=>name.toLowerCase()==='content-type'?contentType(canonical):null},
          clone(){ return this; },
        };
      },
      caches:{
        async open(){ return {async put(){ putCalls+=1; }}; },
        async delete(){ return true; },
      },
      self:{
        registration:{scope:'https://example.test/app/'},
        location:{origin:'https://example.test'},
        clients:{async matchAll(){ return []; },async claim(){}},
        async skipWaiting(){},
        addEventListener(type,handler){ listeners[type]=handler; },
      },
    };
    runServiceWorker(context);
    let installPromise;
    listeners.install({waitUntil(promise){ installPromise=promise; }});
    await assert.rejects(installPromise,/Refusing non-cacheable precache response/u);
    assert.equal(putCalls,0);
  }

  await attempt({query:true,redirected:false});
  await attempt({query:false,redirected:true});
});
