import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

import {validateBoat,validateRower} from '../js/core.mjs';
import {previewEfaCsv,parseEfaCsv,suggestEfaHeaderMapping,validateEfaCandidate} from '../js/efa-csv.mjs';
import {diffHistoryEntries,historyForEntity} from '../js/history.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>readFileSync(resolve(ROOT,path),'utf8');
const index=read('index.html');
const app=read('js/app.mjs');
const css=read('css/v2.css');
const digest=bytes=>createHash('sha256').update(bytes).digest();
const clock=()=>new Date('2026-07-16T12:00:00.000Z');

function sourceBetween(start,end){
  const from=app.indexOf(start);
  const to=app.indexOf(end,from);
  assert.ok(from>=0&&to>from,`source markers missing: ${start} -> ${end}`);
  return app.slice(from,to);
}

class FakeNode{
  constructor(tag='div'){
    this.tag=tag;
    this.children=[];
    this.style={};
    this.hidden=false;
    this.disabled=false;
    this.value='';
    this._text='';
  }
  set textContent(value){ this._text=String(value); this.children=[]; }
  get textContent(){ return this._text+this.children.map(child=>child.textContent??String(child)).join(''); }
  set innerHTML(_value){ throw new Error('unsafe HTML sink used'); }
  append(...children){ this.children.push(...children); }
  appendChild(child){ this.children.push(child); return child; }
  replaceChildren(...children){ this.children=[...children]; this._text=''; }
  focus(options){ this.focusOptions=options; }
}

class EventControl extends FakeNode{
  constructor(tag='button'){
    super(tag);
    this.handlers=new Map();
  }
  addEventListener(type,handler){ this.handlers.set(type,handler); }
  emit(type,event={}){
    const handler=this.handlers.get(type);
    assert.equal(typeof handler,'function',`${type} handler must be registered`);
    return handler(event);
  }
}

test('History renders create, update, and privacy-delete through inert text nodes',()=>{
  const entries=[
    {
      entityId:'person-1',revision:1,changedAt:'2026-07-16T10:00:00.000Z',operation:'create',
      source:'local-ui',reason:'person-create',snapshot:{name:'<img src=x onerror=alert(1)>',legLen:90},
    },
    {
      entityId:'person-1',revision:2,changedAt:'2026-07-16T10:05:00.000Z',operation:'update',
      source:'local-ui',reason:'person-update',snapshot:{name:'A & B',legLen:91},
    },
    {
      entityId:'person-1',revision:3,changedAt:'2026-07-16T10:10:00.000Z',operation:'delete',
      source:'local-ui',reason:'privacy-delete',snapshot:null,
    },
  ];
  const elements={
    historyKind:Object.assign(new FakeNode('select'),{value:'rowers'}),
    historyEntity:Object.assign(new FakeNode('select'),{value:'person-1'}),
    historyRevision:Object.assign(new FakeNode('select'),{value:'1'}),
    historyMeta:new FakeNode('p'),historyDiff:new FakeNode('dl'),
  };
  const repository={history:()=>entries};
  const context={
    $:id=>elements[id],rowerRepository:repository,boatRepository:repository,
    document:{createElement:tag=>new FakeNode(tag)},historyForEntity,diffHistoryEntries,
    truncateCodePoints:(value,length)=>[...value].slice(0,length).join(''),
  };
  vm.createContext(context);
  const block=sourceBetween('const HISTORY_OPERATION_LABELS=','function refreshHistoryRevisions()');
  assert.doesNotMatch(block,/\.innerHTML\s*=|insertAdjacentHTML|outerHTML/u);
  vm.runInContext(`${block};globalThis.renderHistory=renderHistoryRevision;`,context);

  context.renderHistory();
  assert.match(elements.historyMeta.textContent,/Revision 1 · angelegt/u);
  assert.equal(elements.historyDiff.children.length,1);
  assert.equal(elements.historyDiff.children[0].children[0].textContent,'Gesamtdatensatz');
  assert.equal(elements.historyDiff.children[0].children[1].textContent,'Alt: —');
  assert.match(elements.historyDiff.children[0].children[2].textContent,/<img src=x onerror=alert\(1\)>/u,
    'markup-shaped stored text stays literal text');

  elements.historyRevision.value='2';
  context.renderHistory();
  assert.match(elements.historyMeta.textContent,/Revision 2 · geändert/u);
  assert.deepEqual(
    elements.historyDiff.children.map(row=>row.children[0].textContent),
    ['Beinlänge (cm)','Name'],
  );
  assert.match(elements.historyDiff.textContent,/Alt: 90Neu: 91/u);
  assert.match(elements.historyDiff.textContent,/Alt: <img src=x onerror=alert\(1\)>Neu: A & B/u);

  elements.historyRevision.value='3';
  context.renderHistory();
  assert.match(elements.historyMeta.textContent,/Revision 3 · datenschutzkonform gelöscht/u);
  assert.equal(elements.historyDiff.children.length,1);
  assert.equal(elements.historyDiff.children[0].children[0].textContent,'Datenschutz-Löschung');
  assert.match(elements.historyDiff.children[0].children[1].textContent,/Altsnapshots wurden entfernt/u);
  assert.doesNotMatch(elements.historyDiff.textContent,/A & B|onerror/u,
    'the delete view must not re-expose purged personal snapshots');
});

