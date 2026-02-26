/* ================================================================
   SchulungsHub v4 – Evaluation Queries
   Progress-Berechnungen, ETA, History, Forecast-Faktoren
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

  /* ── Learning Curve (adaptive velocity) ── */
  function computeLearningCurve(traineeId) {
    const evals = (S.db.evaluations || [])
      .filter(e => e.trainee_id === traineeId && e.score === 100 && e.evaluated_at)
      .sort((a, b) => new Date(a.evaluated_at) - new Date(b.evaluated_at));

    if (evals.length < 3) return { factor: 1.0, recentVelocity: 0, overallVelocity: 0, trend: "neutral" };

    const now = Date.now();
    const RECENT_WEEKS = 4;
    const recentCutoff = now - RECENT_WEEKS * 7 * 86400000;

    const recentCompletions = evals.filter(e => new Date(e.evaluated_at).getTime() > recentCutoff).length;
    const recentVelocity = recentCompletions / RECENT_WEEKS;
    const overallVelocity = evals.length / Math.max(
      (now - new Date(evals[0].evaluated_at).getTime()) / (7 * 86400000), 0.1
    );

    if (overallVelocity < 0.001) return { factor: 1.0, recentVelocity, overallVelocity, trend: "neutral" };

    const ratio = recentVelocity / overallVelocity;
    // Clamp: accelerating (ratio>1) → factor <1 (faster), decelerating → factor >1 (slower)
    // Damped: max 30% adjustment either way
    const factor = Math.max(0.7, Math.min(1.3, 1 / Math.max(ratio, 0.3)));
    const trend = ratio > 1.15 ? "accelerating" : ratio < 0.85 ? "decelerating" : "neutral";

    return { factor, recentVelocity, overallVelocity, trend };
  }

  /* ── Motivation Index (NIO pattern analysis) ── */
  function computeMotivationIndex(traineeId) {
    const evals = (S.db.evaluations || [])
      .filter(e => e.trainee_id === traineeId && e.evaluated_at)
      .sort((a, b) => new Date(a.evaluated_at) - new Date(b.evaluated_at));

    if (evals.length < 3) return { index: 1.0, nioRate: 0, recentNioRate: 0, trend: "neutral" };

    const nioAll = evals.filter(e => e.score === 0).length;
    const nioRate = nioAll / evals.length;

    // Recent 4 weeks
    const now = Date.now();
    const recentCutoff = now - 4 * 7 * 86400000;
    const recentEvals = evals.filter(e => new Date(e.evaluated_at).getTime() > recentCutoff);
    const recentNio = recentEvals.filter(e => e.score === 0).length;
    const recentNioRate = recentEvals.length ? recentNio / recentEvals.length : 0;

    // Consecutive NIO streak (from most recent)
    let streak = 0;
    for (let i = evals.length - 1; i >= 0; i--) {
      if (evals[i].score === 0) streak++;
      else break;
    }

    // Index: 1.0 = neutral, >1 = demotivated (slower), <1 = motivated (faster)
    let index = 1.0;
    // Rising NIO rate → demotivation
    if (recentNioRate > nioRate + 0.1) index += 0.1;
    // Consecutive NIO streak penalty
    if (streak >= 3) index += 0.05 * Math.min(streak - 2, 4);
    // Falling NIO rate → motivation boost
    if (recentNioRate < nioRate - 0.1 && recentEvals.length >= 3) index -= 0.05;

    index = Math.max(0.85, Math.min(1.3, index));
    const trend = index > 1.05 ? "sinking" : index < 0.95 ? "rising" : "neutral";

    return { index, nioRate, recentNioRate, streak, trend };
  }

  /* ── Attendance Factor (Anwesenheitsquote + Hochrechnung) ── */
  function computeAttendance(traineeId, measureStart) {
    const attendance = DbEngine.queryAll(
      "SELECT date FROM attendance WHERE trainee_id = ?", [traineeId]
    );
    const presentDays = attendance.length;

    if (!measureStart || presentDays === 0) {
      return { factor: 1.0, rate: 1.0, presentDays: 0, expectedDays: 0, projectedAbsentWeeks: 0, hasData: false };
    }

    // Count expected working days (Mo-Fr) from measure_start to now
    const start = new Date(measureStart);
    const now = new Date();
    let expectedDays = 0;
    const cursor = new Date(start);
    while (cursor <= now) {
      const dow = cursor.getDay();
      if (dow !== 0 && dow !== 6) expectedDays++;
      cursor.setDate(cursor.getDate() + 1);
    }

    if (expectedDays < 5) {
      return { factor: 1.0, rate: 1.0, presentDays, expectedDays, projectedAbsentWeeks: 0, hasData: true };
    }

    // Attendance rate (capped: can't be >1 even if calendar has extra days)
    const rate = Math.min(presentDays / expectedDays, 1.0);

    // Factor: inverse of rate — 80% attendance → 1.25x longer
    const factor = 1 / Math.max(rate, 0.3);

    return { factor, rate, presentDays, expectedDays, projectedAbsentWeeks: 0, hasData: true };
  }

  /* ── Full Forecast Breakdown ── */
  function computeEtaDetailed() {
    if (!S.selectedTraineeId) return null;
    const trainee = findUser(S.selectedTraineeId);
    if (!trainee) return null;

    const goals = S.db.learning_goals;
    if (!goals.length) return null;

    // ── 1. Weighted remaining ──
    let weightedRemaining = 0;
    let completedCount = 0;
    let nioCount = 0;
    let inProgressCount = 0;

    goals.forEach(g => {
      const ev = S.evalMap[g.id];
      if (!ev) { weightedRemaining += 1.0; return; }
      const score = ev.score || 0;
      if (score === 100) { completedCount++; return; }
      if (score === 0 && ev.evaluated_at) { weightedRemaining += 1.0; nioCount++; return; }
      inProgressCount++;
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
    const phaseFactor = PHASE_FACTORS[currentPhase];

    // ── 5. Error factor ──
    const NIO_MULT = { 1: 25, 2: 12.5, 3: 8.3, 4: 0 };
    const errorFactor = 1 + (nioCount * (NIO_MULT[currentPhase] || 0)) / 100;

    // ── 6. Individual factor (training, age, language, motorik) ──
    const trainingFactor = 1 / (1 + 0.15 * (trainee.has_training ? 1 : 0));

    let ageFactor = 1.0;
    const age = trainee.age != null ? trainee.age : null;
    if (age != null && age > 30) {
      ageFactor = 1 + 0.015 * Math.min(age - 30, 25);
    }

    const langLevel = trainee.language_level != null ? trainee.language_level : 3;
    const languageFactor = 1 + 0.2 * (3 - langLevel);

    const motorikLevel = trainee.motorik_level != null ? trainee.motorik_level : 2;
    const motorikFactor = 1 + 0.15 * (2 - motorikLevel);

    const individualFactor = trainingFactor * ageFactor * languageFactor * motorikFactor;

    // ── 7. Learning curve ──
    const learningCurve = computeLearningCurve(S.selectedTraineeId);

    // ── 8. Motivation index ──
    const motivation = computeMotivationIndex(S.selectedTraineeId);

    // ── 9. Attendance ──
    const attendance = computeAttendance(S.selectedTraineeId, measureStart);
    const attendanceFactor = attendance.factor;

    // ── 10. Final — anchor to measure start ──
    const baseWeeks = weightedRemaining / Math.max(velocity, 0.0001);
    const adjustedWeeks = baseWeeks
      * phaseFactor * errorFactor * individualFactor
      * learningCurve.factor * motivation.index
      * attendanceFactor
      * 1.1;

    // attendanceFactor already stretches time by 1/rate,
    // projectedAbsentWeeks is INFORMATIONAL only (no additive stacking)
    const absenceRate = attendance.hasData ? (1 - attendance.rate) : 0;
    const projectedAbsentWeeks = adjustedWeeks * absenceRate;
    attendance.projectedAbsentWeeks = projectedAbsentWeeks;

    const remainingWeeks = adjustedWeeks;

    const startMs = new Date(measureStart).getTime();
    const endDate = new Date(startMs + remainingWeeks * 7 * 86400000);

    return {
      date: endDate,
      kw: getCalendarWeek(endDate),
      // Breakdown
      totalGoals: goals.length,
      completedCount,
      inProgressCount,
      nioCount,
      unevaluated: goals.length - completedCount - inProgressCount - nioCount,
      weightedRemaining,
      measureStart,
      elapsedWeeks,
      velocity,
      overall,
      currentPhase,
      phaseFactor,
      errorFactor,
      trainingFactor,
      ageFactor,
      age,
      languageFactor,
      langLevel,
      motorikFactor,
      motorikLevel,
      individualFactor,
      learningCurve,
      motivation,
      attendance,
      attendanceFactor,
      baseWeeks,
      adjustedWeeks,
      projectedAbsentWeeks,
      remainingWeeks,
    };
  }

  function computeEta() {
    const detail = computeEtaDetailed();
    if (!detail) return null;
    return { date: detail.date, kw: detail.kw };
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

  return {
    buildEvalMap, goalScore, phaseProgress, machineProgress, overallProgress,
    computeEta, computeEtaDetailed, computeLearningCurve, computeMotivationIndex,
    computeAttendance, recentHistory, getMachinesForPhase,
  };
})();

/* Global shortcuts */
const buildEvalMap = Eval.buildEvalMap;
const goalScore = Eval.goalScore;
const phaseProgress = Eval.phaseProgress;
const machineProgress = Eval.machineProgress;
const overallProgress = Eval.overallProgress;
const computeEta = Eval.computeEta;
const computeEtaDetailed = Eval.computeEtaDetailed;
const computeLearningCurve = Eval.computeLearningCurve;
const computeMotivationIndex = Eval.computeMotivationIndex;
const computeAttendance = Eval.computeAttendance;
const recentHistory = Eval.recentHistory;
const getMachinesForPhase = Eval.getMachinesForPhase;
