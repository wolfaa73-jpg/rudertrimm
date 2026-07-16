import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {PRESETS,SCHEMA_VERSION,SCHEMAS,validateBoat,validateCurrentConfig,validateRower} from '../js/core.mjs';
import {
  LegacyV1ValidationError,
  adaptLegacyV1Boats,
  adaptLegacyV1Workspace,
} from '../js/legacy-v1.mjs';

function profile(name='Testiel',overrides={}){
  return {
    name,
    legLen:90,
    torsoLen:95,
    wingspan:188,
    SB:40,
    weight:80,
    stemmX:48,
    ...overrides,
  };
}

function seatValues(rig='skull',overrides={}){
  const preset=rig==='skull'?PRESETS['4x']:PRESETS['4-'];
  return {
    DA:preset.DA,
    IH:preset.IH,
    L:preset.Lbig,
    d:2,
    handGap:18,
    a:preset.a,
    anlage:4,
    aussen:0,
    dBB:0.5,
    stemmW:42,
    rollL:75,
    rueh:5,
    ...overrides,
  };
}

function crewMember(name,rig,overrides={}){
  return {...profile(name),...seatValues(rig),...overrides};
}

function v1Boat(preset='4x',name=`Boot ${preset}`,overrides={}){
  const values=PRESETS[preset];
  const rig=values.rig;
  const first=seatValues(rig,{DA:values.DA,IH:values.IH,L:values.Lbig,a:values.a});
  const second=seatValues(rig,{DA:values.DA,IH:values.IH+(rig==='skull'?0.5:-0.5),L:values.Lbig,a:values.a});
  return {
    name,
    preset,
    blade:'big',
    rig,
    strokeSide:1,
    phiA:rig==='skull'?66:54,
    phiR:rig==='skull'?44:36,
    c:8,
    seatOffset:5,
    s1:first,
    s2:second,
    ...overrides,
  };
}

function v1Workspace(preset='4x',overrides={}){
  const rig=PRESETS[preset].rig;
  const s1=crewMember('Schlagmann',rig,{
    DA:PRESETS[preset].DA,
    IH:PRESETS[preset].IH,
    L:PRESETS[preset].Lbig,
    a:PRESETS[preset].a,
    stemmX:rig==='skull'?48:50,
  });
  const s2=crewMember('Ruderer 2',rig,{
    DA:PRESETS[preset].DA,
    IH:PRESETS[preset].IH+(rig==='skull'?0.5:-0.5),
    L:PRESETS[preset].Lbig,
    a:PRESETS[preset].a,
    stemmX:rig==='skull'?39:46,
  });
  return {
    state:{
      rig,
      strokeSide:1,
      phiA:rig==='skull'?66:54,
      phiR:rig==='skull'?44:36,
      t:37,
      recovery:true,
      c:8,
      kg:0,
      mode:'werkstatt',
      heightRef:'sitz',
      seatOffset:5,
      crew:{s1,s2},
      editSeat:'s1',
      db:[],
      dbIdx:-1,
      boats:[],
      ...overrides.state,
    },
    preset,
    blade:'big',
    ...Object.fromEntries(Object.entries(overrides).filter(([key])=>key!=='state')),
  };
}

test('V1 workspace maps stroke s1 to highest real seat and s2 to the preceding seat',()=>{
  for(const preset of ['4x','4-','8+']){
    const source=v1Workspace(preset);
    const before=structuredClone(source);
    const result=adaptLegacyV1Workspace(source,{seed:`workspace-${preset.replace('+','plus')}`});
    const {workspace}=result;
    const count=PRESETS[preset].seatCount;
    assert.equal(workspace.schemaVersion,SCHEMA_VERSION);
    assert.equal(validateCurrentConfig(workspace).ok,true,JSON.stringify(validateCurrentConfig(workspace).errors));
    assert.equal(workspace.boat.seats.length,count);
    assert.deepEqual(workspace.crew.map(item=>item.rower.name),['Ruderer 2','Schlagmann']);
    assert.deepEqual(
      workspace.crew.map(item=>workspace.boat.seats.find(seat=>seat.id===item.seatId).position),
      [count-1,count],
    );
    assert.equal(workspace.boat.seats[0].role,'bow');
    assert.equal(workspace.boat.seats.at(-1).role,'stroke');
    assert.equal(workspace.boat.seats.at(-1).label,`Platz ${count} · Schlag`);
    assert.equal(workspace.editSeatId,workspace.boat.seats.at(-1).id);
    assert.equal(workspace.referenceSeatId,workspace.boat.seats.at(-1).id);
    assert.equal(workspace.boat.seats.slice(0,count-2).every(seat=>seat.rowerRef===null),true);
    assert.deepEqual(source,before,'pure adapter must not mutate the parsed V1 value');
  }
});