test('History entity and revision controls remain read-only and explicitly labelled',()=>{
  const historyBlock=sourceBetween('const HISTORY_OPERATION_LABELS=','$\(\'historyKind\'\).addEventListener');
  for(const forbidden of ['repositoryWrite','\.create(','\.update(','\.delete(','applyProfile','applyBoat','setDirty']){
    assert.equal(historyBlock.includes(forbidden),false,`history view must not contain ${forbidden}`);
  }
  for(const id of ['historyKind','historyEntity','historyRevision']){
    assert.match(index,new RegExp(`<label for="${id}">`,'u'));
  }
  assert.match(index,/id="historyMeta" role="status" aria-live="polite"/u);
  assert.match(index,/id="historyDiff" aria-label="Änderungen Alt zu Neu"/u);
  assert.match(index,/Keine automatische Wiederherstellung/u);
});

test('UTF-8 CSV parsing populates only explicit mapping controls and leaves app state untouched',()=>{
  const ids=[
    'efaEntityType','efaDelimiter','efaPersonNameMode','efaDisplayNameColumn','efaFirstNameColumn',
    'efaLastNameColumn','efaAffixColumn','efaBoatNameColumn','efaIdColumn','efaScope','efaMapping',
    'efaPreview','efaCommit','efaPreviewResult','efaPreviewList','efaImportStatus',
  ];
  const elements=Object.fromEntries(ids.map(id=>[id,new FakeNode(id.startsWith('efa')?'select':'div')]));
  elements.efaEntityType.value='person';
  elements.efaDelimiter.value=';';
  elements.efaPersonNameMode.value='display';
  elements.efaScope.value='Verein Nord';
  const visibility={person:[new FakeNode()],boat:[new FakeNode()],display:[new FakeNode()],parts:[new FakeNode()]};
  const state={seat:'seat-4',phase:0.63,dirty:true,playing:true};
  const before=structuredClone(state);
  const context={
    state,parseEfaCsv,suggestEfaHeaderMapping,$:id=>elements[id],
    document:{querySelectorAll:selector=>({
      '.efa-person-only':visibility.person,'.efa-boat-only':visibility.boat,
      '.efa-display-only':visibility.display,'.efa-parts-only':visibility.parts,
    })[selector]??[]},
    replaceOptions(select,_placeholder,items){ select.items=structuredClone(items); select.value=''; },
  };
  vm.createContext(context);
  const mappingBlock=sourceBetween("let efaCsvText='';",'const EFA_CLASS_LABELS=');
  vm.runInContext(`${mappingBlock}
    globalThis.setCsv=value=>{efaCsvText=value;};
    globalThis.parseCsv=parseSelectedEfaText;
    globalThis.contract=currentEfaContract;`,context);
  context.setCsv('\ufeffVorname;Nachname;eFa ID\r\nJörg;Müller;p-7\r\n');
  context.parseCsv();

  assert.equal(elements.efaPersonNameMode.value,'parts');
  assert.equal(elements.efaFirstNameColumn.value,'Vorname');
  assert.equal(elements.efaLastNameColumn.value,'Nachname');
  assert.equal(elements.efaIdColumn.value,'eFa ID');
  assert.equal(elements.efaMapping.disabled,false);
  assert.equal(elements.efaPreview.disabled,false);
  assert.equal(elements.efaCommit.disabled,true);
  assert.equal(JSON.stringify(context.contract()),JSON.stringify({
    text:'\ufeffVorname;Nachname;eFa ID\r\nJörg;Müller;p-7\r\n',delimiter:';',entityType:'person',
    mapping:{firstName:'Vorname',lastName:'Nachname',id:'eFa ID'},scope:'Verein Nord',
  }));
  assert.deepEqual(state,before,'mapping and preview preparation must not touch operational state');
  assert.match(app,/new TextDecoder\('utf-8',\{fatal:true\}\)/u);
  assert.throws(()=>new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.of(0xff)));
});

