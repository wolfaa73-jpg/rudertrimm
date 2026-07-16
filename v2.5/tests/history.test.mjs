import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HistoryValidationError,
  diffHistoryEntries,
  historyForEntity,
  historyTimelineForEntity,
  normalizeHistoryEntry,
  normalizeHistoryEntries,
  validateHistoryEntry,
} from '../js/history.mjs';

const at=revision=>`2026-07-16T10:0${revision}:00.000Z`;
const entry=(revision,overrides={})=>({
  entityId:'boat-4x',
  revision,
  changedAt:at(revision),
  operation:revision===1?'create':'update',
  source:'local-ui',
  reason:'Bewusst gespeichert',
  snapshot:{kind:'boat',name:'Vierer',rig:{inboard:88,crew:['A','B']}},
  ...overrides,
});

test('normalization accepts only the exact immutable entry contract',()=>{
  const source=entry(1,{source:'  local-ui  ',reason:'  Erstanlage  '});
  const normalized=normalizeHistoryEntry(source);
  assert.deepEqual(Object.keys(normalized).sort(),[
    'changedAt','entityId','operation','reason','revision','snapshot','source',
  ]);
  assert.equal(normalized.source,'local-ui');
  assert.equal(normalized.reason,'Erstanlage');
  assert.equal(Object.isFrozen(normalized),true);
  assert.equal(Object.isFrozen(normalized.snapshot.rig.crew),true);
  source.snapshot.name='Nachträglich manipuliert';
  assert.equal(normalized.snapshot.name,'Vierer');
  assert.throws(()=>normalizeHistoryEntry({...entry(1),extra:true}),HistoryValidationError);
  assert.throws(()=>normalizeHistoryEntry({...entry(1),revision:0}),/positive safe integer/u);
  assert.throws(()=>normalizeHistoryEntry({...entry(1),entityId:'../boat'}),/safe stable id/u);
  assert.throws(()=>normalizeHistoryEntry({...entry(1),changedAt:'2026-07-16'}),/canonical ISO/u);
  assert.throws(()=>normalizeHistoryEntry({...entry(1),operation:'restore'}),/not supported/u);
});

test('delete is an explicit tombstone and every other operation carries a DTO',()=>{
  const deletion=normalizeHistoryEntry(entry(3,{operation:'delete',snapshot:null}));
  assert.equal(deletion.snapshot,null);
  for(const operation of ['baseline','create','update','import','migration']){
    assert.equal(validateHistoryEntry(entry(1,{operation})).ok,true,operation);
    assert.equal(validateHistoryEntry(entry(1,{operation,snapshot:null})).ok,false,operation);
  }
  assert.equal(validateHistoryEntry(entry(3,{operation:'delete'})).ok,false);
});

test('validation rejects non-JSON values, dangerous keys, sparse arrays and cycles',()=>{
  assert.equal(validateHistoryEntry(entry(1,{snapshot:{value:NaN}})).ok,false);
  assert.equal(validateHistoryEntry(entry(1,{snapshot:{value:Infinity}})).ok,false);
  assert.equal(validateHistoryEntry(entry(1,{snapshot:{value:undefined}})).ok,false);
  assert.equal(validateHistoryEntry(entry(1,{snapshot:{value:new Date()}})).ok,false);
  const dangerous=JSON.parse('{"safe":1,"__proto__":{"polluted":true}}');
  assert.equal(validateHistoryEntry(entry(1,{snapshot:dangerous})).ok,false);
  const sparse=[];
  sparse.length=2;
  sparse[1]='B';
  assert.equal(validateHistoryEntry(entry(1,{snapshot:{crew:sparse}})).ok,false);
  const cycle={kind:'boat'};
  cycle.self=cycle;
  assert.equal(validateHistoryEntry(entry(1,{snapshot:cycle})).ok,false);
});

test('history selection is deterministic, immutable and derives validity without rewriting facts',()=>{
  const first=entry(1);
  const second=entry(2,{changedAt:'2026-07-16T10:02:00.000Z'});
  const other=entry(1,{entityId:'rower-a',snapshot:{kind:'rower',name:'A'}});
  const selected=historyForEntity([second,other,first],'boat-4x');
  assert.deepEqual(selected.map(item=>item.revision),[1,2]);
  assert.equal(Object.isFrozen(selected),true);
  assert.equal(Object.isFrozen(selected[0]),true);
  const timeline=historyTimelineForEntity([second,first],'boat-4x');
  assert.equal(timeline[0].validFrom,first.changedAt);
  assert.equal(timeline[0].validTo,second.changedAt);
  assert.equal(timeline[1].validTo,null);
  assert.equal(Object.hasOwn(timeline[0].entry,'validTo'),false,'derived validity never mutates the stored fact');
  assert.equal(Object.isFrozen(timeline[0]),true);
});

test('history selection rejects duplicate revisions, backwards time and facts after deletion',()=>{
  assert.throws(()=>historyForEntity([entry(1),entry(1,{changedAt:at(2)})],'boat-4x'),/strictly increasing revisions/u);
  assert.throws(()=>historyForEntity([
    entry(1,{changedAt:at(2)}),entry(2,{changedAt:at(1)}),
  ],'boat-4x'),/must not move backwards/u);
  assert.throws(()=>historyForEntity([
    entry(1),entry(2,{operation:'delete',snapshot:null}),entry(3),
  ],'boat-4x'),/must not continue after deletion/u);
});

