import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const SUPABASE_URL = "https://nzklfdjsdtemtzrfslfa.supabase.co";
const SUPABASE_KEY = "sb_publishable_VuaPlhuHvgs3bM0diIKZ_Q_InkSXHT5";
const MAX_PER_ROOM = 5;
const MAX_TEXT = 600;
const SEND_EVERY_MS = 100;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { params: { eventsPerSecond: 20 } },
});

/* ---------- device memory ---------- */
const store = {
  get(k, d = null) { try { const v = localStorage.getItem("cbl." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("cbl." + k, JSON.stringify(v)); } catch {} },
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));

let deviceId = store.get("device");
if (!deviceId) { deviceId = uuid(); store.set("device", deviceId); }
const tabId = uuid().slice(0, 12);             // one presence entry per tab
let profile = store.get("profile");            // { name, location }
let muted = new Set(store.get("muted", []));   // device ids you've muted

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const code = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}
function show(screen) {
  for (const s of ["welcome", "lobby", "room"]) $(s).classList.toggle("hidden", s !== screen);
  $("editProfileBtn").classList.toggle("hidden", !profile || screen === "welcome");
  if (profile) $("meName").textContent = profile.name;
}

/* ---------- lobby presence (who's online + which rooms exist) ---------- */
let lobby = null;
let lobbyState = {};
let current = null; // { id, name, priv }

function myLobbyMeta() {
  return {
    device: deviceId, name: profile?.name, loc: profile?.location || "",
    room: current?.id || null, roomName: current?.name || null, priv: !!current?.priv,
    at: Date.now(),
  };
}
function trackLobby() { if (lobby && profile) lobby.track(myLobbyMeta()); }

function connectLobby() {
  lobby = sb.channel("cbl-lobby", { config: { presence: { key: tabId } } });
  lobby
    .on("presence", { event: "sync" }, () => { lobbyState = lobby.presenceState(); renderLobby(); })
    .subscribe(status => {
      $("connDot").classList.toggle("on", status === "SUBSCRIBED");
      if (status === "SUBSCRIBED") { lobbyState = lobby.presenceState(); renderLobby(); trackLobby(); }
      else $("onlineCount").textContent = "hang on, reconnecting...";
    });
}

function lobbyPeople() {
  return Object.values(lobbyState).map(m => m[m.length - 1]).filter(Boolean);
}

function renderLobby() {
  const people = lobbyPeople();
  const devices = new Set(people.map(p => p.device));
  $("onlineCount").textContent = `${devices.size} ${devices.size === 1 ? "person" : "people"} here`;

  const rooms = new Map();
  for (const p of people) {
    if (!p.room || p.priv) continue;
    const r = rooms.get(p.room) || { id: p.room, name: p.roomName || "Untitled", people: [] };
    r.people.push(p);
    rooms.set(p.room, r);
  }
  const list = [...rooms.values()].sort((a, b) => b.people.length - a.people.length);
  const ul = $("roomList"); ul.replaceChildren();
  $("noRooms").classList.toggle("hidden", list.length > 0);
  $("roomCount").textContent = list.length ? `${list.length} room${list.length > 1 ? "s" : ""}` : "";
  for (const r of list) {
    const li = el("li", "room-item");
    const info = el("div");
    info.append(el("div", "rname", r.name));
    const ppl = el("div", "people");
    const seats = el("span", "seats");
    for (let i = 0; i < MAX_PER_ROOM; i++) seats.append(el("i", i < r.people.length ? "f" : ""));
    ppl.append(seats, document.createTextNode(r.people.map(p => p.name).join(", ")));
    info.append(ppl);
    const full = r.people.length >= MAX_PER_ROOM;
    const btn = el("button", full ? "" : "primary", full ? "full" : "join");
    btn.disabled = full || current?.id === r.id;
    btn.onclick = () => joinRoom(r.id, r.name, false);
    li.append(info, btn);
    ul.append(li);
  }
}

/* ---------- rooms ---------- */
let roomCh = null;
let members = [];              // [{key, device, name, loc, joined}]
let texts = {};                // key -> text
let slotEls = {};              // key -> {slot, body, dot}
let myText = "";
let sendTimer = null, lastSend = 0;
let kicked = new Set();         // devices voted out of the current room

