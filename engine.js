// --- Phoneme inventory (toy)
export const PHONEMES = [
  {sym:'p', cls:'C'}, {sym:'t', cls:'C'}, {sym:'k', cls:'C'}, {sym:'s', cls:'C'},
  {sym:'m', cls:'N'}, {sym:'n', cls:'N'},
  {sym:'a', cls:'V'}, {sym:'i', cls:'V'}, {sym:'u', cls:'V'}
];
export const CLASS_OF = Object.fromEntries(PHONEMES.map(x=>[x.sym,x.cls]).concat([['#','#']]));

// --- DFA over classes (CV/CVC with word boundary #)
const DFA = {
  START:'START', ACCEPT:new Set(['NUCLEUS','CODA','SEP']),
  T:{
    START:   { C:'ONSET', V:'NUCLEUS' },
    ONSET:   { V:'NUCLEUS' },
    NUCLEUS: { C:'CODA', N:'CODA', '#':'SEP', C_to_ONSET:'ONSET' },
    CODA:    { '#':'SEP', C:'ONSET' },
    SEP:     { C:'ONSET', V:'NUCLEUS' }
  }
};
export function dfaAllows(state, clsOrHash) {
  const row = DFA.T[state] || {};
  if (clsOrHash==='C' && row['C_to_ONSET']) return true; // pseudo edge means syllable break then ONSET
  return Boolean(row[clsOrHash]);
}
export function dfaNext(state, clsOrHash) {
  const row = DFA.T[state] || {};
  if (clsOrHash==='C' && row['C_to_ONSET']) return 'ONSET';
  return row[clsOrHash] || state;
}

// --- Two anchor Markov matrices (rows -> next symbol probs)
export const P_PRESENT = {
  '#': {p:.34,t:.33,k:.2,s:.13},
  p:  {a:.35,i:.2,u:.15,r:.1,l:.1,'#':.1},
  t:  {a:.35,i:.25,u:.1, r:.1,l:.1,'#':.1},
  k:  {a:.4, i:.15,u:.15,r:.1,l:.1,'#':.1},
  s:  {a:.25,i:.25,u:.15,r:.15,l:.1,'#':.1},
  m:  {'#':.5,a:.25,i:.15,u:.1},
  n:  {'#':.5,a:.25,i:.15,u:.1},
  a:  {m:.15,n:.15,p:.2,t:.15,k:.15,s:.1,'#':.1},
  i:  {m:.15,n:.15,p:.1,t:.2, k:.1, s:.2,'#':.1},
  u:  {m:.15,n:.15,p:.2,t:.1, k:.2, s:.1,'#':.1}
};
export const P_PAST = {
  '#': {p:.38,t:.38,k:.14,s:.10},
  p:  {a:.45,i:.2,u:.2,'#':.15},
  t:  {a:.45,i:.25,'#':.3},
  k:  {a:.5, i:.2, '#':.3},
  s:  {a:.35,i:.3, '#':.35},
  m:  {'#':.65,a:.2,i:.15},
  n:  {'#':.65,a:.2,i:.15},
  a:  {p:.2,t:.2,k:.2,s:.2,'#':.2},
  i:  {p:.15,t:.25,k:.15,s:.25,'#':.2},
  u:  {p:.25,t:.15,k:.25,s:.15,'#':.2}
};

// --- Log-space interpolation: P(t) = softmax((1-α)logP0 + α logP1)
function interpRowLogSoftmax(rowA={}, rowB={}, alpha){
  const keys = new Set([...Object.keys(rowA), ...Object.keys(rowB)]);
  const tmp = [];
  for (const k of keys){
    const a = Math.max(rowA[k]||1e-9, 1e-9);
    const b = Math.max(rowB[k]||1e-9, 1e-9);
    tmp.push([k, (1-alpha)*Math.log(a) + alpha*Math.log(b)]);
  }
  const max = Math.max(...tmp.map(([,v])=>v));
  const exps = tmp.map(([k,v])=>[k, Math.exp(v-max)]);
  const Z = exps.reduce((s,[,e])=>s+e,0) || 1;
  const out = {};
  exps.forEach(([k,e])=> out[k]=e/Z);
  return out;
}
export function buildP(alpha){ // alpha=0 → present, 1 → past
  const keys = new Set([...Object.keys(P_PRESENT),...Object.keys(P_PAST)]);
  const P = {};
  keys.forEach(k=> P[k] = interpRowLogSoftmax(P_PRESENT[k]||{}, P_PAST[k]||{}, alpha));
  return P;
}

