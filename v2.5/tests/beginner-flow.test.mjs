import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

import {workflowGuideState} from '../js/ui-session.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>readFileSync(resolve(ROOT,path),'utf8');
const index=read('index.html');
const app=read('js/app.mjs');
const css=read('css/v2.css');

function sourceBetween(start,end){
  const from=app.indexOf(start),to=app.indexOf(end,from);
  assert.ok(from>=0&&to>from,`missing source markers ${start} -> ${end}`);
  return app.slice(from,to);
}

test('the existing five-step guide has exact real targets and one compact help block',()=>{
  const guide=index.slice(index.indexOf('<details class="workflow-guide'),index.indexOf('</details>',index.indexOf('<details class="workflow-guide'))+10);
  const steps=[...guide.matchAll(/data-guide-step="([^"]+)"[^>]*><a href="#([^"]+)" data-guide-target="([^"]+)"/gu)]
    .map(([,step,target,hook])=>[step,target,hook]);
  assert.deepEqual(steps,[
    ['boat','preset','boat'],['seat','seattabs','seat'],['profile','dbSelect','profile'],
    ['result','actionResult','result'],['save','bSave','save'],
  ]);
  assert.equal((index.match(/id="workflowGuide"/gu)??[]).length,1);
  assert.match(index,/id="actionResult"[^>]*tabindex="-1"/u);
  assert.equal((index.match(/id="compactTrimHelp"/gu)??[]).length,1);
  const help=index.slice(index.indexOf('id="compactTrimHelp"'),index.indexOf('</details>',index.indexOf('id="compactTrimHelp"')));
  for(const phrase of ['Innenhebel','Stemmbrett','Kraftverhältnis','Reichweitenmodell','unkalibrierte Prüfmodelle']) assert.ok(help.includes(phrase));
  assert.match(css,/@media \(max-width: 340px\)[\s\S]*?\.workflow-guide ol\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/u);
});

test('guide rendering names one next step, caches RAF updates and never reopens itself',()=>{
  class Link{
    constructor(){ this.attributes=new Map(); }
    setAttribute(name,value){ this.attributes.set(name,String(value)); }
    removeAttribute(name){ this.attributes.delete(name); }
  }
  const steps=new Map();
  for(const id of ['boat','seat','profile','result','save']){
    const link=new Link(),state={textContent:''};
    const item={dataset:{},querySelector:selector=>selector==='[data-guide-target]'?link:state};
    steps.set(id,{item,link,state});
  }
  const guide={
    open:false,
    querySelector:selector=>steps.get(selector.match(/"([^"]+)"/u)?.[1])?.item??null,
  };
  const status={textContent:''};
  const context={
    workflowGuideReady:true,workflowGuideSignature:'',workflowCurrentResultSignature:'',workflowReviewedResultSignature:'',workflowGuideState,
    PRESETS:{'1x':{}},state:{seats:[{id:'seat-1'}],editSeatId:'seat-1'},
    dirty:true,workspaceViewState:'new',lastActionPlan:{status:'missing'},
    activeSeat:()=>({id:'seat-1'}),activeAssignment:()=>null,
    $:id=>id==='workflowGuide'?guide:id==='workflowGuideStatus'?status:id==='preset'?{value:'1x'}:null,
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween('function renderWorkflowGuide()','function workflowGuideTarget('),context);
  vm.runInContext('renderWorkflowGuide()',context);
  assert.equal(status.textContent,'2 von 5 erledigt · nächster sicherer Schritt markiert');
  assert.deepEqual([...steps].map(([,step])=>step.item.dataset.guideStatus),['done','done','current','open','open']);
  assert.equal(steps.get('profile').link.attributes.get('aria-current'),'step');
  assert.equal([...steps.values()].filter(step=>step.link.attributes.has('aria-current')).length,1);

  guide.open=false;
  context.lastActionPlan={status:'change'};
  context.workflowCurrentResultSignature='review-a';
  context.activeAssignment=()=>({rower:{name:'Test'}});
  vm.runInContext('renderWorkflowGuide()',context);
  assert.equal(guide.open,false,'state updates must respect a manually closed guide');
  assert.equal(steps.get('result').link.attributes.get('aria-current'),'step',
    'an available result must be reviewed before the guide advances to save');

  context.workflowReviewedResultSignature='review-a';
  vm.runInContext('renderWorkflowGuide()',context);
  assert.equal(steps.get('save').link.attributes.get('aria-current'),'step');

  context.lastActionPlan={status:'change',summary:'changed result'};
  context.workflowCurrentResultSignature='review-b';
  vm.runInContext('renderWorkflowGuide()',context);
  assert.equal(steps.get('result').link.attributes.get('aria-current'),'step',
    'changing the result invalidates the session-only review');
  assert.equal(context.workflowReviewedResultSignature,'');
  const signature=context.workflowGuideSignature;
  vm.runInContext('renderWorkflowGuide()',context);
  assert.equal(context.workflowGuideSignature,signature,'unchanged animation frames reuse the UI signature');

  const renderSource=sourceBetween('function renderWorkflowGuide()','function workflowGuideTarget(');
  assert.doesNotMatch(renderSource,/\.open\s*=/u);
  assert.match(app,/guide\.open=workspaceViewState==='new'&&!activeAssignment\(\)/u);
  assert.match(app,/\$\('actionResult'\)\.addEventListener\('focusin',markWorkflowResultReviewed\)/u);
});

