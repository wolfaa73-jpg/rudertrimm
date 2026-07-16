/**
 * Deterministic action ranking over diagnostics already calculated by the app.
 * This module deliberately contains no geometry, DOM, storage, or auto-adjustment:
 * it turns the existing target/actual evidence into an explainable next step.
 */

const finite=value=>typeof value==='number'&&Number.isFinite(value);
const outside=(value,min,max)=>value<min?min-value:value>max?value-max:0;

function freezePlan(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    Object.freeze(value);
    for(const child of Object.values(value)) freezePlan(child);
  }
  return value;
}

function completeSeat(seat){
  return seat&&typeof seat==='object'
    &&typeof seat.seatId==='string'&&seat.seatId.length>0
    &&Number.isSafeInteger(seat.position)&&seat.position>0
    &&['skull','riemen'].includes(seat.rig)
    &&typeof seat.naturalResolved==='boolean'&&typeof seat.reachable==='boolean'&&typeof seat.trackLimited==='boolean'
    &&['IH','IHsoll','anlage','stemmX','knee90','roll90'].every(key=>finite(seat[key]));
}

function seatScope(seat){
  return Object.freeze({
    type:'seat',seatId:seat.seatId,position:seat.position,
    label:String(seat.label||`Platz ${seat.position}`),
    rowerName:String(seat.rowerName||'Profil'),
  });
}

/**
 * @param {{seats:Array, referenceSeatId?:string|null, totalSeatCount?:number, maxActions?:number}} input
 * @returns {{status:string, summary:string, actions:Array, evaluatedSeats:number, unavailableSeats:number}}
 */