test('preview is outside the lock; commit re-previews inside and rejects a stale plan',async()=>{
  const elements={
    efaPreview:new EventControl(),efaCommit:new EventControl(),efaFile:new FakeNode('input'),
    efaMapping:new FakeNode('fieldset'),
  };
  let records=[];
  let insideLock=false;
  let mergeCalls=0;
  const previewCalls=[];
  const errors=[];
  const notices=[];
  const candidate={name:'Testperson',status:'incomplete'};
  const state={seat:'seat-2',phase:0.42,dirty:true,playing:true};
  const before=structuredClone(state);
  const repository={list:()=>records};
  const context={
    state,efaApprovedPreview:null,efaApprovedContract:null,efaCsvText:'Name\nTestperson\n',efaParsed:{headers:['Name']},
    $:id=>elements[id],clearErrorStatus(){},currentEfaContract:()=>({
      text:'Name\nTestperson\n',delimiter:';',entityType:'person',mapping:{displayName:'Name'},scope:null,
    }),
    previewEfaCsv:async options=>{
      previewCalls.push({insideLock,existing:options.existingCandidates.length});
      const stale=options.existingCandidates.length>0;
      return {
        planFingerprint:stale?'plan-with-concurrent-record':'plan-empty',
        importedAt:'2026-07-16T12:00:00.000Z',
        counts:{new:stale?0:1,exactDuplicate:stale?1:0,invalid:0,nameReview:0,idConflict:0},
        items:stale?[]:[{classification:'new',candidate}],
      };
    },
    efaCandidateRepository:repository,
    renderEfaPreview:preview=>notices.push(['render',preview.planFingerprint]),
    repositoryWrite:async (selected,action)=>{
      assert.equal(selected,repository);
      assert.equal(insideLock,false);
      insideLock=true;
      try{ return await action(); }
      finally{ insideLock=false; }
    },
    collectionExchange:()=>({kind:'exchange'}),STORAGE_KINDS:{efaCandidates:'efaCandidates'},
    validateEfaCandidate,
    mergeCollectionImport:()=>{ mergeCalls+=1; return {added:1}; },
    resetEfaPreview:message=>notices.push(['reset',message]),
    refreshEfaCandidateList:()=>notices.push(['refresh']),announce:message=>notices.push(['announce',message]),
    reportError:(error,label)=>errors.push({error,label}),
  };
  vm.createContext(context);
  const handlers=sourceBetween("$('efaPreview').addEventListener('click',async()=>{",'function refreshBoatSelect(');
  vm.runInContext(handlers,context);

  await elements.efaPreview.emit('click');
  assert.deepEqual(previewCalls,[{insideLock:false,existing:0}]);
  records=[{value:candidate}];
  await elements.efaCommit.emit('click');
  assert.deepEqual(previewCalls,[{insideLock:false,existing:0},{insideLock:true,existing:1}]);
  assert.equal(mergeCalls,0,'a concurrent candidate must invalidate the approved plan before persistence');
  assert.equal(errors.length,1);
  assert.equal(errors[0].error.code,'efa-preview-changed');
  assert.deepEqual(state,before,'a rejected import must preserve all operational view state');
});

