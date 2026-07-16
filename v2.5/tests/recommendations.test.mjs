import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTrimActionPlan} from '../js/recommendations.mjs';

const seat=(position,overrides={})=>({
  seatId:`seat-${position}`,position,label:position===1?'Platz 1 · Bug':`Platz ${position} · Schlag`,
  rowerName:`Test ${position}`,rig:'skull',naturalResolved:true,reachable:true,trackLimited:false,
  IH:88,IHsoll:88,anlage:4,stemmX:32.5,knee90:165,roll90:75,...overrides,
});

test('action plan prioritizes safety, crew consistency, then largest target deviation',()=>{
  const input=[
    seat(1,{reachable:false,IH:84,anlage:3.5}),
    seat(4,{seatId:'seat-4',label:'Platz 4 · Schlag',IH:84,IHsoll:88,anlage:4}),
  ];
  const plan=buildTrimActionPlan({seats:input,referenceSeatId:'seat-4',totalSeatCount:4});
  assert.equal(plan.status,'change');
  assert.deepEqual(plan.actions.map(action=>action.id),['safety:seat-1','crew:anlage','inboard:seat-4']);
  assert.equal(plan.actions[0].scope.seatId,'seat-1');
  assert.equal(plan.actions[1].target.value,4);
  assert.equal(plan.actions[1].focusSeatId,'seat-1','crew action opens the actual deviating place');
  assert.equal(plan.actions[2].direction,'Innenhebel erhöhen');
  assert.equal(plan.actions[2].current.unit,'cm');
});

test('safety action suppresses a contradictory footstretcher recommendation for the same seat',()=>{
  const plan=buildTrimActionPlan({seats:[seat(1,{naturalResolved:false,knee90:145,roll90:92})],totalSeatCount:1});
  assert.deepEqual(plan.actions.map(action=>action.id),['safety:seat-1']);
});

test('complete in-range diagnostics report no acute action without claiming perfection',()=>{
  const plan=buildTrimActionPlan({seats:[seat(1)],totalSeatCount:1});
  assert.equal(plan.status,'ok');
  assert.equal(plan.actions.length,0);
  assert.match(plan.summary,/geprüften Regeln/u);
  assert.doesNotMatch(plan.summary,/perfekt|optimal/iu);
});

test('missing or invalid diagnostics never fabricate a recommendation',()=>{
  const empty=buildTrimActionPlan({seats:[],totalSeatCount:4});
  assert.equal(empty.status,'missing');
  assert.equal(empty.actions.length,0);
  const invalid=buildTrimActionPlan({seats:[seat(1,{IH:NaN})],totalSeatCount:1});
  assert.equal(invalid.status,'missing');
  assert.equal(invalid.actions.length,0);
});

test('ranking is deterministic, bounded to three, and leaves inputs untouched',()=>{
  const input=[seat(1,{IH:82,knee90:150}),seat(2,{seatId:'seat-2',IH:83,knee90:150,anlage:5})];
  const before=structuredClone(input);
  const first=buildTrimActionPlan({seats:input,referenceSeatId:'seat-2',totalSeatCount:2});
  const second=buildTrimActionPlan({seats:input,referenceSeatId:'seat-2',totalSeatCount:2});
  assert.deepEqual(first,second);
  assert.ok(first.actions.length<=3);
  assert.deepEqual(input,before);
});

test('synthetic comparison evidence visibly demonstrates crew pitch before the comparison inboard',()=>{
  const diagnostics=[
    seat(3,{seatId:'demo-compare',label:'Platz 3',rowerName:'Testiel 2',IH:84,IHsoll:87,anlage:3.5}),
    seat(4,{seatId:'demo-reference',label:'Platz 4 · Schlag',rowerName:'Testiel',IH:87,IHsoll:87,anlage:4}),
  ];
  const plan=buildTrimActionPlan({seats:diagnostics,referenceSeatId:'demo-reference',totalSeatCount:4});
  assert.equal(plan.status,'change');
  assert.deepEqual(plan.actions.slice(0,2).map(action=>action.id),['crew:anlage','inboard:demo-compare']);
  assert.equal(plan.actions[0].target.value,4);
  assert.equal(plan.actions[0].scope.seatId,null,'crew scope remains crew-wide');
  assert.equal(plan.actions[0].focusSeatId,'demo-compare','field jump targets Testiel 2, not the already matching reference');
  assert.equal(plan.actions[1].scope.position,3);
  assert.equal(plan.actions.length<=3,true);
});
