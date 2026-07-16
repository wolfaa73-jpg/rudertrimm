import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';

import {
  EFA_CANDIDATE_KIND,
  EFA_CANDIDATE_SCHEMA_VERSION,
  EFA_CSV_LIMITS,
  EfaCsvValidationError,
  parseEfaCsv,
  previewEfaCsv,
  suggestEfaHeaderMapping,
  validateEfaCandidate,
} from '../js/efa-csv.mjs';

const fixedTime='2026-07-16T12:00:00.000Z';
const clock=()=>new Date(fixedTime);
const digest=bytes=>createHash('sha256').update(bytes).digest();

function personPreview(overrides={}){
  return previewEfaCsv({
    text:'Name\nTestiel\n',
    delimiter:';',
    entityType:'person',
    mapping:{displayName:'Name'},
    clock,
    digest,
    ...overrides,
  });
}

test('parser accepts UTF-8 BOM, CRLF, escaped quotes, and quoted multiline cells',()=>{
  const parsed=parseEfaCsv(
    '\ufeffVorname;Nachname;Notiz\r\n"Anna";"von ""Test""";"Zeile 1\r\nZeile 2"\r\n',
    {delimiter:';'},
  );
  assert.deepEqual(parsed.headers,['Vorname','Nachname','Notiz']);
  assert.deepEqual(parsed.rows,[['Anna','von "Test"','Zeile 1\nZeile 2']]);
  assert.equal(parsed.delimiter,';');
  assert.ok(parsed.byteLength>0);
  assert.equal(Object.isFrozen(parsed),true);
  assert.equal(Object.isFrozen(parsed.rows[0]),true);
});

test('comma and tab are accepted only when selected explicitly',()=>{
  assert.deepEqual(parseEfaCsv('Name,ID\nAlpha,1',{delimiter:','}).rows,[['Alpha','1']]);
  assert.deepEqual(parseEfaCsv('Name\tID\nAlpha\t1',{delimiter:'\t'}).rows,[['Alpha','1']]);
  assert.throws(()=>parseEfaCsv('Name|ID\nAlpha|1',{delimiter:'|'}),error=>error instanceof EfaCsvValidationError&&error.code==='delimiter');
  assert.throws(()=>parseEfaCsv('Name,ID\nAlpha,1'),/Trennzeichen/u);
});

test('malformed quoting, bare CR, column drift, empty headers, and normalized duplicate headers fail closed',()=>{
  assert.throws(()=>parseEfaCsv('Name\n"offen',{delimiter:';'}),error=>error.code==='malformed');
  assert.throws(()=>parseEfaCsv('Name\nA"B',{delimiter:';'}),error=>error.code==='malformed');
  assert.throws(()=>parseEfaCsv('Name\rA',{delimiter:';'}),error=>error.code==='malformed');
  assert.throws(()=>parseEfaCsv('Name;ID\nAlpha',{delimiter:';'}),error=>error.code==='columns');
  assert.throws(()=>parseEfaCsv(';ID\nAlpha;1',{delimiter:';'}),error=>error.code==='header');
  assert.throws(()=>parseEfaCsv('ID; id \n1;2',{delimiter:';'}),error=>error.code==='duplicate-header');
  assert.throws(()=>parseEfaCsv('Name\n"Alpha" x',{delimiter:';'}),error=>error.code==='malformed');
});

test('hard byte, row, column, and Unicode-cell limits cannot be raised',()=>{
  assert.throws(()=>parseEfaCsv('H\n1234',{delimiter:';',limits:{maxBytes:3}}),error=>error.code==='limit');
  assert.throws(()=>parseEfaCsv('H\n1\n2',{delimiter:';',limits:{maxRows:1}}),error=>error.code==='limit');
  assert.throws(()=>parseEfaCsv('A;B;C',{delimiter:';',limits:{maxColumns:2}}),error=>error.code==='limit');
  assert.throws(()=>parseEfaCsv('H\n😀😀',{delimiter:';',limits:{maxCellCodePoints:1}}),error=>error.code==='limit');
  assert.throws(()=>parseEfaCsv('H',{delimiter:';',limits:{maxRows:EFA_CSV_LIMITS.maxRows+1}}),/feste Importgrenze/u);

  const exactly250=['Name',...Array.from({length:250},(_value,index)=>`Person ${index+1}`)].join('\n');
  assert.equal(parseEfaCsv(exactly250,{delimiter:';'}).rows.length,250);
  assert.throws(()=>parseEfaCsv(`${exactly250}\nPerson 251`,{delimiter:';'}),error=>error.code==='limit');
});

test('UTF-16 markers, NUL, embedded BOM, lone surrogates, and noncharacters are rejected',()=>{
  for(const text of ['\ufffeName', '\u00ff\u00feName', '\u00fe\u00ffName', 'Na\u0000me', 'Name\nA\ufeffB', 'Name\n\ud800', 'Name\n\ufdd0']){
    assert.throws(()=>parseEfaCsv(text,{delimiter:';'}),error=>error instanceof EfaCsvValidationError&&error.code==='encoding');
  }
  assert.deepEqual(parseEfaCsv('\ufeffName\nAlpha',{delimiter:';'}).headers,['Name']);
});

