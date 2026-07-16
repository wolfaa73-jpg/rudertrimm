/**
 * Pure domain logic for Rudertrimm v2.
 *
 * This module deliberately has no DOM, storage, network, or download side effects.
 * Every externally supplied object must pass a strict, versioned validator before
 * it becomes application state.
 */

export const SCHEMA_VERSION = 4;
export const MAX_NAME_LENGTH = 80;

export function truncateCodePoints(value, maxLength = MAX_NAME_LENGTH) {
  if (typeof value !== 'string') throw new TypeError('Expected a string');
  if (!Number.isSafeInteger(maxLength) || maxLength < 0) throw new RangeError('maxLength must be a non-negative safe integer');
  return [...value].slice(0, maxLength).join('');
}
export const MAX_IMPORT_ITEMS = 250;

const RIGS = Object.freeze(['skull', 'riemen']);
const BLADES = Object.freeze(['big', 'mac']);
const LEGACY_SEATS = Object.freeze(['s1', 's2']);
const CAPACITY_STATUSES = Object.freeze(['preset', 'confirmed', 'legacy-assumed']);
const SEAT_ROLES = Object.freeze(['single', 'bow', 'crew', 'stroke']);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Uncalibrated catch template used to derive the modelled actual catch angle.
 * Angles are degrees; Fa/defaultFa values are centimetres measured heel-to-pin.
 * These constants describe a reproducible beta model, not trainer-approved targets.
 */
export const CATCH_MODEL = deepFreeze({
  kneeDeg: 58,
  leanDeg: 16,
  sweepShoulderRotationDeg: 16,
  defaultFa: {skull: 32.5, riemen: 50},
  search: {minDeg: 20, maxDeg: 88, stepDeg: 0.5, refineIterations: 14},
});

/** Presets retained from the validated v1 data tables. */
export const PRESETS = deepFreeze({
  '1x': {rig: 'skull', DA: 159, IH: 88, Lbig: 288, Lmac: 298, a: 15, single: true, seatCount: 1},
  '2x': {rig: 'skull', DA: 159, IH: 88, Lbig: 288, Lmac: 300, a: 15, seatCount: 2},
  // 3x/6x sind ausdrücklich gewünschte Vereinsklassen. Ihre Startwerte
  // übernehmen transparent den 4x-Grundtrimm; sie sind keine World-Rowing-Klasse.
  '3x': {rig: 'skull', DA: 158, IH: 87, Lbig: 289, Lmac: 300, a: 15, seatCount: 3, clubClass: true},
  '4x': {rig: 'skull', DA: 158, IH: 87, Lbig: 289, Lmac: 300, a: 15, seatCount: 4},
  '6x': {rig: 'skull', DA: 158, IH: 87, Lbig: 289, Lmac: 300, a: 15, seatCount: 6, clubClass: true},
  '2-': {rig: 'riemen', DA: 85, IH: 115, Lbig: 374, Lmac: 383, a: 17, seatCount: 2},
  '4-': {rig: 'riemen', DA: 84, IH: 114, Lbig: 375, Lmac: 382, a: 17, seatCount: 4},
  '4+': {rig: 'riemen', DA: 84, IH: 114, Lbig: 375, Lmac: 382, a: 17, seatCount: 4, coxed: true},
  '8+': {rig: 'riemen', DA: 83, IH: 113.5, Lbig: 375, Lmac: 384, a: 17, seatCount: 8, coxed: true},
  gigS: {rig: 'skull', DA: 160, IH: 88, Lbig: 289, Lmac: 298, a: 15, seatCount: null},
  gigR: {rig: 'riemen', DA: 84, IH: 114, Lbig: 375, Lmac: 384, a: 17, seatCount: null},
  wmM1x: {rig: 'skull', DA: 160, IH: 88.5, Lbig: 288.5, Lmac: 298, a: 16, single: true, seatCount: 1},
  wmW1x: {rig: 'skull', DA: 160, IH: 88, Lbig: 286.5, Lmac: 296, a: 16, single: true, seatCount: 1},
  wmM2x: {rig: 'skull', DA: 159, IH: 88.5, Lbig: 289, Lmac: 299, a: 16, seatCount: 2},
  wmW2x: {rig: 'skull', DA: 159.5, IH: 87.5, Lbig: 287.5, Lmac: 297, a: 16, seatCount: 2},
  wmM4x: {rig: 'skull', DA: 159, IH: 88, Lbig: 289.5, Lmac: 299, a: 16, seatCount: 4},
  wmW4x: {rig: 'skull', DA: 159, IH: 88, Lbig: 288, Lmac: 298, a: 16, seatCount: 4},
  'wmM2-': {rig: 'riemen', DA: 86, IH: 116, Lbig: 375.5, Lmac: 384, a: 17, seatCount: 2},
  'wmW2-': {rig: 'riemen', DA: 86.5, IH: 116, Lbig: 373, Lmac: 382, a: 17, seatCount: 2},
  'wmM4-': {rig: 'riemen', DA: 85, IH: 115, Lbig: 376, Lmac: 385, a: 17, seatCount: 4},
  'wmW4-': {rig: 'riemen', DA: 85, IH: 115.5, Lbig: 373, Lmac: 382, a: 17, seatCount: 4},
  'wmM8+': {rig: 'riemen', DA: 83.5, IH: 114, Lbig: 377, Lmac: 386, a: 17, seatCount: 8, coxed: true},
  'wmW8+': {rig: 'riemen', DA: 84, IH: 114, Lbig: 373, Lmac: 382, a: 17, seatCount: 8, coxed: true},
});

/** UI and import bounds. All endpoints are inclusive. */
export const RANGES = deepFreeze({
  skull: {DA: [150, 168], IH: [82, 94], L: [265, 306]},
  riemen: {DA: [78, 92], IH: [106, 122], L: [355, 392]},
  seat: {
    d: [1, 3], handGap: [14, 22], a: [11, 21], anlage: [0, 8],
    aussen: [0, 3], dBB: [-2, 3], stemmW: [36, 48], rollL: [68, 80], rueh: [-5, 12],
  },
  rower: {
    legLen: [70, 105], torsoLen: [75, 110], wingspan: [150, 215],
    SB: [32, 48], weight: [45, 120], stemmX: [26, 56],
  },
  boat: {phiA: [40, 85], phiR: [20, 60], c: [5, 10], seatOffset: [3, 8]},
  current: {kg: [-20, 20], t: [0, 100]},
});

/** Machine-readable structural contract summary used by import/export adapters. */
export const SCHEMAS = deepFreeze({
  rower: {
    kind: 'rower',
    fields: ['schemaVersion', 'kind', 'externalRef', 'name', 'legLen', 'torsoLen', 'wingspan', 'SB', 'weight', 'stemmX'],
  },
  seat: {
    kind: 'seat',
    fields: ['schemaVersion', 'kind', 'id', 'trimId', 'externalRef', 'position', 'role', 'label', 'rig', 'DA', 'IH', 'L', 'd', 'handGap', 'a', 'anlage', 'aussen', 'dBB', 'stemmW', 'rollL', 'rueh', 'stemmX', 'rowerRef'],
  },
  boat: {
    kind: 'boat',
    fields: ['schemaVersion', 'kind', 'externalRef', 'name', 'preset', 'blade', 'rig', 'strokeSide', 'phiA', 'phiR', 'c', 'seatOffset', 'cox', 'capacityStatus', 'seats', 'legacyRigTemplate'],
  },
  crewAssignment: {
    kind: 'crewAssignment',
    fields: ['schemaVersion', 'kind', 'seatId', 'trimId', 'rowerRef', 'rower'],
  },
  currentConfig: {
    kind: 'currentConfig',
    fields: ['schemaVersion', 'kind', 'boatRef', 'boat', 'crew', 'editSeatId', 'referenceSeatId', 'mode', 'heightRef', 'kg', 't', 'recovery'],
  },
  importKinds: ['rudertrimm.rowers', 'rudertrimm.boats', 'rudertrimm.current-config'],
});

/** German rowing convention: bow is 1; stroke is the highest rower number. */
export function seatRoleForPosition(position,seatCount){
  if(!Number.isSafeInteger(position)||!Number.isSafeInteger(seatCount)||seatCount<1||position<1||position>seatCount){
    throw new RangeError('seat position must be inside a positive real-seat count');
  }
  if(seatCount===1) return 'single';
  if(position===1) return 'bow';
  if(position===seatCount) return 'stroke';
  return 'crew';
}

export function seatLabelForPosition(position,seatCount){
  const role=seatRoleForPosition(position,seatCount);
  if(role==='single') return 'Platz 1 · Einer';
  if(role==='bow') return 'Platz 1 · Bug';
  if(role==='stroke') return `Platz ${position} · Schlag`;
  return `Platz ${position}`;
}

/**
 * Plans a capacity change without silently turning bow/stroke into an interior seat.
 * Existing seat objects are returned by reference so stable seat/trim ids and their
 * person assignment can follow the rowing role; new positions remain null.
 */
export function planSeatLayoutByRole(priorSeats,targetCount){
  if(!Array.isArray(priorSeats)) throw new TypeError('priorSeats must be an array');
  if(!Number.isSafeInteger(targetCount)||targetCount<1||targetCount>8){
    throw new RangeError('targetCount must be an integer between 1 and 8');
  }
  const used=new Set();
  const take=predicate=>{
    const seat=priorSeats.find(candidate=>!used.has(candidate)&&predicate(candidate));
    if(seat) used.add(seat);
    return seat??null;
  };
  const sources=Array(targetCount).fill(null);
  if(targetCount===1){
    sources[0]=take(seat=>seat?.role==='single')
      ??take(seat=>seat?.role==='stroke')
      ??take(seat=>seat?.position===1);
  }else{
    sources[0]=take(seat=>seat?.role==='bow')
      ??take(seat=>seat?.position===1&&seat?.role!=='single');
    sources[targetCount-1]=take(seat=>seat?.role==='stroke')
      ??take(seat=>seat?.role==='single');
    for(let position=2;position<targetCount;position+=1){
      sources[position-1]=take(seat=>seat?.position===position&&seat?.role==='crew');
    }
  }
  return Object.freeze({
    sources:Object.freeze(sources),
    removed:Object.freeze(priorSeats.filter(seat=>!used.has(seat))),
  });
}

