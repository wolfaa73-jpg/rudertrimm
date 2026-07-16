import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARM_ANGLE_POLICY,
  CATCH_MODEL,
  MAX_IMPORT_ITEMS,
  MAX_NAME_LENGTH,
  ORTHOGONAL_POLICY,
  PRESETS,
  RANGES,
  SCHEMA_VERSION,
  STROKE_CYCLE,
  advanceStrokeCycle,
  armAngleToHorizontal,
  assessArmAngle,
  assessArmReachability3D,
  assessOrthogonalTrim,
  buildBoatDTO,
  buildCurrentConfigDTO,
  buildImportDTO,
  buildRowerDTO,
  buildSeatDTO,
  buildTestielComparisonDemoConfig,
  buildTestielDemoConfig,
  clamp,
  cycleProgressFromStrokePose,
  defaultFaForRig,
  deriveBodySegments,
  derivedGeometry,
  forceRatio,
  findHighestReachableAngle,
  hasHiddenSingleSeatProfile,
  isFiniteNumber,
  isInRange,
  migrateBoatToCurrent,
  migrateBoatV2,
  migrateBoatV3,
  migrateCurrentConfigToCurrent,
  migrateCurrentConfigV2,
  migrateCurrentConfigV3,
  migrateRowerToCurrent,
  migrateRowerV2,
  minimizeHiddenSingleSeatProfile,
  planSeatLayoutByRole,
  requireFinite,
  requireRange,
  solveInboardForRatio,
  solveNaturalCatchAngle,
  seatLabelForPosition,
  seatRoleForPosition,
  strokePoseAtCycleProgress,
  validateArmPose3D,
  validateBoat,
  validateCurrentConfig,
  validateImportObject,
  validateRower,
  truncateCodePoints,
  validateSeat,
  UnsupportedSchemaVersionError,
} from '../js/core.mjs';

function validRower(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'rower',
    externalRef: null,
    name: 'Alex',
    legLen: 90,
    torsoLen: 95,
    wingspan: 188,
    SB: 40,
    weight: 80,
    stemmX: 48,
    ...overrides,
  };
}

function validSeat(rig = 'skull', overrides = {}) {
  const {seatCount: explicitSeatCount, ...seatOverrides} = overrides;
  const position = seatOverrides.position ?? 1;
  const seatCount = explicitSeatCount ?? Math.max(1, position);
  const base = rig === 'skull'
    ? {DA: 159, IH: 88, L: 288, a: 15}
    : {DA: 84, IH: 114, L: 375, a: 17};
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'seat',
    id: `seat-${position}`,
    trimId: `trim-${position}`,
    externalRef: null,
    position,
    role: seatRoleForPosition(position, seatCount),
    label: seatLabelForPosition(position, seatCount),
    rig,
    ...base,
    d: 2,
    handGap: 18,
    anlage: 4,
    aussen: 0,
    dBB: 0.5,
    stemmW: 42,
    rollL: 75,
    rueh: 5,
    stemmX: rig === 'skull' ? 32.5 : 50,
    rowerRef: null,
    ...seatOverrides,
  };
}

function validBoat(overrides = {}) {
  const rig = overrides.rig ?? 'skull';
  const preset = overrides.preset ?? (rig === 'skull' ? '2x' : '4-');
  const seatCount = PRESETS[preset]?.seatCount ?? 2;
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'boat',
    externalRef: null,
    name: 'Vereinsboot 1',
    preset,
    blade: 'big',
    rig,
    strokeSide: 1,
    phiA: rig === 'skull' ? 66 : 54,
    phiR: rig === 'skull' ? 44 : 36,
    c: 8,
    seatOffset: 5,
    cox: null,
    capacityStatus: PRESETS[preset]?.seatCount === null ? 'legacy-assumed' : 'preset',
    seats: Array.from({length: seatCount}, (_, index) => validSeat(rig, {
      position: index + 1,
      seatCount,
    })),
    legacyRigTemplate: null,
    ...overrides,
  };
}

function validConfig(overrides = {}) {
  const {boat: boatOverride, crew: crewOverride, ...rest} = overrides;
  const baseBoat = boatOverride ?? validBoat();
  const defaultCrew = baseBoat.seats.slice(-Math.min(2, baseBoat.seats.length)).map(seat => ({
    schemaVersion: SCHEMA_VERSION,
    kind: 'crewAssignment',
    seatId: seat.id,
    trimId: seat.trimId,
    rowerRef: {id: `rower-${seat.position}`, revision: 1},
    rower: validRower({
      name: seat.role === 'stroke'
        ? 'Schlagmann'
        : seat.role === 'bow'
          ? 'Bugmann'
          : `Ruderer ${seat.position}`,
    }),
  }));
  const crew = crewOverride ?? defaultCrew;
  const assignments = new Map(crew.map(item => [item.seatId, item]));
  const boat = {
    ...baseBoat,
    seats: baseBoat.seats.map(seat => {
      const assignment = assignments.get(seat.id);
      return assignment ? {...seat, rowerRef: assignment.rowerRef} : seat;
    }),
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'currentConfig',
    boatRef: null,
    boat,
    crew,
    editSeatId: boat.seats.at(-1).id,
    referenceSeatId: boat.seats.at(-1).id,
    mode: 'werkstatt',
    heightRef: 'sitz',
    kg: 0,
    t: 0,
    recovery: false,
    ...rest,
  };
}

function legacyRower(overrides = {}) {
  const {externalRef, ...current} = validRower(overrides);
  return {...current, schemaVersion: 2};
}

function legacySeat(rig = 'skull', overrides = {}) {
  const {
    id, trimId, externalRef, position, role, label, stemmX, rowerRef, ...current
  } = validSeat(rig, overrides);
  return {...current, schemaVersion: 2};
}

function legacyBoat(overrides = {}) {
  const rig = overrides.rig ?? 'skull';
  const preset = overrides.preset ?? (rig === 'skull' ? '2x' : '4-');
  const current = validBoat({rig, preset});
  return {
    schemaVersion: 2,
    kind: 'boat',
    name: overrides.name ?? current.name,
    preset,
    blade: overrides.blade ?? current.blade,
    rig,
    strokeSide: overrides.strokeSide ?? current.strokeSide,
    phiA: overrides.phiA ?? current.phiA,
    phiR: overrides.phiR ?? current.phiR,
    c: overrides.c ?? current.c,
    seatOffset: overrides.seatOffset ?? current.seatOffset,
    s1: overrides.s1 ?? legacySeat(rig),
    s2: overrides.s2 ?? legacySeat(rig),
  };
}

function legacyConfig(overrides = {}) {
  const boat = overrides.boat ?? legacyBoat();
  return {
    schemaVersion: 2,
    kind: 'currentConfig',
    boat,
    crew: overrides.crew ?? {
      s1: legacyRower({name: 'Schlagmann'}),
      s2: PRESETS[boat.preset]?.single ? null : legacyRower({name: 'Ruderer 2'}),
    },
    editSeat: overrides.editSeat ?? 's1',
    mode: overrides.mode ?? 'werkstatt',
    heightRef: overrides.heightRef ?? 'sitz',
    kg: overrides.kg ?? 0,
    t: overrides.t ?? 0,
    recovery: overrides.recovery ?? false,
  };
}

function previousRower(overrides = {}) {
  return {...validRower(overrides), schemaVersion: 3};
}

function previousSeat(rig, seatCount, overrides = {}) {
  const current = validSeat(rig, {...overrides, seatCount});
  const {role, ...withoutRole} = current;
  return {...withoutRole, schemaVersion: 3};
}