test('create and delete comparisons are explicit and immutable',()=>{
  const creation=diffHistoryEntries(null,entry(1));
  assert.equal(creation.changeType,'create');
  assert.deepEqual(creation.changes.map(change=>[change.path,change.type]),[['','added']]);
  assert.equal(creation.changes[0].beforePresent,false);
  assert.equal(creation.changes[0].after.name,'Vierer');
  assert.equal(Object.isFrozen(creation.changes[0].after),true);

  const deletion=diffHistoryEntries(entry(2),entry(3,{operation:'delete',snapshot:null}));
  assert.equal(deletion.changeType,'delete');
  assert.deepEqual(deletion.changes.map(change=>[change.path,change.type]),[['','removed']]);
  assert.equal(deletion.changes[0].before.name,'Vierer');
  assert.equal(deletion.changes[0].afterPresent,false);
  assert.throws(()=>diffHistoryEntries(null,entry(1,{operation:'delete',snapshot:null})),/requires a previous snapshot/u);
});

test('nested objects and arrays report only changed deterministic JSON-pointer paths',()=>{
  const previous=entry(1,{snapshot:{
    crew:[{name:'A',side:'port'},{name:'B',side:'starboard'}],
    measurements:{inboard:88,pitch:4},
    note:null,
  }});
  const current=entry(2,{snapshot:{
    crew:[{name:'A',side:'port'},{name:'C',side:'starboard'},{name:'D',side:'port'}],
    measurements:{inboard:89,pitch:4},
    newField:null,
  }});
  const diff=diffHistoryEntries(previous,current);
  assert.equal(diff.changeType,'update');
  assert.deepEqual(diff.changes.map(change=>[change.path,change.type]),[
    ['/crew/1/name','changed'],
    ['/crew/2','added'],
    ['/measurements/inboard','changed'],
    ['/newField','added'],
    ['/note','removed'],
  ]);
  assert.equal(diff.changes[3].beforePresent,false,'missing remains distinct from null');
  assert.equal(diff.changes[3].after,null);
  assert.equal(Object.isFrozen(diff),true);
  assert.equal(Object.isFrozen(diff.changes),true);
});

test('boat seats are compared by stable ID when a capacity change moves their array position',()=>{
  const previous=entry(1,{snapshot:{kind:'boat',name:'Zweier',seats:[
    {id:'seat-bow',position:1,role:'bow',IH:90},
    {id:'seat-stroke',position:2,role:'stroke',IH:92},
  ]}});
  const current=entry(2,{snapshot:{kind:'boat',name:'Vierer',seats:[
    {id:'seat-bow',position:1,role:'bow',IH:90},
    {id:'seat-2',position:2,role:'crew',IH:90},
    {id:'seat-3',position:3,role:'crew',IH:90},
    {id:'seat-stroke',position:4,role:'stroke',IH:92},
  ]}});
  const changes=diffHistoryEntries(previous,current).changes;
  assert.ok(changes.some(change=>change.path==='/seats/@seat-stroke/position'));
  assert.ok(changes.some(change=>change.path==='/seats/@seat-2'&&change.type==='added'));
  assert.ok(changes.some(change=>change.path==='/seats/@seat-3'&&change.type==='added'));
  assert.equal(changes.some(change=>change.path==='/seats/@seat-stroke/IH'),false,
    'moving the physical stroke seat must not invent an inboard change');
  assert.equal(changes.some(change=>/^\/seats\/\d+\//u.test(change.path)),false,
    'stable seat comparisons never fall back to array indexes');
});

test('a real seat trim change remains attached to its stable seat ID',()=>{
  const previous=entry(1,{snapshot:{kind:'boat',name:'Vierer',seats:[
    {id:'seat-bow',position:1,role:'bow',IH:90},
    {id:'seat-stroke',position:4,role:'stroke',IH:92},
  ]}});
  const current=entry(2,{snapshot:{kind:'boat',name:'Vierer',seats:[
    {id:'seat-stroke',position:4,role:'stroke',IH:93},
    {id:'seat-bow',position:1,role:'bow',IH:90},
  ]}});
  assert.deepEqual(diffHistoryEntries(previous,current).changes.map(change=>[change.path,change.before,change.after]),[
    ['/seats/@seat-stroke/IH',92,93],
  ]);
});

test('unchanged snapshots produce no invented differences',()=>{
  const previous=entry(1);
  const current=entry(2,{snapshot:structuredClone(previous.snapshot)});
  const diff=diffHistoryEntries(previous,current);
  assert.equal(diff.changeType,'unchanged');
  assert.deepEqual(diff.changes,[]);
});

test('diff ordering and normalization are deterministic without mutating inputs',()=>{
  const previous=entry(1,{snapshot:{z:1,a:{b:2,a:1},slash:{'a/b':1,'a~b':1}}});
  const current=entry(2,{snapshot:{z:2,a:{b:3,a:1},slash:{'a/b':2,'a~b':2}}});
  const before=structuredClone([previous,current]);
  const first=diffHistoryEntries(previous,current);
  const second=diffHistoryEntries(previous,current);
  assert.deepEqual(first,second);
  assert.deepEqual(first.changes.map(change=>change.path),[
    '/a/b','/slash/a~1b','/slash/a~0b','/z',
  ]);
  assert.deepEqual([previous,current],before);
  assert.doesNotMatch(JSON.stringify(first),/<(?:script|div|span)/iu);
});

test('collection normalization rejects holes and freezes every entry',()=>{
  const sparse=[];
  sparse.length=1;
  assert.throws(()=>normalizeHistoryEntries(sparse),/dense array/u);
  const normalized=normalizeHistoryEntries([entry(1)]);
  assert.equal(Object.isFrozen(normalized),true);
  assert.equal(Object.isFrozen(normalized[0].snapshot),true);
});