test('header aliases only suggest a mapping and never turn it into an accepted import plan',()=>{
  const person=suggestEfaHeaderMapping(['Vorname','Nachname','Namenszusatz','eFa ID'],{entityType:'person'});
  assert.deepEqual(person,{displayName:null,firstName:'Vorname',lastName:'Nachname',affix:'Namenszusatz',id:'eFa ID'});
  const boat=suggestEfaHeaderMapping(['Bootsname','Bootsnummer'],{entityType:'boat'});
  assert.deepEqual(boat,{name:'Bootsname',id:'Bootsnummer'});
  assert.equal(suggestEfaHeaderMapping(['Name','NAME'],{entityType:'person'}).displayName,null);
  assert.equal(Object.isFrozen(person),true);
});

test('explicit split-name mapping creates an exact incomplete person candidate with scoped ID',async()=>{
  const preview=await personPreview({
    text:'Vorname;Zusatz;Nachname;ID\r\nAda;von;Lovelace;p-17\r\n',
    mapping:{firstName:'Vorname',affix:'Zusatz',lastName:'Nachname',id:'ID'},
    scope:'verein-17',
  });
  const candidate=preview.items[0].candidate;
  assert.deepEqual(Object.keys(candidate).sort(),[
    'entityType','externalRef','kind','name','provenance','schemaVersion','status',
  ]);
  assert.equal(candidate.schemaVersion,EFA_CANDIDATE_SCHEMA_VERSION);
  assert.equal(candidate.kind,EFA_CANDIDATE_KIND);
  assert.equal(candidate.entityType,'person');
  assert.equal(candidate.name,'Ada von Lovelace');
  assert.deepEqual(candidate.externalRef,{system:'efa2-csv',scope:'verein-17',id:'p-17'});
  assert.equal(candidate.status,'incomplete');
  assert.deepEqual(preview.items[0].classifications,['new','incomplete']);
  assert.equal(validateEfaCandidate(candidate).ok,true);
});

test('an ID mapping requires an explicit scope and a scope cannot float without an ID mapping',async()=>{
  await assert.rejects(()=>personPreview({
    text:'Name;ID\nAlpha;1',mapping:{displayName:'Name',id:'ID'},
  }),error=>error.code==='scope');
  await assert.rejects(()=>personPreview({scope:'verein-17'}),error=>error.code==='scope');
  await assert.rejects(()=>personPreview({
    text:'Name;ID\nAlpha;1',mapping:{displayName:'Name',id:'ID'},scope:'<verein>',
  }),error=>error.code==='scope');
});

test('boat CSV produces a provisional label candidate and invents no boat or rigging fields',async()=>{
  const preview=await previewEfaCsv({
    text:'Bootsname,ID\nWelle,b-9',
    delimiter:',',
    entityType:'boat',
    mapping:{name:'Bootsname',id:'ID'},
    scope:'verein-17',
    clock,
    digest,
  });
  const candidate=preview.items[0].candidate;
  assert.equal(candidate.entityType,'boat');
  assert.equal(candidate.name,'Welle');
  assert.equal(candidate.status,'incomplete');
  for(const forbidden of ['preset','rig','blade','seats','crew','legLen','weight']){
    assert.equal(Object.hasOwn(candidate,forbidden),false);
  }
  assert.equal(validateEfaCandidate(candidate).ok,true);
});

test('missing split-name parts and markup become inert invalid rows without raw-value retention',async()=>{
  const preview=await personPreview({
    text:'Vorname;Nachname\n;NurNachname\n<script>;Person',
    mapping:{firstName:'Vorname',lastName:'Nachname'},
  });
  assert.deepEqual(preview.items.map(item=>item.classification),['invalid','invalid']);
  assert.deepEqual(preview.counts,{new:0,exactDuplicate:0,nameReview:0,idConflict:0,invalid:2,incomplete:0});
  assert.equal(preview.items.every(item=>item.candidate===null),true);
  assert.equal(JSON.stringify(preview).includes('<script>'),false);
  assert.equal(Object.hasOwn(preview.items[1],'raw'),false);
});

test('same scoped reference is duplicate only for same semantic content and conflicts otherwise',async()=>{
  const initial=await personPreview({
    text:'ID;Name\n1;Alpha',
    mapping:{id:'ID',displayName:'Name'},
    scope:'verein-17',
  });
  const preview=await personPreview({
    text:'ID;Name\n1;Alpha\n1;Beta\n2;Alpha\n3;Gamma',
    mapping:{id:'ID',displayName:'Name'},
    scope:'verein-17',
    existingCandidates:[initial.items[0].candidate],
  });
  assert.deepEqual(preview.items.map(item=>item.classification),[
    'exactDuplicate','idConflict','nameReview','new',
  ]);
  assert.deepEqual(preview.counts,{new:1,exactDuplicate:1,nameReview:1,idConflict:1,invalid:0,incomplete:4});
  assert.equal(preview.items.every(item=>item.classifications.includes('incomplete')),true);
});