/** @returns {boolean} true only for finite JavaScript numbers. */
export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Inclusive finite range predicate. */
export function isInRange(value, min, max) {
  return isFiniteNumber(value) && isFiniteNumber(min) && isFiniteNumber(max) && min <= max && value >= min && value <= max;
}

/** Require a finite number and return it unchanged. */
export function requireFinite(value, label = 'value') {
  if (!isFiniteNumber(value)) throw new TypeError(`${label} must be a finite number`);
  return value;
}

/** Require a finite number inside an inclusive range. */
export function requireRange(value, min, max, label = 'value') {
  requireFinite(min, `${label}.min`);
  requireFinite(max, `${label}.max`);
  if (min > max) throw new RangeError(`${label} has an inverted range`);
  requireFinite(value, label);
  if (value < min || value > max) throw new RangeError(`${label} must be in [${min}, ${max}]`);
  return value;
}

/**
 * Reproduzierbarer Zeitvertrag der vorhandenen V1-Schlagchoreografie.
 * `driveShare` ist ein dimensionsloser Zyklusanteil; `durationMs` gilt bei 1,0x.
 * Die Werte sind ein Darstellungsmodell und keine trainerkalibrierte Schlagfrequenz.
 */
export const STROKE_CYCLE = deepFreeze({durationMs: 2800, driveShare: 0.45});

function normalizedCycleProgress(value) {
  requireFinite(value, 'cycleProgress');
  return ((value % 1) + 1) % 1;
}

function smoothStep(value) {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded * bounded * (3 - 2 * bounded);
}