export function buildTrimActionPlan({seats,referenceSeatId=null,totalSeatCount=seats?.length??0,maxActions=3}={}){
  if(!Array.isArray(seats)) throw new TypeError('seats must be an array');
  if(!Number.isSafeInteger(totalSeatCount)||totalSeatCount<seats.length) throw new RangeError('totalSeatCount must include every diagnostic seat');
  if(!Number.isSafeInteger(maxActions)||maxActions<1||maxActions>10) throw new RangeError('maxActions must be in [1, 10]');

  const valid=seats.filter(completeSeat);
  const unavailable=seats.length-valid.length;
  if(valid.length===0){
    return freezePlan({
      status:'missing',
      summary:'Für eine Empfehlung fehlt mindestens ein vollständiges Rudererprofil mit gültigen Mess- und Trimmwerten.',
      actions:[],evaluatedSeats:0,unavailableSeats:totalSeatCount,
    });
  }

  // Product priority is safety → crew pitch consistency → inboard → footstretcher.
  // score sorts only inside one priority level; maxActions limits the result last.
  const candidates=[];
  const safetySeats=new Set();
  for(const seat of valid){
    const issues=[];
    if(!seat.naturalResolved) issues.push('Natural-Catch-Gleichung ohne Lösung');
    if(!seat.reachable) issues.push('Griffziele im 3D-Prüfmodell nicht erreichbar');
    if(seat.trackLimited) issues.push('vorläufige Sitz-/Rollbahngrenze berührt');
    if(issues.length){
      safetySeats.add(seat.seatId);
      candidates.push({
        id:`safety:${seat.seatId}`,priority:0,score:issues.length,severity:'change',
        scope:seatScope(seat),field:'stemmX',parameter:'Stemmbrettposition (Fa)',
        current:{value:seat.stemmX,unit:'cm'},target:{text:'Messdaten und Bewegungsgrenzen zuerst plausibilisieren'},
        direction:'zuerst prüfen, nicht blind verstellen',
        reason:issues.join(' · '),
        effect:'Verhindert eine Empfehlung auf Basis einer geometrisch nicht belastbaren Pose.',
        uncertainty:'Körperkinematik und Reichweite sind unkalibrierte Prüfmodelle; Trainer- und Messfreigabe offen.',
      });
    }
  }

  if(valid.length>1){
    const min=Math.min(...valid.map(seat=>seat.anlage));
    const max=Math.max(...valid.map(seat=>seat.anlage));
    if(max-min>1e-9){
      const reference=valid.find(seat=>seat.seatId===referenceSeatId)??valid.slice().sort((a,b)=>b.position-a.position)[0];
      // Die Maßnahme gilt der Crew, aber „Zum Wert“ muss einen tatsächlich abweichenden
      // Platz öffnen. Größte Abweichung zur Referenz zuerst; Position/ID lösen Gleichstände
      // reproduzierbar, ohne die crewweite Bedeutung auf einen Sitz zu verkürzen.
      const focusSeat=valid.slice().sort((left,right)=>
        Math.abs(right.anlage-reference.anlage)-Math.abs(left.anlage-reference.anlage)
        ||left.position-right.position||left.seatId.localeCompare(right.seatId))[0];
      candidates.push({
        id:'crew:anlage',priority:1,score:max-min,severity:'change',
        scope:Object.freeze({type:'crew',seatId:null,position:null,label:'Ganzes Boot',rowerName:null}),
        focusSeatId:focusSeat.seatId,
        field:'anlage',parameter:'Dollen-Neigung (Anlage)',
        current:{min,max,unit:'°'},target:{value:reference.anlage,unit:'°',text:`gemeinsamer Prüfwert der Referenz ${reference.label||`Platz ${reference.position}`}`},
        direction:'abweichende Plätze auf einen gemeinsam bestätigten Wert abstimmen',
        reason:'Die Anlage ist platzbezogen gespeichert, soll innerhalb der Mannschaft aber gleich eingestellt sein.',
        effect:'Reduziert einen vermeidbaren Rigg-Unterschied zwischen den belegten Plätzen.',
        uncertainty:'Der gemeinsame Wert bleibt bis Trainer-/Messfreigabe ein Prüfwert; die App gleicht nichts automatisch an.',
      });
    }
  }

  for(const seat of valid){
    // Erst belastbare Pose herstellen; Zielkorridor-Feinwerte desselben Sitzes
    // würden bis dahin nur eine widersprüchliche Scheingenauigkeit erzeugen.
    if(safetySeats.has(seat.seatId)) continue;
    const delta=seat.IHsoll-seat.IH;
    if(Math.abs(delta)>1){
      candidates.push({
        id:`inboard:${seat.seatId}`,priority:2,score:Math.abs(delta),severity:Math.abs(delta)>2?'change':'check',
        scope:seatScope(seat),field:'IH',parameter:'Innenhebel IH',
        current:{value:seat.IH,unit:'cm'},target:{min:seat.IHsoll-1,max:seat.IHsoll+1,unit:'cm'},
        direction:delta>0?'Innenhebel erhöhen':'Innenhebel verringern',
        reason:`Die vorhandene ${seat.rig==='skull'?'Skull-Formel DA/2 + 8':'Riemen-Formel DA + 30'} ergibt ${seat.IHsoll} cm.`,
        effect:'Nähert das Hebelverhältnis dem ausgewiesenen Rigg-Zielkorridor.',
        uncertainty:'Modellvorschlag; Materialgrenzen prüfen und anschließend auf dem Wasser sowie mit Trainer gegenprüfen.',
      });
    }

    const kneeDistance=outside(seat.knee90,160,170);
    const rollDistance=outside(seat.roll90,70,80);
    if(kneeDistance>0||rollDistance>0){
      candidates.push({
        id:`footstretcher:${seat.seatId}`,priority:3,score:kneeDistance/6+rollDistance/5,
        severity:kneeDistance>6||rollDistance>5?'change':'check',scope:seatScope(seat),
        field:'stemmX',parameter:'Stemmbrettposition (Fa)',current:{value:seat.stemmX,unit:'cm'},
        target:{text:'bei 90° gleichzeitig Knie 160–170° und genutzter Rollweg 70–80 %'},
        direction:'Fa in kleinen Schritten verändern und beide Prüfwerte erneut kontrollieren',
        reason:`Ist bei 90°: Knie ${seat.knee90}° · Rollweg ${seat.roll90} %.`,
        effect:'Nähert Knie- und Rollweg-Prüfwert gemeinsam dem ausgewiesenen Korridor.',
        uncertainty:'Unkalibriertes 90°-Körpermodell; keine automatische Korrektur und keine Trainerfreigabe.',
      });
    }
  }

  candidates.sort((left,right)=>left.priority-right.priority||right.score-left.score
    ||(left.scope.position??0)-(right.scope.position??0)||left.id.localeCompare(right.id));
  const actions=candidates.slice(0,maxActions).map(({score,...action})=>action);
  const status=actions.some(action=>action.severity==='change')?'change':actions.length?'check':'ok';
  const free=Math.max(0,totalSeatCount-valid.length-unavailable);
  const summary=status==='ok'
    ?`Kein akuter Handlungsbedarf aus den geprüften Regeln für ${valid.length} ${valid.length===1?'belegten Platz':'belegte Plätze'}.`
    :status==='change'
      ?`${actions.length} priorisierte${actions.length===1?' Maßnahme':' Maßnahmen'} – zuerst bewusst prüfen, dann manuell ändern.`
      :`${actions.length} Prüfpunkt${actions.length===1?'':'e'} vor einer Änderung.`;
  return freezePlan({status,summary,actions,evaluatedSeats:valid.length,unavailableSeats:unavailable,freeSeats:free});
}
