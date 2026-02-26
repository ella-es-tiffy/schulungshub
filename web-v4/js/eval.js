/* ================================================================
   SchulungsHub v4 – Evaluation Queries
   Progress-Berechnungen, ETA, History
   Depends on: state.js (S, S.db, S.evalMap, S.selectedTraineeId)
   ================================================================ */
const Eval = (() => {
  function buildEvalMap(traineeId) {
    const map = {};
    (S.db.evaluations || [])
      .filter(e => e.trainee_id === traineeId)
      .sort((a, b) => new Date(a.evaluated_at) - new Date(b.evaluated_at))
      .forEach(e => { map[e.goal_id] = e; });
    return map;
  }

  function goalScore(gid) { return S.evalMap[gid] ? (S.evalMap[gid].score || 0) : 0; }

  function phaseProgress(pid) {
    const g = S.db.learning_goals.filter(g => g.phase === pid);
    return g.length ? g.reduce((s, g) => s + goalScore(g.id), 0) / g.length : 0;
  }

  function machineProgress(pid, mid) {
    const g = S.db.learning_goals.filter(g => g.phase === pid && g.machine_id === mid);
    return g.length ? g.reduce((s, g) => s + goalScore(g.id), 0) / g.length : 0;
  }

  function overallProgress() {
    const g = S.db.learning_goals;
    return g.length ? g.reduce((s, g) => s + goalScore(g.id), 0) / g.length : 0;
  }

  function computeEta() {
    if (!S.selectedTraineeId) return null;
    const trainee = findUser(S.selectedTraineeId);
    if (!trainee) return null;

    const goals = S.db.learning_goals;
    if (!goals.length) return null;

    // ── 1. Weighted remaining ──
    let weightedRemaining = 0;
    let completedCount = 0;
    let nioCount = 0;

    goals.forEach(g => {
      const ev = S.evalMap[g.id];
      if (!ev) { weightedRemaining += 1.0; return; }
      const score = ev.score || 0;
      if (score === 100) { completedCount++; return; }
      if (score === 0 && ev.evaluated_at) { weightedRemaining += 1.0; nioCount++; return; }
      if (score === 75) weightedRemaining += 0.25;
      else if (score === 50) weightedRemaining += 0.50;
      else if (score === 25) weightedRemaining += 0.75;
      else weightedRemaining += 1.0;
    });

    if (weightedRemaining <= 0) return null;

    // ── 2. Elapsed weeks ──
    let measureStart = trainee.measure_start;
    if (!measureStart) {
      const firstEval = (S.db.evaluations || [])
        .filter(e => e.trainee_id === S.selectedTraineeId && e.evaluated_at)
        .sort((a, b) => new Date(a.evaluated_at) - new Date(b.evaluated_at))[0];
      if (!firstEval) return null;
      measureStart = firstEval.evaluated_at;
    }
    const elapsedWeeks = Math.max((Date.now() - new Date(measureStart).getTime()) / (7 * 86400000), 0.1);

    // ── 3. Velocity ──
    const velocity = completedCount / elapsedWeeks;

    // ── 4. Phase factor ──
    const overall = overallProgress();
    const currentPhase = overall < 25 ? 1 : overall < 50 ? 2 : overall < 75 ? 3 : 4;
    const PHASE_FACTORS = { 1: 1.2, 2: 1.0, 3: 1.1, 4: 1.05 };

    // ── 5. Error factor ──
    const NIO_MULT = { 1: 25, 2: 12.5, 3: 8.3, 4: 0 };
    const errorFactor = 1 + (nioCount * (NIO_MULT[currentPhase] || 0)) / 100;

    // ── 6. Individual factor ──
    const trainingFactor = 1 / (1 + 0.15 * (trainee.has_training ? 1 : 0));

    let ageFactor = 1.0;
    if (trainee.birthdate) {
      const age = (Date.now() - new Date(trainee.birthdate).getTime()) / (365.25 * 86400000);
      if (age > 30) ageFactor = 1 + 0.015 * Math.min(age - 30, 25);
    }

    const langLevel = trainee.language_level != null ? trainee.language_level : 3;
    const languageFactor = 1 + 0.2 * (3 - langLevel);

    const individualFactor = trainingFactor * ageFactor * languageFactor;

    // ── 7. Final — anchor to measure start (like Excel) ──
    const remainingWeeks = (weightedRemaining / Math.max(velocity, 0.0001))
      * PHASE_FACTORS[currentPhase] * errorFactor * individualFactor * 1.1;

    const startMs = new Date(measureStart).getTime();
    const endDate = new Date(startMs + remainingWeeks * 7 * 86400000);
    return { date: endDate, kw: getCalendarWeek(endDate) };
  }

  function recentHistory(limit = 20) {
    if (!S.selectedTraineeId) return [];
    return (S.db.evaluations || [])
      .filter(e => e.trainee_id === S.selectedTraineeId)
      .sort((a, b) => new Date(b.evaluated_at) - new Date(a.evaluated_at))
      .slice(0, limit);
  }

  function getMachinesForPhase(pid) {
    const ids = new Set();
    S.db.learning_goals.filter(g => g.phase === pid).forEach(g => ids.add(g.machine_id));
    const order = {};
    (S.db.machines || []).forEach(m => { order[m.id] = m.position || 99; });
    return [...ids].sort((a, b) => (order[a] || 99) - (order[b] || 99));
  }

  return { buildEvalMap, goalScore, phaseProgress, machineProgress, overallProgress, computeEta, recentHistory, getMachinesForPhase };
})();

/* Global shortcuts */
const buildEvalMap = Eval.buildEvalMap;
const goalScore = Eval.goalScore;
const phaseProgress = Eval.phaseProgress;
const machineProgress = Eval.machineProgress;
const overallProgress = Eval.overallProgress;
const computeEta = Eval.computeEta;
const recentHistory = Eval.recentHistory;
const getMachinesForPhase = Eval.getMachinesForPhase;