test('name equality without the same scoped ID is review-only and never an automatic duplicate',async()=>{
  const existing=(await personPreview()).items[0].candidate;
  const preview=await personPreview({
    text:'Name\ntestiel',
    existingCandidates:[existing],
    clock:()=>new Date('2026-07-16T13:00:00.000Z'),
  });
  assert.equal(preview.items[0].classification,'nameReview');
  assert.equal(preview.counts.exactDuplicate,0);
});

test('fingerprints are deterministic across preview time but change with file or mapping',async()=>{
  const first=await personPreview();
  const later=await personPreview({clock:()=>new Date('2026-07-17T12:00:00.000Z')});
  assert.equal(first.fileSha256,later.fileSha256);
  assert.equal(first.mappingFingerprint,later.mappingFingerprint);
  assert.equal(first.baseFingerprint,later.baseFingerprint);
  assert.equal(first.planFingerprint,later.planFingerprint);
  assert.notEqual(first.importedAt,later.importedAt);

  const changedFile=await personPreview({text:'Name\nTestiel 2\n'});
  assert.notEqual(changedFile.fileSha256,first.fileSha256);
  assert.notEqual(changedFile.planFingerprint,first.planFingerprint);

  const split=await personPreview({
    text:'Vorname;Nachname\nTes;tiel',
    mapping:{firstName:'Vorname',lastName:'Nachname'},
  });
  assert.notEqual(split.mappingFingerprint,first.mappingFingerprint);
});

test('candidate and provenance contracts are exact, private, and keep eFa version unknown',async()=>{
  const preview=await personPreview();
  const candidate=preview.items[0].candidate;
  assert.deepEqual(Object.keys(candidate.provenance).sort(),[
    'delimiter','efaVersion','encoding','fileSha256','importedAt','mappingFingerprint','source',
  ]);
  assert.equal(candidate.provenance.source,'efa-csv');
  assert.equal(candidate.provenance.encoding,'utf-8');
  assert.equal(candidate.provenance.efaVersion,'unknown');
  assert.match(candidate.provenance.fileSha256,/^sha256-[0-9a-f]{64}$/u);
  assert.match(candidate.provenance.mappingFingerprint,/^sha256-[0-9a-f]{64}$/u);
  const serialized=JSON.stringify(candidate.provenance);
  for(const forbidden of ['filename','fileName','path','/Users/','rawRow']) assert.equal(serialized.includes(forbidden),false);

  const extra=JSON.parse(JSON.stringify(candidate));
  extra.secret='no';
  assert.equal(validateEfaCandidate(extra).ok,false);
  const complete=JSON.parse(JSON.stringify(candidate));
  complete.status='complete';
  assert.equal(validateEfaCandidate(complete).ok,false);
});

test('mapping validation rejects ambiguity, unknown roles, reused columns, and absent required parts',async()=>{
  await assert.rejects(()=>personPreview({mapping:{}}),error=>error.code==='mapping');
  await assert.rejects(()=>personPreview({mapping:{displayName:'Name',firstName:'Name',lastName:'Name'}}),error=>error.code==='mapping');
  await assert.rejects(()=>personPreview({mapping:{firstName:'Name'}}),error=>error.code==='mapping');
  await assert.rejects(()=>personPreview({mapping:{displayName:'Name',unknown:'Name'}}),error=>error.code==='mapping');
  await assert.rejects(()=>previewEfaCsv({
    text:'Name\nBoot',delimiter:';',entityType:'boat',mapping:{},clock,digest,
  }),error=>error.code==='mapping');
  await assert.rejects(()=>previewEfaCsv({
    text:'Name\nBoot',delimiter:';',entityType:'boat',mapping:{name:'Fehlt'},clock,digest,
  }),error=>error.code==='mapping');
});

test('invalid existing candidates and invalid digest implementations stop the whole preview',async()=>{
  const valid=(await personPreview()).items[0].candidate;
  const invalid={...valid,status:'complete'};
  await assert.rejects(()=>personPreview({existingCandidates:[invalid]}),error=>error.code==='existing-candidate');
  await assert.rejects(()=>personPreview({digest:()=>new Uint8Array(31)}),error=>error.code==='digest');
});

test('the staging module remains DOM-, storage-, and network-independent',async()=>{
  const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../js/efa-csv.mjs',import.meta.url),'utf8'));
  for(const forbidden of ['document.','window.','localStorage','sessionStorage','fetch(','XMLHttpRequest']){
    assert.equal(source.includes(forbidden),false,forbidden);
  }
});