function previousBoat(overrides = {}) {
  const rig = overrides.rig ?? 'skull';
  const preset = overrides.preset ?? (rig === 'skull' ? '4x' : '4-');
  const seatCount = PRESETS[preset].seatCount;
  const current = validBoat({rig, preset});
  const {cox, ...withoutCox} = current;
  return {
    ...withoutCox,
    schemaVersion: 3,
    seats: Array.from({length: seatCount}, (_, index) => previousSeat(rig, seatCount, {
      position: index + 1,
      id: `v3-physical-seat-${index + 1}`,
      trimId: `v3-physical-trim-${index + 1}`,
      label: index === 0 ? 'Schlagplatz' : `Altplatz ${index + 1}`,
    })),
    ...overrides,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('stroke cycle preserves pose across start, resume and tempo changes', () => {
  assert.deepEqual(STROKE_CYCLE, {durationMs: 2800, driveShare: 0.45});
  const phases = [
    {t: 0, recovery: false},
    {t: 25, recovery: false},
    {t: 50, recovery: false},
    {t: 75, recovery: false},
    {t: 100, recovery: false},
    {t: 50, recovery: true},
  ];
  for (const phase of phases) {
    const progress = cycleProgressFromStrokePose(phase);
    const roundTrip = strokePoseAtCycleProgress(progress);
    assert.ok(Math.abs(roundTrip.t - phase.t) < 1e-7, `phase t=${phase.t} round-trips`);
    assert.equal(roundTrip.recovery, phase.recovery, `phase t=${phase.t} keeps branch`);
  }

  const frozen = cycleProgressFromStrokePose({t: 63, recovery: true});
  assert.equal(advanceStrokeCycle(frozen, 0, 0.5), frozen);
  assert.equal(advanceStrokeCycle(frozen, 0, 2), frozen);
  const slow = advanceStrokeCycle(frozen, 16, 0.5);
  const fast = advanceStrokeCycle(frozen, 16, 2);
  assert.ok(fast > slow, 'tempo affects only future elapsed motion');
  assert.deepEqual(strokePoseAtCycleProgress(1), {t: 0, recovery: false});
  assert.throws(() => cycleProgressFromStrokePose({t: 50, recovery: 'yes'}), TypeError);
  assert.throws(() => advanceStrokeCycle(0, -1, 1), RangeError);
  assert.throws(() => advanceStrokeCycle(0, 16, 0), RangeError);
});

function naturalCatch(rig, stemmX, {targetPhiA, rower = {}, seat = {}} = {}) {
  const base = rig === 'skull'
    ? {DA: 159, IH: 88, L: 288, a: 15, phiA: targetPhiA ?? 66, phiR: 44}
    : {DA: 84, IH: 114, L: 375, a: 17, phiA: targetPhiA ?? 54, phiR: 36};
  Object.assign(base, seat);
  const geometry = derivedGeometry({rig, ...base, d: 2, t: 0, c: 8, kg: 0});
  return solveNaturalCatchAngle({
    rig,
    DA: geometry.DA,
    inboardFromPin: geometry.inb,
    outboardFromPin: geometry.outb,
    a: base.a,
    c: 8,
    kg: 0,
    rower: {
      legLen: 90,
      torsoLen: 95,
      wingspan: 188,
      SB: 40,
      stemmX,
      rollL: 75,
      rueh: 5,
      ...rower,
    },
  });
}

test('preset and range tables expose the retained domain defaults and are frozen', () => {
  assert.equal(PRESETS['1x'].rig, 'skull');
  assert.equal(PRESETS['1x'].single, true);
  assert.equal(PRESETS['4-'].IH, 114);
  assert.deepEqual(RANGES.skull.IH, [82, 94]);
  assert.ok(Object.isFrozen(PRESETS));
  assert.ok(Object.isFrozen(PRESETS['1x']));
  assert.ok(Object.isFrozen(RANGES.rower));
  assert.deepEqual(CATCH_MODEL.defaultFa, {skull: 32.5, riemen: 50});
  assert.equal(defaultFaForRig('skull'), 32.5);
  assert.equal(defaultFaForRig('riemen'), 50);
  assert.equal(Object.values(PRESETS).some(preset => Object.hasOwn(preset, 'fa')), false,
    'World-Rowing source presets must not masquerade a model Fa default as survey data');

  const requiredClasses = {
    '1x': {rig: 'skull', seatCount: 1},
    '2x': {rig: 'skull', seatCount: 2},
    '2-': {rig: 'riemen', seatCount: 2},
    '3x': {rig: 'skull', seatCount: 3, clubClass: true},
    '4x': {rig: 'skull', seatCount: 4},
    '4-': {rig: 'riemen', seatCount: 4},
    '4+': {rig: 'riemen', seatCount: 4, coxed: true},
    '6x': {rig: 'skull', seatCount: 6, clubClass: true},
    '8+': {rig: 'riemen', seatCount: 8, coxed: true},
  };
  for (const [key, expected] of Object.entries(requiredClasses)) {
    assert.equal(PRESETS[key].rig, expected.rig, `${key} rig`);
    assert.equal(PRESETS[key].seatCount, expected.seatCount, `${key} real rower places`);
    assert.equal(Boolean(PRESETS[key].clubClass), Boolean(expected.clubClass), `${key} club marker`);
    assert.equal(Boolean(PRESETS[key].coxed), Boolean(expected.coxed), `${key} cox marker`);
  }
  assert.equal(PRESETS['3x'].clubClass, true, '3x is explicitly a club class, not a World Rowing standard class');
  assert.equal(PRESETS['6x'].clubClass, true, '6x is explicitly a club class, not a World Rowing standard class');
});

test('seat numbering is bow-first and assigns the stroke role only to the highest real rower place', () => {
  assert.equal(seatRoleForPosition(1, 1), 'single');
  assert.equal(seatLabelForPosition(1, 1), 'Platz 1 · Einer');
  assert.deepEqual(
    Array.from({length: 4}, (_, index) => seatRoleForPosition(index + 1, 4)),
    ['bow', 'crew', 'crew', 'stroke'],
  );
  assert.deepEqual(
    Array.from({length: 4}, (_, index) => seatLabelForPosition(index + 1, 4)),
    ['Platz 1 · Bug', 'Platz 2', 'Platz 3', 'Platz 4 · Schlag'],
  );
  assert.equal(seatRoleForPosition(8, 8), 'stroke');
  assert.equal(seatLabelForPosition(8, 8), 'Platz 8 · Schlag');
  assert.throws(() => seatRoleForPosition(0, 4), RangeError);
  assert.throws(() => seatRoleForPosition(5, 4), RangeError);
});

test('capacity changes preserve stable bow and stroke identities instead of remapping by array index', () => {
  const single={id:'seat-single',trimId:'trim-single',position:1,role:'single'};
  const singleToEight=planSeatLayoutByRole([single],8);
  assert.equal(singleToEight.sources.length,8);
  assert.equal(singleToEight.sources[7],single,'the existing single follows the stroke/reference role');
  assert.equal(singleToEight.sources.slice(0,7).every(value=>value===null),true);
  assert.deepEqual(singleToEight.removed,[]);

  const eight=Array.from({length:8},(_,index)=>({
    id:`seat-${index+1}`,trimId:`trim-${index+1}`,position:index+1,
    role:seatRoleForPosition(index+1,8),
  }));
  const eightToFour=planSeatLayoutByRole(eight,4);
  assert.deepEqual(eightToFour.sources.map(seat=>seat?.id??null),['seat-1','seat-2','seat-3','seat-8']);
  assert.deepEqual(eightToFour.removed.map(seat=>seat.id),['seat-4','seat-5','seat-6','seat-7']);
  assert.equal(eightToFour.sources[0].trimId,'trim-1');
  assert.equal(eightToFour.sources[3].trimId,'trim-8');
  assert.equal(planSeatLayoutByRole(eight,1).sources[0],eight[7]);
  assert.throws(()=>planSeatLayoutByRole(eight,0),RangeError);
});

test('Testiel demo config is deterministic, complete, and validator-clean without hidden crew data', () => {
  const first = buildTestielDemoConfig();
  const second = buildTestielDemoConfig();
  assert.deepEqual(first, second);
  assert.equal(validateCurrentConfig(first).ok, true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.boat), true);
  assert.equal(Object.isFrozen(first.crew[0]), true);
  assert.equal(first.boat.seats.length, 1);
  assert.equal(first.boat.seats[0].role, 'single');
  assert.equal(first.boat.seats[0].label, 'Platz 1 · Einer');
  assert.equal(first.boat.cox, null);
  assert.equal(first.crew.length, 1);
  assert.equal(first.crew[0].rower.name, 'Testiel');
  assert.equal(first.crew[0].rower.externalRef, null);
  assert.equal(first.crew[0].rower.legLen + first.crew[0].rower.torsoLen, 185);
  assert.equal(Object.hasOwn(first.crew[0].rower, 'height'), false);
  assert.deepEqual(first.boat.seats[0].rowerRef, first.crew[0].rowerRef);
  assert.equal(first.boat.seats[0].stemmX, 32.5);
  assert.deepEqual({
    editSeatId: first.editSeatId,
    referenceSeatId: first.referenceSeatId,
    mode: first.mode,
    heightRef: first.heightRef,
    kg: first.kg,
    t: first.t,
    recovery: first.recovery,
  }, {
    editSeatId: first.boat.seats[0].id,
    referenceSeatId: first.boat.seats[0].id,
    mode: 'werkstatt',
    heightRef: 'sitz',
    kg: 0,
    t: 0,
    recovery: false,
  });
  assert.deepEqual({
    name: first.boat.name,
    preset: first.boat.preset,
    blade: first.boat.blade,
    rig: first.boat.rig,
    strokeSide: first.boat.strokeSide,
    phiA: first.boat.phiA,
    phiR: first.boat.phiR,
    c: first.boat.c,
    seatOffset: first.boat.seatOffset,
  }, {
    name: 'Testiel · Demo-Boot', preset: '1x', blade: 'big', rig: 'skull',
    strokeSide: 1, phiA: 66, phiR: 44, c: 8, seatOffset: 5,
  });
  assert.equal(first.boat.legacyRigTemplate, null);
});

test('Testiel comparison demo is a deterministic 4x two-profile state without persistence payloads', () => {
  const first = buildTestielComparisonDemoConfig();
  const second = buildTestielComparisonDemoConfig();
  assert.deepEqual(first, second);
  assert.equal(validateCurrentConfig(first).ok, true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.crew[0]), true);
  assert.equal(Object.isFrozen(first.crew[1]), true);
  assert.deepEqual({
    name: first.boat.name,
    preset: first.boat.preset,
    blade: first.boat.blade,
    rig: first.boat.rig,
    phiA: first.boat.phiA,
    phiR: first.boat.phiR,
  }, {
    name: 'Testiel · Vergleichs-Demo-Boot',
    preset: '4x',
    blade: 'big',
    rig: 'skull',
    phiA: 66,
    phiR: 44,
  });
  assert.deepEqual(first.crew.map(item => item.rower.name), ['Testiel 2', 'Testiel']);
  assert.equal(first.boat.seats.length, 4);
  assert.equal(first.crew.length, 2);
  assert.deepEqual(first.boat.seats.map(seat => seat.position), [1, 2, 3, 4]);
  assert.deepEqual(first.boat.seats.map(seat => seat.rowerRef), [null, null, null, null],
    'synthetic unsaved profiles must not masquerade as repository records');
  assert.deepEqual(first.crew.map(item => item.seatId), first.boat.seats.slice(2).map(seat => seat.id));
  assert.deepEqual(first.boat.seats.map(seat => seat.role), ['bow', 'crew', 'crew', 'stroke']);
  assert.equal(first.boat.seats[0].label, 'Platz 1 · Bug');
  assert.equal(first.boat.seats[2].label, 'Platz 3');
  assert.equal(first.boat.seats[3].label, 'Platz 4 · Schlag');
  assert.equal(first.referenceSeatId, first.boat.seats[3].id);
  assert.equal(first.crew.find(item => item.rower.name === 'Testiel').seatId, first.referenceSeatId);
  assert.equal(first.boat.seats[3].IH, PRESETS['4x'].IH);
  assert.equal(first.boat.seats[3].anlage, 4);
  assert.equal(first.boat.seats[2].IH, PRESETS['4x'].IH - 3);
  assert.equal(first.boat.seats[2].anlage, 3.5);
  assert.deepEqual({
    editSeatId: first.editSeatId,mode: first.mode,heightRef: first.heightRef,
    kg: first.kg,t: first.t,recovery: first.recovery,
  }, {editSeatId:first.boat.seats[3].id,mode:'werkstatt',heightRef:'sitz',kg:0,t:0,recovery:false});
  for(const forbidden of ['db','boats','profiles','records','playing']){
    assert.equal(Object.hasOwn(first,forbidden),false);
  }
});

