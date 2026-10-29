const $ = (id) => document.getElementById(id);
function stored(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function remember(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
const savedPreferences = stored("oda-dashboard-preferences", {});
const preferences =
  savedPreferences && typeof savedPreferences === "object" && !Array.isArray(savedPreferences)
    ? savedPreferences
    : {};

const state = {
  tasks: [],
  runs: [],
  selectedTask: null,
  selected: null,
  workView: ["tasks", "attention", "runs"].includes(preferences.workView)
    ? preferences.workView
    : "attention",
  weekOffset: 0,
  fixtureMode: null,
  workHorizon: null,
  planningSync: null,
  online: false,
  busy: false,
  terminal: [],
  samples: [],
  lowPower: preferences.lowPower === true,
  lastNoncritical: 0,
  events: 0,
  critical: 0,
  renderedLines: 0,
  decisionHandoffs: {},
};
const auth = () => ({
  authorization: `Bearer ${localStorage.getItem("oda-session") || "phase2-local-session"}`,
  "x-csrf-token": localStorage.getItem("oda-csrf") || "phase2-local-csrf",
  "content-type": "application/json",
});

function node(tag, text, cls) {
  const n = document.createElement(tag);
  n.textContent = String(text ?? "");
  if (cls) n.className = cls;
  return n;
}

export { $, stored, remember, preferences, state, auth, node };