function inverseSmoothStep(value) {
  const bounded = requireRange(value, 0, 1, 'smoothStepValue');
  if (bounded === 0 || bounded === 1) return bounded;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const middle = (low + high) / 2;
    if (smoothStep(middle) < bounded) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** Map a normalized cycle position to the existing drive/recovery pose. */
export function strokePoseAtCycleProgress(cycleProgress) {
  const progress = normalizedCycleProgress(cycleProgress);
  if (progress < STROKE_CYCLE.driveShare) {
    return Object.freeze({
      t: 100 * smoothStep(progress / STROKE_CYCLE.driveShare),
      recovery: false,
    });
  }
  return Object.freeze({
    t: 100 * (1 - smoothStep((progress - STROKE_CYCLE.driveShare) / (1 - STROKE_CYCLE.driveShare))),
    recovery: true,
  });
}

/**
 * Recover cycle position from a frozen/manual pose so Start and Resume continue
 * at that pose instead of resetting the body, seat and oars to the catch.
 */
export function cycleProgressFromStrokePose({t, recovery}) {
  requireRange(t, 0, 100, 't');
  if (typeof recovery !== 'boolean') throw new TypeError('recovery must be a boolean');
  if (!recovery) return STROKE_CYCLE.driveShare * inverseSmoothStep(t / 100);
  return STROKE_CYCLE.driveShare
    + (1 - STROKE_CYCLE.driveShare) * inverseSmoothStep((100 - t) / 100);
}

/**
 * Advance only by elapsed frame time. Reading speed here makes a tempo change
 * affect future motion while preserving the current normalized pose exactly.
 */
export function advanceStrokeCycle(cycleProgress, elapsedMs, speed) {
  requireFinite(elapsedMs, 'elapsedMs');
  requireFinite(speed, 'speed');
  if (elapsedMs < 0) throw new RangeError('elapsedMs must not be negative');
  if (speed <= 0) throw new RangeError('speed must be positive');
  return normalizedCycleProgress(
    normalizedCycleProgress(cycleProgress) + elapsedMs * speed / STROKE_CYCLE.durationMs,
  );
}

/** Clamp a finite number to an inclusive finite range. */
export function clamp(value, min, max) {
  requireFinite(value);
  requireFinite(min, 'min');
  requireFinite(max, 'max');
  if (min > max) throw new RangeError('min must not exceed max');
  return Math.max(min, Math.min(max, value));
}

/**
 * Find the highest reachable angle without assuming reachability is globally monotonic.
 * A descending scan locates the highest reachable interval; bisection only refines that
 * local reachable→unreachable boundary.
 */
export function findHighestReachableAngle({
  minDeg,
  maxDeg,
  stepDeg = 0.5,
  refineIterations = 14,
  isReachable,
}) {
  requireFinite(minDeg, 'minDeg');
  requireFinite(maxDeg, 'maxDeg');
  requireFinite(stepDeg, 'stepDeg');
  if (minDeg >= maxDeg) throw new RangeError('minDeg must be smaller than maxDeg');
  if (stepDeg <= 0) throw new RangeError('stepDeg must be positive');
  if (!Number.isSafeInteger(refineIterations) || refineIterations < 0 || refineIterations > 30) {
    throw new RangeError('refineIterations must be an integer in [0, 30]');
  }
  if (typeof isReachable !== 'function') throw new TypeError('isReachable must be a function');
  const check = angle => {
    const result = isReachable(angle);
    if (typeof result !== 'boolean') throw new TypeError('isReachable must return a boolean');
    return result;
  };

  if (check(maxDeg)) return Object.freeze({angleDeg: maxDeg, reachable: true, limited: false});
  const sampleCount = Math.ceil((maxDeg - minDeg) / stepDeg);
  let upper = maxDeg;
  for (let index = 1; index <= sampleCount; index += 1) {
    const candidate = Math.max(minDeg, maxDeg - index * stepDeg);
    if (check(candidate)) {
      let low = candidate;
      let high = upper;
      for (let iteration = 0; iteration < refineIterations; iteration += 1) {
        const middle = (low + high) / 2;
        if (check(middle)) low = middle;
        else high = middle;
      }
      return Object.freeze({angleDeg: low, reachable: true, limited: true});
    }
    upper = candidate;
    if (candidate === minDeg) break;
  }
  return Object.freeze({angleDeg: minDeg, reachable: false, limited: true});
}

function requireRig(rig) {
  if (!RIGS.includes(rig)) throw new RangeError(`Unknown rig: ${String(rig)}`);
  return rig;
}

/** Return the new-workspace Fa model default without rewriting stored profiles. */
export function defaultFaForRig(rig) {
  return CATCH_MODEL.defaultFa[requireRig(rig)];
}

/**
 * Convert measured centimetre inputs into the segment lengths shared by every projection.
 * The hand deduction is a model assumption and therefore remains centralized and testable.
 */
export function deriveBodySegments({legLen, torsoLen, wingspan, SB}) {
  for (const [key, value] of Object.entries({legLen, torsoLen, wingspan, SB})) requireFinite(value, key);
  if (legLen <= 0 || torsoLen <= 0 || wingspan <= 0 || SB <= 0) throw new RangeError('Body measurements must be positive');
  const reach = Math.max(24, (wingspan - SB) / 2 - 8);
  const HEAD = 24;
  const NECK = Math.max(6, torsoLen * 0.09);
  return Object.freeze({
    OS: legLen / 2,
    US: legLen / 2,
    T: Math.max(30, torsoLen - HEAD - NECK),
    OA: reach * 0.48,
    UA: reach * 0.52,
    HEAD,
    NECK,
    height: legLen + torsoLen,
  });
}

/**
 * Derive the modelled actual catch from Fa, body measurements and current rig geometry.
 * Coordinates match the side view: x points sternwards, y upwards, z to starboard; all
 * distances are centimetres. The bounded 0.5-degree scan preserves Alex' non-monotonic
 * lateral-arm proposal, while local refinement makes the result deterministic and smooth.
 * Callers cache by configuration because stroke phase is deliberately not an input.
 */
export function solveNaturalCatchAngle({rig, DA, inboardFromPin, outboardFromPin, a, c, kg, rower}) {
  requireRig(rig);
  for (const [key, value] of Object.entries({DA, inboardFromPin, outboardFromPin, a, c, kg})) requireFinite(value, key);
  if (DA <= 0 || inboardFromPin <= 0 || outboardFromPin <= 0) throw new RangeError('Rig distances must be positive');
  if (!rower || typeof rower !== 'object' || Array.isArray(rower)) throw new TypeError('rower must be an object');
  for (const key of ['legLen', 'torsoLen', 'wingspan', 'SB', 'stemmX', 'rollL', 'rueh']) requireFinite(rower[key], `rower.${key}`);
  if (rower.rollL <= 0) throw new RangeError('rower.rollL must be positive');

  const rad = degrees => degrees * Math.PI / 180;
  const smoothStep = value => {
    const x = Math.max(0, Math.min(1, value));
    return x * x * (3 - 2 * x);
  };
  const segments = deriveBodySegments(rower);
  const foot = {x: rower.stemmX, y: c - 18};
  const hipY = c + 4;
  const dyLeg = hipY - foot.y;
  const legDistance = angle => Math.sqrt(segments.OS ** 2 + segments.US ** 2 - 2 * segments.OS * segments.US * Math.cos(angle));
  const hipForKnee = angle => foot.x - Math.sqrt(Math.max(1, legDistance(angle) ** 2 - dyLeg ** 2));
  const nominalHipX = hipForKnee(rad(CATCH_MODEL.kneeDeg));

  // Preserve V2's seat/track envelope even though the hand no longer moves the hip.
  const seatReferenceOffset = 5;
  const anatomyMin = hipForKnee(rad(172));
  const anatomyMax = hipForKnee(rad(45));
  const rawMin = Math.max(anatomyMin, rower.rueh - rower.rollL + seatReferenceOffset);
  const rawMax = Math.min(anatomyMax, rower.rueh + seatReferenceOffset);
  const hipMin = Math.min(rawMin, rawMax);
  const hipMax = Math.max(rawMin, rawMax);
  const hipX = Math.max(hipMin, Math.min(hipMax, nominalHipX));
  const trackLimited = rawMin > rawMax || Math.abs(hipX - nominalHipX) > 0.05;

  const lean = rad(CATCH_MODEL.leanDeg);
  const flex = segments.T * 0.42 * smoothStep(lean / rad(CATCH_MODEL.leanDeg));
  const shoulder = {
    x: hipX + segments.T * Math.sin(lean) + 0.35 * flex,
    y: hipY + segments.T * Math.cos(lean) - 0.9 * flex,
  };
  const DAr = rig === 'skull' ? DA / 2 : DA;
  const waterline = kg * 0.1;
  const pinY = c + a;
  const bladeLiftAtCatch = -8;
  const sinBlade = Math.max(-0.5, Math.min(0.5, (pinY - waterline - bladeLiftAtCatch) / outboardFromPin));
  const handY = pinY + inboardFromPin * sinBlade;
  const armLength3D = segments.OA + segments.UA;

  let evaluations = 0;
  const residual = angleDeg => {
    evaluations += 1;
    const theta = rad(angleDeg);
    const wristZ = DAr - inboardFromPin * Math.cos(theta);
    const lateral = rig === 'skull'
      ? Math.abs(wristZ - rower.SB / 2)
      : Math.abs(wristZ + Math.cos(rad(CATCH_MODEL.sweepShoulderRotationDeg)) * rower.SB / 2);
    const sagittalArm = Math.sqrt(Math.max((armLength3D * 0.55) ** 2, armLength3D ** 2 - lateral ** 2));
    const vertical = rig === 'skull'
      ? Math.max(Math.abs(shoulder.y - (handY - 1.5)), Math.abs(shoulder.y - (handY + 1.5)))
      : Math.abs(shoulder.y - handY);
    const horizontalSquared = sagittalArm ** 2 - vertical ** 2;
    const achievedX = shoulder.x + (horizontalSquared <= 4 ? 0 : Math.sqrt(horizontalSquared));
    const requiredX = inboardFromPin * Math.sin(theta);
    return requiredX - achievedX;
  };

  const {minDeg, maxDeg, stepDeg, refineIterations} = CATCH_MODEL.search;
  const sampleCount = Math.round((maxDeg - minDeg) / stepDeg);
  let previous = null;
  let best = {angle: minDeg, value: residual(minDeg)};
  let bracket = null;
  for (let index = 0; index <= sampleCount; index += 1) {
    const angle = Math.min(maxDeg, minDeg + index * stepDeg);
    const value = index === 0 ? best.value : residual(angle);
    if (Math.abs(value) < Math.abs(best.value)) best = {angle, value};
    if (previous && previous.value * value <= 0) {
      const score = Math.min(Math.abs(previous.value), Math.abs(value));
      if (!bracket || score < bracket.score) bracket = {lo: previous.angle, hi: angle, flo: previous.value, score};
    }
    previous = {angle, value};
  }

  let angleDeg;
  const bracketed = Boolean(bracket);
  if (bracket) {
    let {lo, hi, flo} = bracket;
    for (let iteration = 0; iteration < refineIterations; iteration += 1) {
      const middle = (lo + hi) / 2;
      const value = residual(middle);
      if (flo * value <= 0) hi = middle;
      else { lo = middle; flo = value; }
    }
    angleDeg = (lo + hi) / 2;
  } else {
    let lo = Math.max(minDeg, best.angle - stepDeg);
    let hi = Math.min(maxDeg, best.angle + stepDeg);
    for (let iteration = 0; iteration < refineIterations; iteration += 1) {
      const left = (2 * lo + hi) / 3;
      const right = (lo + 2 * hi) / 3;
      if (Math.abs(residual(left)) <= Math.abs(residual(right))) hi = right;
      else lo = left;
    }
    angleDeg = (lo + hi) / 2;
  }
  const finalResidual = residual(angleDeg);
  // `bracketed` is part of the public result contract: without a sign-changing interval the
  // returned boundary/minimum is only a finite drawing candidate, never an exact Ist-Auslage.
  return Object.freeze({
    angleDeg,
    residualCm: finalResidual,
    hipX,
    trackLimited,
    bracketed,
    evaluations,
    modelStatus: 'needsCalibration',
  });
}

/**
 * Derive the coherent oar geometry for one seat.
 * IH is measured to the collar; d moves the moment arm to the pin.
 */
export function derivedGeometry({rig, DA, IH, L, d, a, phiA, phiR, t = 0, c = 8, kg = 0}) {
  requireRig(rig);
  for (const [key, value] of Object.entries({DA, IH, L, d, a, phiA, phiR, t, c, kg})) {
    requireFinite(value, key);
  }
  requireRange(t, 0, 100, 't');

  const inb = IH + d;
  const outb = L - IH - d;
  if (inb <= 0) throw new RangeError('IH + d must be positive');
  if (outb <= 0) throw new RangeError('L - IH - d must be positive');

  const skull = rig === 'skull';
  const overlap = skull ? 2 * inb - DA : inb - DA;
  const outsideLever = L - IH; // conventional collar-to-tip measure; not a pin moment arm
  const strokeWidth = phiA + phiR;
  if (strokeWidth <= 0) throw new RangeError('phiA + phiR must be positive');
  const shareBeforeOrthogonal = 100 * phiA / strokeWidth;
  const pinHeightAboveWater = a + c - kg * 0.1;
  const targetIH = skull ? DA / 2 + 8 : DA + 30;
  const theta = phiA - t / 100 * strokeWidth;
  const DAr = skull ? DA / 2 : DA;

  return Object.freeze({
    rig, skull, inb, outb,
    inboardFromPin: inb,
    outboardFromPin: outb,
    overlap, U: overlap,
    outsideLever, AH: outsideLever,
    strokeWidth, SW: strokeWidth,
    shareBeforeOrthogonal, antV: shareBeforeOrthogonal,
    pinHeightAboveWater, dWL: pinHeightAboveWater,
    targetIH, IHsoll: targetIH,
    theta, DA, DAr, phiA,
  });
}

/** Physical outboard/inboard moment-arm ratio about the oarlock pin. */
export function forceRatio({L, IH, d}) {
  for (const [key, value] of Object.entries({L, IH, d})) requireFinite(value, key);
  const inb = IH + d;
  const outb = L - IH - d;
  if (inb <= 0 || outb <= 0) throw new RangeError('Moment arms must both be positive');
  return outb / inb;
}

/**
 * Solve IH for a desired physical force ratio while retaining L and d.
 * Optional range clamping and step rounding are explicit in the result.
 */
export function solveInboardForRatio({L, d, targetRatio, range, step = 0.5}) {
  requireFinite(L, 'L');
  requireFinite(d, 'd');
  requireFinite(targetRatio, 'targetRatio');
  requireFinite(step, 'step');
  if (L <= 0 || d < 0 || targetRatio <= 0 || step < 0) throw new RangeError('Invalid solve parameters');

  const rawIH = L / (targetRatio + 1) - d;
  let IH = step > 0 ? Math.round(rawIH / step) * step : rawIH;
  let clamped = false;
  if (range !== undefined) {
    if (!Array.isArray(range) || range.length !== 2) throw new TypeError('range must be [min, max]');
    const [min, max] = range;
    requireFinite(min, 'range[0]');
    requireFinite(max, 'range[1]');
    if (min > max) throw new RangeError('range is inverted');
    const bounded = clamp(IH, min, max);
    clamped = bounded !== IH;
    IH = bounded;
  }
  const achievedRatio = forceRatio({L, IH, d});
  return Object.freeze({
    IH,
    rawIH,
    targetRatio,
    achievedRatio,
    delta: achievedRatio - targetRatio,
    rounded: step > 0 && Math.abs(IH - rawIH) > 1e-12,
    clamped,
    status: clamped ? 'clamped' : 'ok',
  });
}

function requirePoint2(point, label) {
  if (!point || typeof point !== 'object' || Array.isArray(point)) throw new TypeError(`${label} must be a point`);
  requireFinite(point.x, `${label}.x`);
  requireFinite(point.y, `${label}.y`);
  return point;
}

function requirePoint3(point, label) {
  requirePoint2(point, label);
  requireFinite(point.z, `${label}.z`);
  return point;
}

/** Euclidean distance in 3D. */
export function distance3D(a, b) {
  requirePoint3(a, 'a');
  requirePoint3(b, 'b');
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

/**
 * Check the exact two-segment reachability invariant:
 * |upperArm-forearm| <= shoulder-hand distance <= upperArm+forearm.
 */
export function assessArmReachability3D({shoulder, hand, upperArm, forearm, tolerance = 1e-6}) {
  requirePoint3(shoulder, 'shoulder');
  requirePoint3(hand, 'hand');
  requireFinite(upperArm, 'upperArm');
  requireFinite(forearm, 'forearm');
  requireFinite(tolerance, 'tolerance');
  if (upperArm <= 0 || forearm <= 0 || tolerance < 0) throw new RangeError('Arm lengths must be positive and tolerance non-negative');

  const distance = distance3D(shoulder, hand);
  const minReach = Math.abs(upperArm - forearm);
  const maxReach = upperArm + forearm;
  const overreach = Math.max(0, distance - maxReach);
  const underreach = Math.max(0, minReach - distance);
  const reachable = overreach <= tolerance && underreach <= tolerance;
  const status = reachable ? 'ok' : overreach > tolerance ? 'overreach' : 'underreach';
  return Object.freeze({reachable, status, distance, minReach, maxReach, overreach, underreach, tolerance});
}

/** Validate that an already solved elbow preserves both segment lengths. */
export function validateArmPose3D({shoulder, elbow, hand, upperArm, forearm, tolerance = 1e-6}) {
  requirePoint3(elbow, 'elbow');
  const reachability = assessArmReachability3D({shoulder, hand, upperArm, forearm, tolerance});
  const measuredUpperArm = distance3D(shoulder, elbow);
  const measuredForearm = distance3D(elbow, hand);
  const upperError = Math.abs(measuredUpperArm - upperArm);
  const forearmError = Math.abs(measuredForearm - forearm);
  const segmentsPreserved = upperError <= tolerance && forearmError <= tolerance;
  const ok = reachability.reachable && segmentsPreserved;
  return Object.freeze({
    ok,
    status: ok ? 'ok' : !reachability.reachable ? reachability.status : 'segmentLengthViolation',
    segmentsPreserved,
    measuredUpperArm,
    measuredForearm,
    upperError,
    forearmError,
    reachability,
  });
}

/** Calibrated DRV criterion used at the orthogonal oar position. */
export const ORTHOGONAL_POLICY = deepFreeze({
  kneeDeg: {target: 165, min: 160, max: 170},
  rollwayPct: {target: 75, min: 70, max: 80},
});

/** Assess both required parts of the stem-board criterion; neither is optional. */
export function assessOrthogonalTrim({kneeDeg, rollwayPct}, policy = ORTHOGONAL_POLICY) {
  requireRange(kneeDeg, 0, 180, 'kneeDeg');
  requireRange(rollwayPct, 0, 100, 'rollwayPct');
  const knee = policy?.kneeDeg;
  const rollway = policy?.rollwayPct;
  if (!knee || !rollway) throw new TypeError('policy must define kneeDeg and rollwayPct');
  for (const [label, band] of [['kneeDeg', knee], ['rollwayPct', rollway]]) {
    requireFinite(band.target, `${label}.target`);
    requireFinite(band.min, `${label}.min`);
    requireFinite(band.max, `${label}.max`);
    if (band.min > band.max || !isInRange(band.target, band.min, band.max)) throw new RangeError(`${label} policy is invalid`);
  }

  const kneeOk = isInRange(kneeDeg, knee.min, knee.max);
  const rollwayOk = isInRange(rollwayPct, rollway.min, rollway.max);
  const ok = kneeOk && rollwayOk;
  return Object.freeze({
    ok,
    status: ok ? 'ok' : 'outOfRange',
    knee: Object.freeze({ok: kneeOk, value: kneeDeg, ...knee, delta: kneeDeg - knee.target}),
    rollway: Object.freeze({ok: rollwayOk, value: rollwayPct, ...rollway, delta: rollwayPct - rollway.target}),
  });
}

/**
 * Provisional arm-angle definition. The target is visible, but not certified;
 * therefore the default assessment can never return `ok`.
 */
export const ARM_ANGLE_POLICY = deepFreeze({
  definition: 'Signed shoulder-to-hand angle in the sagittal x/y plane relative to horizontal; positive when the hand is below the shoulder.',
  targetDeg: 6,
  toleranceDeg: 3,
  calibrated: false,
  source: 'DRV Trimmhandbuch figure reference; exact operational tolerance still requires calibration.',
});

/** Actual signed shoulder-to-hand angle to the horizontal in degrees. */
export function armAngleToHorizontal({shoulder, hand}) {
  requirePoint2(shoulder, 'shoulder');
  requirePoint2(hand, 'hand');
  const dx = hand.x - shoulder.x;
  const dy = shoulder.y - hand.y;
  if (Math.hypot(dx, dy) <= Number.EPSILON) throw new RangeError('Shoulder and hand must not coincide');
  return Math.atan2(dy, dx) * 180 / Math.PI;
}

/** Assess the actual arm angle. Uncalibrated policies explicitly remain non-green. */
export function assessArmAngle({shoulder, hand}, policy = ARM_ANGLE_POLICY) {
  const angleDeg = armAngleToHorizontal({shoulder, hand});
  const merged = {...ARM_ANGLE_POLICY, ...policy};
  requireFinite(merged.targetDeg, 'targetDeg');
  requireFinite(merged.toleranceDeg, 'toleranceDeg');
  if (merged.toleranceDeg < 0 || typeof merged.calibrated !== 'boolean') throw new RangeError('Invalid arm-angle policy');
  const delta = angleDeg - merged.targetDeg;
  const inBand = Math.abs(delta) <= merged.toleranceDeg;
  const status = merged.calibrated ? (inBand ? 'ok' : 'outOfRange') : 'needsCalibration';
  return Object.freeze({
    angleDeg,
    delta,
    inProvisionalBand: inBand,
    ok: status === 'ok',
    status,
    policy: deepFreeze({...merged}),
  });
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function addError(errors, path, code, message) {
  errors.push(Object.freeze({path, code, message}));
}

function exactRecord(value, fields, path, errors) {
  if (!isPlainRecord(value)) {
    addError(errors, path, 'type', 'Expected a plain object');
    return false;
  }
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addError(errors, `${path}.${key}`, 'unknownField', 'Unknown field');
  }
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) addError(errors, `${path}.${key}`, 'required', 'Required field is missing');
  }
  return true;
}