test('profile Fa defaults and actual per-seat Fa remain independent through DTO rebuilds', () => {
  const stored = validConfig();
  stored.crew[0].rower = validRower({name: 'Bestand 1', stemmX: 48});
  stored.crew[1].rower = validRower({name: 'Bestand 2', stemmX: 38});
  stored.boat.seats[0].stemmX = 47;
  stored.boat.seats[1].stemmX = 41;
  const rebuilt = buildCurrentConfigDTO(stored);
  assert.equal(rebuilt.crew[0].rower.stemmX, 48);
  assert.equal(rebuilt.crew[1].rower.stemmX, 38);
  assert.equal(rebuilt.boat.seats[0].stemmX, 47);
  assert.equal(rebuilt.boat.seats[1].stemmX, 41);
  assert.equal(validateCurrentConfig(rebuilt).ok, true);
});

test('finite and inclusive range helpers reject NaN, Infinity, and inverted ranges', () => {
  assert.equal(isFiniteNumber(1.25), true);
  assert.equal(isFiniteNumber(NaN), false);
  assert.equal(isFiniteNumber(Infinity), false);
  assert.equal(isFiniteNumber('1'), false);
  assert.equal(isInRange(1, 1, 2), true);
  assert.equal(isInRange(2, 1, 2), true);
  assert.equal(isInRange(3, 1, 2), false);
  assert.equal(isInRange(1, 2, 1), false);
  assert.equal(requireFinite(-2), -2);
  assert.equal(requireRange(2, 1, 2), 2);
  assert.throws(() => requireFinite(NaN), /finite/);
  assert.throws(() => requireRange(Infinity, 0, 1), /finite/);
  assert.throws(() => requireRange(1, 2, 0), /inverted/);
});

test('clamp is inclusive and refuses invalid numeric inputs', () => {
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(4, 0, 10), 4);
  assert.equal(clamp(11, 0, 10), 10);
  assert.throws(() => clamp(NaN, 0, 1), /finite/);
  assert.throws(() => clamp(1, 2, 1), /must not exceed/);
});

test('body segments and natural catch use one finite centimetre model', () => {
  const segments = deriveBodySegments({legLen: 90, torsoLen: 95, wingspan: 188, SB: 40});
  assert.equal(segments.OS + segments.US, 90);
  assert.equal(segments.height, 185);
  assert.ok(segments.OA > 0 && segments.UA > 0 && Object.values(segments).every(Number.isFinite));
  assert.ok(Object.isFrozen(segments));
  assert.throws(() => deriveBodySegments({legLen: NaN, torsoLen: 95, wingspan: 188, SB: 40}), /finite/);
});

test('Fa drives the modelled actual catch for skull and sweep without reading the rig target', () => {
  const skullShort = naturalCatch('skull', 26);
  const skullDefault = naturalCatch('skull', defaultFaForRig('skull'));
  const sweepShort = naturalCatch('riemen', 26);
  const sweepDefault = naturalCatch('riemen', defaultFaForRig('riemen'));
  assert.ok(skullShort.angleDeg < skullDefault.angleDeg);
  assert.ok(sweepShort.angleDeg < sweepDefault.angleDeg);
  assert.ok(skullDefault.angleDeg > 64 && skullDefault.angleDeg < 67);
  assert.ok(sweepDefault.angleDeg > 51 && sweepDefault.angleDeg < 55);
  assert.deepEqual(naturalCatch('skull', 32.5, {targetPhiA: 40}), naturalCatch('skull', 32.5, {targetPhiA: 85}));
  for (const result of [skullShort, skullDefault, sweepShort, sweepDefault]) {
    assert.equal(Number.isFinite(result.angleDeg), true);
    assert.equal(Number.isFinite(result.residualCm), true);
    assert.ok(result.angleDeg >= CATCH_MODEL.search.minDeg && result.angleDeg <= CATCH_MODEL.search.maxDeg);
    assert.ok(result.evaluations <= 180, 'solver work must stay deterministically bounded');
    assert.equal(result.modelStatus, 'needsCalibration');
    assert.equal(Object.hasOwn(result, 'ok'), false);
    assert.equal(Object.hasOwn(result, 'targetPhiA'), false);
  }
});

