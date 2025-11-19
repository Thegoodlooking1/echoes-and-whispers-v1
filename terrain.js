// terrain.js
import * as THREE from "three";

// --- helpers ---
function safe(v, d=0) { return (v===undefined || isNaN(v)) ? d : v; }
function sum(obj) { return Object.values(obj||{}).reduce((a,b)=>a+Number(b||0),0); }

// Normalize simple stats from your JSON (works even if some sections are missing)
export function analyzeLanguage(langJson){
  const freqC = langJson?.freq?.C || {};
  const freqV = langJson?.freq?.V || {};
  const freqN = langJson?.freq?.N || {};
  const total = sum(freqC)+sum(freqV)+sum(freqN) || 1;

  const pc = (sum(freqC)/total); // consonant mass
  const pv = (sum(freqV)/total); // vowel mass
  const pn = (sum(freqN)/total); // nasal mass

  const big = langJson?.bigrams || {};
  const cv = safe(big["C->V"], .5);
  const cc = safe(big["C->C"], .1);
  const vv = safe(big["V->V"], .1);

  // high-level “traits” 0..1
  return {
    name: langJson?.name || "Unknown",
    consonance: THREE.MathUtils.clamp(pc, 0, 1),
    vocality:   THREE.MathUtils.clamp(pv, 0, 1),
    nasality:   THREE.MathUtils.clamp(pn, 0, 1),
    clusteriness: THREE.MathUtils.clamp(cc, 0, 1),  // C->C
    vowelRun:     THREE.MathUtils.clamp(vv, 0, 1),  // V->V
    cvBias:       THREE.MathUtils.clamp(cv, 0, 1)   // C->V
  };
}

// Height function: combines smooth hills + ridges influenced by traits & drift
function heightAt(i, j, res, traits, drift){
  const x = i/res, y = j/res;

  // base hills (vocality -> smoother / higher plateaus)
  const base = (0.35 + 0.4*traits.vocality) * (
    Math.sin(2.1*x + 0.6*drift) * Math.cos(2.0*y - 0.5*drift)
  );

  // consonant cluster ridges (more spiky with clusteriness & drift)
  const ridges = (0.25 + 0.6*traits.clusteriness) * (
    Math.sin(8.0*x + 1.2*drift) * Math.sin(7.5*y - 0.9*drift)
  );

  // nasal basins (lower areas depending on nasality)
  const basins = - (0.18 + 0.25*traits.nasality) * (
    Math.cos(3.0*x - 0.4*drift) * Math.cos(3.8*y + 0.3*drift)
  );

  // small detail tied to cvBias (more C→V = more ripple)
  const ripple = 0.08 * traits.cvBias * Math.sin(20*x + 17*y + 1.7*drift);

  // combine
  let h = base + ridges + basins + ripple;
  // normalize to ~[-1, 1]
  h = THREE.MathUtils.clamp(h, -1.2, 1.2);
  return h;
}

// color based on local slope + traits
function colorAt(h, nx, ny, traits){
  // steepness
  const slope = Math.sqrt(nx*nx + ny*ny); // 0..big
  const tSlope = THREE.MathUtils.clamp(slope * 0.8, 0, 1);

  // hue drift towards warm with vocality, cool with consonance
  const hue = THREE.MathUtils.clamp(0.66*(1-traits.vocality) + 0.06*traits.consonance, 0, 0.75);
  const sat = 0.5 + 0.3*traits.clusteriness;
  const light = 0.50 + 0.15*traits.vocality - 0.10*tSlope + 0.08*traits.nasality;

  const c = new THREE.Color();
  c.setHSL(hue, sat, THREE.MathUtils.clamp(light, 0.25, 0.85));
  return c;
}

// Build a displaced plane mesh (width x height in world units)
export function buildTerrainMesh(traits, {width=3.5, height=3.5, res=64, drift=0.5} = {}){
  const geo = new THREE.PlaneGeometry(width, height, res, res);
  geo.rotateX(-Math.PI/2); // lie flat on XZ
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);

  // compute height & simple normals
  const H = new Float32Array((res+1)*(res+1));
  const idx = (i,j)=> i + (res+1)*j;

  for (let j=0;j<=res;j++){
    for (let i=0;i<=res;i++){
      H[idx(i,j)] = heightAt(i,j,res,traits,drift);
    }
  }
  // set vertices + simple gradient normals for color
  for (let j=0;j<=res;j++){
    for (let i=0;i<=res;i++){
      const k = idx(i,j);
      const y = H[k];
      const vx = i/(res), vy = j/(res);

      const kx1 = idx(Math.min(i+1,res), j), kx0 = idx(Math.max(i-1,0), j);
      const ky1 = idx(i, Math.min(j+1,res)), ky0 = idx(i, Math.max(j-1,0));

      const nx = (H[kx1] - H[kx0]) * 0.5;
      const ny = (H[ky1] - H[ky0]) * 0.5;

      const pIndex = 3*(i + (res+1)*j);
      pos.setY(i + (res+1)*j, y); // displacement
      const c = colorAt(y, nx, ny, traits);
      col[pIndex+0] = c.r; col[pIndex+1] = c.g; col[pIndex+2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.0,
    transparent: true,
    opacity: 0.95
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.isLanguageTerrain = true;
  return mesh;
}