function checkConst(value, expected, path, errors) {
  if (value !== expected) addError(errors, path, 'const', `Expected ${JSON.stringify(expected)}`);
}

function checkEnum(value, allowed, path, errors) {
  if (!allowed.includes(value)) addError(errors, path, 'enum', `Expected one of: ${allowed.join(', ')}`);
}

function checkBoolean(value, path, errors) {
  if (typeof value !== 'boolean') addError(errors, path, 'type', 'Expected a boolean');
}

function checkNumber(value, range, path, errors) {
  if (!isFiniteNumber(value)) {
    addError(errors, path, 'finite', 'Expected a finite number');
  } else if (range && !isInRange(value, range[0], range[1])) {
    addError(errors, path, 'range', `Expected a value in [${range[0]}, ${range[1]}]`);
  }
}

const FORBIDDEN_NAME_CHARS = /[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

function hasInvalidUnicodeScalar(value) {
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) return true;
      codePoint = 0x10000 + ((first - 0xd800) * 0x400) + (second - 0xdc00);
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      return true;
    }
    if ((codePoint >= 0xfdd0 && codePoint <= 0xfdef) || (codePoint & 0xffff) >= 0xfffe) return true;
  }
  return false;
}

function checkName(value, path, errors) {
  if (typeof value !== 'string') {
    addError(errors, path, 'type', 'Expected a string');
    return;
  }
  const length = [...value].length;
  if (value !== value.trim()) addError(errors, path, 'whitespace', 'Leading or trailing whitespace is not allowed');
  if (length < 1 || length > MAX_NAME_LENGTH) addError(errors, path, 'length', `Name must contain 1-${MAX_NAME_LENGTH} characters`);
  if (FORBIDDEN_NAME_CHARS.test(value)) addError(errors, path, 'unsafeText', 'Markup, controls, and bidi controls are not allowed in names');
  if (hasInvalidUnicodeScalar(value)) addError(errors, path, 'unicode', 'Lone surrogates and Unicode noncharacters are not allowed in names');
}

function validationResult(value, errors) {
  const frozenErrors = Object.freeze(errors);
  return Object.freeze({ok: errors.length === 0, value: errors.length === 0 ? value : null, errors: frozenErrors});
}

const LEGACY_SCHEMA_VERSION = 2;
const PREVIOUS_SCHEMA_VERSION = 3;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LEGACY_ROWER_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'name', 'legLen', 'torsoLen', 'wingspan', 'SB', 'weight', 'stemmX',
]);
const LEGACY_SEAT_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'rig', 'DA', 'IH', 'L', 'd', 'handGap', 'a', 'anlage',
  'aussen', 'dBB', 'stemmW', 'rollL', 'rueh',
]);
const LEGACY_BOAT_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'name', 'preset', 'blade', 'rig', 'strokeSide', 'phiA',
  'phiR', 'c', 'seatOffset', 's1', 's2',
]);
const LEGACY_CURRENT_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'boat', 'crew', 'editSeat', 'mode', 'heightRef', 'kg', 't', 'recovery',
]);
const PREVIOUS_SEAT_FIELDS=Object.freeze(SCHEMAS.seat.fields.filter(field=>field!=='role'));
const PREVIOUS_BOAT_FIELDS=Object.freeze(SCHEMAS.boat.fields.filter(field=>field!=='cox'));

function checkStableId(value, path, errors) {
  if (typeof value !== 'string' || !STABLE_ID_PATTERN.test(value)) {
    addError(errors, path, 'id', 'Expected a stable 1-128 character local id');
  }
}

function checkPositiveRevision(value, path, errors) {
  if (!Number.isSafeInteger(value) || value < 1) {
    addError(errors, path, 'revision', 'Expected a positive safe-integer revision');
  }
}

function checkExternalRef(value, path, errors) {
  if (value === null) return;
  if (!exactRecord(value, ['system', 'scope', 'id'], path, errors)) return;
  for (const key of ['system', 'scope', 'id']) {
    checkName(value[key], `${path}.${key}`, errors);
  }
}

function checkCox(value,path,errors){
  if(value===null) return;
  if(!exactRecord(value,['name'],path,errors)) return;
  checkName(value.name,`${path}.name`,errors);
}

function checkRecordRef(value, path, errors, {nullable = true} = {}) {
  if (value === null && nullable) return;
  if (!exactRecord(value, ['id', 'revision'], path, errors)) return;
  checkStableId(value.id, `${path}.id`, errors);
  checkPositiveRevision(value.revision, `${path}.revision`, errors);
}

