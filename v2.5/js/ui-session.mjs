// DOM-free state guards for UI selections and optimistic workspace edits.
// Keeping them pure makes the dangerous UI↔repository bindings directly testable.

function nonEmptyString(value,label){
  if(typeof value!=='string'||!value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function revision(value,label,{allowZero=false}={}){
  if(!Number.isSafeInteger(value)||value<(allowZero?0:1)) throw new RangeError(`${label} must be a valid revision`);
  return value;
}

const VIEW_STATES=new Set(['new','available','synced']);
const STORAGE_MODES=new Set(['local','session','memory']);
const WORKFLOW_STEP_IDS=Object.freeze(['boat','seat','profile','result','save']);

/**
 * Projects the existing editor state into a cumulative beginner path. It does
 * not unlock, mutate or persist anything; experts can still use every step in
 * any order while the guide names the next safe action for newcomers.
 */
export function workflowGuideState({boatReady,seatReady,profileReady,resultReady,dirty,viewState}){
  for(const [label,value] of Object.entries({boatReady,seatReady,profileReady,resultReady,dirty})){
    if(typeof value!=='boolean') throw new TypeError(`${label} must be a boolean`);
  }
  if(!VIEW_STATES.has(viewState)) throw new RangeError('unknown workspace view state');
  const raw=[
    boatReady,
    boatReady&&seatReady,
    boatReady&&seatReady&&profileReady,
    boatReady&&seatReady&&profileReady&&resultReady,
    boatReady&&seatReady&&profileReady&&resultReady&&viewState==='synced'&&!dirty,
  ];
  const currentIndex=raw.indexOf(false);
  const steps=WORKFLOW_STEP_IDS.map((id,index)=>Object.freeze({
    id,
    status:raw[index]?'done':index===currentIndex?'current':'open',
  }));
  return Object.freeze({
    steps:Object.freeze(steps),
    completedCount:raw.filter(Boolean).length,
    currentStep:currentIndex<0?null:WORKFLOW_STEP_IDS[currentIndex],
  });
}

export function workspaceStateLabel({dirty,viewState,storageMode}){
  if(typeof dirty!=='boolean') throw new TypeError('dirty must be a boolean');
  if(!VIEW_STATES.has(viewState)) throw new RangeError('unknown workspace view state');
  if(!STORAGE_MODES.has(storageMode)) throw new RangeError('unknown storage mode');
  if(dirty) return 'Ungespeicherte Änderungen';
  if(viewState==='available') return 'Gespeicherter Stand verfügbar · noch nicht geladen';
  if(viewState==='new') return 'Noch nicht gespeichert';
  if(storageMode==='local') return 'Arbeitsstand gespeichert';
  if(storageMode==='session') return 'Nur in diesem Tab gespeichert';
  return 'Nur flüchtig gespeichert';
}

export function workspaceSavePolicy({viewState,canCommit}){
  if(!VIEW_STATES.has(viewState)) throw new RangeError('unknown workspace view state');
  if(typeof canCommit!=='boolean') throw new TypeError('canCommit must be a boolean');
  if(!canCommit){
    return Object.freeze({
      code:'external-conflict',
      canAttempt:false,
      requiresConfirmation:false,
      message:'Speichern gesperrt: Der Arbeitsstand wurde extern geändert. Zuerst exportieren oder den gespeicherten Stand laden.',
    });
  }
  if(viewState==='available'){
    return Object.freeze({
      code:'unloaded-existing',
      canAttempt:true,
      requiresConfirmation:true,
      message:'Ein gespeicherter Arbeitsstand ist vorhanden, aber noch nicht in die Formulare geladen.',
    });
  }
  return Object.freeze({code:'ready',canAttempt:true,requiresConfirmation:false,message:''});
}

/**
 * Completes an async workspace save without treating a newer editor/demo state as saved.
 * Object identity is intentional: a replaced or removed demo session is a new context.
 */
export function workspaceSaveCompletionPolicy({
  savedChangeVersion,currentChangeVersion,demoAtStart,currentDemo,playing,
}){
  revision(savedChangeVersion,'saved change version',{allowZero:true});
  revision(currentChangeVersion,'current change version',{allowZero:true});
  if(typeof playing!=='boolean') throw new TypeError('playing must be a boolean');
  const stateUnchanged=savedChangeVersion===currentChangeVersion&&demoAtStart===currentDemo;
  return Object.freeze({
    clearDemo:stateUnchanged&&demoAtStart!==null,
    dirty:!stateUnchanged||playing,
  });
}

/**
 * Resolve a delayed profile commit against the context captured at dispatch.
 * Selection adoption and dirty clearing are independent: an old-seat completion
 * may do neither after a seat/selection or draft-version change.
 */
export function profileCommitPolicy({savedContext,activeContext,selectionUnchanged,savedVersion,currentVersion}){
  nonEmptyString(savedContext,'saved context');
  nonEmptyString(activeContext,'active context');
  if(typeof selectionUnchanged!=='boolean') throw new TypeError('selectionUnchanged must be a boolean');
  revision(savedVersion,'saved draft version',{allowZero:true});
  revision(currentVersion,'current draft version',{allowZero:true});
  return Object.freeze({
    adoptSelection:savedContext===activeContext&&selectionUnchanged,
    clearDraft:savedVersion===currentVersion,
  });
}

export function createContextualSelection(){
  let current=Object.freeze({id:'',revision:null,context:null});
  const snapshot=()=>Object.freeze({...current});

  return Object.freeze({
    snapshot,
    adopt({id,revision:recordRevision,context}){
      current=Object.freeze({
        id:nonEmptyString(id,'selection id'),
        revision:revision(recordRevision,'selection revision'),
        context:nonEmptyString(context,'selection context'),
      });
      return snapshot();
    },
    clear(){
      current=Object.freeze({id:'',revision:null,context:null});
      return snapshot();
    },
    isFor(context){
      return current.id!==''&&current.context===context;
    },
    matches({id,revision:recordRevision,context}){
      return current.id!==''&&current.id===id&&current.revision===recordRevision&&current.context===context;
    },
  });
}

export function createObservedRevision(initialRevision=0){
  let current=Object.freeze({
    observedRevision:revision(initialRevision,'initial revision',{allowZero:true}),
    externalRevision:null,
    stale:false,
  });
  const snapshot=()=>Object.freeze({...current,canCommit:!current.stale});

  return Object.freeze({
    snapshot,
    adopt(nextRevision){
      current=Object.freeze({
        observedRevision:revision(nextRevision,'observed revision',{allowZero:true}),
        externalRevision:null,
        stale:false,
      });
      return snapshot();
    },
    markExternal(nextRevision){
      current=Object.freeze({
        observedRevision:current.observedRevision,
        externalRevision:revision(nextRevision,'external revision',{allowZero:true}),
        stale:true,
      });
      return snapshot();
    },
  });
}