test('natural catch is deterministic at Fa and anthropometry boundaries and preserves the seat envelope', () => {
  for (const rig of ['skull', 'riemen']) {
    for (const stemmX of [RANGES.rower.stemmX[0], RANGES.rower.stemmX[1]]) {
      for (const rower of [
        {legLen: 70, torsoLen: 75, wingspan: 150, SB: 32},
        {legLen: 105, torsoLen: 110, wingspan: 215, SB: 48},
      ]) {
        const first = naturalCatch(rig, stemmX, {rower});
        const second = naturalCatch(rig, stemmX, {rower});
        assert.deepEqual(first, second);
        assert.ok(Number.isFinite(first.hipX));
      }
    }
  }
  const unresolved = naturalCatch('skull', RANGES.rower.stemmX[1], {
    rower: {legLen: 105, torsoLen: 110, wingspan: 215, SB: 48},
  });
  assert.equal(unresolved.bracketed, false, 'a boundary minimum is not an exact actual catch');
  assert.ok(unresolved.angleDeg > 87.9 && Math.abs(unresolved.residualCm) > 1);
  assert.equal(naturalCatch('skull', 56).trackLimited, true);
  assert.throws(() => naturalCatch('skull', NaN), /finite/);
});

test('highest reachable angle search handles a nonmonotonic reachability island', () => {
  const result=findHighestReachableAngle({
    minDeg:30,
    maxDeg:88,
    stepDeg:0.5,
    isReachable:angle=>angle>=49.5&&angle<=51.25,
  });
  assert.equal(result.reachable,true);
  assert.equal(result.limited,true);
  assert.ok(Math.abs(result.angleDeg-51.25)<0.001);
  assert.equal(30>=49.5&&30<=51.25,false,'the lower bound is deliberately unreachable');
  assert.equal(Number.isFinite(result.angleDeg),true);
  assert.equal(Object.hasOwn(result,'status'),false,'reach search must not invent a calibrated status');
  assert.equal(Object.hasOwn(result,'ok'),false,'reach search must not invent a trainer approval');

  assert.deepEqual(findHighestReachableAngle({
    minDeg:0,maxDeg:90,isReachable:angle=>angle===90,
  }),{angleDeg:90,reachable:true,limited:false});
  assert.deepEqual(findHighestReachableAngle({
    minDeg:0,maxDeg:90,isReachable:angle=>angle===0,
  }),{angleDeg:0,reachable:true,limited:true});
  assert.deepEqual(findHighestReachableAngle({
    minDeg:30,maxDeg:88,isReachable:()=>false,
  }),{angleDeg:30,reachable:false,limited:true});

  const gripTargets=[
    angle=>angle>=20&&angle<=70,
    angle=>angle>=35&&angle<=62.5,
  ];
  const bothGrips=findHighestReachableAngle({
    minDeg:0,
    maxDeg:90,
    isReachable:angle=>gripTargets.every(target=>target(angle)),
  });
  const firstGripOnly=findHighestReachableAngle({
    minDeg:0,
    maxDeg:90,
    isReachable:gripTargets[0],
  });
  assert.ok(Math.abs(bothGrips.angleDeg-62.5)<0.001);
  assert.ok(Math.abs(firstGripOnly.angleDeg-70)<0.001);
  assert.ok(gripTargets.every(target=>target(bothGrips.angleDeg)));

  const deterministicOptions={
    minDeg:0,
    maxDeg:90,
    stepDeg:0.5,
    refineIterations:14,
    isReachable:angle=>angle>=41.25&&angle<=67.125,
  };
  assert.deepEqual(
    findHighestReachableAngle(deterministicOptions),
    findHighestReachableAngle(deterministicOptions),
  );

  const evaluatedAngles=[];
  const finiteResult=findHighestReachableAngle({
    minDeg:0,
    maxDeg:90,
    isReachable:angle=>{ evaluatedAngles.push(angle); return angle<=45; },
  });
  assert.equal(Number.isFinite(finiteResult.angleDeg),true);
  assert.ok(evaluatedAngles.length>0&&evaluatedAngles.every(Number.isFinite));
  for(const options of [
    {minDeg:NaN,maxDeg:90,stepDeg:0.5},
    {minDeg:0,maxDeg:Infinity,stepDeg:0.5},
    {minDeg:0,maxDeg:90,stepDeg:NaN},
    {minDeg:0,maxDeg:90,stepDeg:Infinity},
  ]) assert.throws(()=>findHighestReachableAngle({...options,isReachable:()=>true}),/finite/u);
  assert.throws(()=>findHighestReachableAngle({
    minDeg:0,maxDeg:90,refineIterations:Infinity,isReachable:()=>true,
  }),/integer/u);
  assert.throws(()=>findHighestReachableAngle({minDeg:30,maxDeg:88,isReachable:()=> 'yes'}),/boolean/u);
});

test('derived skull geometry preserves overlap, height, and stroke formulas', () => {
  const result = derivedGeometry({
    rig: 'skull', DA: 159, IH: 88, L: 288, d: 2, a: 15,
    phiA: 66, phiR: 44, t: 0, c: 8, kg: 0,
  });
  assert.equal(result.inb, 90);
  assert.equal(result.outb, 198);
  assert.equal(result.overlap, 21);
  assert.equal(result.outsideLever, 200);
  assert.equal(result.strokeWidth, 110);
  assert.equal(result.shareBeforeOrthogonal, 60);
  assert.equal(result.pinHeightAboveWater, 23);
  assert.equal(result.targetIH, 87.5);
  assert.equal(result.theta, 66);
  assert.equal(result.DAr, 79.5);
});

test('derived sweep geometry uses pin moment arms and the correct immersion sign', () => {
  const result = derivedGeometry({
    rig: 'riemen', DA: 84, IH: 114, L: 375, d: 2, a: 17,
    phiA: 54, phiR: 36, t: 50, c: 8, kg: 10,
  });
  assert.equal(result.inboardFromPin, 116);
  assert.equal(result.outboardFromPin, 259);
  assert.equal(result.overlap, 32);
  assert.equal(result.strokeWidth, 90);
  assert.equal(result.theta, 9);
  assert.equal(result.pinHeightAboveWater, 24);
  assert.equal(result.targetIH, 114);
  assert.equal(result.DAr, 84);
});

test('derived geometry rejects unknown rigs, nonfinite values, and nonphysical arms', () => {
  const base = {rig: 'skull', DA: 159, IH: 88, L: 288, d: 2, a: 15, phiA: 66, phiR: 44};
  assert.throws(() => derivedGeometry({...base, rig: 'kajak'}), /Unknown rig/);
  assert.throws(() => derivedGeometry({...base, L: NaN}), /finite/);
  assert.throws(() => derivedGeometry({...base, L: 90}), /outb|positive/);
  assert.throws(() => derivedGeometry({...base, t: 101}), /\[0, 100\]/);
});

test('force ratio consistently uses moment arms about the pin', () => {
  assert.equal(forceRatio({L: 288, IH: 88, d: 1}), 199 / 89);
  assert.equal(forceRatio({L: 288, IH: 88, d: 3}), 197 / 91);
  assert.notEqual(forceRatio({L: 288, IH: 88, d: 1}), forceRatio({L: 288, IH: 88, d: 3}));
});

test('inboard solver includes d and reproduces the target physical ratio', () => {
  const targetRatio = forceRatio({L: 288, IH: 88, d: 1});
  const solved = solveInboardForRatio({L: 288, d: 3, targetRatio, range: [82, 94], step: 0});
  assert.equal(solved.rawIH, 86);
  assert.equal(solved.IH, 86);
  assert.equal(solved.achievedRatio, targetRatio);
  assert.equal(solved.clamped, false);
  assert.equal(solved.status, 'ok');
});

test('inboard solver reports explicit rounding and range clamping', () => {
  const rounded = solveInboardForRatio({L: 288, d: 2, targetRatio: 2.21, range: [82, 94], step: 0.5});
  assert.equal(rounded.IH * 2, Math.round(rounded.IH * 2));
  assert.equal(rounded.rounded, true);
  const clampedResult = solveInboardForRatio({L: 288, d: 2, targetRatio: 0.1, range: [82, 94], step: 0.5});
  assert.equal(clampedResult.IH, 94);
  assert.equal(clampedResult.clamped, true);
  assert.equal(clampedResult.status, 'clamped');
});