function recordRefEqual(left, right) {
  if (left === null || right === null) return left === right;
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  return left.id === right.id && left.revision === right.revision;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * Produce deterministic local ids for legacy values that never had domain ids.
 * This is not a security hash; it makes repeated pure migrations idempotent.
 */
function stableLegacyId(prefix, value) {
  const text = canonicalJson(value);
  let high = 0x9e3779b9;
  let low = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${prefix}-${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}

function copyExternalRef(value) {
  return value === null ? null : {system: value.system, scope: value.scope, id: value.id};
}

function copyRecordRef(value) {
  return value === null ? null : {id: value.id, revision: value.revision};
}

function validateLegacyRower(value, path = 'rower') {
  const errors = [];
  if (!exactRecord(value, LEGACY_ROWER_FIELDS, path, errors)) return validationResult(value, errors);
  checkConst(value.schemaVersion, LEGACY_SCHEMA_VERSION, `${path}.schemaVersion`, errors);
  checkConst(value.kind, 'rower', `${path}.kind`, errors);
  checkName(value.name, `${path}.name`, errors);
  for (const key of ['legLen', 'torsoLen', 'wingspan', 'SB', 'weight', 'stemmX']) {
    checkNumber(value[key], RANGES.rower[key], `${path}.${key}`, errors);
  }
  if (isFiniteNumber(value.SB) && isFiniteNumber(value.wingspan) && value.SB >= value.wingspan) {
    addError(errors, `${path}.SB`, 'geometry', 'Shoulder width must be smaller than wingspan');
  }
  return validationResult(value, errors);
}

function validateLegacySeat(value, path = 'seat') {
  const errors = [];
  if (!exactRecord(value, LEGACY_SEAT_FIELDS, path, errors)) return validationResult(value, errors);
  checkConst(value.schemaVersion, LEGACY_SCHEMA_VERSION, `${path}.schemaVersion`, errors);
  checkConst(value.kind, 'seat', `${path}.kind`, errors);
  checkEnum(value.rig, RIGS, `${path}.rig`, errors);
  const rigRanges = RANGES[value.rig];
  for (const key of ['DA', 'IH', 'L']) checkNumber(value[key], rigRanges?.[key], `${path}.${key}`, errors);
  for (const key of Object.keys(RANGES.seat)) checkNumber(value[key], RANGES.seat[key], `${path}.${key}`, errors);
  if (isFiniteNumber(value.L) && isFiniteNumber(value.IH) && isFiniteNumber(value.d) && value.L - value.IH - value.d <= 0) {
    addError(errors, `${path}.L`, 'geometry', 'Outboard moment arm must be positive');
  }
  return validationResult(value, errors);
}

function validateLegacyBoat(value, path = 'boat') {
  const errors = [];
  if (!exactRecord(value, LEGACY_BOAT_FIELDS, path, errors)) return validationResult(value, errors);
  checkConst(value.schemaVersion, LEGACY_SCHEMA_VERSION, `${path}.schemaVersion`, errors);
  checkConst(value.kind, 'boat', `${path}.kind`, errors);
  checkName(value.name, `${path}.name`, errors);
  checkEnum(value.preset, Object.keys(PRESETS), `${path}.preset`, errors);
  checkEnum(value.blade, BLADES, `${path}.blade`, errors);
  checkEnum(value.rig, RIGS, `${path}.rig`, errors);
  if (value.strokeSide !== -1 && value.strokeSide !== 1) addError(errors, `${path}.strokeSide`, 'enum', 'Expected -1 or 1');
  for (const key of ['phiA', 'phiR', 'c', 'seatOffset']) checkNumber(value[key], RANGES.boat[key], `${path}.${key}`, errors);
  for (const key of LEGACY_SEATS) {
    errors.push(...validateLegacySeat(value[key], `${path}.${key}`).errors);
    if (isPlainRecord(value[key]) && RIGS.includes(value.rig) && value[key].rig !== value.rig) {
      addError(errors, `${path}.${key}.rig`, 'coherence', 'Seat rig must match boat rig');
    }
  }
  if (PRESETS[value.preset] && RIGS.includes(value.rig) && PRESETS[value.preset].rig !== value.rig) {
    addError(errors, `${path}.rig`, 'coherence', 'Preset and boat rig do not match');
  }
  return validationResult(value, errors);
}

function validateLegacyCurrentConfig(value, path = 'config') {
  const errors = [];
  if (!exactRecord(value, LEGACY_CURRENT_FIELDS, path, errors)) return validationResult(value, errors);
  checkConst(value.schemaVersion, LEGACY_SCHEMA_VERSION, `${path}.schemaVersion`, errors);
  checkConst(value.kind, 'currentConfig', `${path}.kind`, errors);
  errors.push(...validateLegacyBoat(value.boat, `${path}.boat`).errors);
  if (exactRecord(value.crew, ['s1', 's2'], `${path}.crew`, errors)) {
    errors.push(...validateLegacyRower(value.crew.s1, `${path}.crew.s1`).errors);
    const single = isPlainRecord(value.boat) && PRESETS[value.boat.preset]?.single;
    if (!(single && value.crew.s2 === null)) {
      errors.push(...validateLegacyRower(value.crew.s2, `${path}.crew.s2`).errors);
    }
  }
  checkEnum(value.editSeat, LEGACY_SEATS, `${path}.editSeat`, errors);
  checkEnum(value.mode, ['werkstatt', 'wasser'], `${path}.mode`, errors);
  checkEnum(value.heightRef, ['sitz', 'schiene'], `${path}.heightRef`, errors);
  checkNumber(value.kg, RANGES.current.kg, `${path}.kg`, errors);
  checkNumber(value.t, RANGES.current.t, `${path}.t`, errors);
  checkBoolean(value.recovery, `${path}.recovery`, errors);
  if (isPlainRecord(value.boat) && PRESETS[value.boat.preset]?.single && value.editSeat === 's2') {
    addError(errors, `${path}.editSeat`, 'coherence', 'A single boat cannot edit seat s2');
  }
  return validationResult(value, errors);
}

/** Strict current rower/profile validator. */
export function validateRower(value, path = 'rower') {
  const errors = [];
  if (!exactRecord(value, SCHEMAS.rower.fields, path, errors)) return validationResult(value, errors);
  checkConst(value.schemaVersion, SCHEMA_VERSION, `${path}.schemaVersion`, errors);
  checkConst(value.kind, 'rower', `${path}.kind`, errors);
  checkExternalRef(value.externalRef, `${path}.externalRef`, errors);
  checkName(value.name, `${path}.name`, errors);
  for (const key of ['legLen', 'torsoLen', 'wingspan', 'SB', 'weight', 'stemmX']) {
    checkNumber(value[key], RANGES.rower[key], `${path}.${key}`, errors);
  }
  if (isFiniteNumber(value.SB) && isFiniteNumber(value.wingspan) && value.SB >= value.wingspan) {
    addError(errors, `${path}.SB`, 'geometry', 'Shoulder width must be smaller than wingspan');
  }
  return validationResult(value, errors);
}

/** Strict current per-seat trim validator. All lengths are centimetres. */
export function validateSeat(value, path = 'seat') {
  const errors = [];
  if (!exactRecord(value, SCHEMAS.seat.fields, path, errors)) return validationResult(value, errors);
  checkConst(value.schemaVersion, SCHEMA_VERSION, `${path}.schemaVersion`, errors);
  checkConst(value.kind, 'seat', `${path}.kind`, errors);
  checkStableId(value.id, `${path}.id`, errors);
  checkStableId(value.trimId, `${path}.trimId`, errors);
  checkExternalRef(value.externalRef, `${path}.externalRef`, errors);
  if (!Number.isSafeInteger(value.position) || value.position < 1 || value.position > 64) {
    addError(errors, `${path}.position`, 'range', 'Expected a seat position in [1, 64]');
  }
  checkEnum(value.role,SEAT_ROLES,`${path}.role`,errors);
  checkName(value.label, `${path}.label`, errors);
  checkEnum(value.rig, RIGS, `${path}.rig`, errors);
  const rigRanges = RANGES[value.rig];
  for (const key of ['DA', 'IH', 'L']) checkNumber(value[key], rigRanges?.[key], `${path}.${key}`, errors);
  for (const key of Object.keys(RANGES.seat)) checkNumber(value[key], RANGES.seat[key], `${path}.${key}`, errors);
  checkNumber(value.stemmX, RANGES.rower.stemmX, `${path}.stemmX`, errors);
  checkRecordRef(value.rowerRef, `${path}.rowerRef`, errors);
  if (isFiniteNumber(value.L) && isFiniteNumber(value.IH) && isFiniteNumber(value.d) && value.L - value.IH - value.d <= 0) {
    addError(errors, `${path}.L`, 'geometry', 'Outboard moment arm must be positive');
  }
  return validationResult(value, errors);
}

/** Strict current boat validator, including real capacity and seat ordering. */
export function validateBoat(value, path = 'boat') {
  const errors = [];
  if (!exactRecord(value, SCHEMAS.boat.fields, path, errors)) return validationResult(value, errors);
  checkConst(value.schemaVersion, SCHEMA_VERSION, `${path}.schemaVersion`, errors);
  checkConst(value.kind, 'boat', `${path}.kind`, errors);
  checkExternalRef(value.externalRef, `${path}.externalRef`, errors);
  checkName(value.name, `${path}.name`, errors);
  checkEnum(value.preset, Object.keys(PRESETS), `${path}.preset`, errors);
  checkEnum(value.blade, BLADES, `${path}.blade`, errors);
  checkEnum(value.rig, RIGS, `${path}.rig`, errors);
  checkEnum(value.capacityStatus, CAPACITY_STATUSES, `${path}.capacityStatus`, errors);
  if (value.strokeSide !== -1 && value.strokeSide !== 1) addError(errors, `${path}.strokeSide`, 'enum', 'Expected -1 or 1');
  for (const key of ['phiA', 'phiR', 'c', 'seatOffset']) checkNumber(value[key], RANGES.boat[key], `${path}.${key}`, errors);
  checkCox(value.cox,`${path}.cox`,errors);
  if(value.cox!==null&&!PRESETS[value.preset]?.coxed){
    addError(errors,`${path}.cox`,'coherence','Cox metadata is allowed only for a coxed boat class');
  }

  if (PRESETS[value.preset] && RIGS.includes(value.rig) && PRESETS[value.preset].rig !== value.rig) {
    addError(errors, `${path}.rig`, 'coherence', 'Preset and boat rig do not match');
  }
  if (!Array.isArray(value.seats)) {
    addError(errors, `${path}.seats`, 'type', 'Expected an ordered seat array');
  } else {
    if (value.seats.length < 1 || value.seats.length > 64) {
      addError(errors, `${path}.seats`, 'length', 'Expected 1-64 real seats');
    }
    const expectedCount = PRESETS[value.preset]?.seatCount;
    if (Number.isSafeInteger(expectedCount) && value.seats.length !== expectedCount) {
      addError(errors, `${path}.seats`, 'capacity', `Preset ${String(value.preset)} requires ${expectedCount} seats`);
    }
    if (expectedCount === null && value.capacityStatus === 'preset') {
      addError(errors, `${path}.capacityStatus`, 'coherence', 'Gig capacity must be confirmed or marked legacy-assumed');
    }
    const seatIds = new Set();
    const trimIds = new Set();
    const rowerIds = new Set();
    for (let index = 0; index < value.seats.length; index += 1) {
      const seat = value.seats[index];
      errors.push(...validateSeat(seat, `${path}.seats[${index}]`).errors);
      if (isPlainRecord(seat)) {
        if (seat.position !== index + 1) {
          addError(errors, `${path}.seats[${index}].position`, 'order', 'Seat positions must be ordered and contiguous');
        }
        const expectedRole=seatRoleForPosition(index+1,value.seats.length);
        if(seat.role!==expectedRole){
          addError(errors,`${path}.seats[${index}].role`,'coherence',`Expected ${expectedRole} for position ${index+1}`);
        }
        const expectedLabel=seatLabelForPosition(index+1,value.seats.length);
        if(seat.label!==expectedLabel){
          addError(errors,`${path}.seats[${index}].label`,'coherence',`Expected ${expectedLabel} for position ${index+1}`);
        }
        if (seatIds.has(seat.id)) addError(errors, `${path}.seats[${index}].id`, 'duplicate', 'Seat id must be unique');
        if (trimIds.has(seat.trimId)) addError(errors, `${path}.seats[${index}].trimId`, 'duplicate', 'Trim id must be unique');
        seatIds.add(seat.id);
        trimIds.add(seat.trimId);
        if (RIGS.includes(value.rig) && seat.rig !== value.rig) {
          addError(errors, `${path}.seats[${index}].rig`, 'coherence', 'Seat rig must match boat rig');
        }
        if (isPlainRecord(seat.rowerRef)) {
          if (rowerIds.has(seat.rowerRef.id)) {
            addError(errors, `${path}.seats[${index}].rowerRef.id`, 'duplicate', 'One rower cannot occupy two seats');
          }
          rowerIds.add(seat.rowerRef.id);
        }
      }
    }
  }
  if (value.legacyRigTemplate !== null) {
    errors.push(...validateLegacySeat(value.legacyRigTemplate, `${path}.legacyRigTemplate`).errors);
    if (!PRESETS[value.preset]?.single) {
      addError(errors, `${path}.legacyRigTemplate`, 'coherence', 'Only 1x may retain the hidden legacy rig template');
    } else if (isPlainRecord(value.legacyRigTemplate) && value.legacyRigTemplate.rig !== value.rig) {
      addError(errors, `${path}.legacyRigTemplate.rig`, 'coherence', 'Legacy rig template must match the boat rig');
    } else if (Array.isArray(value.seats) && isPlainRecord(value.seats[0])) {
      const fields = LEGACY_SEAT_FIELDS.filter(key => key !== 'schemaVersion' && key !== 'kind');
      const redundant = fields.every(key => value.legacyRigTemplate[key] === value.seats[0][key]);
      if (redundant) {
        addError(errors, `${path}.legacyRigTemplate`, 'redundant', 'Legacy rig template is allowed only when it preserves a distinct hidden v2 rig');
      }
    }
  }
  return validationResult(value, errors);
}

const CURRENT_FIELDS = SCHEMAS.currentConfig.fields;

function validateCrewAssignment(value, path = 'assignment') {
  const errors = [];
  if (!exactRecord(value, SCHEMAS.crewAssignment.fields, path, errors)) return validationResult(value, errors);
  checkConst(value.schemaVersion, SCHEMA_VERSION, `${path}.schemaVersion`, errors);
  checkConst(value.kind, 'crewAssignment', `${path}.kind`, errors);
  checkStableId(value.seatId, `${path}.seatId`, errors);
  checkStableId(value.trimId, `${path}.trimId`, errors);
  // Unsaved/draft snapshots have no repository identity. Null is materially
  // different from a saved reference and must never be replaced by a fake id.
  checkRecordRef(value.rowerRef, `${path}.rowerRef`, errors);
  errors.push(...validateRower(value.rower, `${path}.rower`).errors);
  return validationResult(value, errors);
}

/** Strict current workspace snapshot. Database arrays remain intentionally forbidden. */
export function validateCurrentConfig(value, path = 'config') {
  const errors = [];
  if (!exactRecord(value, CURRENT_FIELDS, path, errors)) return validationResult(value, errors);
  checkConst(value.schemaVersion, SCHEMA_VERSION, `${path}.schemaVersion`, errors);
  checkConst(value.kind, 'currentConfig', `${path}.kind`, errors);
  checkRecordRef(value.boatRef, `${path}.boatRef`, errors);
  const boat = validateBoat(value.boat, `${path}.boat`);
  errors.push(...boat.errors);

  if (!Array.isArray(value.crew)) {
    addError(errors, `${path}.crew`, 'type', 'Expected an ordered occupied-seat array');
  } else if (isPlainRecord(value.boat) && Array.isArray(value.boat.seats)) {
    // Structural validation above reports malformed entries. Cross-field checks
    // operate only on records so hostile null/primitive entries cannot escape as
    // TypeErrors and turn an atomic import rejection into an app crash.
    const seatRecords = value.boat.seats.filter(isPlainRecord);
    const seatsById = new Map(seatRecords.map(seat => [seat.id, seat]));
    const crewSeatIds = new Set();
    const crewRowerIds = new Set();
    let lastPosition = 0;
    for (let index = 0; index < value.crew.length; index += 1) {
      const assignment = value.crew[index];
      errors.push(...validateCrewAssignment(assignment, `${path}.crew[${index}]`).errors);
      if (!isPlainRecord(assignment)) continue;
      const seat = seatsById.get(assignment.seatId);
      if (!seat) {
        addError(errors, `${path}.crew[${index}].seatId`, 'reference', 'Assignment seat does not exist');
        continue;
      }
      if (crewSeatIds.has(assignment.seatId)) {
        addError(errors, `${path}.crew[${index}].seatId`, 'duplicate', 'A seat may have only one assignment');
      }
      if (isPlainRecord(assignment.rowerRef) && crewRowerIds.has(assignment.rowerRef.id)) {
        addError(errors, `${path}.crew[${index}].rowerRef.id`, 'duplicate', 'One rower cannot occupy two seats');
      }
      crewSeatIds.add(assignment.seatId);
      if (isPlainRecord(assignment.rowerRef)) crewRowerIds.add(assignment.rowerRef.id);
      if (seat.position <= lastPosition) {
        addError(errors, `${path}.crew[${index}]`, 'order', 'Crew snapshots must follow seat order');
      }
      lastPosition = seat.position;
      if (assignment.trimId !== seat.trimId) {
        addError(errors, `${path}.crew[${index}].trimId`, 'reference', 'Assignment trim id does not match the seat');
      }
      if (!recordRefEqual(assignment.rowerRef, seat.rowerRef)) {
        addError(errors, `${path}.crew[${index}].rowerRef`, 'reference', 'Assignment and seat rower references differ');
      }
    }
    for (const seat of seatRecords) {
      if (seat.rowerRef !== null && !crewSeatIds.has(seat.id)) {
        // A saved rower reference without a snapshot is intentionally unresolved,
        // never replaced by an invented person.
        continue;
      }
    }
  }
  checkStableId(value.editSeatId, `${path}.editSeatId`, errors);
  checkStableId(value.referenceSeatId, `${path}.referenceSeatId`, errors);
  if (isPlainRecord(value.boat) && Array.isArray(value.boat.seats)) {
    const seatIds = new Set(value.boat.seats.filter(isPlainRecord).map(seat => seat.id));
    if (!seatIds.has(value.editSeatId)) addError(errors, `${path}.editSeatId`, 'reference', 'Edit seat does not exist');
    if (!seatIds.has(value.referenceSeatId)) addError(errors, `${path}.referenceSeatId`, 'reference', 'Reference seat does not exist');
  }
  checkEnum(value.mode, ['werkstatt', 'wasser'], `${path}.mode`, errors);
  checkEnum(value.heightRef, ['sitz', 'schiene'], `${path}.heightRef`, errors);
  checkNumber(value.kg, RANGES.current.kg, `${path}.kg`, errors);
  checkNumber(value.t, RANGES.current.t, `${path}.t`, errors);
  checkBoolean(value.recovery, `${path}.recovery`, errors);
  return validationResult(value, errors);
}

/** Compatibility detector for old 1x workspaces that still retain a hidden second profile. */
export function hasHiddenSingleSeatProfile(value) {
  return isPlainRecord(value)
    && value.schemaVersion === LEGACY_SCHEMA_VERSION
    && isPlainRecord(value.boat)
    && PRESETS[value.boat.preset]?.single === true
    && isPlainRecord(value.crew)
    && value.crew.s2 !== null;
}

/** Canonicalize a legacy hidden-person workspace through the pure migration pipeline to the current schema. */
export function minimizeHiddenSingleSeatProfile(value) {
  const migration = migrateCurrentConfigToCurrent(value);
  return Object.freeze({changed: migration.migrated, config: migration.value});
}

/** Validate a complete versioned import envelope. Legacy bare arrays are rejected. */
export function validateImportObject(value, path = 'import') {
  const errors = [];
  if (!isPlainRecord(value)) {
    addError(errors, path, 'type', 'Expected a versioned import object');
    return validationResult(value, errors);
  }
  const importKind = value.kind;
  if (!SCHEMAS.importKinds.includes(importKind)) {
    addError(errors, `${path}.kind`, 'enum', `Unknown import kind: ${String(importKind)}`);
    return validationResult(value, errors);
  }
  const fields = importKind === 'rudertrimm.current-config'
    ? ['schemaVersion', 'kind', 'config']
    : ['schemaVersion', 'kind', 'items'];
  exactRecord(value, fields, path, errors);
  checkConst(value.schemaVersion, SCHEMA_VERSION, `${path}.schemaVersion`, errors);

  if (importKind === 'rudertrimm.current-config') {
    errors.push(...validateCurrentConfig(value.config, `${path}.config`).errors);
  } else if (!Array.isArray(value.items)) {
    addError(errors, `${path}.items`, 'type', 'Expected an array');
  } else {
    if (value.items.length > MAX_IMPORT_ITEMS) addError(errors, `${path}.items`, 'length', `At most ${MAX_IMPORT_ITEMS} items are allowed`);
    const validator = importKind === 'rudertrimm.rowers' ? validateRower : validateBoat;
    for (let index = 0; index < value.items.length; index += 1) {
      errors.push(...validator(value.items[index], `${path}.items[${index}]`).errors);
    }
  }
  return validationResult(value, errors);
}

/** Typed validation failure used by safe DTO builders. */
export class DomainValidationError extends TypeError {
  constructor(label, errors) {
    super(`${label} is invalid: ${errors.map(error => `${error.path} ${error.message}`).join('; ')}`);
    this.name = 'DomainValidationError';
    this.errors = errors;
  }
}

/** Typed forward-compatibility guard: future bytes are never guessed or rewritten. */
export class UnsupportedSchemaVersionError extends RangeError {
  constructor(label, actual) {
    super(`${label} schema version ${String(actual)} is newer than supported version ${SCHEMA_VERSION}`);
    this.name = 'UnsupportedSchemaVersionError';
    this.code = 'unsupported-schema-version';
    this.actual = actual;
    this.supported = SCHEMA_VERSION;
  }
}

function requireValid(result, label) {
  if (!result.ok) throw new DomainValidationError(label, result.errors);
}

function requireMigratableVersion(value, label) {
  const actual = value?.schemaVersion;
  if (Number.isSafeInteger(actual) && actual > SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(label, actual);
  }
  if (actual !== LEGACY_SCHEMA_VERSION && actual !== PREVIOUS_SCHEMA_VERSION && actual !== SCHEMA_VERSION) {
    throw new DomainValidationError(label, [Object.freeze({
      path: `${label}.schemaVersion`,
      code: 'version',
      message: `Expected schema version ${LEGACY_SCHEMA_VERSION}, ${PREVIOUS_SCHEMA_VERSION}, or ${SCHEMA_VERSION}`,
    })]);
  }
  return actual;
}

function buildLegacySeatDTO(source) {
  const dto = {
    schemaVersion: LEGACY_SCHEMA_VERSION,
    kind: 'seat',
    rig: source?.rig,
    DA: source?.DA,
    IH: source?.IH,
    L: source?.L,
    d: source?.d,
    handGap: source?.handGap,
    a: source?.a,
    anlage: source?.anlage,
    aussen: source?.aussen,
    dBB: source?.dBB,
    stemmW: source?.stemmW,
    rollL: source?.rollL,
    rueh: source?.rueh,
  };
  requireValid(validateLegacySeat(dto), 'legacy seat DTO');
  return dto;
}

function defaultSeatSource(presetKey, blade) {
  const preset = PRESETS[presetKey];
  if (!preset) return {};
  return {
    rig: preset.rig,
    DA: preset.DA,
    IH: preset.IH,
    L: blade === 'mac' ? preset.Lmac : preset.Lbig,
    d: 2,
    handGap: 18,
    a: preset.a,
    anlage: 4,
    aussen: 0,
    dBB: 0.5,
    stemmW: 42,
    rollL: 75,
    rueh: 5,
    stemmX: defaultFaForRig(preset.rig),
  };
}

/** Build a safe, explicit rower DTO; unknown source properties are not copied. */
export function buildRowerDTO(source) {
  const dto = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'rower',
    externalRef: source?.externalRef == null ? null : copyExternalRef(source.externalRef),
    name: source?.name,
    legLen: source?.legLen,
    torsoLen: source?.torsoLen,
    wingspan: source?.wingspan,
    SB: source?.SB,
    weight: source?.weight,
    stemmX: source?.stemmX,
  };
  requireValid(validateRower(dto), 'rower DTO');
  return deepFreeze(dto);
}

/** Build a safe, explicit per-seat DTO. */
export function buildSeatDTO(source, defaults = {}) {
  const position = source?.position ?? defaults.position ?? 1;
  const rig = source?.rig ?? defaults.rig;
  const dto = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'seat',
    id: source?.id ?? defaults.id ?? `seat-${position}`,
    trimId: source?.trimId ?? defaults.trimId ?? `trim-${position}`,
    externalRef: source?.externalRef == null ? null : copyExternalRef(source.externalRef),
    position,
    role:source?.role??defaults.role,
    label: source?.label ?? defaults.label ?? `Platz ${position}`,
    rig,
    DA: source?.DA ?? defaults.DA,
    IH: source?.IH ?? defaults.IH,
    L: source?.L ?? defaults.L,
    d: source?.d ?? defaults.d,
    handGap: source?.handGap ?? defaults.handGap,
    a: source?.a ?? defaults.a,
    anlage: source?.anlage ?? defaults.anlage,
    aussen: source?.aussen ?? defaults.aussen,
    dBB: source?.dBB ?? defaults.dBB,
    stemmW: source?.stemmW ?? defaults.stemmW,
    rollL: source?.rollL ?? defaults.rollL,
    rueh: source?.rueh ?? defaults.rueh,
    stemmX: source?.stemmX ?? defaults.stemmX ?? defaultFaForRig(rig),
    rowerRef: source?.rowerRef == null ? null : copyRecordRef(source.rowerRef),
  };
  requireValid(validateSeat(dto), 'seat DTO');
  return deepFreeze(dto);
}

