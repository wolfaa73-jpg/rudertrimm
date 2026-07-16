import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
  PRESETS,
  RANGES,
  derivedGeometry,
  forceRatio,
  solveInboardForRatio,
} from '../js/core.mjs';

const PHI={skull:{A:66,R:44},riemen:{A:54,R:36}};

test('every preset and blade variant produces finite, coherent geometry',()=>{
  for(const [name,preset] of Object.entries(PRESETS)){
    for(const [blade,L] of [['big',preset.Lbig],['mac',preset.Lmac]]){
      const phi=PHI[preset.rig];
      const geometry=derivedGeometry({
        rig:preset.rig,DA:preset.DA,IH:preset.IH,L,d:2,a:preset.a,
        phiA:phi.A,phiR:phi.R,t:0,c:8,kg:0,
      });
      assert.equal(geometry.inb+geometry.outb,L,`${name}/${blade}: Momentarme ergeben Ruderlänge`);
      assert.ok(geometry.inb>0&&geometry.outb>0,`${name}/${blade}: positive Momentarme`);
      assert.ok(Object.values(geometry).filter(value=>typeof value==='number').every(Number.isFinite),`${name}/${blade}: finite Werte`);
      assert.ok(L>=RANGES[preset.rig].L[0]&&L<=RANGES[preset.rig].L[1],`${name}/${blade}: L im UI-Bereich`);
      const expectedOverlap=preset.rig==='skull'?2*(preset.IH+2)-preset.DA:preset.IH+2-preset.DA;
      assert.equal(geometry.overlap,expectedOverlap,`${name}/${blade}: Übergriff`);
    }
  }
});

test('moment-arm equalizer reproduces each preset ratio for every collar offset',()=>{
  for(const [name,preset] of Object.entries(PRESETS)){
    const L=preset.Lbig;
    const target=forceRatio({L,IH:preset.IH,d:1});
    for(const d of [1,1.5,2,2.5,3]){
      const result=solveInboardForRatio({L,d,targetRatio:target,range:RANGES[preset.rig].IH,step:0});
      assert.ok(Math.abs(result.achievedRatio-target)<1e-12,`${name}, d=${d}`);
    }
  }
});

test('World Rowing elite presets match the independently reproduced medians',async()=>{
  const summary=JSON.parse(await readFile(new URL('../data/world-rowing-2017-summary.json',import.meta.url),'utf8'));
  const mapping={
    wmM1x:'M1x',wmW1x:'W1x',wmM2x:'M2x',wmW2x:'W2x',wmM4x:'M4x',wmW4x:'W4x',
    'wmM2-':'M2-','wmW2-':'W2-','wmM4-':'M4-','wmW4-':'W4-','wmM8+':'M8+','wmW8+':'W8+',
  };
  for(const [presetName,sheet] of Object.entries(mapping)){
    const preset=PRESETS[presetName], reference=summary.classes[sheet];
    assert.ok(Math.abs(preset.DA-reference.rigDistance)<=0.25,`${presetName}: DA`);
    assert.ok(Math.abs(preset.IH-reference.inboard)<=0.25,`${presetName}: IH`);
    assert.ok(Math.abs(preset.Lbig-reference.oarLength)<=0.001,`${presetName}: Lbig`);
  }
});
