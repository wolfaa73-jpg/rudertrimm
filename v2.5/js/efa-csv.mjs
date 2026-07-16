/**
 * Side-effect-free staging adapter for one-time eFa CSV exports.
 *
 * CSV rows become deliberately incomplete candidates. They are never promoted
 * to complete Rudertrimm rower/boat DTOs here because an eFa name or boat label
 * cannot supply anthropometry, rigging values, a boat class, or trainer truth.
 */

export const EFA_CSV_LIMITS=Object.freeze({
  maxBytes:1_048_576,
  maxRows:250,
  maxColumns:64,
  maxCellCodePoints:1_000,
});

export const EFA_CANDIDATE_SCHEMA_VERSION=1;
export const EFA_CANDIDATE_KIND='efaCandidate';

const DELIMITERS=new Set([';',',','\t']);
const ENTITY_TYPES=new Set(['person','boat']);
const HASH_PATTERN=/^sha256-[0-9a-f]{64}$/u;
const FORBIDDEN_TEXT=/[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const PROVENANCE_FIELDS=Object.freeze([
  'source','importedAt','fileSha256','encoding','delimiter','mappingFingerprint','efaVersion',
]);
const CANDIDATE_FIELDS=Object.freeze([
  'schemaVersion','kind','entityType','name','externalRef','provenance','status',
]);

const HEADER_ALIASES=Object.freeze({
  person:Object.freeze({
    displayName:Object.freeze(['anzeigename','display name','displayname','fullname','full name','vollständiger name','name','person','ruderer']),
    firstName:Object.freeze(['vorname','first name','firstname','given name','givenname']),
    lastName:Object.freeze(['nachname','last name','lastname','surname','family name','familyname']),
    affix:Object.freeze(['namenszusatz','name affix','affix','name prefix','nameprefix']),
    id:Object.freeze(['efa id','efaid','person id','personid','mitgliedsnummer','member id','memberid','id']),
  }),
  boat:Object.freeze({
    name:Object.freeze(['bootsname','boat name','boatname','boot','name','bezeichnung']),
    id:Object.freeze(['efa id','efaid','boat id','boatid','boots id','bootsid','bootsnummer','id']),
  }),
});

export class EfaCsvValidationError extends TypeError{
  constructor(message,{code='validation',details=[]}={}){
    super(message);
    this.name='EfaCsvValidationError';
    this.code=code;
    this.details=Object.freeze([...details]);
  }
}

function isPlainRecord(value){
  if(value===null||typeof value!=='object'||Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function exactFields(value,fields,label,errors){
  if(!isPlainRecord(value)){
    errors.push(`${label} muss ein einfaches Objekt sein`);
    return false;
  }
  const actual=Object.keys(value).sort();
  const expected=[...fields].sort();
  if(actual.length!==expected.length||actual.some((field,index)=>field!==expected[index])){
    errors.push(`${label} enthält unerwartete oder fehlende Felder`);
    return false;
  }
  return true;
}

function hasInvalidUnicode(value){
  for(let index=0;index<value.length;index+=1){
    const first=value.charCodeAt(index);
    let codePoint=first;
    if(first>=0xd800&&first<=0xdbff){
      const second=value.charCodeAt(index+1);
      if(!(second>=0xdc00&&second<=0xdfff)) return true;
      codePoint=0x10000+((first-0xd800)*0x400)+(second-0xdc00);
      index+=1;
    }else if(first>=0xdc00&&first<=0xdfff){
      return true;
    }
    if((codePoint>=0xfdd0&&codePoint<=0xfdef)||(codePoint&0xffff)>=0xfffe) return true;
  }
  return false;
}

function validText(value,{max=80}={}){
  return typeof value==='string'
    &&value===value.trim()
    &&[...value].length>=1
    &&[...value].length<=max
    &&!FORBIDDEN_TEXT.test(value)
    &&!hasInvalidUnicode(value);
}

function deepFreeze(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    Object.freeze(value);
    for(const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function canonicalJson(value){
  if(value===null||typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function utf8Bytes(value){
  if(typeof TextEncoder!=='function') throw new EfaCsvValidationError('UTF-8-Codierung ist in dieser Laufzeit nicht verfügbar',{code:'encoding-unavailable'});
  return new TextEncoder().encode(value);
}

function normalizeDigest(result){
  if(typeof result==='string'){
    const normalized=result.toLowerCase().replace(/^sha256[:-]/u,'');
    if(!/^[0-9a-f]{64}$/u.test(normalized)) throw new EfaCsvValidationError('Die Digest-Funktion lieferte keinen SHA-256-Wert',{code:'digest'});
    return `sha256-${normalized}`;
  }
  let bytes;
  if(result instanceof ArrayBuffer) bytes=new Uint8Array(result);
  else if(ArrayBuffer.isView(result)) bytes=new Uint8Array(result.buffer,result.byteOffset,result.byteLength);
  else throw new EfaCsvValidationError('Die Digest-Funktion lieferte keinen unterstützten Wert',{code:'digest'});
  if(bytes.byteLength!==32) throw new EfaCsvValidationError('Die Digest-Funktion lieferte keinen SHA-256-Wert',{code:'digest'});
  return `sha256-${[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('')}`;
}

async function sha256(value,digest){
  const bytes=utf8Bytes(value);
  if(digest!==undefined){
    if(typeof digest!=='function') throw new TypeError('digest muss eine Funktion sein');
    return normalizeDigest(await digest(bytes));
  }
  const subtle=globalThis.crypto?.subtle;
  if(!subtle||typeof subtle.digest!=='function'){
    throw new EfaCsvValidationError('SHA-256 ist nicht verfügbar; eine Digest-Funktion muss injiziert werden',{code:'digest-unavailable'});
  }
  return normalizeDigest(await subtle.digest('SHA-256',bytes));
}

function timestamp(clock){
  if(typeof clock!=='function') throw new TypeError('clock muss eine Funktion sein');
  const raw=clock();
  const date=raw instanceof Date?raw:new Date(raw);
  if(!Number.isFinite(date.getTime())) throw new RangeError('clock muss ein gültiges Datum liefern');
  return date.toISOString();
}

function normalizedHeaderKey(value){
  return value.normalize('NFKC').trim().toLocaleLowerCase('de-DE').replace(/[_.-]+/gu,' ').replace(/\s+/gu,' ');
}

function assertDelimiter(delimiter){
  if(!DELIMITERS.has(delimiter)){
    throw new EfaCsvValidationError('Trennzeichen muss explizit Semikolon, Komma oder Tab sein',{code:'delimiter'});
  }
}

function rejectEncodingMarkers(text){
  if(text.startsWith('\ufffe')||text.startsWith('\u00ff\u00fe')||text.startsWith('\u00fe\u00ff')||text.includes('\u0000')||text.slice(1).includes('\ufeff')){
    throw new EfaCsvValidationError('UTF-16-/NUL-Markierung erkannt; erwartet wird UTF-8',{code:'encoding'});
  }
  if(hasInvalidUnicode(text)){
    throw new EfaCsvValidationError('CSV enthält ungültige Unicode-Codepunkte',{code:'encoding'});
  }
}

/**
 * Strict RFC4180-style parser. The caller must choose the delimiter explicitly;
 * line breaks inside quoted cells are normalized to LF for deterministic output.
 */
export function parseEfaCsv(text,{delimiter,limits={}}={}){
  if(typeof text!=='string') throw new TypeError('CSV muss Text sein');
  assertDelimiter(delimiter);
  const normalizedLimits={...EFA_CSV_LIMITS,...limits};
  for(const field of ['maxBytes','maxRows','maxColumns','maxCellCodePoints']){
    if(!Number.isSafeInteger(normalizedLimits[field])||normalizedLimits[field]<1) throw new RangeError(`${field} muss eine positive Ganzzahl sein`);
    if(normalizedLimits[field]>EFA_CSV_LIMITS[field]) throw new RangeError(`${field} darf die feste Importgrenze nicht erhöhen`);
  }
  rejectEncodingMarkers(text);
  const byteLength=utf8Bytes(text).byteLength;
  if(byteLength>normalizedLimits.maxBytes){
    throw new EfaCsvValidationError(`CSV überschreitet ${normalizedLimits.maxBytes} UTF-8-Bytes`,{code:'limit',details:[{byteLength,maxBytes:normalizedLimits.maxBytes}]});
  }
  const source=text.startsWith('\ufeff')?text.slice(1):text;
  if(source.length===0) throw new EfaCsvValidationError('CSV enthält keine Kopfzeile',{code:'empty'});

  const records=[];
  let record=[];
  let field='';
  let quoted=false;
  let afterQuote=false;
  let endedWithRecordBreak=false;

  const pushField=()=>{
    if(record.length>=normalizedLimits.maxColumns){
      throw new EfaCsvValidationError(`CSV überschreitet ${normalizedLimits.maxColumns} Spalten`,{code:'limit'});
    }
    if([...field].length>normalizedLimits.maxCellCodePoints){
      throw new EfaCsvValidationError(`CSV-Zelle überschreitet ${normalizedLimits.maxCellCodePoints} Codepunkte`,{code:'limit'});
    }
    record.push(field);
    field='';
    afterQuote=false;
  };
  const pushRecord=()=>{
    pushField();
    records.push(record);
    record=[];
    if(records.length>normalizedLimits.maxRows+1){
      throw new EfaCsvValidationError(`CSV überschreitet ${normalizedLimits.maxRows} Datenzeilen`,{code:'limit'});
    }
  };

  for(let index=0;index<source.length;index+=1){
    const char=source[index];
    endedWithRecordBreak=false;
    if(quoted){
      if(char==='"'){
        if(source[index+1]==='"'){ field+='"'; index+=1; }
        else{ quoted=false; afterQuote=true; }
      }else if(char==='\r'){
        if(source[index+1]!=='\n') throw new EfaCsvValidationError('Alle CR-Zeilenumbrüche müssen als CRLF vorliegen',{code:'malformed',details:[{offset:index}]});
        field+='\n';
        index+=1;
      }else{
        field+=char;
      }
      continue;
    }
    if(afterQuote){
      if(char===delimiter){ pushField(); continue; }
      if(char==='\n'){ pushRecord(); endedWithRecordBreak=true; continue; }
      if(char==='\r'){
        if(source[index+1]!=='\n') throw new EfaCsvValidationError('Alle CR-Zeilenumbrüche müssen als CRLF vorliegen',{code:'malformed',details:[{offset:index}]});
        pushRecord();
        endedWithRecordBreak=true;
        index+=1;
        continue;
      }
      throw new EfaCsvValidationError('Nach einem schließenden Anführungszeichen ist nur Trennzeichen oder Zeilenende erlaubt',{code:'malformed',details:[{offset:index}]});
    }
    if(char==='"'){
      if(field.length!==0) throw new EfaCsvValidationError('Anführungszeichen darf nur am Feldanfang stehen',{code:'malformed',details:[{offset:index}]});
      quoted=true;
      continue;
    }
    if(char===delimiter){ pushField(); continue; }
    if(char==='\n'){ pushRecord(); endedWithRecordBreak=true; continue; }
    if(char==='\r'){
      if(source[index+1]!=='\n') throw new EfaCsvValidationError('Alle CR-Zeilenumbrüche müssen als CRLF vorliegen',{code:'malformed',details:[{offset:index}]});
      pushRecord();
      endedWithRecordBreak=true;
      index+=1;
      continue;
    }
    field+=char;
  }
  if(quoted) throw new EfaCsvValidationError('Nicht geschlossenes Anführungszeichen in CSV',{code:'malformed'});
  if(!endedWithRecordBreak||record.length>0||field.length>0||afterQuote) pushRecord();

  const rawHeaders=records.shift();
  if(!rawHeaders||rawHeaders.length===0) throw new EfaCsvValidationError('CSV enthält keine Kopfzeile',{code:'empty'});
  const headers=rawHeaders.map(header=>header.trim());
  const seenHeaders=new Map();
  headers.forEach((header,index)=>{
    if(!validText(header,{max:1_000})) throw new EfaCsvValidationError(`Kopfzeile ${index+1} ist leer oder ungültig`,{code:'header'});
    const key=normalizedHeaderKey(header);
    if(seenHeaders.has(key)){
      throw new EfaCsvValidationError(`Kopfzeile „${header}“ ist nicht eindeutig`,{code:'duplicate-header',details:[{columns:[seenHeaders.get(key)+1,index+1]}]});
    }
    seenHeaders.set(key,index);
  });
  records.forEach((row,index)=>{
    if(row.length!==headers.length){
      throw new EfaCsvValidationError(`Datenzeile ${index+2} hat ${row.length} statt ${headers.length} Spalten`,{code:'columns',details:[{row:index+2,actual:row.length,expected:headers.length}]});
    }
  });
  return deepFreeze({delimiter,headers,rows:records,byteLength});
}

function assertEntityType(entityType){
  if(!ENTITY_TYPES.has(entityType)) throw new EfaCsvValidationError('entityType muss person oder boat sein',{code:'entity-type'});
}

/** Suggestions are hints only. The explicit mapping accepted by previewEfaCsv is separate. */
export function suggestEfaHeaderMapping(headers,{entityType}={}){
  assertEntityType(entityType);
  if(!Array.isArray(headers)||headers.some(header=>typeof header!=='string')) throw new TypeError('headers muss ein Text-Array sein');
  const normalized=headers.map(header=>normalizedHeaderKey(header));
  const suggestions={};
  for(const [role,aliases] of Object.entries(HEADER_ALIASES[entityType])){
    const matches=headers.filter((_header,index)=>aliases.includes(normalized[index]));
    suggestions[role]=matches.length===1?matches[0]:null;
  }
  return deepFreeze(suggestions);
}

function normalizeMapping(mapping,headers,entityType){
  if(!isPlainRecord(mapping)) throw new EfaCsvValidationError('Mapping muss explizit angegeben werden',{code:'mapping'});
  const allowed=entityType==='person'
    ?new Set(['displayName','firstName','lastName','affix','id'])
    :new Set(['name','id']);
  for(const key of Object.keys(mapping)){
    if(!allowed.has(key)) throw new EfaCsvValidationError(`Unbekanntes Mapping-Feld: ${key}`,{code:'mapping'});
    if(typeof mapping[key]!=='string'||!headers.includes(mapping[key])){
      throw new EfaCsvValidationError(`Mapping-Feld ${key} verweist nicht eindeutig auf eine Kopfzeile`,{code:'mapping'});
    }
  }
  if(entityType==='person'){
    const hasDisplay=Object.hasOwn(mapping,'displayName');
    const hasParts=Object.hasOwn(mapping,'firstName')||Object.hasOwn(mapping,'lastName');
    if(hasDisplay===hasParts) throw new EfaCsvValidationError('Personen benötigen entweder displayName oder firstName + lastName',{code:'mapping'});
    if(hasParts&&(!Object.hasOwn(mapping,'firstName')||!Object.hasOwn(mapping,'lastName'))){
      throw new EfaCsvValidationError('firstName und lastName müssen gemeinsam gemappt werden',{code:'mapping'});
    }
    if(hasDisplay&&Object.hasOwn(mapping,'affix')) throw new EfaCsvValidationError('affix ist nur mit firstName + lastName zulässig',{code:'mapping'});
  }else if(!Object.hasOwn(mapping,'name')){
    throw new EfaCsvValidationError('Boote benötigen ein name-Mapping',{code:'mapping'});
  }
  const columns=Object.values(mapping);
  if(new Set(columns).size!==columns.length) throw new EfaCsvValidationError('Eine CSV-Spalte darf nur einer Rolle zugeordnet werden',{code:'mapping'});
  return Object.freeze({...mapping});
}

function candidateErrors(value){
  const errors=[];
  if(!exactFields(value,CANDIDATE_FIELDS,'candidate',errors)) return errors;
  if(value.schemaVersion!==EFA_CANDIDATE_SCHEMA_VERSION) errors.push('candidate.schemaVersion wird nicht unterstützt');
  if(value.kind!==EFA_CANDIDATE_KIND) errors.push('candidate.kind ist ungültig');
  if(!ENTITY_TYPES.has(value.entityType)) errors.push('candidate.entityType ist ungültig');
  if(!validText(value.name)) errors.push('candidate.name ist leer, zu lang oder enthält unsichere Zeichen');
  if(value.externalRef!==null){
    if(exactFields(value.externalRef,['system','scope','id'],'candidate.externalRef',errors)){
      if(value.externalRef.system!=='efa2-csv') errors.push('candidate.externalRef.system muss efa2-csv sein');
      if(!validText(value.externalRef.scope)) errors.push('candidate.externalRef.scope ist ungültig');
      if(!validText(value.externalRef.id)) errors.push('candidate.externalRef.id ist ungültig');
    }
  }
  if(exactFields(value.provenance,PROVENANCE_FIELDS,'candidate.provenance',errors)){
    if(value.provenance.source!=='efa-csv') errors.push('candidate.provenance.source ist ungültig');
    const date=typeof value.provenance.importedAt==='string'?new Date(value.provenance.importedAt):null;
    if(!date||!Number.isFinite(date.getTime())||date.toISOString()!==value.provenance.importedAt) errors.push('candidate.provenance.importedAt ist ungültig');
    if(!HASH_PATTERN.test(value.provenance.fileSha256)) errors.push('candidate.provenance.fileSha256 ist ungültig');
    if(value.provenance.encoding!=='utf-8') errors.push('candidate.provenance.encoding muss utf-8 sein');
    if(!DELIMITERS.has(value.provenance.delimiter)) errors.push('candidate.provenance.delimiter ist ungültig');
    if(!HASH_PATTERN.test(value.provenance.mappingFingerprint)) errors.push('candidate.provenance.mappingFingerprint ist ungültig');
    if(value.provenance.efaVersion!=='unknown') errors.push('candidate.provenance.efaVersion muss ohne belegte Exportversion unknown bleiben');
  }
  if(value.status!=='incomplete') errors.push('candidate.status muss incomplete sein');
  return errors;
}

/** Strict exact-field validator for persistent staging candidates. */
export function validateEfaCandidate(value){
  const errors=Object.freeze(candidateErrors(value));
  return Object.freeze({ok:errors.length===0,value:errors.length===0?value:null,errors});
}

function rowValue(row,headers,column){
  return row[headers.indexOf(column)].trim();
}

function nameFromRow(row,headers,mapping,entityType){
  if(entityType==='boat') return rowValue(row,headers,mapping.name);
  if(mapping.displayName) return rowValue(row,headers,mapping.displayName);
  const firstName=rowValue(row,headers,mapping.firstName);
  const lastName=rowValue(row,headers,mapping.lastName);
  if(!firstName||!lastName) return '';
  const parts=[
    firstName,
    mapping.affix?rowValue(row,headers,mapping.affix):'',
    lastName,
  ].filter(Boolean);
  return parts.join(' ');
}

function refKey(ref){
  return ref===null?null:canonicalJson(ref);
}

function comparableCandidate(candidate){
  return {
    entityType:candidate.entityType,
    name:candidate.name,
    externalRef:candidate.externalRef,
    status:candidate.status,
  };
}

function normalizedName(name){
  return name.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('de-DE');
}

function classifyCandidate(candidate,pool){
  const key=refKey(candidate.externalRef);
  const sameRef=key===null?[]:pool.filter(existing=>refKey(existing.externalRef)===key);
  if(sameRef.some(existing=>canonicalJson(comparableCandidate(existing))!==canonicalJson(comparableCandidate(candidate)))) return 'idConflict';
  if(sameRef.some(existing=>canonicalJson(comparableCandidate(existing))===canonicalJson(comparableCandidate(candidate)))) return 'exactDuplicate';
  if(pool.some(existing=>existing.entityType===candidate.entityType&&normalizedName(existing.name)===normalizedName(candidate.name))) return 'nameReview';
  return 'new';
}

function candidateFromRow({row,headers,mapping,entityType,scope,provenance}){
  const name=nameFromRow(row,headers,mapping,entityType);
  const externalId=mapping.id?rowValue(row,headers,mapping.id):'';
  const candidate={
    schemaVersion:EFA_CANDIDATE_SCHEMA_VERSION,
    kind:EFA_CANDIDATE_KIND,
    entityType,
    name,
    externalRef:externalId?{system:'efa2-csv',scope,id:externalId}:null,
    provenance:{...provenance},
    status:'incomplete',
  };
  return deepFreeze(candidate);
}

/**
 * Parse and classify a one-time CSV import without persistence. Relationship
 * classification and readiness are intentionally orthogonal: every valid row is
 * also `incomplete`, while its relationship is new/duplicate/review/conflict.
 */
export async function previewEfaCsv({
  text,
  delimiter,
  entityType,
  mapping,
  scope=null,
  existingCandidates=[],
  clock=()=>new Date(),
  digest,
  limits,
}={}){
  assertEntityType(entityType);
  const parsed=parseEfaCsv(text,{delimiter,limits});
  const normalizedMapping=normalizeMapping(mapping,parsed.headers,entityType);
  const mapsExternalId=Object.hasOwn(normalizedMapping,'id');
  if(mapsExternalId&&!validText(scope)){
    throw new EfaCsvValidationError('Ein ID-Mapping benötigt einen expliziten, sicheren eFa-Scope',{code:'scope'});
  }
  if(!mapsExternalId&&scope!==null){
    throw new EfaCsvValidationError('Ein Scope ist nur zusammen mit einem expliziten ID-Mapping zulässig',{code:'scope'});
  }
  if(!Array.isArray(existingCandidates)) throw new TypeError('existingCandidates muss ein Array sein');
  for(const [index,candidate] of existingCandidates.entries()){
    const validation=validateEfaCandidate(candidate);
    if(!validation.ok) throw new EfaCsvValidationError(`Bestehender Kandidat ${index+1} ist ungültig`,{code:'existing-candidate',details:validation.errors});
  }

  const importedAt=timestamp(clock);
  const fileSha256=await sha256(text,digest);
  const mappingContract={entityType,delimiter,mapping:normalizedMapping,scope:mapsExternalId?scope:null};
  const mappingFingerprint=await sha256(canonicalJson(mappingContract),digest);
  const provenance=Object.freeze({
    source:'efa-csv',
    importedAt,
    fileSha256,
    encoding:'utf-8',
    delimiter,
    mappingFingerprint,
    efaVersion:'unknown',
  });

  const pool=[...existingCandidates];
  const counts={new:0,exactDuplicate:0,nameReview:0,idConflict:0,invalid:0,incomplete:0};
  const items=parsed.rows.map((row,index)=>{
    const candidate=candidateFromRow({row,headers:parsed.headers,mapping:normalizedMapping,entityType,scope,provenance});
    const validation=validateEfaCandidate(candidate);
    if(!validation.ok){
      counts.invalid+=1;
      return deepFreeze({rowNumber:index+2,classification:'invalid',classifications:['invalid'],candidate:null,errors:[...validation.errors]});
    }
    const classification=classifyCandidate(candidate,pool);
    counts[classification]+=1;
    counts.incomplete+=1;
    pool.push(candidate);
    return deepFreeze({rowNumber:index+2,classification,classifications:[classification,'incomplete'],candidate,errors:[]});
  });

  const baseFingerprint=await sha256(canonicalJson(existingCandidates.map(comparableCandidate)),digest);
  const planFingerprint=await sha256(canonicalJson({
    fileSha256,
    mappingFingerprint,
    baseFingerprint,
    rows:items.map(item=>({classification:item.classification,candidate:item.candidate&&comparableCandidate(item.candidate)})),
  }),digest);
  return deepFreeze({
    schemaVersion:1,
    kind:'efaCsvPreview',
    entityType,
    delimiter,
    headers:[...parsed.headers],
    mapping:{...normalizedMapping},
    scope:mapsExternalId?scope:null,
    fileSha256,
    mappingFingerprint,
    baseFingerprint,
    planFingerprint,
    importedAt,
    counts,
    items,
  });
}
