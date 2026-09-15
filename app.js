// Anatomy of Proof — a scripted forensic medicine history quest

const STORAGE_KEY = 'forensic-quest-progress';
const LOG_KEY = 'forensic-quest-log';

let questsData = null;
let rollNumbers = null;

let state = {
  rollNumber: null,
  currentQuestIndex: 0,
  completedQuests: [],
  startedAt: null,
  notebook: [],
};

// ===== Data loading =====
async function loadData() {
  const [qRes, rRes] = await Promise.all([
    fetch('quests.json'),
    fetch('rollnumbers.json'),
  ]);
  questsData = await qRes.json();
  rollNumbers = await rRes.json();
}

// ===== Persistence =====
function saveProgress() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { /* private mode */ }
}

function loadProgress() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.rollNumber && parsed.startedAt) {
        state = { ...state, ...parsed };
        return true;
      }
    }
  } catch (e) { /* ignore */ }
  return false;
}

// ===== Logging =====
function logEvent(eventType, payload = {}) {
  if (state.rollNumber === 'TEACHER-TEST') return;
  try {
    const log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    log.push({ event: eventType, ts: new Date().toISOString(), roll: state.rollNumber, ...payload });
    localStorage.setItem(LOG_KEY, JSON.stringify(log));
  } catch (e) { /* ignore */ }
}

async function syncLog() {
  try {
    const log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    if (!log.length) return;
    await fetch('/api/quest-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: log }),
    });
    localStorage.setItem(LOG_KEY, '[]');
  } catch (e) { /* offline — retry later */ }
}

// ===== Rendering helper =====
function render(html) {
  document.getElementById('app').innerHTML = html;
}

// ===== Entry =====
function renderEntry() {
  const options = rollNumbers.students
    .map((s) => `<option value="${s.reg}">${s.reg} — ${s.name}</option>`)
    .join('');

  render(`
    <div class="entry">
      <h1>${questsData.title}</h1>
      <p class="subtitle">${questsData.subtitle}</p>
      <label for="roll">Enter your roll number</label>
      <select id="roll"><option value="">— Select —</option>${options}</select>
      <button id="begin">Begin</button>
    </div>
  `);

  document.getElementById('begin').addEventListener('click', () => {
    const roll = document.getElementById('roll').value;
    if (!roll) return;
    state.rollNumber = roll;
    state.startedAt = new Date().toISOString();
    saveProgress();
    logEvent('session_start');
    if (roll === 'TEACHER-TEST') document.title = '[TEST] Anatomy of Proof';
    renderMap();
  });
}

// ===== Map =====
function renderMap() {
  const total = questsData.quests.length;
  const done = state.completedQuests.length;
  const current = state.currentQuestIndex;
  const isTeacher = state.rollNumber === 'TEACHER-TEST';

  const resetBtn = isTeacher
    ? `<button class="btn-reset" id="reset-progress">Reset progress (teacher only)</button>`
    : '';

  const nodes = questsData.quests.map((q, i) => {
    const isCompleted = state.completedQuests.includes(q.id);
    const isCurrent = i === current && !isCompleted;
    const isLocked = !isCompleted && !isCurrent && i > current;
    const cls = ['quest-node'];
    if (isCompleted) cls.push('completed');
    if (isCurrent) cls.push('current');
    if (isLocked) cls.push('locked');
    return `
      <div class="${cls.join(' ')}" data-index="${i}">
        <div class="qnum">Quest ${q.number}</div>
        <h3>${q.title}</h3>
        <div class="qmeta">${q.year} — ${q.place}</div>
      </div>
    `;
  }).join('');

  const notebookHTML = state.notebook.length
    ? `<div class="notebook">
         <div class="notebook-header">Your Case File</div>
         <ul>${state.notebook.map((n) => `<li>${n}</li>`).join('')}</ul>
       </div>`
    : '';

  render(`
    <div class="map-header">
      <h2>The Quest</h2>
      <div class="progress">${done} of ${total} complete</div>
      ${resetBtn}
    </div>
    ${notebookHTML}
    <div class="timeline">${nodes}</div>
  `);

  document.querySelectorAll('.quest-node:not(.locked)').forEach((el) => {
    el.addEventListener('click', () => {
      const i = parseInt(el.dataset.index, 10);
      state.currentQuestIndex = i;
      saveProgress();
      renderQuest(questsData.quests[i], 'b1');
    });
  });

  document.getElementById('reset-progress')?.addEventListener('click', () => {
    if (!confirm('Reset all progress and start over?')) return;
    state = {
      rollNumber: state.rollNumber,
      currentQuestIndex: 0,
      completedQuests: [],
      startedAt: new Date().toISOString(),
      notebook: [],
    };
    localStorage.removeItem(STORAGE_KEY);
    saveProgress();
    renderMap();
  });

  if (done === total) setTimeout(renderCompletion, 400);
}

