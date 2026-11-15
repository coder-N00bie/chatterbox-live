import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const SUPABASE_URL = "https://oauwzvjxxcicegkkgdnl.supabase.co";
const SUPABASE_KEY = "sb_publishable_asHBwWLPE9cLOy3AbnWO9Q_GTs900Eo";
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
      else $("onlineCount").textContent = "reconnecting…";
    });
}

function lobbyPeople() {
  return Object.values(lobbyState).map(m => m[m.length - 1]).filter(Boolean);
}

function renderLobby() {
  const people = lobbyPeople();
  const devices = new Set(people.map(p => p.device));
  $("onlineCount").textContent = `${devices.size} online`;

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
    const btn = el("button", full ? "" : "primary", full ? "Full" : "Join");
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

async function joinRoom(id, name, priv) {
  id = clean(id, 6).toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(id)) return toast("Room codes are 6 letters/numbers.");
  if (current) await leaveRoom(true);

  current = { id, name: clean(name, 32) || "Private room", priv };
  myText = ""; texts = {}; members = []; slotEls = {};
  history.replaceState(null, "", "#" + id);
  $("roomTitle").textContent = current.name;
  $("roomMeta").textContent = `Room code ${id}${priv ? " · private" : ""}`;
  $("slots").replaceChildren();
  show("room");

  const joined = Date.now();
  roomCh = sb.channel("cbl-room-" + id, { config: { presence: { key: tabId }, broadcast: { self: false } } });
  roomCh
    .on("presence", { event: "sync" }, () => onRoomSync())
    .on("presence", { event: "join" }, ({ key }) => { if (key !== tabId) sendText(true); })
    .on("broadcast", { event: "text" }, ({ payload }) => onRemoteText(payload))
    .on("broadcast", { event: "meta" }, ({ payload }) => {
      // learn the real room name when joining by code/link
      if (payload?.name && current && current.name === "Private room" && !current.named) {
        current.name = clean(payload.name, 32); current.priv = !!payload.priv; current.named = true;
        $("roomTitle").textContent = current.name;
        $("roomMeta").textContent = `Room code ${current.id}${current.priv ? " · private" : ""}`;
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
    .filter(m => m.name)
    .sort((a, b) => a.joined - b.joined || a.key.localeCompare(b.key));
  const myIndex = members.findIndex(m => m.key === tabId);
  if (myIndex >= MAX_PER_ROOM) {
    toast("That room is full (5 max).");
    leaveRoom();
    return;
  }
  members = members.slice(0, MAX_PER_ROOM);
  // tell newcomers the room's name
  if (current && (current.named || current.name !== "Private room")) {
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
    const h = el("div", "slot-head"); h.append(el("span", "where", "empty seat"));
    e.append(h, el("div", "slot-body"));
    box.append(e);
  }
  $("roomMeta").textContent = `Room code ${current.id}${current.priv ? " · private" : ""} · ${members.length}/${MAX_PER_ROOM} here`;
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
    body.placeholder = "Start typing — everyone sees it live…";
    body.value = myText;
    body.addEventListener("input", () => { myText = body.value.slice(-MAX_TEXT); sendText(); });
    const clr = el("button", "ghost small", "Clear");
    clr.type = "button";
    clr.onclick = () => { body.value = ""; myText = ""; sendText(true); body.focus(); };
    tools.append(clr);
    setTimeout(() => body.focus(), 50);
  } else {
    body = el("div", "slot-body");
    const isMuted = muted.has(m.device);
    const mb = el("button", "ghost small", isMuted ? "Unmute" : "Mute");
    mb.type = "button";
    mb.onclick = () => {
      if (muted.has(m.device)) muted.delete(m.device); else muted.add(m.device);
      store.set("muted", [...muted]);
      mb.textContent = muted.has(m.device) ? "Unmute" : "Mute";
      paintRemote(m.key);
    };
    tools.append(mb);
  }
  slot.append(head, body);
  const s = { slot, body, dot, device: m.device };
  slotEls[m.key] = s;
  if (!me) paintRemote(m.key);
  return s;
}

function paintRemote(key) {
  const s = slotEls[key]; if (!s) return;
  if (muted.has(s.device)) { s.body.textContent = "(muted)"; s.body.classList.add("muted-text"); return; }
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
  history.replaceState(null, "", location.pathname);
  trackLobby();
  if (!silent) { show("lobby"); renderLobby(); }
}

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
  if (/^[A-Za-z0-9]{6}$/.test(pending)) joinRoom(pending, "Private room", true);
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
  joinRoom(c, known?.roomName || "Private room", !known);
});

$("leaveBtn").onclick = () => leaveRoom();
$("copyLinkBtn").onclick = async () => {
  const url = location.origin + location.pathname + "#" + current.id;
  try { await navigator.clipboard.writeText(url); toast("Invite link copied!"); }
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
  if (!first) { $("welcomeTitle").textContent = "Edit your name"; $("welcomeSub").textContent = "Changes are saved to this device."; }
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
    .then(({ data }) => { if (data?.visits > 1) toast(`Welcome back, ${profile.name}! (visit #${data.visits})`); });
  const hash = location.hash.slice(1);
  if (/^[A-Za-z0-9]{6}$/.test(hash)) joinRoom(hash, "Private room", true);
  else { show("lobby"); renderLobby(); }
})();