async function joinRoom(id, name, priv) {
  id = clean(id, 6).toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(id)) return toast("hmm, room codes are 6 letters or numbers. double check it?");
  const bans = store.get("bans", {});
  if (bans[id] && bans[id] > Date.now()) {
    const mins = Math.ceil((bans[id] - Date.now()) / 60000);
    return toast(`you got voted out of that room. you can go back in ${mins} min.`);
  }
  if (current) await leaveRoom(true);

  current = { id, name: clean(name, 32) || "secret room", priv };
  kicked = new Set(); endVote(); resetBoard(); resetTube();
  myText = ""; texts = {}; members = []; slotEls = {};
  history.replaceState(null, "", "#" + id);
  $("roomTitle").textContent = current.name;
  $("roomMeta").textContent = `code: ${id}${priv ? " · secret room" : ""}`;
  $("slots").replaceChildren();
  show("room");

  const joined = Date.now();
  roomCh = sb.channel("cbl-room-" + id, { config: { presence: { key: tabId }, broadcast: { self: false } } });
  roomCh
    .on("presence", { event: "sync" }, () => onRoomSync())
    .on("presence", { event: "join" }, ({ key }) => { if (key !== tabId) { sendText(true); maybeSendSnapshot(key); maybeSendTube(key); } })
    .on("broadcast", { event: "text" }, ({ payload }) => onRemoteText(payload))
    .on("broadcast", { event: "draw" }, ({ payload }) => drawRemote(payload))
    .on("broadcast", { event: "tube" }, ({ payload }) => onRemoteTube(payload))
    .on("broadcast", { event: "tube-stop" }, () => applyTube(null))
    .on("broadcast", { event: "board-clear" }, () => clearBoard(false))
    .on("broadcast", { event: "board-snap" }, ({ payload }) => onSnapshotChunk(payload))
    .on("broadcast", { event: "vote-start" }, ({ payload }) => onVoteStart(payload))
    .on("broadcast", { event: "vote-cast" }, ({ payload }) => onVoteCast(payload))
    .on("broadcast", { event: "kick" }, ({ payload }) => { if (payload?.device === deviceId) getKicked(); else if (payload?.device) kicked.add(payload.device); })
    .on("broadcast", { event: "meta" }, ({ payload }) => {
      // learn the real room name when joining by code/link
      if (payload?.name && current && current.name === "secret room" && !current.named) {
        current.name = clean(payload.name, 32); current.priv = !!payload.priv; current.named = true;
        $("roomTitle").textContent = current.name;
        setMeta();
        trackLobby();
      }
    })
    .subscribe(async status => {
      if (status === "SUBSCRIBED") {
        await roomCh.track({ device: deviceId, name: profile.name, loc: profile.location || "", joined });
        trackLobby();
      }
    });
}

function onRoomSync() {
  if (!roomCh) return;
  const st = roomCh.presenceState();
  members = Object.entries(st).map(([key, metas]) => ({ key, ...metas[metas.length - 1] }))
    .filter(m => m.name && (m.key === tabId || !kicked.has(m.device)))
    .sort((a, b) => a.joined - b.joined || a.key.localeCompare(b.key));
  const myIndex = members.findIndex(m => m.key === tabId);
  if (myIndex >= MAX_PER_ROOM) {
    toast("sorry, that room's full (5 people max). try another one!");
    leaveRoom();
    return;
  }
  members = members.slice(0, MAX_PER_ROOM);
  // anyone who was voted out but came back gets told to leave again
  for (const [key, metas] of Object.entries(st)) {
    const d = metas[metas.length - 1]?.device;
    if (key !== tabId && kicked.has(d)) roomCh.send({ type: "broadcast", event: "kick", payload: { device: d } });
  }
  if (vote && !members.some(m => m.key === vote.target)) endVote();
  // tell newcomers the room's name
  if (current && (current.named || current.name !== "secret room")) {
    roomCh.send({ type: "broadcast", event: "meta", payload: { name: current.name, priv: current.priv } });
  }
  renderSlots();
}

function colorFor(i) { return `var(--c${i % 5})`; }

