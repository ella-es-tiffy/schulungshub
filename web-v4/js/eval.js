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
    const evals = (S.db.evaluations || [])
      .filter(e => e.trainee_id === S.selectedTraineeId && e.score > 0)
      .sort((a, b) => new Date(a.evaluated_at) - new Date(b.evaluated_at));
    if (evals.length < 2) return null;
    const overall = overallProgress();
    if (overall <= 0 || overall >= 100) return null;
    const elapsed = Math.max((Date.now() - new Date(evals[0].evaluated_at).getTime()) / 86400000, 1);
    const days = Math.ceil((100 - overall) / (overall / elapsed));
    return new Date(Date.now() + days * 86400000);
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
