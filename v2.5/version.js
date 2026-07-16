(() => {
  'use strict';
  const appVersion = '0.9.0-beta.1';
  const buildDate = '2026-07-16';
  const shellRevision = 'sha256-1f28bf1a5d5a322a26dd19b5efdc3aff0addd97bdc29e48d0f5629732cbb0d96';
  const buildId = `shell-${shellRevision.slice(7, 23)}`;
  const release = Object.freeze({
    appVersion, buildDate, shellRevision, buildId,
    label: `Rudertrimm V2 · ${appVersion} · Build ${buildDate} · ${buildId}`,
  });
  globalThis.RUDERTRIMM_RELEASE = release;

  if(typeof document!=='undefined'){
    const root=document.documentElement;
    root.dataset.rudertrimmBoot='release-loaded';
    const buildState=document.getElementById('buildState');
    if(buildState) buildState.textContent=release.label;
    globalThis.setTimeout?.(()=>{
      if(root.dataset.rudertrimmBoot==='ready'||root.dataset.rudertrimmBoot==='failed') return;
      root.dataset.rudertrimmBoot='failed';
      if(buildState) buildState.textContent=`Startfehler · ${release.appVersion}`;
      const status=document.getElementById('errorStatus');
      if(status){
        status.hidden=false;
        status.dataset.bootFallback='true';
        status.textContent='Die App-Logik wurde nicht geladen. Bitte den entpackten App-Ordner vollständig zusammenlassen und erneut öffnen.';
      }
    },4000);
  }
})();
