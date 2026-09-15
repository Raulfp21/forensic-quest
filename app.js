// Anatomy of Proof — a forensic medicine history quest

const STORAGE_KEY = 'forensic-quest-progress';
const LOG_KEY = 'forensic-quest-log';

let questsData = null;
let rollNumbers = null;
let state = {
  rollNumber: null,
  currentQuestIndex: 0,
  completedQuests: [],
  startedAt: null,
};

// ===== Load data =====
async function loadData() {
  const [qRes, rRes] = await Promise.all([
    fetch('quests.json'),
    fetch('rollnumbers.json'),
  ]);
  questsData = await qRes.json();
  rollNumbers = await rRes.json();
}

// ===== Persist state =====
function saveProgress() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) { /* ignore in private mode */ }
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

// ===== Logging for engagement tracking =====
function logEvent(eventType, payload = {}) {
  // Skip logging for the teacher/test account
  if (state.rollNumber === 'TEACHER-TEST') return;
  try {
    const log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    log.push({
      event: eventType,
      ts: new Date().toISOString(),
      roll: state.rollNumber,
      ...payload,
    });
    localStorage.setItem(LOG_KEY, JSON.stringify(log));
  } catch (e) { /* ignore */ }
}

async function syncLog() {
  try {
    const log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    if (!log.length) return;
    // Send to your backend or Google Sheet webhook.
    // If it fails (offline), keep the log local — it'll retry next time.
    await fetch('/api/quest-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: log }),
    });
    localStorage.setItem(LOG_KEY, '[]');
  } catch (e) {
    // Offline — the log stays queued. Retry on next page load or sync.
  }
}

// ===== Rendering =====
function render(html) {
  document.getElementById('app').innerHTML = html;
}

function renderEntry() {
  const options = rollNumbers.students
    .map((s) => `<option value="${s.reg}">${s.reg} — ${s.name}</option>`)
    .join('');

  render(`
    <div class="entry">
      <h1>${questsData.title}</h1>
      <p class="subtitle">${questsData.subtitle}</p>
      <label for="roll">Enter your roll number</label>
      <select id="roll">
        <option value="">— Select —</option>
        ${options}
      </select>
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
    renderMap();
  });
}

function renderMap() {
  const total = questsData.quests.length;
  const done = state.completedQuests.length;

  const nodes = questsData.quests.map((q, i) => {
    const isCompleted = state.completedQuests.includes(q.id);
    const isCurrent = i === state.currentQuestIndex && !isCompleted;
    const isLocked = !isCompleted && !isCurrent && i > state.currentQuestIndex;
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

  render(`
    <div class="map-header">
      <h2>The Quest</h2>
      <div class="progress">${done} of ${total} complete</div>
    </div>
    <div class="timeline">${nodes}</div>
  `);

  document.querySelectorAll('.quest-node:not(.locked)').forEach((el) => {
    el.addEventListener('click', () => {
      const i = parseInt(el.dataset.index, 10);
      state.currentQuestIndex = i;
      saveProgress();
      renderQuest();
    });
  });

  if (done === total) {
    setTimeout(renderCompletion, 300);
  }
}

function renderQuest() {
  const q = questsData.quests[state.currentQuestIndex];
  logEvent('quest_open', { questId: q.id, index: state.currentQuestIndex });

  render(`
    <div class="quest-screen">
      <div class="quest-header">
        <div class="qnum">Quest ${q.number} of ${questsData.quests.length}</div>
        <h2>${q.title}</h2>
        <div class="qmeta">${q.year} — ${q.place}</div>
      </div>

      <div class="portrait-wrap">
        <img class="portrait" src="${q.portrait}" alt="${q.portraitCaption}" 
             onerror="this.style.display='none'">
        <div class="portrait-caption">${q.portraitCaption}</div>
      </div>

      <div class="scene">
        <p>${q.scene}</p>
      </div>

      <div class="question">${q.question}</div>

      <div class="choices" id="choices">
        ${q.choices.map((c, i) => `
          <button class="choice" data-index="${i}">
            ${c.text}
            <span class="choice-option" data-outcome="${i}"></span>
          </button>
        `).join('')}
      </div>

      <div id="after-choice"></div>

      <div class="quest-actions">
        <button class="btn-secondary" id="back-map">Back to map</button>
      </div>
    </div>
  `);

  document.querySelectorAll('.choice').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.index, 10);
      revealChoice(q, i);
    });
  });

  document.getElementById('back-map').addEventListener('click', renderMap);
}

function revealChoice(q, chosenIndex) {
  const chosen = q.choices[chosenIndex];
  logEvent('choice_made', { questId: q.id, choiceIndex: chosenIndex });

  // Fill in outcome for the chosen button, and mark it
  document.querySelectorAll('.choice').forEach((b, i) => {
    b.disabled = true;
    if (i === chosenIndex) b.classList.add('correct');
  });

  // Show outcome box
  const after = document.getElementById('after-choice');
  after.innerHTML = `
    <div class="outcome-box">
      <h4>What this would have meant</h4>
      <p>${chosen.outcome}</p>
    </div>

    <div class="outcome-box">
      <h4>What actually happened</h4>
      <p>${q.outcome}</p>
    </div>

    <div class="what-changed">
      <h5>What changed</h5>
      <p>${q.whatChanged}</p>
    </div>

    <div class="next-card">
      <div class="label">Who built on this</div>
      <p>${q.whoBuiltOnThis}</p>
    </div>

    <div class="quest-actions">
      <button class="btn-primary" id="finish-quest">Complete quest</button>
    </div>
  `;

  document.getElementById('finish-quest').addEventListener('click', () => {
    if (!state.completedQuests.includes(q.id)) {
      state.completedQuests.push(q.id);
    }
    if (state.currentQuestIndex < questsData.quests.length - 1) {
      state.currentQuestIndex += 1;
    }
    saveProgress();
    logEvent('quest_complete', { questId: q.id });
    renderMap();
  });
}

function renderCompletion() {
  logEvent('session_complete');

  const dates = questsData.quests
    .map((q) => `<div><strong>${q.year}</strong> — ${q.place}</div>`)
    .join('');

  render(`
    <div class="completion">
      <h1>You've walked the whole arc.</h1>
      <p class="summary">
        From Madras in 1693 to Delhi in 2013 — three centuries of medicine
        learning to make the body testify.
      </p>
      <div class="dates">${dates}</div>
      <div class="quest-actions">
        <button class="btn-primary" id="sync">Send my progress</button>
        <button class="btn-secondary" id="restart">Start over</button>
      </div>
    </div>
  `);

  document.getElementById('sync').addEventListener('click', async () => {
    await syncLog();
    document.getElementById('sync').textContent = 'Progress sent ✓';
    document.getElementById('sync').disabled = true;
  });

  document.getElementById('restart').addEventListener('click', () => {
    state = { rollNumber: null, currentQuestIndex: 0, completedQuests: [], startedAt: null };
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
      // Resume where they left off
      if (state.completedQuests.length === questsData.quests.length) {
        renderCompletion();
      } else {
        renderMap();
      }
    } else {
      renderEntry();
    }
    // Try to sync any queued log entries when online
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