function renderSlots() {
  const box = $("slots");
  const keep = new Set(members.map(m => m.key));
  for (const k of Object.keys(slotEls)) if (!keep.has(k)) { slotEls[k].slot.remove(); delete slotEls[k]; delete texts[k]; }
  box.querySelectorAll(".empty-slot").forEach(e => e.remove());

  members.forEach((m, i) => {
    let s = slotEls[m.key];
    if (!s) s = slotEls[m.key] = buildSlot(m);
    s.slot.style.setProperty("--c", colorFor(i));
    box.append(s.slot); // re-append keeps order
  });
  for (let i = members.length; i < MAX_PER_ROOM; i++) {
    const e = el("div", "slot empty-slot");
    const h = el("div", "slot-head"); h.append(el("span", "where", "open seat"));
    e.append(h, el("div", "slot-body"));
    box.append(e);
  }
  setMeta();
}
function setMeta() {
  if (!current) return;
  $("roomMeta").textContent = `code: ${current.id}${current.priv ? " · secret room" : ""} · ${members.length} of ${MAX_PER_ROOM} seats taken`;
}

function buildSlot(m) {
  const me = m.key === tabId;
  const slot = el("div", "slot" + (me ? " me" : ""));
  const head = el("div", "slot-head");
  const who = el("span", "who", m.name + (me ? " (you)" : ""));
  if (m.loc) who.append(el("span", "where", " · " + m.loc));
  const tools = el("span", "tools");
  const dot = el("span", "typing");
  tools.append(dot);
  head.append(who, tools);

  let body;
  if (me) {
    body = el("textarea");
    body.maxLength = MAX_TEXT;
    body.placeholder = "say something! everyone sees it as you type";
    body.value = myText;
    body.addEventListener("input", () => { myText = body.value.slice(-MAX_TEXT); sendText(); });
    const clr = el("button", "ghost small", "clear");
    clr.type = "button";
    clr.onclick = () => { body.value = ""; myText = ""; sendText(true); body.focus(); };
    tools.append(clr);
    setTimeout(() => body.focus(), 50);
  } else {
    body = el("div", "slot-body");
    const isMuted = muted.has(m.device);
    const mb = el("button", "ghost small", isMuted ? "unmute" : "mute");
    mb.type = "button";
    mb.onclick = () => {
      if (muted.has(m.device)) muted.delete(m.device); else muted.add(m.device);
      store.set("muted", [...muted]);
      mb.textContent = muted.has(m.device) ? "unmute" : "mute";
      paintRemote(m.key);
    };
    tools.append(mb);
    const kb = el("button", "ghost small kick-btn", "kick?");
    kb.type = "button";
    kb.title = "start a vote to kick this person";
    kb.onclick = () => startVote(m);
    tools.append(kb);
  }
  slot.append(head, body);
  const s = { slot, body, dot, device: m.device };
  slotEls[m.key] = s;
  if (!me) paintRemote(m.key);
  return s;
}

function paintRemote(key) {
  const s = slotEls[key]; if (!s) return;
  if (muted.has(s.device)) { s.body.textContent = "(you muted this person)"; s.body.classList.add("muted-text"); return; }
  s.body.classList.remove("muted-text");
  s.body.textContent = texts[key] || "";
  s.body.scrollTop = s.body.scrollHeight;
}

function onRemoteText(p) {
  if (!p || typeof p.key !== "string" || p.key === tabId) return;
  texts[p.key] = String(p.text ?? "").slice(-MAX_TEXT);
  const s = slotEls[p.key];
  if (!s) return;
  paintRemote(p.key);
  s.dot.classList.add("on");
  clearTimeout(s._t); s._t = setTimeout(() => s.dot.classList.remove("on"), 700);
}

function sendText(now = false) {
  if (!roomCh) return;
  const fire = () => {
    lastSend = Date.now(); sendTimer = null;
    roomCh.send({ type: "broadcast", event: "text", payload: { key: tabId, text: myText } });
  };
  const wait = SEND_EVERY_MS - (Date.now() - lastSend);
  if (now || wait <= 0) { clearTimeout(sendTimer); fire(); }
  else if (!sendTimer) sendTimer = setTimeout(fire, wait);
}

async function leaveRoom(silent = false) {
  if (roomCh) { const ch = roomCh; roomCh = null; try { await ch.untrack(); } catch {} sb.removeChannel(ch); }
  current = null;
  endVote(); resetTube();
  history.replaceState(null, "", location.pathname);
  trackLobby();
  if (!silent) { show("lobby"); renderLobby(); }
}

/* ---------- Coolioboard (shared drawing) ---------- */
const board = $("board");
const bctx = board.getContext("2d");
const COLORS = ["#ffb347", "#5ff2ff", "#9dff5c", "#ff6ad5", "#fff35c", "#ffffff", "#ff5a3c"];
let pen = { c: COLORS[0], s: 7, e: false };
let boardDirty = false;
let drawing = false, lastPt = null, pending = [], flushTimer = null;
let snapBuf = {};