/** Build a safe, explicit boat DTO. */
export function buildBoatDTO(source, {idSeed} = {}) {
  const presetKey = source?.preset;
  const blade = source?.blade;
  const expectedCount = PRESETS[presetKey]?.seatCount;
  const hasSeatArray = Array.isArray(source?.seats);
  const seatCount = hasSeatArray ? source.seats.length : (expectedCount ?? 2);
  const seed = idSeed ?? stableLegacyId('boat', {
    name: source?.name,
    preset: presetKey,
    rig: source?.rig,
    seats: source?.seats ?? [source?.s1, source?.s2],
  });
  const presetSeat = defaultSeatSource(presetKey, blade);
  const seats = Array.from({length: seatCount}, (_, index) => {
    const position = index + 1;
    const sourceSeat = hasSeatArray
      ? source.seats[index]
      : (seatCount===1
          ?source?.s1
          :position===seatCount
            ?source?.s1
            :position===seatCount-1
              ?(source?.s2??presetSeat)
              :presetSeat);
    return buildSeatDTO(sourceSeat, {
      ...presetSeat,
      position,
      id: `${seed}-seat-${position}`,
      trimId: `${seed}-trim-${position}`,
      role:seatRoleForPosition(position,seatCount),
      label:seatLabelForPosition(position,seatCount),
    });
  });

  let legacyRigTemplate = null;
  if (source?.legacyRigTemplate != null) {
    legacyRigTemplate = buildLegacySeatDTO(source.legacyRigTemplate);
  } else if (!hasSeatArray && PRESETS[presetKey]?.single && source?.s2) {
    const first = buildLegacySeatDTO(source.s1);
    const second = buildLegacySeatDTO(source.s2);
    if (canonicalJson(first) !== canonicalJson(second)) legacyRigTemplate = second;
  }
  const dto = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'boat',
    externalRef: source?.externalRef == null ? null : copyExternalRef(source.externalRef),
    name: source?.name,
    preset: presetKey,
    blade,
    rig: source?.rig,
    strokeSide: source?.strokeSide,
    phiA: source?.phiA,
    phiR: source?.phiR,
    c: source?.c,
    seatOffset: source?.seatOffset,
    cox:source?.cox==null?null:{name:source.cox.name},
    capacityStatus: source?.capacityStatus ?? (expectedCount === null ? 'legacy-assumed' : 'preset'),
    seats,
    legacyRigTemplate,
  };
  requireValid(validateBoat(dto), 'boat DTO');
  return deepFreeze(dto);
}