test('V1 1x removes hidden s2 person and rig instead of retaining a phantom seat',()=>{
  const source=v1Workspace('1x');
  source.state.crew.s2.name='Verborgene Person';
  source.state.crew.s2.IH=86;
  source.state.editSeat='s2';
  const result=adaptLegacyV1Workspace(JSON.stringify(source),{seed:'workspace-one'});
  assert.equal(result.workspace.boat.seats.length,1);
  assert.equal(result.workspace.boat.seats[0].role,'single');
  assert.equal(result.workspace.boat.seats[0].label,'Platz 1 · Einer');
  assert.equal(result.workspace.crew.length,1);
  assert.equal(result.workspace.crew[0].rower.name,'Schlagmann');
  assert.equal(result.workspace.editSeatId,result.workspace.boat.seats[0].id);
  assert.equal(result.workspace.boat.legacyRigTemplate,null);
  assert.doesNotMatch(JSON.stringify(result),/Verborgene Person/u);
});

test('bare V1 boat array migrates 1x, 4x, 4- and 8+ with deterministic current ids',()=>{
  const source=['1x','4x','4-','8+'].map(preset=>v1Boat(preset));
  const raw=JSON.stringify(source);
  const first=adaptLegacyV1Boats(raw,{seed:'stored-boats'});
  const repeated=adaptLegacyV1Boats(raw,{seed:'stored-boats'});
  const anotherSeed=adaptLegacyV1Boats(raw,{seed:'other-boats'});
  assert.deepEqual(first,repeated);
  assert.equal(raw,JSON.stringify(source),'raw source bytes stay untouched');
  assert.deepEqual(first.map(boat=>boat.seats.length),[1,4,4,8]);
  assert.equal(first.every(boat=>boat.schemaVersion===SCHEMA_VERSION&&validateBoat(boat).ok),true);
  assert.equal(first[0].legacyRigTemplate,null,'V1 s2 must not survive in a 1x boat record');
  for(const boat of first){
    assert.equal(boat.seats.at(-1).IH,source.find(candidate=>candidate.preset===boat.preset).s1.IH);
    if(boat.seats.length>1){
      assert.equal(boat.seats.at(-2).IH,source.find(candidate=>candidate.preset===boat.preset).s2.IH);
    }
  }
  assert.notEqual(first[1].seats[0].id,anotherSeed[1].seats[0].id);
});

test('embedded V1 databases are returned separately and never leak into workspace',()=>{
  const embeddedBoat=v1Boat('4x','Boot & Mannschaft');
  const source=v1Workspace('4x',{state:{
    db:[profile('Anna & Bob'),profile('Zitat „nur Text“',{weight:72})],
    dbIdx:1,
    boats:[embeddedBoat],
  }});
  const result=adaptLegacyV1Workspace(JSON.stringify(source),{seed:'separated'});
  assert.deepEqual(result.rowers.map(rower=>rower.name),['Anna & Bob','Zitat „nur Text“']);
  assert.equal(result.rowers.every(rower=>validateRower(rower).ok),true);
  assert.equal(result.boats.length,1);
  assert.equal(result.boats[0].name,'Boot & Mannschaft');
  assert.deepEqual(Object.keys(result.workspace),SCHEMAS.currentConfig.fields);
  assert.equal(Object.hasOwn(result.workspace,'db'),false);
  assert.equal(Object.hasOwn(result.workspace,'boats'),false);
  assert.doesNotMatch(JSON.stringify(result.workspace),/Anna & Bob|Boot & Mannschaft/u);
});

test('one malformed item rejects a mixed candidate atomically and unknown fields stay forbidden',()=>{
  const boats=[v1Boat('4x','Gültig'),v1Boat('4x','Ungültig')];
  boats[1].s2.IH='87';
  assert.throws(()=>adaptLegacyV1Boats(boats),LegacyV1ValidationError);
  const sparse=[v1Boat('4x')];
  sparse.length=2;
  assert.throws(()=>adaptLegacyV1Boats(sparse),/Array-Lücken/u);

  const workspace=v1Workspace('4x',{state:{
    db:[profile('Gültig'),{...profile('Ungültig'),weight:Infinity}],
  }});
  assert.throws(()=>adaptLegacyV1Workspace(workspace),LegacyV1ValidationError);

  const extra=v1Workspace('4x');
  extra.state.crew.s1.html='<img src=x onerror=alert(1)>';
  assert.throws(()=>adaptLegacyV1Workspace(extra),/unbekanntes Feld/u);

  const unsafeName=v1Workspace('4x');
  unsafeName.state.crew.s1.name='<script>alert(1)</script>';
  assert.throws(()=>adaptLegacyV1Workspace(unsafeName),/unsafeText|Markup/u);
});

test('malformed JSON, invalid seed and inconsistent preset/rig fail closed',()=>{
  assert.throws(()=>adaptLegacyV1Boats('[{"name":]'),LegacyV1ValidationError);
  assert.throws(()=>adaptLegacyV1Workspace(v1Workspace('4x'),{seed:'bad seed'}),LegacyV1ValidationError);
  const mismatch=v1Workspace('4x');
  mismatch.state.rig='riemen';
  assert.throws(()=>adaptLegacyV1Workspace(mismatch),/Rigg passt nicht/u);
});

test('legacy adapter stays DOM-, storage- and write-free',async()=>{
  const source=await readFile(new URL('../js/legacy-v1.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\b(?:document|window|localStorage|sessionStorage|indexedDB)\s*[.[]|\.setItem\s*\(|fetch\s*\(/u);
});