test('unchanged fresh eFa plan commits atomically with explicit audit and remains state-neutral',async()=>{
  const elements={
    efaPreview:new EventControl(),efaCommit:new EventControl(),efaFile:Object.assign(new FakeNode('input'),{value:'efa.csv'}),
    efaMapping:new FakeNode('fieldset'),
  };
  let insideLock=false;
  const calls=[];
  const candidate={name:'Testboot',status:'incomplete'};
  const repository={list:()=>[]};
  const state={seat:'seat-3',view:'side',phase:0.77,dirty:true,playing:true};
  const before=structuredClone(state);
  const context={
    state,efaApprovedPreview:null,efaApprovedContract:null,efaCsvText:'Bootsname\nTestboot\n',efaParsed:{headers:['Bootsname']},
    $:id=>elements[id],clearErrorStatus(){},currentEfaContract:()=>({
      text:'Bootsname\nTestboot\n',delimiter:';',entityType:'boat',mapping:{name:'Bootsname'},scope:null,
    }),
    previewEfaCsv:async options=>{
      calls.push(['preview',insideLock,options.existingCandidates.length]);
      return {
        planFingerprint:'stable-plan',importedAt:'2026-07-16T12:00:00.000Z',
        counts:{new:1,exactDuplicate:0,invalid:0,nameReview:0,idConflict:0},
        items:[{classification:'new',candidate}],
      };
    },
    efaCandidateRepository:repository,renderEfaPreview:()=>calls.push(['render']),
    repositoryWrite:async (_repository,action)=>{
      insideLock=true;
      try{ return await action(); }
      finally{ insideLock=false; }
    },
    collectionExchange:(kind,candidates,builder,options)=>{
      assert.equal(insideLock,true);
      assert.equal(kind,'efaCandidates');
      assert.deepEqual(candidates,[candidate]);
      assert.equal(builder(candidate),candidate);
      assert.equal(options.clock().toISOString(),'2026-07-16T12:00:00.000Z');
      return {kind,candidates};
    },
    STORAGE_KINDS:{efaCandidates:'efaCandidates'},validateEfaCandidate,
    mergeCollectionImport:options=>{
      assert.equal(insideLock,true);
      assert.equal(options.audit.source,'efa-csv');
      assert.equal(options.audit.reason,'efa-csv-import');
      assert.equal(options.approve({incoming:1,added:1}),true);
      calls.push(['merge']);
      return {added:1};
    },
    resetEfaPreview:message=>calls.push(['reset',message]),refreshEfaCandidateList:()=>calls.push(['refresh']),
    announce:message=>calls.push(['announce',message]),reportError:error=>assert.fail(error),
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween("$('efaPreview').addEventListener('click',async()=>{",'function refreshBoatSelect('),context);

  await elements.efaPreview.emit('click');
  await elements.efaCommit.emit('click');
  assert.deepEqual(calls.slice(0,4),[
    ['preview',false,0],['render'],['preview',true,0],['merge'],
  ]);
  assert.equal(elements.efaFile.value,'');
  assert.equal(elements.efaMapping.disabled,true);
  assert.equal(elements.efaPreview.disabled,true);
  assert.deepEqual(state,before,'candidate staging must not alter seat, view, phase, dirty, or animation state');
});