function strokeLine(pts, c, s, e) {
  bctx.save();
  bctx.globalCompositeOperation = e ? "destination-out" : "source-over";
  bctx.strokeStyle = c; bctx.lineWidth = s; bctx.lineCap = "round"; bctx.lineJoin = "round";
  bctx.beginPath();
  bctx.moveTo(pts[0], pts[1]);
  if (pts.length === 2) bctx.lineTo(pts[0] + 0.01, pts[1]);
  for (let i = 2; i + 1 < pts.length; i += 2) bctx.lineTo(pts[i], pts[i + 1]);
  bctx.stroke();
  bctx.restore();
  if (!e) boardDirty = true;
}
function boardPoint(ev) {
  const r = board.getBoundingClientRect();
  return [Math.round((ev.clientX - r.left) * board.width / r.width), Math.round((ev.clientY - r.top) * board.height / r.height)];
}
board.addEventListener("pointerdown", ev => {
  if (!roomCh) return;
  board.setPointerCapture(ev.pointerId);
  drawing = true; lastPt = boardPoint(ev); pending = [...lastPt];
  strokeLine(lastPt, pen.c, pen.s, pen.e); scheduleFlush();
});
board.addEventListener("pointermove", ev => {
  if (!drawing) return;
  const p = boardPoint(ev);
  strokeLine([...lastPt, ...p], pen.c, pen.s, pen.e);
  lastPt = p; pending.push(...p); scheduleFlush();
});
const stopDrawing = () => { if (drawing) { drawing = false; flushDraw(); } };
board.addEventListener("pointerup", stopDrawing);
board.addEventListener("pointercancel", stopDrawing);

