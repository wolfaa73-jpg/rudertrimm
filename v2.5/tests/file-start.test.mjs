import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import vm from 'node:vm';

import {buildClassicBundle} from '../scripts/build-classic-bundle.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>readFileSync(resolve(ROOT,path),'utf8');
const index=read('index.html');
const app=read('js/app.mjs');
const bundle=read('js/app.bundle.js');
const releaseSource=read('version.js');
const packageVersion=JSON.parse(read('package.json')).version;

test('the delivered HTML uses only existing classic scripts in deterministic order',()=>{
  const scripts=[...index.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)];
  const sources=scripts.map(([,attributes])=>attributes.match(/\bsrc="([^"]+)"/u)?.[1]??null);
  assert.deepEqual(sources,['version.js','js/app.bundle.js']);
  for(const [,attributes,body] of scripts){
    assert.doesNotMatch(attributes,/\btype\s*=\s*["']module["']/iu);
    assert.doesNotMatch(attributes,/\b(?:async|defer)\b/iu);
    assert.equal(body.trim(),'');
  }
  assert.doesNotMatch(index,/src="js\/app\.mjs"/u);

  const indexUrl=pathToFileURL(resolve(ROOT,'index.html'));
  for(const source of sources){
    const url=new URL(source,indexUrl);
    assert.equal(url.protocol,'file:');
    assert.equal(existsSync(fileURLToPath(url)),true,`missing delivered script: ${source}`);
  }
});

test('the committed classic bundle is parseable, deterministic and current',async()=>{
  const first=await buildClassicBundle();
  const second=await buildClassicBundle();
  assert.equal(first,second,'two builds from identical native modules must be byte-identical');
  assert.equal(bundle,first,'run npm run bundle after changing a native module');
  assert.doesNotThrow(()=>new vm.Script(bundle,{filename:'js/app.bundle.js'}));
  assert.doesNotMatch(bundle,/(^|\n)\s*(?:import|export)\s/mu);
  assert.doesNotMatch(bundle,/\beval\s*\(|new\s+Function\s*\(/u);
  assert.doesNotMatch(bundle,/\/Users\/|file:\/\//u);
  assert.match(bundle,/RUDERTRIMM_BOOT_PROMISE/u);
  assert.match(bundle,/rudertrimmBoot/u);
  assert.match(bundle,/Direktstart · PWA\/Offline-Cache nicht verfügbar/u);
});

test('file mode skips service workers and late HTTP boot still registers once',()=>{
  const modeSource=app.slice(
    app.indexOf('function serviceWorkerMode('),
    app.indexOf('function scheduleServiceWorkerRegistration('),
  );
  const scheduleSource=app.slice(
    app.indexOf('function scheduleServiceWorkerRegistration('),
    app.indexOf('async function registerServiceWorker('),
  );
  assert.ok(modeSource.startsWith('function serviceWorkerMode('));
  assert.ok(scheduleSource.startsWith('function scheduleServiceWorkerRegistration('));

  const modeContext={};
  vm.createContext(modeContext);
  vm.runInContext(modeSource,modeContext);
  for(const [protocol,supported,expected] of [
    ['file:',true,'direct-file'],
    ['file:',false,'direct-file'],
    ['http:',true,'register'],
    ['https:',true,'register'],
    ['https:',false,'unsupported'],
    ['custom:',true,'unsupported'],
  ]) assert.equal(vm.runInContext(`serviceWorkerMode('${protocol}',${supported})`,modeContext),expected);

  let calls=0;
  const complete={document:{readyState:'complete'},window:{addEventListener(){ throw new Error('unexpected listener'); }},task(){ calls+=1; }};
  vm.createContext(complete);
  vm.runInContext(scheduleSource,complete);
  vm.runInContext('scheduleServiceWorkerRegistration(task)',complete);
  assert.equal(calls,1);

  let handler=null;
  const loading={
    document:{readyState:'loading'},
    window:{addEventListener(type,next,options){
      assert.equal(type,'load');
      assert.equal(options.once,true);
      assert.equal(Object.keys(options).join(','),'once');
      handler=next;
    }},
    task(){ calls+=1; },
  };
  vm.createContext(loading);
  vm.runInContext(scheduleSource,loading);
  vm.runInContext('scheduleServiceWorkerRegistration(task)',loading);
  assert.equal(calls,1);
  handler();
  assert.equal(calls,2);

  assert.match(app,/error\.code='direct-file'/u);
  assert.match(app,/if\(isDirectFile\)[\s\S]*?Direktstart · PWA\/Offline-Cache nicht verfügbar/u);
  assert.match(app,/if\(swMode==='register'\) scheduleServiceWorkerRegistration\(registerServiceWorker\)/u);
});

test('release metadata replaces the placeholder and exposes a visible boot failure',()=>{
  let timer=null;
  const root={dataset:{}};
  const buildState={textContent:'Build wird geprüft'};
  const errorStatus={hidden:true,textContent:'',dataset:{}};
  const context={
    document:{
      documentElement:root,
      getElementById(id){ return id==='buildState'?buildState:id==='errorStatus'?errorStatus:null; },
    },
    setTimeout(callback,delay){ assert.equal(delay,4000); timer=callback; },
  };
  vm.createContext(context);
  vm.runInContext(releaseSource,context,{filename:'version.js'});
  assert.equal(context.RUDERTRIMM_RELEASE.appVersion,packageVersion);
  assert.equal(buildState.textContent,context.RUDERTRIMM_RELEASE.label);
  assert.equal(root.dataset.rudertrimmBoot,'release-loaded');
  assert.equal(typeof timer,'function');
  timer();
  assert.equal(root.dataset.rudertrimmBoot,'failed');
  assert.equal(errorStatus.hidden,false);
  assert.equal(errorStatus.dataset.bootFallback,'true');
  assert.match(errorStatus.textContent,/App-Logik wurde nicht geladen/u);
});