// ===== Quest / scene =====
function renderQuest(q, beatId) {
  const beat = q.beats.find((b) => b.id === beatId);
  if (!beat) {
    // Fallback — shouldn't happen, but guard
    console.warn('beat not found', beatId);
    renderMap();
    return;
  }
  logEvent('beat_view', { questId: q.id, beatId });

  const isNarrator = beat.speaker === 'Narrator';
  const speakerClass = isNarrator ? 'narrator' : 'npc';

  const optionsHTML = beat.options.map((opt, i) => `
    <button class="option-btn" data-index="${i}">
      <span class="option-quote">"${opt.text}"</span>
    </button>
  `).join('');

  render(`
    <div class="quest-screen">
      <div class="quest-header">
        <div class="qnum">Quest ${q.number} of ${questsData.quests.length}</div>
        <h2>${q.title}</h2>
        <div class="qmeta">${q.year} — ${q.place}</div>
      </div>

      <div class="role-block">
        <div class="role-line"><span class="role-label">You are</span> ${q.yourRole}</div>
      </div>

      <div class="portrait-wrap">
        <img class="portrait" src="${q.portrait}" alt="${q.portraitCaption}"
             onerror="this.style.display='none'">
        <div class="portrait-caption">${q.portraitCaption}</div>
      </div>

      <div class="scene">
        <div class="speaker ${speakerClass}">${beat.speaker}</div>
        <div class="speech ${speakerClass}">${beat.text}</div>
      </div>

      <div class="options">${optionsHTML}</div>

      <div class="quest-actions">
        <button class="btn-secondary" id="back-map">Back to map</button>
      </div>
    </div>
  `);

  document.querySelectorAll('.option-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.index, 10);
      const opt = beat.options[i];
      logEvent('option_chosen', { questId: q.id, beatId, optionIndex: i });

      if (opt.next === 'END') {
        finishQuest(q, opt.ending);
      } else {
        renderQuest(q, opt.next);
      }
    });
  });

  document.getElementById('back-map').addEventListener('click', renderMap);
}

// ===== End of a quest =====
function finishQuest(q, ending) {
  if (!state.completedQuests.includes(q.id)) {
    state.completedQuests.push(q.id);
  }
  if (q.notebookEntry && !state.notebook.includes(q.notebookEntry)) {
    state.notebook.push(q.notebookEntry);
  }
  if (state.currentQuestIndex < questsData.quests.length - 1) {
    state.currentQuestIndex += 1;
  }
  saveProgress();
  logEvent('quest_complete', { questId: q.id, ending });
  renderOutcome(q, ending);
}

function renderOutcome(q, ending) {
  const notebookHTML = state.notebook.length
    ? `<div class="notebook">
         <div class="notebook-header">Your Case File</div>
         <ul>${state.notebook.map((n) => `<li>${n}</li>`).join('')}</ul>
       </div>`
    : '';

  render(`
    <div class="quest-screen">
      <div class="quest-header">
        <div class="qnum">Quest ${q.number} of ${questsData.quests.length} — Complete</div>
        <h2>${q.title}</h2>
      </div>

      <div class="outcome-box highlight">
        <h4>What happened</h4>
        <p>${q.outcome}</p>
      </div>

      <div class="what-changed">
        <h5>What changed</h5>
        <p>${q.whatChanged}</p>
      </div>

      ${notebookHTML}

      <div class="quest-actions">
        <button class="btn-primary" id="continue">Continue</button>
        <button class="btn-secondary" id="back-map">Back to map</button>
      </div>
    </div>
  `);

  document.getElementById('continue').addEventListener('click', () => {
    if (state.completedQuests.length === questsData.quests.length) {
      renderCompletion();
    } else {
      renderMap();
    }
  });
  document.getElementById('back-map').addEventListener('click', renderMap);
}

// ===== Completion =====
function renderCompletion() {
  logEvent('session_complete');

  const notebookHTML = state.notebook.length
    ? `<div class="notebook final">
         <div class="notebook-header">Your Case File</div>
         <ul>${state.notebook.map((n) => `<li>${n}</li>`).join('')}</ul>
       </div>`
    : '';

  render(`
    <div class="completion">
      <h1>You've walked the whole arc.</h1>
      <p class="summary">
        From Madras in 1693 to Delhi in 2013 — three centuries of medicine
        learning to make the body testify.
      </p>
      ${notebookHTML}
      <div class="quest-actions">
        <button class="btn-primary" id="sync">Send my progress</button>
        <button class="btn-secondary" id="restart">Start over</button>
      </div>
    </div>
  `);

  document.getElementById('sync').addEventListener('click', async (e) => {
    await syncLog();
    e.target.textContent = 'Progress sent ✓';
    e.target.disabled = true;
  });

  document.getElementById('restart').addEventListener('click', () => {
    state = {
      rollNumber: null, currentQuestIndex: 0, completedQuests: [],
      startedAt: null, notebook: [],
    };
    localStorage.removeItem(STORAGE_KEY);
    renderEntry();
  });
}

// ===== Boot =====
(async function init() {
  try {
    await loadData();
    const hasProgress = loadProgress();
    if (hasProgress && state.rollNumber) {
      if (state.completedQuests.length === questsData.quests.length) {
        renderCompletion();
      } else {
        renderMap();
      }
    } else {
      renderEntry();
    }
    window.addEventListener('online', syncLog);
    syncLog();
  } catch (err) {
    render(`
      <div class="entry">
        <h1>Something went wrong</h1>
        <p class="subtitle">Could not load quest data.</p>
        <p style="color:var(--accent)">${err.message}</p>
      </div>
    `);
  }
})();