test('3D arm reachability accepts both exact triangle boundaries', () => {
  const shoulder = {x: 0, y: 0, z: 0};
  const maxBoundary = assessArmReachability3D({shoulder, hand: {x: 7, y: 0, z: 0}, upperArm: 3, forearm: 4});
  assert.equal(maxBoundary.reachable, true);
  assert.equal(maxBoundary.status, 'ok');
  const minBoundary = assessArmReachability3D({shoulder, hand: {x: 2, y: 0, z: 0}, upperArm: 5, forearm: 3});
  assert.equal(minBoundary.reachable, true);
});

test('3D arm reachability distinguishes overreach and underreach', () => {
  const shoulder = {x: 0, y: 0, z: 0};
  const over = assessArmReachability3D({shoulder, hand: {x: 8, y: 0, z: 0}, upperArm: 3, forearm: 4});
  assert.equal(over.reachable, false);
  assert.equal(over.status, 'overreach');
  assert.equal(over.overreach, 1);
  const under = assessArmReachability3D({shoulder, hand: {x: 1, y: 0, z: 0}, upperArm: 5, forearm: 1});
  assert.equal(under.reachable, false);
  assert.equal(under.status, 'underreach');
  assert.equal(under.underreach, 3);
});

test('solved 3D arm pose must preserve each segment instead of stretching it', () => {
  const valid = validateArmPose3D({
    shoulder: {x: 0, y: 0, z: 0}, elbow: {x: 3, y: 0, z: 0}, hand: {x: 7, y: 0, z: 0},
    upperArm: 3, forearm: 4,
  });
  assert.equal(valid.ok, true);
  const stretched = validateArmPose3D({
    shoulder: {x: 0, y: 0, z: 0}, elbow: {x: 4, y: 0, z: 0}, hand: {x: 7, y: 0, z: 0},
    upperArm: 3, forearm: 4,
  });
  assert.equal(stretched.ok, false);
  assert.equal(stretched.status, 'segmentLengthViolation');
  assert.throws(() => assessArmReachability3D({
    shoulder: {x: 0, y: 0, z: 0}, hand: {x: Infinity, y: 0, z: 0}, upperArm: 3, forearm: 4,
  }), /finite/);
});

test('orthogonal trim is green only when knee and 70-80% rollway both pass', () => {
  const good = assessOrthogonalTrim({kneeDeg: 165, rollwayPct: 75});
  assert.equal(good.ok, true);
  assert.equal(good.status, 'ok');
  assert.equal(good.knee.ok, true);
  assert.equal(good.rollway.ok, true);

  const oldDefault = assessOrthogonalTrim({kneeDeg: 164.4, rollwayPct: 98.7});
  assert.equal(oldDefault.ok, false);
  assert.equal(oldDefault.knee.ok, true);
  assert.equal(oldDefault.rollway.ok, false);
  assert.equal(oldDefault.status, 'outOfRange');

  const wrongKnee = assessOrthogonalTrim({kneeDeg: 150, rollwayPct: 75});
  assert.equal(wrongKnee.ok, false);
  assert.equal(wrongKnee.knee.ok, false);
});

test('orthogonal trim includes its documented boundaries and validates policy/input', () => {
  assert.equal(assessOrthogonalTrim({kneeDeg: 160, rollwayPct: 70}).ok, true);
  assert.equal(assessOrthogonalTrim({kneeDeg: 170, rollwayPct: 80}).ok, true);
  assert.throws(() => assessOrthogonalTrim({kneeDeg: NaN, rollwayPct: 75}), /finite/);
  assert.throws(() => assessOrthogonalTrim(
    {kneeDeg: 165, rollwayPct: 75},
    {...ORTHOGONAL_POLICY, rollwayPct: {target: 90, min: 70, max: 80}},
  ), /policy is invalid/);
});

test('arm angle is the actual signed shoulder-hand angle to horizontal', () => {
  const hand = {x: 10, y: -10 * Math.tan(6 * Math.PI / 180)};
  assert.ok(Math.abs(armAngleToHorizontal({shoulder: {x: 0, y: 0}, hand}) - 6) < 1e-12);
  assert.throws(() => armAngleToHorizontal({shoulder: {x: 1, y: 1}, hand: {x: 1, y: 1}}), /must not coincide/);
});

test('provisional arm-angle policy never reports green before calibration', () => {
  const atTarget = {x: 10, y: -10 * Math.tan(ARM_ANGLE_POLICY.targetDeg * Math.PI / 180)};
  const provisional = assessArmAngle({shoulder: {x: 0, y: 0}, hand: atTarget});
  assert.equal(provisional.inProvisionalBand, true);
  assert.equal(provisional.status, 'needsCalibration');
  assert.equal(provisional.ok, false);
  assert.match(provisional.policy.definition, /shoulder-to-hand/);

  const calibrated = assessArmAngle(
    {shoulder: {x: 0, y: 0}, hand: atTarget},
    {...ARM_ANGLE_POLICY, calibrated: true},
  );
  assert.equal(calibrated.status, 'ok');
  assert.equal(calibrated.ok, true);

  const twentySeven = {x: 10, y: -10 * Math.tan(27 * Math.PI / 180)};
  const out = assessArmAngle(
    {shoulder: {x: 0, y: 0}, hand: twentySeven},
    {...ARM_ANGLE_POLICY, calibrated: true},
  );
  assert.equal(out.status, 'outOfRange');
  assert.equal(out.ok, false);
});

test('strict rower schema accepts boundaries and safe punctuation', () => {
  const min = validRower({name: "Alex & O'Connor", legLen: 70, torsoLen: 75, wingspan: 150, SB: 32, weight: 45, stemmX: 26});
  const max = validRower({name: 'A'.repeat(MAX_NAME_LENGTH), legLen: 105, torsoLen: 110, wingspan: 215, SB: 48, weight: 120, stemmX: 56});
  assert.equal(validateRower(min).ok, true);
  assert.equal(validateRower(max).ok, true);
});

test('Unicode name limits preserve complete code points at the 80-character boundary', () => {
  const boundary = `${'A'.repeat(MAX_NAME_LENGTH - 1)}😀`;
  assert.equal([...boundary].length, MAX_NAME_LENGTH);
  assert.equal(validateRower(validRower({name: boundary})).ok, true);
  assert.equal(truncateCodePoints(`${boundary}B`), boundary);
  assert.equal(truncateCodePoints(boundary).charCodeAt(boundary.length - 1), 0xde00);
});

test('rower validator rejects XSS names, excess names, controls, unknown fields, types, and nonfinite values', () => {
  const attacks = [
    validRower({name: '<img src=x onerror=alert(1)>'}),
    validRower({name: '</option><script>alert(1)</script>'}),
    validRower({name: `Alex\nAdmin`}),
    validRower({name: 'A'.repeat(MAX_NAME_LENGTH + 1)}),
    validRower({name: ' Alex'}),
    validRower({name: `Alex\ud83d`}),
    validRower({name: `Alex\udc00`}),
    validRower({name: `Alex\ufdd0`}),
    validRower({name: `Alex\u{1fffe}`}),
  ];
  for (const attack of attacks) assert.equal(validateRower(attack).ok, false);
  assert.equal(validateRower({...validRower(), onerror: 'alert(1)'}).ok, false);
  assert.equal(validateRower(validRower({weight: '80'})).ok, false);
  assert.equal(validateRower(validRower({weight: NaN})).ok, false);
  assert.equal(validateRower(validRower({weight: Infinity})).ok, false);
  assert.equal(validateRower(validRower({legLen: 69.99})).ok, false);
});

test('strict seat schema validates rig-specific boundaries and rejects malformed rigs', () => {
  assert.equal(validateSeat(validSeat('skull', {DA: 150, IH: 82, L: 265, d: 1, rueh: -5})).ok, true);
  assert.equal(validateSeat(validSeat('riemen', {DA: 92, IH: 122, L: 392, d: 3, rueh: 12})).ok, true);
  assert.equal(validateSeat(validSeat('skull', {rig: 'kajak'})).ok, false);
  assert.equal(validateSeat(validSeat('skull', {DA: 149.5})).ok, false);
  assert.equal(validateSeat({...validSeat(), unexpected: true}).ok, false);
  assert.equal(validateSeat(validSeat('skull', {IH: Infinity})).ok, false);
  assert.equal(validateSeat(validSeat('skull', {id: '../seat', label: '<b>Bug</b>'})).ok, false);
  assert.equal(validateSeat(validSeat('skull', {role: 'cox'})).ok, false);
});

