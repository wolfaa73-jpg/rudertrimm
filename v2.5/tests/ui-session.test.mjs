import assert from 'node:assert/strict';
import test from 'node:test';
import {createContextualSelection,createObservedRevision,profileCommitPolicy,workflowGuideState,workspaceSaveCompletionPolicy,workspaceSavePolicy,workspaceStateLabel} from '../js/ui-session.mjs';

test('beginner workflow derives one cumulative next step without changing editor state',()=>{
  const empty=workflowGuideState({boatReady:false,seatReady:false,profileReady:false,resultReady:false,dirty:false,viewState:'new'});
  assert.equal(empty.completedCount,0);
  assert.equal(empty.currentStep,'boat');
  assert.deepEqual(empty.steps.map(step=>step.status),['current','open','open','open','open']);

  const defaultBoat=workflowGuideState({boatReady:true,seatReady:true,profileReady:false,resultReady:false,dirty:false,viewState:'new'});
  assert.equal(defaultBoat.completedCount,2);
  assert.equal(defaultBoat.currentStep,'profile');

  const assigned=workflowGuideState({boatReady:true,seatReady:true,profileReady:true,resultReady:false,dirty:true,viewState:'new'});
  assert.equal(assigned.currentStep,'result');
  const evaluated=workflowGuideState({boatReady:true,seatReady:true,profileReady:true,resultReady:true,dirty:true,viewState:'synced'});
  assert.equal(evaluated.currentStep,'save');

  const complete=workflowGuideState({boatReady:true,seatReady:true,profileReady:true,resultReady:true,dirty:false,viewState:'synced'});
  assert.equal(complete.completedCount,5);
  assert.equal(complete.currentStep,null);
  assert.ok(complete.steps.every(step=>step.status==='done'));
  assert.equal(Object.isFrozen(complete),true);
  assert.equal(Object.isFrozen(complete.steps),true);
  assert.ok(complete.steps.every(Object.isFrozen));

  const savedEmpty=workflowGuideState({boatReady:true,seatReady:true,profileReady:false,resultReady:false,dirty:false,viewState:'synced'});
  assert.equal(savedEmpty.currentStep,'profile','saving incomplete data cannot skip the missing profile/result');
  assert.equal(savedEmpty.completedCount,2);
  assert.throws(()=>workflowGuideState({boatReady:1,seatReady:true,profileReady:true,resultReady:true,dirty:false,viewState:'synced'}));
  assert.throws(()=>workflowGuideState({boatReady:true,seatReady:true,profileReady:true,resultReady:true,dirty:false,viewState:'unknown'}));
});

test('workspace label distinguishes new, available, dirty, and synchronized editor state',()=>{
  assert.equal(workspaceStateLabel({dirty:false,viewState:'new',storageMode:'local'}),'Noch nicht gespeichert');
  assert.equal(workspaceStateLabel({dirty:false,viewState:'available',storageMode:'local'}),'Gespeicherter Stand verfügbar · noch nicht geladen');
  assert.equal(workspaceStateLabel({dirty:true,viewState:'synced',storageMode:'local'}),'Ungespeicherte Änderungen');
  assert.equal(workspaceStateLabel({dirty:false,viewState:'synced',storageMode:'local'}),'Arbeitsstand gespeichert');
  assert.equal(workspaceStateLabel({dirty:false,viewState:'synced',storageMode:'session'}),'Nur in diesem Tab gespeichert');
  assert.equal(workspaceStateLabel({dirty:false,viewState:'synced',storageMode:'memory'}),'Nur flüchtig gespeichert');
  assert.throws(()=>workspaceStateLabel({dirty:false,viewState:'unknown',storageMode:'local'}));
});

test('workspace save policy never silently overwrites an unloaded or externally changed stand',()=>{
  assert.deepEqual(workspaceSavePolicy({viewState:'new',canCommit:true}),{
    code:'ready',canAttempt:true,requiresConfirmation:false,message:'',
  });
  assert.deepEqual(workspaceSavePolicy({viewState:'available',canCommit:true}),{
    code:'unloaded-existing',canAttempt:true,requiresConfirmation:true,
    message:'Ein gespeicherter Arbeitsstand ist vorhanden, aber noch nicht in die Formulare geladen.',
  });
  const conflict=workspaceSavePolicy({viewState:'available',canCommit:false});
  assert.equal(conflict.code,'external-conflict');
  assert.equal(conflict.canAttempt,false);
  assert.equal(conflict.requiresConfirmation,false);
  assert.match(conflict.message,/Speichern gesperrt/u);
});

