/* ============================================================================
   ONPE · captura v2 — Segunda Vuelta Presidencial 2026
   Votos por candidato a todo nivel geográfico (nacional, región, provincia,
   distrito · continente, país, ciudad) + cobertura de actas.
   ----------------------------------------------------------------------------
   USO: abre https://resultadosegundavuelta.onpe.gob.pe/main/resumen
        F12 -> Consola -> pega TODO esto -> Enter.
   Helpers:
     ONPE.snap()        captura + descarga (corre solo al pegar)
     ONPE.exportSerie() descarga toda la serie acumulada en un archivo
     ONPE.serie() / ONPE.clear()
   Profundidad: cambia DEPTH abajo. 'departamento' | 'provincia' | 'distrito'.
   ========================================================================== */
(() => {
  const DEPTH = 'distrito';           // máximo detalle: región/provincia/distrito + continente/país/ciudad
  const CONCURRENCY = 8;
  const FALLBACK_ID = 10;
  const BASE = location.origin + '/presentacion-backend';
  const SERIE_KEY = 'onpe_serie_v2';
  const LV = { departamento: 1, provincia: 2, distrito: 3 }[DEPTH] || 2;

  const qs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  async function get(path, params) {
    const url = BASE + path + (params ? '?' + qs(params) : '');
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    const t = await r.text();
    if (!t) return { __status: r.status, __empty: true };
    try { const o = JSON.parse(t); return ('data' in o) ? o.data : o; }
    catch { return { __status: r.status, __nonjson: t.slice(0, 80) }; }
  }
  const pad6 = (c) => String(c).padStart(6, '0');
  const num = (...vs) => { for (const v of vs) { if (v == null) continue;
    const n = typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : v;
    if (typeof n === 'number' && !Number.isNaN(n)) return n; } return null; };

  function normCand(c) {
    const agr = c.nombreAgrupacionPolitica ?? c.agrupacion ?? '';
    const nombre = (c.nombreCandidato || c.nombre || agr || '?');
    return { nombre, agrupacion: agr,
      votos: num(c.totalVotosValidos, c.votos, c.totalVotosEmitidos),
      pct: num(c.porcentajeVotosValidos, c.porcentaje),
      especial: /blanco|nulo|viciad/i.test(nombre + ' ' + agr) };
  }
  const nodeCode = (n) => String(n.idUbigeo ?? n.ubigeo ?? n.codigo ?? n.codigoUbigeo ?? n.id ?? '');
  const nodeName = (n) => n.nombre ?? n.descripcion ?? n.nombreUbigeo ?? n.nombreDepartamento ?? n.nombreProvincia ?? n.nombreDistrito ?? n.nombrePais ?? n.nombreContinente ?? n.nombreCiudad ?? '';

  let ID = FALLBACK_ID;
  const ubiList = (path, ambito, extra) => get('/ubigeos/' + path, { idEleccion: ID, idAmbitoGeografico: ambito, ...(extra || {}) });
  const votos = (ambito, niveles) => get('/eleccion-presidencial/participantes-ubicacion-geografica-nombre',
    { idEleccion: ID, tipoFiltro: 'ubigeo_nivel_0' + niveles.length, idAmbitoGeografico: ambito,
      ubigeoNivel1: niveles[0], ubigeoNivel2: niveles[1], ubigeoNivel3: niveles[2] });
  const votosAmbito = (tipoFiltro, ambito) => get('/eleccion-presidencial/participantes-ubicacion-geografica-nombre',
    { idEleccion: ID, tipoFiltro, idAmbitoGeografico: ambito });
  const totalesAmbito = (tipoFiltro, ambito) => get('/resumen-general/totales', { idEleccion: ID, tipoFiltro, idAmbitoGeografico: ambito });

  async function pool(items, n, fn) {
    const out = []; let i = 0;
    await Promise.all(Array.from({ length: n }, async () => {
      while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
    }));
    return out;
  }

  async function preflight() {
    const deps = await ubiList('departamentos', 1);
    if (!Array.isArray(deps) || !deps.length) return { ok: false, why: 'departamentos no es lista', raw: deps };
    const d0 = deps[0], code0 = nodeCode(d0), name0 = nodeName(d0);
    const provs = await ubiList('provincias', 1, { idUbigeoDepartamento: code0 });
    const cand = await votos(1, [code0]);
    const cc = Array.isArray(cand) ? cand.map(normCand).filter(c => !c.especial) : [];
    const okName = !!name0 && !!code0;
    const okVotos = cc.length >= 1 && cc.some(c => c.votos != null);
    return { ok: okName && okVotos, okName, okVotos,
      muestra: { dep_code: code0, dep_name: name0, provincias_es_lista: Array.isArray(provs), prov_0: Array.isArray(provs) ? provs[0] : provs,
        candidatos_muestra: cc.slice(0, 2), candidatos_raw0: Array.isArray(cand) ? cand[0] : cand } };
  }

  async function walkAmbito(ambito) {
    const out = [];
    const deps = await ubiList('departamentos', ambito);
    if (!Array.isArray(deps)) return out;
    await pool(deps, CONCURRENCY, async (d) => {
      const code = nodeCode(d);
      const cand = await votos(ambito, [code]);
      out.push({ code, level: 'dep', ambito, nombre: nodeName(d), parent: null,
        candidatos: (Array.isArray(cand) ? cand.map(normCand) : []) });
      if (LV >= 2) {
        const provs = await ubiList('provincias', ambito, { idUbigeoDepartamento: code });
        if (Array.isArray(provs)) {
          await pool(provs, CONCURRENCY, async (p) => {
            const pc = nodeCode(p);
            const cp = await votos(ambito, [code, pc]);
            out.push({ code: pc, level: 'prov', ambito, nombre: nodeName(p), parent: code,
              candidatos: (Array.isArray(cp) ? cp.map(normCand) : []) });
            if (LV >= 3) {
              const dists = await ubiList('distritos', ambito, { idUbigeoProvincia: pc });
              if (Array.isArray(dists)) {
                await pool(dists, CONCURRENCY, async (di) => {
                  const dc = nodeCode(di);
                  const cd = await votos(ambito, [code, pc, dc]);
                  out.push({ code: dc, level: 'dist', ambito, nombre: nodeName(di), parent: pc,
                    candidatos: (Array.isArray(cd) ? cd.map(normCand) : []) });
                });
              }
            }
          });
        }
      }
    });
    return out;
  }

  function mergeCoverage(regiones, heatProv, heatDist) {
    const cov = {};
    (Array.isArray(heatProv) ? heatProv : []).forEach(h => { cov[pad6(h.ubigeoNivel02)] = h; });
    (Array.isArray(heatDist) ? heatDist : []).forEach(h => { cov[pad6(h.ubigeoNivel03)] = h; });
    regiones.forEach(r => { const h = cov[pad6(r.code)]; if (h) { r.pctActas = num(h.porcentajeActasContabilizadas); r.contActas = num(h.actasContabilizadas); } });
  }

  function download(name, obj) {
    const b = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

  function pushSerie(snap) {
    let s = []; try { s = JSON.parse(localStorage.getItem(SERIE_KEY) || '[]'); } catch {}
    const key = x => x.capturedAt.slice(0, 16);
    s = s.filter(x => key(x) !== key(snap));
    s.push({ schemaVersion: 2, type: 'snapshot', capturedAt: snap.capturedAt, idEleccion: snap.idEleccion,
      nacional: snap.nacional, peru: snap.peru, exterior: snap.exterior, heatDepartamentos: snap.heatProvincias });
    s.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    try { localStorage.setItem(SERIE_KEY, JSON.stringify(s)); } catch (e) { console.warn('serie no guardada', e); }
    return s.length;
  }

  async function build() {
    ID = (await get('/proceso/proceso-electoral-activo')).idEleccionPrincipal || FALLBACK_ID;
    console.log('%cPreflight…', 'color:#5a7a3a');
    const pf = await preflight();
    if (!pf.ok) {
      console.error('Preflight FALLÓ. No lanzo la captura completa. Mándame esto:');
      console.log(JSON.stringify(pf, null, 2));
      try { await navigator.clipboard.writeText(JSON.stringify(pf)); console.log('(copiado al portapapeles)'); } catch {}
      return null;
    }
    console.log('%cPreflight OK. Capturando hasta ' + DEPTH + '…', 'color:#5a7a3a');

    const [nacC, nacT, peruC, peruT, extC, extT, hProv, hDist] = await Promise.all([
      get('/eleccion-presidencial/participantes-ubicacion-geografica-nombre', { idEleccion: ID, tipoFiltro: 'eleccion' }),
      get('/resumen-general/totales', { idEleccion: ID, tipoFiltro: 'eleccion' }),
      votosAmbito('ambito_geografico', 1), totalesAmbito('ambito_geografico', 1),
      votosAmbito('ambito_geografico', 2), totalesAmbito('ambito_geografico', 2),
      get('/resumen-general/mapa-calor', { idEleccion: ID, tipoFiltro: 'ubigeo_nivel_01' }),
      LV >= 3 ? get('/resumen-general/mapa-calor', { idEleccion: ID, tipoFiltro: 'ubigeo_nivel_02' }) : null,
    ]);

    const reg1 = await walkAmbito(1);
    const reg2 = await walkAmbito(2);
    const regiones = reg1.concat(reg2);
    mergeCoverage(regiones, hProv, hDist);

    const snap = { schemaVersion: 2, type: 'snapshot', capturedAt: new Date().toISOString(), idEleccion: ID, depth: DEPTH,
      nacional: { totales: nacT, candidatos: nacC }, peru: { totales: peruT, candidatos: peruC }, exterior: { totales: extT, candidatos: extC },
      heatProvincias: hProv, heatDistritos: hDist, regiones };
    console.log(`%cListo: ${regiones.length} regiones (${reg1.length} Perú · ${reg2.length} exterior)`, 'color:#5a7a3a;font-weight:bold');
    return snap;
  }

  const ONPE = {
    async snap() {
      const s = await build(); if (!s) return;
      pushSerie(s);
      download(`onpe_${stamp()}.json`, s);
      console.log('Descargado. Súbelo a snapshots/ y commit.');
      return s;
    },
    serie() { try { return JSON.parse(localStorage.getItem(SERIE_KEY) || '[]'); } catch { return []; } },
    exportSerie() { const s = this.serie(); download(`onpe_serie_${stamp()}.json`, { schemaVersion: 2, type: 'serie', exportedAt: new Date().toISOString(), idEleccion: s[0]?.idEleccion ?? FALLBACK_ID, serie: s }); console.log('serie:', s.length, 'cortes'); },
    clear() { localStorage.removeItem(SERIE_KEY); console.log('serie borrada'); },
  };
  window.ONPE = ONPE;
  console.log('%cONPE v2 listo (profundidad: ' + DEPTH + '). Capturando…', 'color:#5a7a3a;font-weight:bold');
  ONPE.snap();
})();