test('boat validator enforces exact version, class/rig/seat-role coherence, and cox metadata isolation', () => {
  assert.equal(validateBoat(validBoat()).ok, true);
  assert.equal(validateBoat(validBoat({rig: 'riemen', preset: '4-'})).ok, true);
  assert.equal(validateBoat(validBoat({rig: 'riemen', preset: '2x'})).ok, false);
  const mixedRig = validBoat();
  mixedRig.seats[1] = validSeat('riemen', {position: 2});
  assert.equal(validateBoat(mixedRig).ok, false);
  const duplicateSeat = validBoat();
  duplicateSeat.seats[1] = {...duplicateSeat.seats[1], id: duplicateSeat.seats[0].id};
  assert.equal(validateBoat(duplicateSeat).ok, false);
  const wrongSeatRole = validBoat({preset: '4x'});
  wrongSeatRole.seats[0] = {...wrongSeatRole.seats[0], role: 'stroke'};
  assert.equal(validateBoat(wrongSeatRole).ok, false);
  assert.equal(validateBoat(validBoat({seats: [validSeat('skull')]})).ok, false);
  const redundantLegacyRig = validBoat({preset: '1x'});
  redundantLegacyRig.legacyRigTemplate = legacySeat('skull');
  assert.equal(validateBoat(redundantLegacyRig).ok, false);
  assert.equal(validateBoat(validBoat({schemaVersion: 1})).ok, false);
  assert.equal(validateBoat({...validBoat(), db: []}).ok, false);
  assert.equal(validateBoat(validBoat({name: '<svg onload=alert(1)>'})).ok, false);

  for (const preset of ['4+', '8+']) {
    const coxed = validBoat({preset, rig: 'riemen', cox: {name: 'Steuerperson'}});
    assert.equal(validateBoat(coxed).ok, true, `${preset} accepts separate cox metadata`);
    assert.equal(coxed.seats.length, PRESETS[preset].seatCount, `${preset} cox is not a rower place`);
    assert.equal(coxed.seats.some(seat => seat.role === 'cox'), false);
    assert.equal(JSON.stringify(coxed.seats).includes('Steuerperson'), false);
  }
  assert.equal(validateBoat(validBoat({preset: '4x', cox: {name: 'Nicht zulässig'}})).ok, false,
    'uncoxed classes cannot smuggle a cox into boat metadata');
  assert.equal(validateBoat(validBoat({preset: '4+', rig: 'riemen', cox: {name: '<script>'}})).ok, false);
});

test('current config validator forbids embedded databases and incoherent single-seat editing', () => {
  assert.equal(validateCurrentConfig(validConfig()).ok, true);
  assert.equal(validateCurrentConfig({...validConfig(), db: [], boats: []}).ok, false);
  const singleBoat = validBoat({preset: '1x'});
  assert.equal(validateCurrentConfig(validConfig({boat: singleBoat, editSeatId: 'missing-seat'})).ok, false);
  assert.equal(validateCurrentConfig(validConfig({kg: 20, t: 100, recovery: true})).ok, true);
  assert.equal(validateCurrentConfig(validConfig({kg: 20.1})).ok, false);
  assert.equal(validateCurrentConfig(validConfig({recovery: 1})).ok, false);
});

test('safe DTO builders copy only explicit fields and exclude db/boats', () => {
  const source = validConfig();
  source.db = [validRower({name: 'Nicht exportieren'})];
  source.boats = [validBoat({name: 'Nicht exportieren'})];
  source.secret = 'also omitted';
  source.boat.db = ['omit'];
  source.crew[0].rower.unexpected = 'omit';
  const dto = buildCurrentConfigDTO(source);
  assert.equal(validateCurrentConfig(dto).ok, true);
  assert.equal(Object.hasOwn(dto, 'db'), false);
  assert.equal(Object.hasOwn(dto, 'boats'), false);
  assert.equal(Object.hasOwn(dto, 'secret'), false);
  assert.equal(Object.hasOwn(dto.boat, 'db'), false);
  assert.equal(Object.hasOwn(dto.crew[0].rower, 'unexpected'), false);
  assert.doesNotMatch(JSON.stringify(dto), /Nicht exportieren|secret/);
  assert.ok(Object.isFrozen(dto));
  assert.ok(Object.isFrozen(dto.crew[0]));
});

test('single-seat current configs omit the hidden second-person profile', () => {
  const source = legacyConfig({
    boat: legacyBoat({preset: '1x'}),
    crew: {s1: legacyRower({name: 'Schlagmann'}), s2: legacyRower({name: 'Verborgene Person'})},
    editSeat: 's1',
  });
  const dto = buildCurrentConfigDTO(source);
  assert.equal(dto.crew.length, 1);
  assert.equal(dto.crew[0].rower.name, 'Schlagmann');
  assert.doesNotMatch(JSON.stringify(dto), /Verborgene Person/);
  assert.equal(validateCurrentConfig(dto).ok, true);
  assert.equal(hasHiddenSingleSeatProfile(source), true);
  assert.equal(hasHiddenSingleSeatProfile(dto), false);
  assert.equal(hasHiddenSingleSeatProfile(validConfig()), false);
  const minimized=minimizeHiddenSingleSeatProfile(source);
  assert.equal(minimized.changed,true);
  assert.equal(minimized.config.crew.length,1);
  assert.doesNotMatch(JSON.stringify(minimized.config),/Verborgene Person/u);
  const repeated=minimizeHiddenSingleSeatProfile(minimized.config);
  assert.equal(repeated.changed,false);
  assert.equal(repeated.config,minimized.config);
});

test('external references are nullable, scoped, exact, and inert domain data', () => {
  const externalRef = {system: 'efaLive', scope: 'verein-17', id: 'person-42'};
  assert.equal(validateRower(validRower({externalRef})).ok, true);
  assert.equal(validateBoat(validBoat({externalRef})).ok, true);
  assert.equal(validateSeat(validSeat('skull', {externalRef})).ok, true);
  assert.equal(validateRower(validRower({externalRef: {...externalRef, token: 'secret'}})).ok, false);
  assert.equal(validateRower(validRower({externalRef: {...externalRef, id: '<script>'}})).ok, false);
  const built = buildRowerDTO({...validRower({externalRef}), browserCredential: 'must-not-copy'});
  assert.deepEqual(built.externalRef, externalRef);
  assert.equal(Object.hasOwn(built, 'browserCredential'), false);
});

test('v2 rower migration is pure, strict, idempotent at current schema, and rejects future schemas', () => {
  const legacy = legacyRower({name: 'Bestand', stemmX: 47});
  const before = clone(legacy);
  const migrated = migrateRowerV2(legacy);
  assert.deepEqual(legacy, before);
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.equal(migrated.externalRef, null);
  assert.equal(migrated.stemmX, 47);
  assert.equal(validateRower(migrated).ok, true);

  const first = migrateRowerToCurrent(legacy);
  assert.equal(first.migrated, true);
  assert.deepEqual(first.value, migrated);
  const repeated = migrateRowerToCurrent(first.value);
  assert.deepEqual(repeated, {value: first.value, migrated: false});
  assert.equal(repeated.value, first.value);
  assert.throws(
    () => migrateRowerToCurrent({...migrated, schemaVersion: SCHEMA_VERSION + 1}),
    error => error instanceof UnsupportedSchemaVersionError
      && error.code === 'unsupported-schema-version'
      && error.actual === SCHEMA_VERSION + 1
      && error.supported === SCHEMA_VERSION,
  );
  assert.throws(() => migrateRowerV2({...legacy, unknown: true}), /invalid/u);
});