test('a waiting workspace save cannot take over a newer demo or hide its dirty state',()=>{
  const demo={id:'demo-a'};
  assert.deepEqual(workspaceSaveCompletionPolicy({
    savedChangeVersion:4,currentChangeVersion:4,demoAtStart:demo,currentDemo:demo,playing:false,
  }),{clearDemo:true,dirty:false},'an explicit unchanged demo save takes over that demo');
  assert.deepEqual(workspaceSaveCompletionPolicy({
    savedChangeVersion:4,currentChangeVersion:5,demoAtStart:null,currentDemo:demo,playing:false,
  }),{clearDemo:false,dirty:true},'a pre-demo save leaves the newer demo removable and dirty');
  assert.deepEqual(workspaceSaveCompletionPolicy({
    savedChangeVersion:4,currentChangeVersion:4,demoAtStart:demo,currentDemo:null,playing:false,
  }),{clearDemo:false,dirty:true},'removing a demo while saving cannot be undone by completion');
  assert.deepEqual(workspaceSaveCompletionPolicy({
    savedChangeVersion:4,currentChangeVersion:4,demoAtStart:null,currentDemo:null,playing:true,
  }),{clearDemo:false,dirty:true},'a running animation remains an unsaved visible state');
});

test('contextual record selection is bound to id, revision, and edited seat',()=>{
  const selection=createContextualSelection();
  assert.deepEqual(selection.snapshot(),{id:'',revision:null,context:null});

  selection.adopt({id:'rower-a',revision:3,context:'s1'});
  assert.equal(selection.isFor('s1'),true);
  assert.equal(selection.isFor('s2'),false);
  assert.equal(selection.matches({id:'rower-a',revision:3,context:'s1'}),true);
  assert.equal(selection.matches({id:'rower-a',revision:3,context:'s2'}),false);
  assert.equal(selection.matches({id:'rower-a',revision:4,context:'s1'}),false);

  assert.deepEqual(selection.clear(),{id:'',revision:null,context:null});
});

test('a queued profile commit never rebinds a different seat or clears a changed draft',()=>{
  assert.deepEqual(profileCommitPolicy({
    savedContext:'s1',
    activeContext:'s2',
    selectionUnchanged:false,
    savedVersion:4,
    currentVersion:5,
  }),{adoptSelection:false,clearDraft:false});

  assert.deepEqual(profileCommitPolicy({
    savedContext:'s1',
    activeContext:'s2',
    selectionUnchanged:true,
    savedVersion:4,
    currentVersion:4,
  }),{adoptSelection:false,clearDraft:true});

  assert.deepEqual(profileCommitPolicy({
    savedContext:'s1',
    activeContext:'s1',
    selectionUnchanged:true,
    savedVersion:4,
    currentVersion:4,
  }),{adoptSelection:true,clearDraft:true});

  assert.deepEqual(profileCommitPolicy({
    savedContext:'s1',
    activeContext:'s1',
    selectionUnchanged:false,
    savedVersion:4,
    currentVersion:4,
  }),{adoptSelection:false,clearDraft:true});
});

test('contextual record selection rejects incomplete or invalid bindings',()=>{
  const selection=createContextualSelection();
  for(const value of [
    {id:'',revision:1,context:'s1'},
    {id:'rower-a',revision:0,context:'s1'},
    {id:'rower-a',revision:1,context:''},
  ]) assert.throws(()=>selection.adopt(value));
});

test('workspace revision remains stale until the user explicitly adopts a revision',()=>{
  const revision=createObservedRevision();
  assert.deepEqual(revision.snapshot(),{
    observedRevision:0,externalRevision:null,stale:false,canCommit:true,
  });

  revision.adopt(4);
  revision.markExternal(5);
  assert.deepEqual(revision.snapshot(),{
    observedRevision:4,externalRevision:5,stale:true,canCommit:false,
  });

  revision.adopt(5);
  assert.deepEqual(revision.snapshot(),{
    observedRevision:5,externalRevision:null,stale:false,canCommit:true,
  });
});

test('workspace revision validates every observed and external revision',()=>{
  assert.throws(()=>createObservedRevision(-1));
  const revision=createObservedRevision(2);
  assert.throws(()=>revision.adopt(1.5));
  assert.throws(()=>revision.markExternal(-1));
});