/**
 * Build the shareable current-config DTO from an application state.
 * `db`, `boats`, and every other unrelated property are intentionally omitted.
 */
export function buildCurrentConfigDTO(source, {boatIdSeed} = {}) {
  const sourceHadLegacySeats = !Array.isArray(source?.boat?.seats);
  let boat = buildBoatDTO(source?.boat, {idSeed: boatIdSeed});
  const assignments = [];
  if (Array.isArray(source?.crew)) {
    for (const candidate of source.crew) {
      const seat = boat.seats.find(item => item.id === candidate?.seatId);
      const rower = buildRowerDTO(candidate?.rower);
      const rowerRef = candidate?.rowerRef == null ? null : copyRecordRef(candidate.rowerRef);
      assignments.push({
        schemaVersion: SCHEMA_VERSION,
        kind: 'crewAssignment',
        seatId: candidate?.seatId,
        trimId: candidate?.trimId ?? seat?.trimId,
        rowerRef,
        rower,
      });
    }
  } else {
    for (const [index, key] of LEGACY_SEATS.entries()) {
      const seat = boat.seats[boat.seats.length===1?0:boat.seats.length-1-index];
      const candidate = source?.crew?.[key];
      if (!seat || candidate == null) continue;
      if (index > 0 && PRESETS[boat.preset]?.single) continue;
      const rower = buildRowerDTO(candidate);
      const explicitRef = source?.rowerRefs?.[key] ?? null;
      assignments.push({
        schemaVersion: SCHEMA_VERSION,
        kind: 'crewAssignment',
        seatId: seat.id,
        trimId: seat.trimId,
        rowerRef: explicitRef == null ? null : copyRecordRef(explicitRef),
        rower,
      });
    }
  }

  const assignmentsBySeat = new Map(assignments.map(assignment => [assignment.seatId, assignment]));
  boat = buildBoatDTO({
    ...boat,
    seats: boat.seats.map(seat => {
      const assignment = assignmentsBySeat.get(seat.id);
      if (!assignment) return seat;
      return {
        ...seat,
        rowerRef: assignment.rowerRef,
        // V2 only had profile Fa; migration promotes it to the actual per-seat
        // setting once, while current seat values remain independently editable.
        stemmX: sourceHadLegacySeats ? assignment.rower.stemmX : seat.stemmX,
      };
    }),
  }, {idSeed: boatIdSeed});

  const seatOrder = new Map(boat.seats.map(seat => [seat.id, seat.position]));
  assignments.sort((left, right) => seatOrder.get(left.seatId) - seatOrder.get(right.seatId));
  const editSeatId = source?.editSeatId
    ?? (source?.editSeat === 's2'
      ?boat.seats[Math.max(0,boat.seats.length-2)]?.id
      :boat.seats[boat.seats.length-1]?.id);
  const dto = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'currentConfig',
    boatRef: source?.boatRef == null ? null : copyRecordRef(source.boatRef),
    boat,
    crew: assignments,
    editSeatId,
    referenceSeatId: source?.referenceSeatId ?? boat.seats[boat.seats.length-1]?.id,
    mode: source?.mode,
    heightRef: source?.heightRef,
    kg: source?.kg,
    t: source?.t,
    recovery: source?.recovery,
  };
  requireValid(validateCurrentConfig(dto), 'current-config DTO');
  return deepFreeze(dto);
}