test('eFa candidates are valid staging records but invalid operational rower/boat DTOs',async()=>{
  const preview=await previewEfaCsv({
    text:'Name;ID\nTestiel;p-1\n',delimiter:';',entityType:'person',mapping:{displayName:'Name',id:'ID'},
    scope:'Verein Nord',clock,digest,
  });
  const candidate=preview.items[0].candidate;
  assert.equal(validateEfaCandidate(candidate).ok,true);
  assert.equal(validateRower(candidate).ok,false);
  assert.equal(validateBoat(candidate).ok,false);
  for(const forbidden of ['legLen','torsoLen','wingspan','SB','weight','preset','rig','seats']){
    assert.equal(Object.hasOwn(candidate,forbidden),false,`${forbidden} must never be invented by CSV staging`);
  }

  const candidateUi=sourceBetween('function refreshEfaCandidateList()','async function loadEfaCandidates()');
  assert.doesNotMatch(candidateUi,/applyProfile|applyBoat|assignStoredProfileToSeat|loadStoredBoatIntoWorkspace|state\.seats|setDirty/u);
  const operationalProfile=sourceBetween('function assignStoredProfileToSeat(',"$('dbSelect').addEventListener");
  const operationalBoat=sourceBetween('function loadStoredBoatIntoWorkspace(',"$('boatSelect').addEventListener");
  assert.doesNotMatch(operationalProfile,/efaCandidateRepository/u);
  assert.doesNotMatch(operationalBoat,/efaCandidateRepository/u);
});

test('History and eFa tools are Details-only, labelled, touch-sized, and reflow at 390 px',()=>{
  const masterStart=index.indexOf('<section class="card master-data details-only" id="masterDataSection"');
  const historyStart=index.indexOf('<details class="master-data-tool" id="historySection">');
  const efaStart=index.indexOf('<details class="master-data-tool" id="efaImportSection">');
  const masterEnd=index.indexOf('<details class="foot details-only">',efaStart);
  assert.ok(masterStart>=0&&masterStart<historyStart&&historyStart<efaStart&&efaStart<masterEnd,
    'both tools must remain inside the existing Details-only master-data section');
  assert.doesNotMatch(index.slice(historyStart,historyStart+100),/\sopen(?:\s|>)/u);
  assert.doesNotMatch(index.slice(efaStart,efaStart+100),/\sopen(?:\s|>)/u);

  const ids=[
    'historyKind','historyEntity','historyRevision','efaEntityType','efaDelimiter','efaFile',
    'efaPersonNameMode','efaDisplayNameColumn','efaFirstNameColumn','efaLastNameColumn',
    'efaAffixColumn','efaBoatNameColumn','efaIdColumn','efaScope',
  ];
  for(const id of ids){
    assert.equal((index.match(new RegExp(`\\bid="${id}"`,'gu'))??[]).length,1,`${id} must exist once`);
    assert.match(index,new RegExp(`<label[^>]*for="${id}"`,'u'),`${id} must have a visible label`);
  }
  assert.match(index,/id="efaImportStatus" role="status" aria-live="polite"/u);
  assert.match(index,/Keine Verbindung und kein Sync/u);
  assert.match(index,/werden weder berechnet noch Plätzen zugeordnet/u);

  assert.match(css,/\.master-data-tool > summary\s*\{[^}]*min-block-size:\s*var\(--v2-touch\)/su);
  assert.match(css,/\.efa-import-actions button\s*\{[^}]*min-block-size:\s*var\(--v2-touch\)/su);
  assert.match(css,/#efaCandidateList button\s*\{[^}]*min-block-size:\s*var\(--v2-touch\)/su);
  const phone=css.match(/@media \(max-width: 560px\) \{[\s\S]*?(?=\n@media |$)/u)?.[0]??'';
  assert.ok(phone,'the phone reflow contract must exist and therefore include 390 px');
  assert.match(phone,/\.history-selectors,[\s\S]*?\.efa-import-grid,[\s\S]*?\.efa-mapping\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/u);
  assert.match(phone,/\.history-diff > div\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/u);
  assert.match(phone,/#efaPreviewList li,[\s\S]*?#efaCandidateList li\s*\{[\s\S]*?flex-direction:\s*column/u);
});

test('central repository writes migrate freshly reloaded v2 bytes before the requested action',()=>{
  const block=sourceBetween('const repositoryWrite=','let selectedBoatId=');
  assert.match(block,/withExclusiveRepositoryWrite\(repository,\(\)=>\{/u);
  const migration=block.indexOf('repository.commitPendingMigration');
  const action=block.indexOf('return action()');
  assert.ok(migration>=0&&action>migration,'pending migration must commit before the requested mutation');
  assert.doesNotMatch(block,/confirm\(|prompt\(|alert\(/u,'no human wait may be held inside the repository lock');
});