// --- Product-automaton constrained sampler
function sampleWeighted(obj){
  const r = Math.random();
  let acc = 0;
  for (const [k,p] of Object.entries(obj)){ acc += p; if (r <= acc) return k; }
  // fallback
  return Object.keys(obj)[0];
}
export function generateWord(P, maxSyllables=3){
  let state = 'START', last = '#', out = [];
  let syllables = 0;
  while (syllables < maxSyllables){
    // legal next symbols by DFA class allowance
    const candidates = {};
    for (const [sym, prob] of Object.entries(P[last] || {})){
      const cls = CLASS_OF[sym] || '#';
      if (!dfaAllows(state, cls)) continue;
      candidates[sym] = (candidates[sym]||0) + prob;
    }
    if (!Object.keys(candidates).length) break;
    const next = sampleWeighted(candidates);
    out.push(next);
    const cls = CLASS_OF[next] || '#';
    state = dfaNext(state, cls);
    if (cls==='#' || state==='SEP'){ syllables++; state='SEP'; last='#'; continue; }
    last = next;
  }
  // strip boundary markers in middle, keep for word breaks if needed
  return out.filter(x=>x!=='#').join('');
}

export function generateSequence(alpha, words=10){
  const P = buildP(alpha);
  const seq = [];
  for (let i=0;i<words;i++) seq.push(generateWord(P, 2 + Math.floor(Math.random()*2)));
  return seq;
}

// === Traced generator: returns words + per-step effective probs & surprise ===
// Effective prob = Markov prob renormalized after DFA legality filtering
export function generateSequenceTrace(alpha, words = 8) {
  const P = buildP(alpha);
  const out = [];
  for (let w = 0; w < words; w++) {
    const { letters, edges } = generateWordWithTrace(P, 2 + Math.floor(Math.random() * 2));
    out.push({ letters, edges });
  }
  return out;
}

// Internal helper mirroring your generator but collecting probabilities
function generateWordWithTrace(P, maxSyllables = 3) {
  let state = 'START', last = '#';
  const letters = [];
  const edges = []; // [{prev, next, p_raw, p_eff, surprise}]

  let syllables = 0;
  while (syllables < maxSyllables) {
    // Collect DFA-legal candidates from Markov row
    const row = P[last] || {};
    const cand = [];
    let Z = 0;
    for (const [sym, p] of Object.entries(row)) {
      const cls = CLASS_OF[sym] || '#';
      if (!dfaAllows(state, cls)) continue;
      if (p <= 0) continue;
      cand.push([sym, p]);
      Z += p;
    }
    if (!cand.length) break;

    // Sample proportional to p_eff = p_raw / Z
    let r = Math.random() * Z;
    let pick = cand[0][0], p_raw = cand[0][1];
    for (const [sym, p] of cand) {
      r -= p;
      if (r <= 0) { pick = sym; p_raw = p; break; }
    }
    const p_eff = p_raw / (Z || 1e-12);
    const surprise = -Math.log(Math.max(p_eff, 1e-12));

    letters.push(pick);
    edges.push({ prev: last, next: pick, p_raw, p_eff, surprise });

    const cls = CLASS_OF[pick] || '#';
    state = dfaNext(state, cls);
    if (cls === '#' || state === 'SEP') { syllables++; state = 'SEP'; last = '#'; continue; }
    last = pick;
  }
  // strip boundaries from letters if they slipped in
  return { letters: letters.filter(s => s !== '#'), edges };
}