test('v3 to v4 migration reverses stroke-first numbering without swapping physical seat ids or people', () => {
  const strokeRef = {id: 'rower-stroke', revision: 7};
  const bowRef = {id: 'rower-bow', revision: 3};
  const boat = previousBoat({preset: '4x', rig: 'skull'});
  boat.seats[0] = {...boat.seats[0], IH: 93, rowerRef: strokeRef};
  boat.seats[3] = {...boat.seats[3], IH: 83, rowerRef: bowRef};
  const source = {
    schemaVersion: 3,
    kind: 'currentConfig',
    boatRef: {id: 'boat-v3', revision: 5},
    boat,
    crew: [
      {
        schemaVersion: 3,
        kind: 'crewAssignment',
        seatId: boat.seats[0].id,
        trimId: boat.seats[0].trimId,
        rowerRef: strokeRef,
        rower: previousRower({name: 'Person am Schlag', stemmX: 49}),
      },
      {
        schemaVersion: 3,
        kind: 'crewAssignment',
        seatId: boat.seats[3].id,
        trimId: boat.seats[3].trimId,
        rowerRef: bowRef,
        rower: previousRower({name: 'Person am Bug', stemmX: 37}),
      },
    ],
    editSeatId: boat.seats[3].id,
    referenceSeatId: boat.seats[0].id,
    mode: 'werkstatt',
    heightRef: 'sitz',
    kg: 0,
    t: 0,
    recovery: false,
  };
  const before = clone(source);

  const migratedBoat = migrateBoatV3(boat);
  assert.deepEqual(source, before, 'one-step migrations are pure');
  assert.deepEqual(
    migratedBoat.seats.map(seat => seat.id),
    boat.seats.map(seat => seat.id).reverse(),
    'the ordered seat entities are reversed instead of copying values between ids',
  );
  assert.deepEqual(migratedBoat.seats.map(seat => seat.position), [1, 2, 3, 4]);
  assert.deepEqual(migratedBoat.seats.map(seat => seat.role), ['bow', 'crew', 'crew', 'stroke']);
  assert.deepEqual(
    migratedBoat.seats.map(seat => seat.label),
    ['Platz 1 · Bug', 'Platz 2', 'Platz 3', 'Platz 4 · Schlag'],
  );
  assert.equal(migratedBoat.seats[0].IH, 83, 'bow physical trim stays with the bow seat id');
  assert.equal(migratedBoat.seats[3].IH, 93, 'stroke physical trim stays with the stroke seat id');
  assert.deepEqual(migratedBoat.seats[0].rowerRef, bowRef);
  assert.deepEqual(migratedBoat.seats[3].rowerRef, strokeRef);
  assert.equal(migratedBoat.cox, null, 'schema v3 did not contain cox metadata');
  assert.equal(validateBoat(migratedBoat).ok, true);

  const migrated = migrateCurrentConfigV3(source);
  assert.deepEqual(source, before, 'workspace migration does not mutate the source');
  assert.equal(validateCurrentConfig(migrated).ok, true);
  const migratedStroke = migrated.boat.seats.find(seat => seat.id === boat.seats[0].id);
  const migratedBow = migrated.boat.seats.find(seat => seat.id === boat.seats[3].id);
  assert.equal(migratedStroke.position, 4);
  assert.equal(migratedStroke.role, 'stroke');
  assert.deepEqual(migratedStroke.rowerRef, strokeRef);
  assert.equal(migratedBow.position, 1);
  assert.equal(migratedBow.role, 'bow');
  assert.deepEqual(migratedBow.rowerRef, bowRef);
  assert.equal(
    migrated.crew.find(item => item.rower.name === 'Person am Schlag').seatId,
    migratedStroke.id,
  );
  assert.equal(
    migrated.crew.find(item => item.rower.name === 'Person am Bug').seatId,
    migratedBow.id,
  );
  assert.equal(migrated.editSeatId, migratedBow.id, 'edit context follows the stable physical seat id');
  assert.equal(migrated.referenceSeatId, migratedStroke.id, 'stroke reference follows the stable physical seat id');

  const routedBoat = migrateBoatToCurrent(boat);
  assert.equal(routedBoat.migrated, true);
  assert.deepEqual(routedBoat.value, migratedBoat);
  const routedConfig = migrateCurrentConfigToCurrent(source);
  assert.equal(routedConfig.migrated, true);
  assert.deepEqual(routedConfig.value, migrated);
  assert.deepEqual(migrateCurrentConfigToCurrent(migrated), {value: migrated, migrated: false});
  assert.equal(migrateRowerToCurrent(previousRower({name: 'v3 Person'})).migrated, true);
});

test('v2 boat migration creates deterministic real capacities without inventing occupants', () => {
  const cases = [
    ['1x', 'skull', 1, 'preset'],
    ['2x', 'skull', 2, 'preset'],
    ['2-', 'riemen', 2, 'preset'],
    ['3x', 'skull', 3, 'preset'],
    ['4x', 'skull', 4, 'preset'],
    ['4-', 'riemen', 4, 'preset'],
    ['4+', 'riemen', 4, 'preset'],
    ['6x', 'skull', 6, 'preset'],
    ['8+', 'riemen', 8, 'preset'],
    ['gigS', 'skull', 2, 'legacy-assumed'],
  ];
  for (const [preset, rig, count, capacityStatus] of cases) {
    const legacy = legacyBoat({preset, rig});
    const first = migrateBoatV2(legacy, {record: {id: `boat-record-${preset}`}});
    const second = migrateBoatV2(legacy, {record: {id: `boat-record-${preset}`}});
    assert.deepEqual(first, second);
    assert.equal(validateBoat(first).ok, true, preset);
    assert.equal(first.seats.length, count, preset);
    assert.equal(first.capacityStatus, capacityStatus, preset);
    assert.deepEqual(first.seats.map(seat => seat.position), Array.from({length: count}, (_, index) => index + 1));
    assert.deepEqual(first.seats.map(seat => seat.role), Array.from(
      {length: count},
      (_, index) => seatRoleForPosition(index + 1, count),
    ));
    assert.equal(first.seats[0].label, count === 1 ? 'Platz 1 · Einer' : 'Platz 1 · Bug');
    assert.equal(first.seats.at(-1).label, count === 1 ? 'Platz 1 · Einer' : `Platz ${count} · Schlag`);
    assert.equal(new Set(first.seats.map(seat => seat.id)).size, count);
    assert.equal(new Set(first.seats.map(seat => seat.trimId)).size, count);
    assert.equal(first.seats.every(seat => seat.rowerRef === null), true);
    assert.equal(first.cox, null, 'legacy v2 had no cox metadata to invent');
  }

  const singleWithDistinctHiddenRig = legacyBoat({
    preset: '1x',
    s1: legacySeat('skull', {IH: 88}),
    s2: legacySeat('skull', {IH: 90}),
  });
  const preserved = migrateBoatV2(singleWithDistinctHiddenRig);
  assert.equal(preserved.seats.length, 1);
  assert.equal(preserved.seats[0].IH, 88);
  assert.equal(preserved.legacyRigTemplate.IH, 90);
  assert.equal(migrateBoatV2(legacyBoat({preset: '1x'})).legacyRigTemplate, null);

  const current = migrateBoatToCurrent(preserved);
  assert.equal(current.migrated, false);
  assert.equal(current.value, preserved);
  assert.throws(
    () => migrateBoatToCurrent({...preserved, schemaVersion: 99}),
    UnsupportedSchemaVersionError,
  );
});

test('v2 workspace migration maps two snapshots onto real seats and leaves every other place free', () => {
  const legacy = legacyConfig({
    boat: legacyBoat({preset: '4x'}),
    crew: {
      s1: legacyRower({name: 'Schlagmann', stemmX: 48}),
      s2: legacyRower({name: 'Bugmann', stemmX: 38}),
    },
    editSeat: 's2',
  });
  const before = clone(legacy);
  const migrated = migrateCurrentConfigV2(legacy);
  assert.deepEqual(migrated, migrateCurrentConfigV2(legacy));
  assert.deepEqual(legacy, before);
  assert.equal(validateCurrentConfig(migrated).ok, true);
  assert.equal(migrated.boat.seats.length, 4);
  assert.deepEqual(migrated.crew.map(item => item.rower.name), ['Bugmann', 'Schlagmann']);
  assert.deepEqual(migrated.crew.map(item => item.seatId), migrated.boat.seats.slice(2).map(seat => seat.id));
  assert.deepEqual(migrated.crew.map(item => item.rowerRef), [null, null]);
  assert.deepEqual(migrated.boat.seats.map(seat => seat.rowerRef), [null, null, null, null]);
  assert.deepEqual(migrated.boat.seats.map(seat => seat.stemmX), [32.5, 32.5, 38, 48],
    'occupied legacy seats retain actual Fa while newly represented free seats use the explicit model default');
  assert.equal(migrated.editSeatId, migrated.boat.seats[2].id, 'legacy s2 follows its physical near-stroke place');
  assert.equal(migrated.referenceSeatId, migrated.boat.seats[3].id, 'legacy s1 remains the stroke reference');
  assert.equal(migrated.crew.find(item => item.rower.name === 'Schlagmann').seatId, migrated.boat.seats[3].id);
  assert.equal(migrated.crew.find(item => item.rower.name === 'Bugmann').seatId, migrated.boat.seats[2].id);
  assert.equal(migrated.boatRef, null);

  const first = migrateCurrentConfigToCurrent(legacy);
  assert.equal(first.migrated, true);
  const repeated = migrateCurrentConfigToCurrent(first.value);
  assert.equal(repeated.migrated, false);
  assert.equal(repeated.value, first.value);
});