/** Strict one-step profile migration. The input is never mutated. */
export function migrateRowerV2(source) {
  requireValid(validateLegacyRower(source), 'v2 rower');
  return buildRowerDTO(source);
}

/** Strict one-step boat migration with deterministic real-seat identities. */
export function migrateBoatV2(source, context = {}) {
  requireValid(validateLegacyBoat(source), 'v2 boat');
  const idSeed = stableLegacyId('boat', {
    recordId: context?.record?.id ?? null,
    boat: source,
  });
  return buildBoatDTO(source, {idSeed});
}

/**
 * Strict one-step workspace migration.
 * V2 modelled at most two people; the current schema expands real boat capacity but leaves
 * every additional place free rather than inventing rowers.
 */
export function migrateCurrentConfigV2(source, context = {}) {
  requireValid(validateLegacyCurrentConfig(source), 'v2 current config');
  const boatIdSeed = stableLegacyId('boat', {
    recordId: context?.record?.id ?? null,
    boat: source.boat,
  });
  return buildCurrentConfigDTO(source, {boatIdSeed});
}

function requirePreviousRecord(value,fields,label,kind){
  const errors=[];
  if(exactRecord(value,fields,label,errors)){
    checkConst(value.schemaVersion,PREVIOUS_SCHEMA_VERSION,`${label}.schemaVersion`,errors);
    checkConst(value.kind,kind,`${label}.kind`,errors);
  }
  requireValid(validationResult(value,errors),label);
}

/** Schema 3 had the same profile values, but no corrected seat-role contract. */
export function migrateRowerV3(source){
  requirePreviousRecord(source,SCHEMAS.rower.fields,'v3 rower','rower');
  return buildRowerDTO({...source,schemaVersion:SCHEMA_VERSION});
}

function migrateSeatV3(source,position,seatCount){
  requirePreviousRecord(source,PREVIOUS_SEAT_FIELDS,'v3 seat','seat');
  // Schema 3 numbered from stroke towards bow. Reverse the ordered physical
  // seat entity while retaining its stable id, trim id, values, and rowerRef.
  return buildSeatDTO({
    ...source,
    schemaVersion:SCHEMA_VERSION,
    position,
    role:seatRoleForPosition(position,seatCount),
    label:seatLabelForPosition(position,seatCount),
  });
}

/** Reverse the old stroke-first order without ever swapping data between IDs. */
export function migrateBoatV3(source){
  requirePreviousRecord(source,PREVIOUS_BOAT_FIELDS,'v3 boat','boat');
  if(!Array.isArray(source.seats)){
    throw new DomainValidationError('v3 boat',[Object.freeze({path:'v3 boat.seats',code:'type',message:'Expected an ordered seat array'})]);
  }
  const seatCount=source.seats.length;
  const seats=source.seats.slice().reverse().map((seat,index)=>migrateSeatV3(seat,index+1,seatCount));
  return buildBoatDTO({...source,schemaVersion:SCHEMA_VERSION,cox:null,seats});
}

/** Preserve person↔seat identity while the referenced seat entity changes number. */
export function migrateCurrentConfigV3(source){
  requirePreviousRecord(source,SCHEMAS.currentConfig.fields,'v3 current config','currentConfig');
  if(!Array.isArray(source.crew)){
    throw new DomainValidationError('v3 current config',[Object.freeze({path:'v3 current config.crew',code:'type',message:'Expected an assignment array'})]);
  }
  const boat=migrateBoatV3(source.boat);
  const crew=source.crew.map((assignment,index)=>{
    requirePreviousRecord(assignment,SCHEMAS.crewAssignment.fields,`v3 assignment[${index}]`,'crewAssignment');
    return {
      ...assignment,
      schemaVersion:SCHEMA_VERSION,
      rower:migrateRowerV3(assignment.rower),
    };
  });
  return buildCurrentConfigDTO({...source,schemaVersion:SCHEMA_VERSION,boat,crew});
}

/**
 * Storage/import adapter API. Structured results match the repository migration
 * contract and make current-schema idempotence explicit.
 */
export function migrateRowerToCurrent(source, context = {}) {
  const version = requireMigratableVersion(source, 'rower');
  if (version === SCHEMA_VERSION) {
    requireValid(validateRower(source), 'current rower');
    return Object.freeze({value: source, migrated: false});
  }
  if(version===PREVIOUS_SCHEMA_VERSION){
    return Object.freeze({value:migrateRowerV3(source,context),migrated:true});
  }
  return Object.freeze({value: migrateRowerV2(source, context), migrated: true});
}

export function migrateBoatToCurrent(source, context = {}) {
  const version = requireMigratableVersion(source, 'boat');
  if (version === SCHEMA_VERSION) {
    requireValid(validateBoat(source), 'current boat');
    return Object.freeze({value: source, migrated: false});
  }
  if(version===PREVIOUS_SCHEMA_VERSION){
    return Object.freeze({value:migrateBoatV3(source,context),migrated:true});
  }
  return Object.freeze({value: migrateBoatV2(source, context), migrated: true});
}

export function migrateCurrentConfigToCurrent(source, context = {}) {
  const version = requireMigratableVersion(source, 'current config');
  if (version === SCHEMA_VERSION) {
    requireValid(validateCurrentConfig(source), 'current config');
    return Object.freeze({value: source, migrated: false});
  }
  if(version===PREVIOUS_SCHEMA_VERSION){
    return Object.freeze({value:migrateCurrentConfigV3(source,context),migrated:true});
  }
  return Object.freeze({value: migrateCurrentConfigV2(source, context), migrated: true});
}

export const buildSafeCurrentConfigDTO = buildCurrentConfigDTO;

/** Deterministic, storage-free showcase state for the explicit Testiel demo action. */
export function buildTestielDemoConfig() {
  const preset = PRESETS['1x'];
  const seat = {
    rig: preset.rig,
    DA: preset.DA,
    IH: preset.IH,
    L: preset.Lbig,
    d: 2,
    handGap: 18,
    a: preset.a,
    anlage: 4,
    aussen: 0,
    dBB: 0.5,
    stemmW: 42,
    rollL: 75,
    rueh: 5,
  };
  return buildCurrentConfigDTO({
    boat: {
      name: 'Testiel · Demo-Boot',
      preset: '1x',
      blade: 'big',
      rig: preset.rig,
      strokeSide: 1,
      phiA: 66,
      phiR: 44,
      c: 8,
      seatOffset: 5,
      s1: seat,
      s2: seat,
    },
    crew: {
      s1: {
        name: 'Testiel',
        legLen: 90,
        torsoLen: 95,
        wingspan: 188,
        SB: 40,
        weight: 80,
        stemmX: defaultFaForRig(preset.rig),
      },
      s2: null,
    },
    editSeat: 's1',
    mode: 'werkstatt',
    heightRef: 'sitz',
    kg: 0,
    t: 0,
    recovery: false,
  });
}

/** Deterministic, storage-free two-profile showcase for the explicit comparison demo action. */
export function buildTestielComparisonDemoConfig() {
  const preset = PRESETS['4x'];
  const seat = {
    rig: preset.rig,
    DA: preset.DA,
    IH: preset.IH,
    L: preset.Lbig,
    d: 2,
    handGap: 18,
    a: preset.a,
    anlage: 4,
    aussen: 0,
    dBB: 0.5,
    stemmW: 42,
    rollL: 75,
    rueh: 5,
  };
  // Die zweite synthetische Position enthält bewusst kleine, plausible
  // Prüfabweichungen. Sie demonstriert Ergebnispriorisierung, ist aber weder
  // Trainerempfehlung noch ein automatisch zu übernehmender Zielzustand.
  const comparisonSeat = {...seat,IH:preset.IH-3,anlage:3.5};
  return buildCurrentConfigDTO({
    boat: {
      name: 'Testiel · Vergleichs-Demo-Boot',
      preset: '4x',
      blade: 'big',
      rig: preset.rig,
      strokeSide: 1,
      phiA: 66,
      phiR: 44,
      c: 8,
      seatOffset: 5,
      s1: seat,
      s2: comparisonSeat,
    },
    crew: {
      s1: {
        name: 'Testiel',
        legLen: 90,
        torsoLen: 95,
        wingspan: 188,
        SB: 40,
        weight: 80,
        stemmX: defaultFaForRig(preset.rig),
      },
      s2: {
        name: 'Testiel 2',
        legLen: 84,
        torsoLen: 90,
        wingspan: 176,
        SB: 38,
        weight: 72,
        stemmX: defaultFaForRig(preset.rig),
      },
    },
    editSeat: 's1',
    mode: 'werkstatt',
    heightRef: 'sitz',
    kg: 0,
    t: 0,
    recovery: false,
  });
}

/** Build a versioned, validator-clean import envelope. */
export function buildImportDTO(kind, payload) {
  let dto;
  if (kind === 'rudertrimm.rowers') {
    if (!Array.isArray(payload)) throw new TypeError('rower payload must be an array');
    dto = {schemaVersion: SCHEMA_VERSION, kind, items: payload.map(buildRowerDTO)};
  } else if (kind === 'rudertrimm.boats') {
    if (!Array.isArray(payload)) throw new TypeError('boat payload must be an array');
    dto = {schemaVersion: SCHEMA_VERSION, kind, items: payload.map(buildBoatDTO)};
  } else if (kind === 'rudertrimm.current-config') {
    dto = {schemaVersion: SCHEMA_VERSION, kind, config: buildCurrentConfigDTO(payload)};
  } else {
    throw new RangeError(`Unknown import kind: ${String(kind)}`);
  }
  requireValid(validateImportObject(dto), 'import DTO');
  return deepFreeze(dto);
}
