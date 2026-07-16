import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>readFileSync(resolve(ROOT,path),'utf8');
const index=read('index.html');
const app=read('js/app.mjs');
const css=read('css/v2.css');

function sourceBetween(start,end){
  const from=app.indexOf(start);
  const to=app.indexOf(end,from);
  assert.ok(from>=0&&to>from,`source markers missing: ${start} -> ${end}`);
  return app.slice(from,to);
}

test('Stammdaten and quick edit expose one accessible nonduplicated UI contract',()=>{
  const requiredIds=[
    'masterDataSection','masterPersonSelect','masterPersonUse','masterPersonManage','masterPersonDelete',
    'masterBoatSelect','masterBoatUse','masterBoatManage','quickEditPerson','quickEditBoat',
    'personQuickEditDialog','personQuickEditTitle','personQuickEditDescription','quickPersonApply','quickPersonCancel',
    'boatQuickEditDialog','boatQuickEditTitle','boatQuickEditDescription','quickBoatApply','quickBoatCancel',
  ];
  for(const id of requiredIds){
    assert.equal((index.match(new RegExp(`\\bid="${id}"`,'gu'))??[]).length,1,`${id} must exist exactly once`);
  }
  assert.match(index,/class="card master-data details-only" id="masterDataSection"/u);
  assert.match(index,/<dialog id="personQuickEditDialog"[^>]*aria-labelledby="personQuickEditTitle"[^>]*aria-describedby="personQuickEditDescription"/u);
  assert.match(index,/<dialog id="boatQuickEditDialog"[^>]*aria-labelledby="boatQuickEditTitle"[^>]*aria-describedby="boatQuickEditDescription"/u);
  assert.match(index,/id="quickPersonHeight"[^>]*aria-live="polite"/u);
  assert.match(index,/id="personQuickEditError"[^>]*role="alert"/u);
  assert.match(index,/id="boatQuickEditError"[^>]*role="alert"/u);

  const quickEditSource=sourceBetween('const QUICK_PERSON_FIELDS=','// „Weiterschalten"');
  assert.doesNotMatch(quickEditSource,/repositoryWrite|\.create\(|\.update\(|\.delete\(/u,
    'quick edit must change only the working copy');
  assert.match(quickEditSource,/workspaceChangeVersion!==context\.changeVersion/u);
  assert.match(quickEditSource,/profileDraftVersion\[context\.seatId\]!==context\.draftVersion/u);
  assert.match(quickEditSource,/seat\.trimId!==context\.trimId/u);
  assert.match(quickEditSource,/addEventListener\('close'.*restoreDialogFocus/su);
  assert.match(css,/@media \(max-width: 560px\)[\s\S]*?\.master-data-grid,[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/u);
  assert.match(css,/@media \(forced-colors: active\)[\s\S]*?\.quick-edit-dialog/u);
});

test('passive Stammdaten selections never load or mutate the working state',()=>{
  const elements={
    masterBoatSelect:{value:'boat-1'},masterBoatUse:{disabled:true},masterBoatStatus:{textContent:''},
    masterPersonSelect:{value:'person-1'},masterPersonUse:{disabled:true},masterPersonDelete:{disabled:true},masterPersonStatus:{textContent:''},
  };
  const boatRecords=[{id:'boat-1',revision:3,value:{name:'Werkboot',rig:'skull',seats:[{},{}]}}];
  const personRecords=[{id:'person-1',revision:4,value:{name:'Testperson',legLen:88,torsoLen:92}}];
  const state={token:'unchanged',phase:73,seats:[{id:'seat-2'}]};
  const before=JSON.stringify(state);
  const effects={writes:0,loads:0};
  const repository=records=>({
    list:()=>records,
    select:id=>{
      const record=records.find(item=>item.id===id);
      return record?{ok:true,record}:{ok:false};
    },
    create(){ effects.writes+=1; },update(){ effects.writes+=1; },delete(){ effects.writes+=1; },
  });
  const context={
    state,
    boatRepository:repository(boatRecords),rowerRepository:repository(personRecords),
    $:id=>elements[id],
    replaceOptions(select,_placeholder,items){ effects.loads+=0; select.items=items; select.value=''; },
    cleanName:(value,fallback)=>value||fallback,
    fmt:value=>String(value),
    activeSeat:()=>state.seats[0],
  };
  vm.createContext(context);
  vm.runInContext(
    sourceBetween('function updateMasterBoatSelection()','const HISTORY_OPERATION_LABELS=')
      +sourceBetween('function updateMasterPersonSelection()','function refreshDBSelect(')
      +'; globalThis.runBoat=refreshMasterBoatSelect; globalThis.runPerson=refreshMasterPersonSelect;',
    context,
  );
  context.runBoat();
  context.runPerson();
  assert.equal(JSON.stringify(state),before);
  assert.equal(effects.writes,0);
  assert.equal(elements.masterBoatSelect.value,'boat-1');
  assert.equal(elements.masterPersonSelect.value,'person-1');
  assert.equal(elements.masterBoatUse.disabled,false);
  assert.equal(elements.masterPersonUse.disabled,false);
  assert.equal(elements.masterPersonDelete.disabled,false);
  assert.match(elements.masterBoatStatus.textContent,/noch nicht geladen/u);
  assert.match(elements.masterPersonStatus.textContent,/noch nicht zugeordnet/u);
});

test('passive person deletion confirms outside locks and rechecks every reference before delete',async()=>{
  function setup({referenced=false,workspaceReferenced=false,confirmResult=true,race=false,workspaceRace=false}={}){
    const events=[];
    const record={id:'person-1',revision:4,value:{name:'Löschprofil'}};
    const trigger={};
    const elements={
      masterPersonSelect:{value:record.id,focus:()=>events.push('focus-master')},
      masterPersonStatus:{textContent:''},dbSelect:{value:''},
    };
    const seatRef={id:'seat-1',position:1,rowerRef:{id:record.id,revision:record.revision}};
    const state={seats:referenced?[seatRef]:[],dbIdx:2,view:'side',phase:4,playing:true};
    let deleted=false;
    const rowerRepository={
      key:'rowers',select:id=>!deleted&&id===record.id?{ok:true,record}:{ok:false},
      list:()=>deleted?[]:[record],reservedIds:()=>[record.id],
      snapshot:()=>({revision:8}),
      delete:(id,options)=>{
        events.push(['delete',id,options]);
        assert.equal(options.expectedRecordRevision,record.revision);
        deleted=true;
      },
    };
    const boatRepository={key:'boats',list:()=>[]};
    let savedWorkspace=workspaceReferenced?{boat:{seats:[seatRef]}}:null;
    const workspaceRepository={key:'workspace',get:()=>savedWorkspace};
    const context={
      state,rowerRepository,boatRepository,workspaceRepository,NoSelectionError:class extends Error{},
      $:id=>elements[id],document:{activeElement:trigger},
      cleanName:value=>value,seatLabel:seat=>`Platz ${seat.position}`,
      confirm:message=>{ events.push(['confirm',message]); return confirmResult; },
      announce:message=>events.push(['announce',message]),
      reportError:(error,message)=>events.push(['error',message,error.message]),
      refreshDBSelect:()=>{ events.push('refresh'); elements.masterPersonSelect.value=''; },
      repositoryWrite:async(repository,action)=>{
        events.push('lock-'+repository.key);
        if(repository===boatRepository&&race) state.seats=[seatRef];
        if(repository===workspaceRepository&&workspaceRace) savedWorkspace={boat:{seats:[seatRef]}};
        return action();
      },
    };
    vm.createContext(context);
    vm.runInContext(
      sourceBetween('function storedRowerReferences(','$(\'dbDelete\').addEventListener')
        +';globalThis.runDelete=deleteStoredRowerProfile;globalThis.assertNoRetired=assertNoRetiredRowerReferences;',context,
    );
    return {context,events,record,trigger,state,seatRef,get deleted(){ return deleted; }};
  }

  const success=setup();
  const before=JSON.stringify(success.state);
  assert.equal(await success.context.runDelete({
    id:success.record.id,expectedRecordRevision:success.record.revision,trigger:success.trigger,
  }),true);
  assert.deepEqual(success.events.slice(0,5).map(item=>Array.isArray(item)?item[0]:item),[
    'confirm','lock-workspace','lock-boats','lock-rowers','delete',
  ]);
  assert.equal(success.deleted,true);
  assert.equal(JSON.stringify({...success.state,dbIdx:2}),before,'view, phase, animation, and work state stay untouched');
  assert.ok(success.events.includes('focus-master'));

  const cancelled=setup({confirmResult:false});
  assert.equal(await cancelled.context.runDelete({
    id:cancelled.record.id,expectedRecordRevision:cancelled.record.revision,trigger:cancelled.trigger,
  }),false);
  assert.deepEqual(cancelled.events.map(item=>Array.isArray(item)?item[0]:item),['confirm']);
  assert.equal(cancelled.deleted,false);

  const blocked=setup({referenced:true});
  assert.equal(await blocked.context.runDelete({
    id:blocked.record.id,expectedRecordRevision:blocked.record.revision,trigger:blocked.trigger,
  }),false);
  assert.equal(blocked.events.some(item=>Array.isArray(item)&&item[0]==='confirm'),false);
  assert.match(blocked.context.$('masterPersonStatus').textContent,/Erst Plätze freigeben/u);

  const workspaceBlocked=setup({workspaceReferenced:true});
  assert.equal(await workspaceBlocked.context.runDelete({
    id:workspaceBlocked.record.id,expectedRecordRevision:workspaceBlocked.record.revision,
    trigger:workspaceBlocked.trigger,
  }),false);
  assert.equal(workspaceBlocked.events.some(item=>Array.isArray(item)&&item[0]==='confirm'),false);
  assert.match(workspaceBlocked.context.$('masterPersonStatus').textContent,/gespeicherter Arbeitsstand/u);

  const raced=setup({race:true});
  assert.equal(await raced.context.runDelete({
    id:raced.record.id,expectedRecordRevision:raced.record.revision,trigger:raced.trigger,
  }),false);
  assert.deepEqual(raced.events.slice(0,4).map(item=>Array.isArray(item)?item[0]:item),[
    'confirm','lock-workspace','lock-boats','lock-rowers',
  ]);
  assert.equal(raced.deleted,false);
  assert.ok(raced.events.some(item=>Array.isArray(item)&&item[0]==='error'));

  const workspaceRaced=setup({workspaceRace:true});
  assert.equal(await workspaceRaced.context.runDelete({
    id:workspaceRaced.record.id,expectedRecordRevision:workspaceRaced.record.revision,
    trigger:workspaceRaced.trigger,
  }),false);
  assert.deepEqual(workspaceRaced.events.slice(0,4).map(item=>Array.isArray(item)?item[0]:item),[
    'confirm','lock-workspace','lock-boats','lock-rowers',
  ]);
  assert.equal(workspaceRaced.deleted,false);
  assert.throws(()=>success.context.assertNoRetired({boat:{seats:[success.seatRef]}}),
    /datenschutzkonform gelöschtes Profil/u,
    'a save waiting behind the delete must reject the retired profile id');
});

test('explicit stored-boat loading reuses the dirty guard and is atomic on cancel',()=>{
  const oldBoat={id:'boat-old',revision:2,value:{name:'Alt',seats:[{id:'old-seat',rowerRef:{id:'person-old',revision:2}}]}};
  const newBoat={id:'boat-new',revision:5,value:{name:'Neu',seats:[{id:'new-seat',rowerRef:null},{id:'new-stroke',rowerRef:{id:'person-new',revision:4}}]}};
  const records=new Map([[oldBoat.id,oldBoat],[newBoat.id,newBoat]]);
  const state={seats:structuredClone(oldBoat.value.seats),editSeatId:'old-seat'};
  const elements={boatUpdate:{disabled:false},boatDelete:{disabled:false}};
  const calls=[];
  const context={
    state,dirty:true,selectedBoatId:oldBoat.id,selectedBoatRevision:oldBoat.revision,
    boatRepository:{select:id=>records.has(id)?{ok:true,record:records.get(id)}:{ok:false}},
    $:id=>elements[id],
    confirmOverwrite:()=>false,
    refreshBoatSelect:(...args)=>calls.push(['refreshBoatSelect',...args]),
    applyBoat:value=>{ calls.push(['applyBoat',value.name]); state.seats=structuredClone(value.seats); },
    endDemoSession:()=>calls.push(['endDemoSession']),
    refreshDBSelect:(...args)=>calls.push(['refreshDBSelect',...args]),
    setDirty:value=>calls.push(['setDirty',value]),
    assignmentFor:()=>null,
    cleanName:(value,fallback)=>value||fallback,
    announce:message=>calls.push(['announce',message]),
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween('function loadStoredBoatIntoWorkspace(','$(\'boatSelect\').addEventListener'),context);
  const before=JSON.stringify(state);
  assert.equal(vm.runInContext("loadStoredBoatIntoWorkspace('boat-new')",context),false);
  assert.equal(JSON.stringify(state),before);
  assert.equal(calls.some(call=>call[0]==='applyBoat'),false);
  assert.deepEqual(calls.at(-1),['refreshBoatSelect','boat-old']);

  calls.length=0; context.dirty=false;
  assert.equal(vm.runInContext("loadStoredBoatIntoWorkspace('boat-new')",context),true);
  assert.equal(state.seats.length,2);
  assert.deepEqual(state.seats.map(seat=>seat.rowerRef?.id??null),[null,'person-new'],
    'accepted loading replaces the working seat references with the stored boat truth');
  assert.deepEqual(calls.map(call=>call[0]),['applyBoat','endDemoSession','refreshDBSelect','setDirty','refreshBoatSelect','announce']);
  assert.equal(context.selectedBoatId,'boat-new');
  assert.equal(context.selectedBoatRevision,5);
  const loadSource=sourceBetween('function loadStoredBoatIntoWorkspace(','$(\'boatSelect\').addEventListener');
  assert.match(loadSource,/ersetzt Boot, Sitzwerte und gespeicherte Belegungsreferenzen/u);
  assert.doesNotMatch(loadSource,/Crewprofile bleiben erhalten/u);
});

test('stored-person assignment validates before adopting the selection',()=>{
  const record={id:'person-new',revision:7,value:{name:'Neu'}};
  const state={editSeatId:'seat-2',seats:[{id:'seat-2',trimId:'trim-2'}],dbIdx:-1};
  const calls=[];
  const context={
    state,
    rowerRepository:{
      select:id=>id===record.id?{ok:true,record}:{ok:false},
      list:()=>[record],
    },
    rowerSelection:{snapshot:()=>({id:'person-old',revision:3,context:'seat-2'})},
    activeAssignment:()=>({rowerRef:{id:'person-old'}}),
    confirmProfileReplacement:()=>true,
    refreshDBSelect:(...args)=>calls.push(['refresh',...args]),
    applyProfile:(...args)=>calls.push(['apply',...args]),
    buildControls:()=>calls.push(['controls']),renderSeatTabs:()=>calls.push(['tabs']),
    setDirty:()=>calls.push(['dirty']),render:()=>calls.push(['render']),
    seatLabel:()=> 'Platz 2 · Schlag',cleanName:value=>value,
    reportError:error=>calls.push(['error',error.message]),announce:message=>calls.push(['announce',message]),
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween('function assignStoredProfileToSeat(','$(\'dbSelect\').addEventListener'),context);
  assert.equal(vm.runInContext("assignStoredProfileToSeat('person-new')",context),true);
  assert.deepEqual(calls.slice(0,2).map(call=>call[0]),['apply','refresh'],
    'the profile must validate and bind before the stored selection is adopted');
  assert.deepEqual(calls[1],['refresh','person-new',true,'seat-2']);

  calls.length=0;
  context.applyProfile=()=>{ throw new RangeError('bereits anderem Platz zugeordnet'); };
  assert.equal(vm.runInContext("assignStoredProfileToSeat('person-new')",context),false);
  assert.equal(calls.some(call=>call[0]==='dirty'),false);
  assert.deepEqual(calls[0],['refresh','person-old']);
  assert.equal(calls[1][0],'error');
});

test('quick edit applies validated working-copy changes once and fails closed on stale context',()=>{
  class Field{
    constructor(value=''){ this.value=String(value); this.attributes=new Map(); this.hidden=false; this.textContent=''; }
    setAttribute(name,value){ this.attributes.set(name,String(value)); }
  }
  const elements={
    quickPersonName:new Field('Testiel neu'),quickPersonLegLen:new Field(91),quickPersonTorsoLen:new Field(96),
    quickPersonWingspan:new Field(189),quickPersonShoulder:new Field(41),quickPersonWeight:new Field(81),
    personQuickEditError:new Field(),personQuickEditDialog:{close:value=>effects.push(['person-close',value])},
    quickBoatName:new Field('Boot neu'),quickBoatInboard:new Field(89),quickBoatFootboard:new Field(34),
    boatQuickEditError:new Field(),boatQuickEditDialog:{close:value=>effects.push(['boat-close',value])},
    boatName:new Field('Boot alt'),
  };
  const seat={id:'seat-1',trimId:'trim-1',IH:88,stemmX:32.5};
  let assignment={seatId:seat.id,rowerRef:{id:'p-1',revision:2},rower:{name:'Testiel',legLen:90,torsoLen:95,wingspan:188,SB:40,weight:80,externalRef:null}};
  const state={editSeatId:seat.id,seats:[seat],rig:'skull'};
  const effects=[];
  const context={
    state,workspaceChangeVersion:4,selectedBoatId:'boat-1',selectedBoatRevision:3,
    profileDraftVersion:{[seat.id]:6},
    personQuickEditContext:{seatId:seat.id,trimId:seat.trimId,assignment,draftVersion:6,changeVersion:4},
    boatQuickEditContext:{seatId:seat.id,trimId:seat.trimId,seat,changeVersion:4,selectedBoatId:'boat-1',selectedBoatRevision:3},
    QUICK_PERSON_FIELDS:[
      {id:'quickPersonLegLen',key:'legLen',min:70,max:105,step:1},
      {id:'quickPersonTorsoLen',key:'torsoLen',min:75,max:110,step:1},
      {id:'quickPersonWingspan',key:'wingspan',min:150,max:215,step:1},
      {id:'quickPersonShoulder',key:'SB',min:32,max:48,step:1},
      {id:'quickPersonWeight',key:'weight',min:45,max:120,step:1},
    ],
    RANGES:{skull:{IH:[82,94]},rower:{stemmX:[26,56]}},
    $:id=>elements[id],cleanOptionalName:value=>String(value).trim()||null,
    numericDraftError:(raw,min,max,step)=>{
      const value=Number(raw);
      if(!Number.isFinite(value)||String(raw).trim()==='') return 'Zahl erforderlich';
      if(value<min||value>max) return 'außerhalb';
      return Math.abs((value-min)/step-Math.round((value-min)/step))>1e-7?'Schrittweite':'';
    },
    activeSeat:()=>seat,assignmentFor:()=>assignment,
    profileOf:value=>structuredClone(value),
    applyProfile:(_seatId,value,options)=>{
      effects.push(['person-apply',options]);
      assignment={...assignment,rower:structuredClone(value),rowerRef:options.rowerRef};
      context.profileDraftVersion[seat.id]+=1;
    },
    setDirty:()=>effects.push(['dirty']),buildControls:()=>effects.push(['controls']),render:()=>effects.push(['render']),
    announce:message=>effects.push(['announce',message]),
    boatOf:()=>({name:'Boot alt',rig:'skull',seats:[structuredClone(seat)]}),
    buildBoatDTO:value=>structuredClone(value),seatLabel:()=> 'Platz 1 · Einer',
  };
  vm.createContext(context);
  const helpers=sourceBetween('function setQuickEditError(','function updateQuickPersonHeight(');
  const personApply=sourceBetween('function applyPersonQuickEdit()','function openBoatQuickEdit()');
  const boatApply=sourceBetween('function applyBoatQuickEdit()','function restoreDialogFocus(');
  vm.runInContext(`${helpers}${personApply}${boatApply}`,context);

  assert.equal(vm.runInContext('applyPersonQuickEdit()',context),true);
  assert.equal(assignment.rower.name,'Testiel neu');
  assert.equal(assignment.rower.legLen,91);
  assert.deepEqual(effects.map(effect=>effect[0]),['person-apply','dirty','controls','render','person-close','announce']);

  effects.length=0;
  context.workspaceChangeVersion=5;
  assert.equal(vm.runInContext('applyBoatQuickEdit()',context),false);
  assert.equal(seat.IH,88);
  assert.equal(elements.boatName.value,'Boot alt');
  assert.equal(effects.length,0);

  context.workspaceChangeVersion=4;
  assert.equal(vm.runInContext('applyBoatQuickEdit()',context),true);
  assert.equal(seat.IH,89);
  assert.equal(seat.stemmX,34);
  assert.equal(elements.boatName.value,'Boot neu');
  assert.deepEqual(effects.map(effect=>effect[0]),['dirty','controls','render','boat-close','announce']);
});