test('1x and 8+ workspace migrations have honest occupied/free counts and no hidden person', () => {
  const single = legacyConfig({
    boat: legacyBoat({preset: '1x'}),
    crew: {
      s1: legacyRower({name: 'Sichtbar'}),
      s2: legacyRower({name: 'Verborgene Person'}),
    },
  });
  const migratedSingle = migrateCurrentConfigV2(single);
  assert.equal(migratedSingle.boat.seats.length, 1);
  assert.equal(migratedSingle.crew.length, 1);
  assert.equal(migratedSingle.crew[0].rower.name, 'Sichtbar');
  assert.doesNotMatch(JSON.stringify(migratedSingle), /Verborgene Person/u);

  const eight = migrateCurrentConfigV2(legacyConfig({
    boat: legacyBoat({preset: '8+', rig: 'riemen'}),
  }));
  assert.equal(eight.boat.seats.length, 8);
  assert.equal(eight.crew.length, 2);
  assert.equal(eight.boat.seats.slice(0, 6).every(seat => seat.rowerRef === null), true);
  assert.deepEqual(eight.crew.map(item => item.seatId), eight.boat.seats.slice(6).map(seat => seat.id));
  assert.equal(eight.referenceSeatId, eight.boat.seats[7].id);
  assert.equal(eight.boat.cox, null, 'v2 cannot invent cox metadata');
});

test('current config accepts unresolved saved references but never fabricates a missing snapshot', () => {
  const current = validConfig();
  const unresolvedRef = current.boat.seats[1].rowerRef;
  current.crew = current.crew.slice(0, 1);
  assert.notEqual(unresolvedRef, null);
  assert.equal(validateCurrentConfig(current).ok, true);
  assert.equal(current.crew.some(item => item.seatId === current.boat.seats[1].id), false);

  const mismatch = clone(validConfig());
  mismatch.crew[0].rowerRef = {id: 'different-rower', revision: 1};
  assert.equal(validateCurrentConfig(mismatch).ok, false);
  const duplicate = clone(validConfig());
  duplicate.crew[1].rowerRef = duplicate.crew[0].rowerRef;
  duplicate.boat.seats[1].rowerRef = duplicate.crew[0].rowerRef;
  assert.equal(validateCurrentConfig(duplicate).ok, false);
});

test('malformed current-schema seat entries and references are rejected without throwing', () => {
  for (const malformedSeat of [null, 7, 'seat']) {
    const config = clone(validConfig());
    config.boat.seats[0] = malformedSeat;
    assert.doesNotThrow(() => validateCurrentConfig(config));
    assert.equal(validateCurrentConfig(config).ok, false);
    assert.doesNotThrow(() => validateImportObject({
      schemaVersion: SCHEMA_VERSION,
      kind: 'rudertrimm.current-config',
      config,
    }));
    assert.equal(validateImportObject({
      schemaVersion: SCHEMA_VERSION,
      kind: 'rudertrimm.current-config',
      config,
    }).ok, false);
  }

  const invalidRefs = clone(validConfig());
  delete invalidRefs.boat.seats[0].rowerRef;
  delete invalidRefs.crew[0].rowerRef;
  assert.doesNotThrow(() => validateCurrentConfig(invalidRefs));
  assert.equal(validateCurrentConfig(invalidRefs).ok, false);

  const sparseSeats = validBoat();
  sparseSeats.seats = new Array(PRESETS['2x'].seatCount);
  assert.equal(validateBoat(sparseSeats).ok, false);
  const sparseCrew = validConfig();
  sparseCrew.crew = new Array(2);
  assert.equal(validateCurrentConfig(sparseCrew).ok, false);
});

test('legacy payloads can be rebuilt into current import envelopes without weakening strict current validation', () => {
  const rowers = buildImportDTO('rudertrimm.rowers', [legacyRower({name: 'Altprofil'})]);
  const boats = buildImportDTO('rudertrimm.boats', [legacyBoat({preset: '4x'})]);
  const workspace = buildImportDTO('rudertrimm.current-config', legacyConfig());
  for (const envelope of [rowers, boats, workspace]) {
    assert.equal(envelope.schemaVersion, SCHEMA_VERSION);
    assert.equal(validateImportObject(envelope).ok, true);
  }
});

test('individual DTO builders validate instead of silently clamping bad data', () => {
  assert.equal(validateRower(buildRowerDTO(validRower())).ok, true);
  assert.equal(validateSeat(buildSeatDTO(validSeat())).ok, true);
  assert.equal(validateBoat(buildBoatDTO(validBoat())).ok, true);
  assert.throws(() => buildRowerDTO(validRower({name: '<script>alert(1)</script>'})), /invalid/);
  assert.throws(() => buildSeatDTO(validSeat('skull', {DA: 999})), /invalid/);
  assert.throws(() => buildBoatDTO(validBoat({name: 'A'.repeat(MAX_NAME_LENGTH + 1)})), /invalid/);
});

test('versioned rower, boat, and current-config import envelopes validate', () => {
  const rowers = buildImportDTO('rudertrimm.rowers', [validRower(), validRower({name: 'Bea'})]);
  const boats = buildImportDTO('rudertrimm.boats', [validBoat()]);
  const config = buildImportDTO('rudertrimm.current-config', validConfig());
  assert.equal(validateImportObject(rowers).ok, true);
  assert.equal(validateImportObject(boats).ok, true);
  assert.equal(validateImportObject(config).ok, true);
  assert.equal(rowers.schemaVersion, SCHEMA_VERSION);
  assert.ok(Object.isFrozen(rowers.items));
});

test('import validator rejects legacy arrays, wrong versions, unknown kinds/fields, holes, and oversized payloads', () => {
  assert.equal(validateImportObject([validRower()]).ok, false);
  assert.equal(validateImportObject({schemaVersion: 1, kind: 'rudertrimm.rowers', items: [validRower()]}).ok, false);
  assert.equal(validateImportObject({schemaVersion: 2, kind: 'rudertrimm.unknown', items: []}).ok, false);
  assert.equal(validateImportObject({schemaVersion: 2, kind: 'rudertrimm.rowers', items: [], extra: true}).ok, false);
  const itemsWithHole = new Array(1);
  assert.equal(validateImportObject({schemaVersion: 2, kind: 'rudertrimm.rowers', items: itemsWithHole}).ok, false);
  const tooMany = Array.from({length: MAX_IMPORT_ITEMS + 1}, (_, index) => validRower({name: `R${index}`}));
  assert.equal(validateImportObject({schemaVersion: 2, kind: 'rudertrimm.rowers', items: tooMany}).ok, false);
  assert.throws(() => buildImportDTO('rudertrimm.unknown', []), /Unknown import kind/);
});

test('malicious nested import strings and numeric payloads are rejected atomically', () => {
  const maliciousRowerImport = {
    schemaVersion: 2,
    kind: 'rudertrimm.rowers',
    items: [validRower({name: '<img src=x onerror=alert(document.domain)>'})],
  };
  assert.equal(validateImportObject(maliciousRowerImport).ok, false);

  const malformedBoat = clone(validBoat());
  malformedBoat.seats[0].IH = '88';
  const boatImport = {schemaVersion: SCHEMA_VERSION, kind: 'rudertrimm.boats', items: [malformedBoat]};
  assert.equal(validateImportObject(boatImport).ok, false);

  const malformedConfig = clone(validConfig());
  malformedConfig.boat.phiA = null;
  assert.equal(validateImportObject({schemaVersion: SCHEMA_VERSION, kind: 'rudertrimm.current-config', config: malformedConfig}).ok, false);
});