test('result review signature follows diagnostics, not animation or presentation state',()=>{
  const context={JSON};
  vm.createContext(context);
  vm.runInContext(sourceBetween('function workflowResultSignature(','function renderWorkflowGuide()'),context);
  const plan={status:'ok',actions:[]};
  const base=[{seatId:'seat-1',position:1,rowerName:'Testiel',rig:'skull',IH:88,IHsoll:88,
    anlage:4,stemmX:32.5,knee90:165,roll90:75,naturalResolved:true,reachable:true,trackLimited:false}];
  const signature=context.workflowResultSignature(plan,base,1,'seat-1');
  assert.equal(signature,context.workflowResultSignature(plan,structuredClone(base),1,'seat-1'),
    'phase, view, speed and presentation are intentionally outside the result contract');
  assert.notEqual(signature,context.workflowResultSignature(plan,[{...base[0],IH:89}],1,'seat-1'));
  assert.notEqual(signature,context.workflowResultSignature(plan,[{...base[0],rowerName:'Testiel 2'}],1,'seat-1'));
  assert.notEqual(signature,context.workflowResultSignature({status:'change',actions:[{id:'ih'}]},base,1,'seat-1'));
  assert.equal(context.workflowResultSignature({status:'missing',actions:[]},[],1,'seat-1'),'');
});

test('guide focus routing is state-neutral and uses the current real seat',()=>{
  const focusLog=[];
  const target=id=>({id,focus:()=>focusLog.push(['focus',id]),scrollIntoView:()=>focusLog.push(['scroll',id])});
  const activeButton={...target('seat-button'),dataset:{seat:'seat-4'}};
  const elements={
    preset:{...target('preset'),value:'4x'},dbSelect:target('dbSelect'),actionResult:target('actionResult'),bSave:target('bSave'),
    seattabs:{querySelectorAll:()=>[activeButton]},liveStatus:{textContent:''},
  };
  const domain={dirty:true,phase:63,playing:true,view:'cross',seat:'seat-4'};
  const before=JSON.stringify(domain);
  const context={
    state:{editSeatId:'seat-4'},
    $:id=>elements[id],
    announce:message=>focusLog.push(['announce',message]),
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween('function workflowGuideTarget(','function initWorkflowGuide('),context);
  for(const step of ['boat','seat','profile','result','save']) assert.equal(vm.runInContext(`focusWorkflowGuideTarget('${step}')`,context),true);
  assert.deepEqual(focusLog.filter(item=>item[0]==='focus').map(item=>item[1]),['preset','seat-button','dbSelect','actionResult','bSave']);
  assert.equal(JSON.stringify(domain),before);
  const focusSource=sourceBetween('function workflowGuideTarget(','function initWorkflowGuide(');
  assert.doesNotMatch(focusSource,/setDirty|setVal|apply|repository|state\.[a-zA-Z]+\s*=/u);
  const scrollContext={motionPreference:{matches:true}};
  vm.createContext(scrollContext);
  vm.runInContext(sourceBetween('function preferredScrollBehavior()','const handleMotionPreference='),scrollContext);
  assert.equal(scrollContext.preferredScrollBehavior(),'auto');
  scrollContext.motionPreference.matches=false;
  assert.equal(scrollContext.preferredScrollBehavior(),'smooth');
  assert.doesNotMatch(app,/scrollIntoView\?\.\(\{[^}]*behavior:'smooth'/u);
});

test('valid recommendations are phrased as problem, manual change and expected effect',()=>{
  const renderSource=sourceBetween('function renderActionPlan()','function actionPlanForExport(');
  assert.match(renderSource,/problemLabel\.textContent='Problem: '/u);
  assert.match(renderSource,/changeLabel\.textContent='Jetzt ändern: '/u);
  assert.match(renderSource,/effectLabel\.textContent='Erwartete Wirkung: '/u);
  assert.match(renderSource,/action\.reason/u);
  assert.match(renderSource,/action\.direction/u);
  assert.match(renderSource,/action\.effect/u);
  assert.match(renderSource,/action\.uncertainty/u);
  assert.doesNotMatch(renderSource,/setVal|setDirty|repositoryWrite/u,
    'rendering a recommendation must never apply it automatically');
});