function scheduleFlush() { if (!flushTimer) flushTimer = setTimeout(flushDraw, 60); }
function flushDraw() {
  clearTimeout(flushTimer); flushTimer = null;
  if (roomCh && pending.length >= 2) roomCh.send({ type: "broadcast", event: "draw", payload: { c: pen.c, s: pen.s, e: pen.e, p: pending } });
  pending = drawing && lastPt ? [...lastPt] : [];
}
function drawRemote(p) {
  if (!p || !Array.isArray(p.p) || p.p.length < 2 || p.p.length > 4000) return;
  if (!/^#[0-9a-f]{6}$/i.test(p.c) || !(p.s >= 1 && p.s <= 40)) return;
  if (!p.p.every(n => typeof n === "number" && isFinite(n))) return;
  strokeLine(p.p, p.c, p.s, !!p.e);
}
function clearBoard(broadcast) {
  bctx.clearRect(0, 0, board.width, board.height);
  boardDirty = false;
  if (broadcast && roomCh) roomCh.send({ type: "broadcast", event: "board-clear", payload: {} });
}
function resetBoard() { clearBoard(false); snapBuf = {}; pending = []; drawing = false; }

// the person who's been here longest hands the drawing to newcomers
function maybeSendSnapshot(newKey) {
  setTimeout(() => {
    if (!roomCh || !boardDirty) return;
    const others = members.filter(m => m.key !== newKey);
    if (others[0]?.key !== tabId) return;
    const data = board.toDataURL("image/png");
    const id = uuid().slice(0, 8), size = 60000, n = Math.ceil(data.length / size);
    for (let i = 0; i < n; i++) {
      setTimeout(() => roomCh?.send({ type: "broadcast", event: "board-snap", payload: { to: newKey, id, i, n, d: data.slice(i * size, (i + 1) * size) } }), i * 150);
    }
  }, 700);
}
function onSnapshotChunk(p) {
  if (!p || p.to !== tabId || typeof p.d !== "string" || typeof p.id !== "string" || !(p.n > 0 && p.n < 80) || !(p.i >= 0 && p.i < p.n)) return;
  const b = snapBuf[p.id] ||= { n: p.n, parts: [], got: 0 };
  if (b.parts[p.i] == null) { b.parts[p.i] = p.d; b.got++; }
  if (b.got < b.n) return;
  delete snapBuf[p.id];
  const url = b.parts.join("");
  if (!url.startsWith("data:image/png;base64,")) return;
  const img = new Image();
  img.onload = () => {
    bctx.save(); bctx.globalCompositeOperation = "destination-over";
    bctx.drawImage(img, 0, 0, board.width, board.height);
    bctx.restore(); boardDirty = true;
  };
  img.src = url;
}

// toolbar
const swatchBox = $("swatches");
COLORS.forEach((c, i) => {
  const b = el("button", "swatch" + (i === 0 ? " on" : ""));
  b.type = "button"; b.style.background = c; b.title = "pick this color";
  b.onclick = () => {
    pen.c = c; pen.e = false; $("eraserBtn").classList.remove("on");
    swatchBox.querySelectorAll(".swatch").forEach(x => x.classList.toggle("on", x === b));
  };
  swatchBox.append(b);
});
document.querySelectorAll("[data-size]").forEach(b => b.onclick = () => {
  pen.s = +b.dataset.size;
  document.querySelectorAll("[data-size]").forEach(x => x.classList.toggle("on", x === b));
});
$("eraserBtn").onclick = () => { pen.e = !pen.e; $("eraserBtn").classList.toggle("on", pen.e); };
$("boardClearBtn").onclick = () => { if (confirm("wipe the whole board for everybody?")) clearBoard(true); };

/* ---------- vote to kick ---------- */
const VOTE_MS = 20000;
const BAN_MS = 10 * 60000;
let vote = null;

const needed = v => Math.floor(v.eligible.size / 2) + 1;

function startVote(m) {
  if (vote) return toast("there's already a vote going on, hang on");
  if (members.length < 3) return toast("you need at least 3 people here to vote someone out (or just leave lol)");
  const payload = {
    id: uuid().slice(0, 8), target: m.key, targetDevice: m.device, targetName: m.name,
    starter: tabId, starterName: profile.name,
    eligible: members.filter(x => x.key !== m.key).map(x => x.key),
  };
  roomCh.send({ type: "broadcast", event: "vote-start", payload });
  onVoteStart(payload);
}

function onVoteStart(p) {
  if (vote || !p || typeof p.id !== "string" || typeof p.target !== "string" || !Array.isArray(p.eligible)) return;
  const here = new Set(members.map(m => m.key));
  if (!here.has(p.target)) return;
  const eligible = new Set(p.eligible.filter(k => here.has(k) && k !== p.target));
  eligible.add(p.starter);
  vote = {
    id: p.id, target: p.target, targetDevice: p.targetDevice,
    targetName: clean(p.targetName, 24) || "someone", starterName: clean(p.starterName, 24) || "someone",
    eligible, yes: new Set([p.starter]), no: new Set(), ends: Date.now() + VOTE_MS,
  };
  vote.timer = setTimeout(() => finishVote(false), VOTE_MS);
  vote.tick = setInterval(renderVote, 1000);
  renderVote();
  checkVote();
}

function castVote(yes) {
  if (!vote || !vote.eligible.has(tabId) || vote.yes.has(tabId) || vote.no.has(tabId)) return;
  const payload = { id: vote.id, voter: tabId, yes };
  roomCh.send({ type: "broadcast", event: "vote-cast", payload });
  onVoteCast(payload);
}

function onVoteCast(p) {
  if (!vote || !p || p.id !== vote.id || !vote.eligible.has(p.voter) || vote.yes.has(p.voter) || vote.no.has(p.voter)) return;
  (p.yes ? vote.yes : vote.no).add(p.voter);
  renderVote();
  checkVote();
}

function checkVote() {
  if (!vote) return;
  const need = needed(vote);
  if (vote.yes.size >= need) finishVote(true);
  else if (vote.no.size > vote.eligible.size - need) finishVote(false);
}

function finishVote(passed) {
  if (!vote) return;
  const v = vote;
  endVote();
  if (!passed) return toast(v.target === tabId ? "phew, the vote failed. you're staying." : `vote failed, ${v.targetName} gets to stay`);
  if (v.target === tabId) return getKicked();
  kicked.add(v.targetDevice);
  toast(`${v.targetName} got voted out. bye!`);
  roomCh?.send({ type: "broadcast", event: "kick", payload: { device: v.targetDevice } });
  onRoomSync();
}

function endVote() {
  if (vote) { clearTimeout(vote.timer); clearInterval(vote.tick); }
  vote = null;
  $("vote").classList.add("hidden");
}

function getKicked() {
  if (!current) return;
  const bans = store.get("bans", {});
  for (const k in bans) if (bans[k] < Date.now()) delete bans[k];
  bans[current.id] = Date.now() + BAN_MS;
  store.set("bans", bans);
  leaveRoom();
  toast("the room voted you out :( you can come back in 10 min");
}

function renderVote() {
  const box = $("vote");
  if (!vote) return box.classList.add("hidden");
  const secs = Math.max(0, Math.ceil((vote.ends - Date.now()) / 1000));
  const msg = el("div");
  if (vote.target === tabId) {
    msg.append(document.createTextNode(`uh oh, ${vote.starterName} started a vote to kick you. `));
  } else {
    msg.append(document.createTextNode(`${vote.starterName} wants to kick `), el("b", null, vote.targetName), document.createTextNode(". kick them? "));
  }
  msg.append(el("span", "muted", `(${vote.yes.size}/${needed(vote)} yes needed · ${secs}s left)`));
  const btns = el("div", "vbtns");
  const voted = vote.yes.has(tabId) || vote.no.has(tabId);
  if (vote.eligible.has(tabId) && !voted) {
    const y = el("button", "danger", "yeah kick");
    const n = el("button", null, "nah");
    y.type = n.type = "button";
    y.onclick = () => castVote(true);
    n.onclick = () => castVote(false);
    btns.append(y, n);
  } else if (voted) {
    btns.append(el("span", "muted", "you voted"));
  }
  box.replaceChildren(msg, btns);
  box.classList.remove("hidden");
}

/* ---------- CoolioTube (watch youtube together) ---------- */
let ytReady = null, player = null, loadedVid = null, tube = null;
let applyingUntil = 0; // ignore our own player's events while applying someone else's change

function loadYT() {
  if (!ytReady) ytReady = new Promise(res => {
    window.onYouTubeIframeAPIReady = res;
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.append(s);
  });
  return ytReady;
}

function parseVid(s) {
  s = String(s || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    let id = null;
    if (u.hostname.endsWith("youtu.be")) id = u.pathname.slice(1, 12);
    else if (u.searchParams.get("v")) id = u.searchParams.get("v").slice(0, 11);
    else { const m = u.pathname.match(/\/(embed|shorts|live)\/([\w-]{11})/); if (m) id = m[2]; }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

function tubeNow() {
  if (!tube) return null;
  let t = tube.t, playing = tube.playing;
  try { if (player?.getCurrentTime) { t = player.getCurrentTime(); playing = player.getPlayerState() === YT.PlayerState.PLAYING; } } catch {}
  return { vid: tube.vid, t, playing };
}

async function applyTube(s) {
  tube = s;
  $("tubeEmpty").classList.toggle("hidden", !!s);
  $("tubeStopBtn").classList.toggle("hidden", !s);
  if (!s) {
    if (player?.stopVideo) { applyingUntil = Date.now() + 1500; player.stopVideo(); }
    return;
  }
  await loadYT();
  if (tube !== s || !current) return;
  applyingUntil = Date.now() + 1500;
  if (!player) {
    player = await new Promise(res => {
      const p = new YT.Player("ytPlayer", {
        videoId: s.vid,
        playerVars: { playsinline: 1, rel: 0, start: Math.floor(s.t) },
        events: { onReady: () => res(p), onStateChange: onYTState },
      });
    });
    loadedVid = s.vid;
    if (tube !== s) return;
    applyingUntil = Date.now() + 1500;
  }
  if (loadedVid !== s.vid) {
    loadedVid = s.vid;
    if (s.playing) player.loadVideoById(s.vid, s.t); else player.cueVideoById(s.vid, s.t);
    return;
  }
  if (Math.abs(player.getCurrentTime() - s.t) > 1.5) player.seekTo(s.t, true);
  if (s.playing) player.playVideo(); else player.pauseVideo();
}

function onYTState(e) {
  if (!tube || !roomCh || Date.now() < applyingUntil) return;
  if (e.data !== YT.PlayerState.PLAYING && e.data !== YT.PlayerState.PAUSED) return;
  tube = { vid: tube.vid, t: player.getCurrentTime(), playing: e.data === YT.PlayerState.PLAYING };
  roomCh.send({ type: "broadcast", event: "tube", payload: tube });
}

function onRemoteTube(p) {
  if (!p || (p.to && p.to !== tabId)) return;
  if (!/^[\w-]{11}$/.test(p.vid) || !(p.t >= 0) || typeof p.playing !== "boolean") return;
  applyTube({ vid: p.vid, t: p.t, playing: p.playing });
}

function maybeSendTube(newKey) {
  setTimeout(() => {
    const s = tubeNow();
    if (!roomCh || !s) return;
    const others = members.filter(m => m.key !== newKey);
    if (others[0]?.key !== tabId) return;
    roomCh.send({ type: "broadcast", event: "tube", payload: { ...s, to: newKey } });
  }, 900);
}

function resetTube() {
  tube = null;
  try { player?.destroy(); } catch {}
  player = null; loadedVid = null;
  if (!$("ytPlayer")) { const d = el("div"); d.id = "ytPlayer"; document.querySelector(".tube-screen").prepend(d); }
  $("tubeEmpty").classList.remove("hidden");
  $("tubeStopBtn").classList.add("hidden");
}

$("tubeForm").addEventListener("submit", e => {
  e.preventDefault();
  if (!roomCh) return;
  const vid = parseVid($("tubeInput").value);
  if (!vid) return toast("hmm, that doesn't look like a youtube link");
  $("tubeInput").value = "";
  const s = { vid, t: 0, playing: true };
  roomCh.send({ type: "broadcast", event: "tube", payload: s });
  applyTube(s);
});
$("tubeStopBtn").onclick = () => {
  roomCh?.send({ type: "broadcast", event: "tube-stop", payload: {} });
  applyTube(null);
};

/* ---------- UI wiring ---------- */
$("profileForm").addEventListener("submit", async e => {
  e.preventDefault();
  const name = clean($("nameInput").value, 24);
  if (!name) return;
  profile = { name, location: clean($("locInput").value, 24) };
  store.set("profile", profile);
  sb.rpc("touch_device", { p_id: deviceId, p_name: profile.name, p_location: profile.location }).then(() => {});
  if (!lobby) connectLobby(); else trackLobby();
  const pending = location.hash.slice(1);
  if (/^[A-Za-z0-9]{6}$/.test(pending)) joinRoom(pending, "secret room", true);
  else { show("lobby"); renderLobby(); }
});

$("createForm").addEventListener("submit", e => {
  e.preventDefault();
  const name = clean($("roomNameInput").value, 32);
  if (!name) return;
  const priv = document.querySelector('input[name="rtype"]:checked').value === "private";
  $("roomNameInput").value = "";
  const id = code();
  joinRoom(id, name, priv).then(() => { if (current) current.named = true; });
});

$("codeForm").addEventListener("submit", e => {
  e.preventDefault();
  const c = $("codeInput").value.trim().toUpperCase();
  $("codeInput").value = "";
  const known = lobbyPeople().find(p => p.room === c && !p.priv);
  joinRoom(c, known?.roomName || "secret room", !known);
});

$("leaveBtn").onclick = () => leaveRoom();
$("copyLinkBtn").onclick = async () => {
  const url = location.origin + location.pathname + "#" + current.id;
  try { await navigator.clipboard.writeText(url); toast("copied! send it to your friends"); }
  catch { toast(url); }
};
$("editProfileBtn").onclick = async () => {
  if (current) await leaveRoom(true);
  openWelcome(false);
};
$("logoLink").onclick = e => { e.preventDefault(); if (profile) { if (current) leaveRoom(); else show("lobby"); } };
window.addEventListener("beforeunload", () => { if (roomCh) roomCh.untrack(); });

function openWelcome(first) {
  $("nameInput").value = profile?.name || "";
  $("locInput").value = profile?.location || "";
  if (!first) { $("welcomeTitle").textContent = "change your name"; $("welcomeSub").textContent = "this saves on this device, so you won't have to do it again."; }
  show("welcome");
  $("nameInput").focus();
}

/* ---------- boot ---------- */
(async function boot() {
  if (!profile) {
    openWelcome(true);
    // the device might be known to the server even if the profile was cleared from this browser
    const { data } = await sb.rpc("get_device", { p_id: deviceId });
    if (data?.name && !$("nameInput").value) { $("nameInput").value = data.name; $("locInput").value = data.location || ""; }
    connectLobby();
    return;
  }
  connectLobby();
  sb.rpc("touch_device", { p_id: deviceId, p_name: profile.name, p_location: profile.location || "" })
    .then(({ data }) => { if (data?.visits > 1) toast(`hey ${profile.name}, welcome back!`); });
  const hash = location.hash.slice(1);
  if (/^[A-Za-z0-9]{6}$/.test(hash)) joinRoom(hash, "secret room", true);
  else { show("lobby"); renderLobby(); }
})();
