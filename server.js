const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true, app: "La Olla de la Fortuna V2" }));

const rooms = new Map();
const MIN_TEAMS = 2;
const MAX_TEAMS = 10;

const DEFAULT_LOTS = [
  { id:"L1", icon:"🧠", category:"Salud", name:"Salud mental y manejo del estrés", description:"Acciones de prevención, acompañamiento y manejo saludable del estrés laboral.", start:15000, impact:5, priority:"Alta" },
  { id:"L2", icon:"🏃", category:"Salud", name:"Actividad física y hábitos saludables", description:"Programas que promueven movimiento, pausas activas y hábitos de vida saludable.", start:10000, impact:4, priority:"Alta" },
  { id:"L3", icon:"👨‍👩‍👧‍👦", category:"Familia", name:"Integración familiar", description:"Actividades que fortalecen la conciliación, integración y participación de las familias.", start:8000, impact:3, priority:"Media" },
  { id:"L4", icon:"💬", category:"Desarrollo", name:"Competencias socioemocionales", description:"Formación en comunicación, empatía, resolución de conflictos y autorregulación.", start:12000, impact:5, priority:"Alta" },
  { id:"L5", icon:"🌿", category:"Descanso", name:"Descanso y recuperación", description:"Iniciativas orientadas a recuperación, desconexión y equilibrio entre vida y trabajo.", start:7000, impact:4, priority:"Media" },
  { id:"L6", icon:"🏆", category:"Reconocimiento", name:"Reconocimiento al desempeño", description:"Estrategias de reconocimiento y valoración de los aportes de las personas.", start:9000, impact:3, priority:"Media" }
];

function cleanText(v, max = 2000) {
  return String(v ?? "").replace(/[<>]/g, "").trim().slice(0, max);
}
function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i=0;i<6;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function teamCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
function now() { return Date.now(); }

function createRoom(socket, setup={}) {
  let code = roomCode();
  while (rooms.has(code)) code = roomCode();
  const r = {
    code,
    instructorId: socket.id,
    activityName: cleanText(setup.activityName || "La Olla de la Fortuna", 100),
    budget: Math.max(1, Number(setup.budget) || 100000),
    minIncrement: Math.max(1, Number(setup.minIncrement) || 1000),
    lotDuration: Math.max(15, Number(setup.lotDuration) || 60),
    noConsecutive: !!setup.noConsecutive,
    teams: [],
    lots: Array.isArray(setup.lots) && setup.lots.length ? normalizeLots(setup.lots) : structuredClone(DEFAULT_LOTS),
    phase: "lobby",
    currentLot: -1,
    currentBid: 0,
    currentBidderId: null,
    bids: [],
    lotEndsAt: null,
    timer: null,
    awarded: [],
    createdAt: now()
  };
  rooms.set(code, r);
  socket.join(code);
  return r;
}
function normalizeLots(lots) {
  return lots.map((x,i)=>({
    id: cleanText(x.id || `L${i+1}`, 20),
    icon: cleanText(x.icon || "🎯", 8),
    category: cleanText(x.category || "Bienestar", 60),
    name: cleanText(x.name || `Necesidad ${i+1}`, 120),
    description: cleanText(x.description || "", 1000),
    start: Math.max(1, Number(x.start) || 1),
    impact: Math.min(5, Math.max(1, Number(x.impact) || 3)),
    priority: ["Alta","Media","Baja"].includes(x.priority) ? x.priority : "Media"
  }));
}
function teamPublic(t) {
  return {
    id:t.id, name:t.name, code:t.code, balance:t.balance, invested:t.invested,
    wins:t.wins, authenticated:t.authenticated, connected:t.connected,
    needs:t.needs.map(n=>({lotId:n.lotId,name:n.name,value:n.value,justification:n.justification,justificationAt:n.justificationAt}))
  };
}
function publicState(r) {
  const lot = r.lots[r.currentLot] || null;
  return {
    code:r.code, activityName:r.activityName, budget:r.budget,
    minIncrement:r.minIncrement, lotDuration:r.lotDuration, noConsecutive:r.noConsecutive,
    teams:r.teams.map(teamPublic),
    lots:r.lots, phase:r.phase, currentLot:r.currentLot,
    currentBid:r.currentBid, currentBidderId:r.currentBidderId,
    currentBidderName:r.teams.find(t=>t.id===r.currentBidderId)?.name || null,
    bids:r.bids.slice(-30), lotEndsAt:r.lotEndsAt,
    awarded:r.awarded, allAuthenticated:r.teams.length>=MIN_TEAMS && r.teams.every(t=>t.authenticated),
    currentLotData:lot
  };
}
function emitState(r) { io.to(r.code).emit("state", publicState(r)); }

function finishLot(r, reason="timer") {
  if (r.phase !== "auction") return;
  const lot = r.lots[r.currentLot];
  if (!lot) return;
  clearTimeout(r.timer); r.timer = null; r.lotEndsAt = null;

  const winner = r.teams.find(t=>t.id===r.currentBidderId);
  if (winner && r.currentBid >= lot.start) {
    const need = { lotId:lot.id, name:lot.name, value:r.currentBid, justification:"", justificationAt:null };
    winner.needs.push(need);
    winner.invested += r.currentBid;
    winner.balance -= r.currentBid;
    winner.wins += 1;
    r.awarded.push({ lotId:lot.id, lotName:lot.name, teamId:winner.id, teamName:winner.name, value:r.currentBid, justification:"", awardedAt:now() });
    r.phase = "justification";
    r.pendingJustification = { teamId:winner.id, lotId:lot.id, startedAt:now(), deadline:now()+60000 };
    emitState(r);
    io.to(r.code).emit("justificationStart", { teamId:winner.id, teamName:winner.name, lotId:lot.id, deadline:r.pendingJustification.deadline });
    r.timer = setTimeout(()=>autoCloseJustification(r), 60000);
  } else {
    r.phase = "between";
    emitState(r);
  }
}
function autoCloseJustification(r) {
  if (r.phase !== "justification" || !r.pendingJustification) return;
  const p = r.pendingJustification;
  const team = r.teams.find(t=>t.id===p.teamId);
  const need = team?.needs.find(n=>n.lotId===p.lotId);
  if (need) {
    need.justification = need.justification || "(Sin justificación registrada dentro del tiempo)";
    need.justificationAt = now();
    const a = r.awarded.find(x=>x.lotId===p.lotId && x.teamId===p.teamId && !x.justification);
    if (a) a.justification = need.justification;
  }
  r.pendingJustification = null; r.timer = null;
  r.phase = "between"; emitState(r);
}
function startNextLot(r) {
  if (r.phase === "finished") return;
  const next = r.currentLot + 1;
  if (next >= r.lots.length) {
    r.phase = "finished"; r.currentLot = r.lots.length;
    clearTimeout(r.timer); r.timer=null; r.lotEndsAt=null; emitState(r); return;
  }
  r.phase = "auction"; r.currentLot = next; r.currentBid = 0; r.currentBidderId = null; r.bids = [];
  r.lotEndsAt = now() + r.lotDuration*1000;
  emitState(r);
  clearTimeout(r.timer);
  r.timer = setTimeout(()=>finishLot(r,"timer"), r.lotDuration*1000);
  io.to(r.code).emit("auctionStart", {lotId:r.lots[next].id, endsAt:r.lotEndsAt});
}

io.on("connection", socket => {
  socket.on("createRoom", setup => {
    const r = createRoom(socket, setup || {});
    socket.data.role="instructor"; socket.data.room=r.code;
    socket.emit("roomCreated", {code:r.code, instructorId:r.instructorId});
    emitState(r);
  });

  socket.on("joinRoom", ({code,name,teamCode}) => {
    const r=rooms.get(String(code||"").toUpperCase().trim());
    if (!r) return socket.emit("errorMsg","No existe esa sala.");
    if (r.phase!=="lobby") return socket.emit("errorMsg","La sala ya inició la simulación.");
    name=cleanText(name,60);
    if (!name) return socket.emit("errorMsg","Escribe el nombre del equipo.");
    let t = r.teams.find(x=>x.code===String(teamCode||"").toUpperCase());
    if (!t) {
      if (r.teams.length>=MAX_TEAMS) return socket.emit("errorMsg","La sala ya tiene el máximo de 10 equipos.");
      t={id:teamCode(),name,code:teamCode(),balance:r.budget,invested:0,wins:0,authenticated:true,connected:true,socketId:socket.id,needs:[],reflections:[]};
      r.teams.push(t);
    } else {
      if (t.name!==name) return socket.emit("errorMsg","El código de equipo no corresponde a ese nombre.");
      t.connected=true; t.socketId=socket.id; t.authenticated=true;
    }
    socket.data.role="team"; socket.data.room=r.code; socket.data.teamId=t.id;
    socket.join(r.code); socket.emit("joined",{team:teamPublic(t), teamCode:t.code});
    emitState(r);
  });

  socket.on("reconnectTeam", ({code,teamCode,name})=>{
    const r=rooms.get(String(code||"").toUpperCase().trim());
    const t=r?.teams.find(x=>x.code===String(teamCode||"").toUpperCase() && x.name===name);
    if (!r || !t) return socket.emit("errorMsg","No fue posible reconectar el equipo.");
    t.connected=true; t.socketId=socket.id; t.authenticated=true;
    socket.data.role="team"; socket.data.room=r.code; socket.data.teamId=t.id; socket.join(r.code);
    socket.emit("joined",{team:teamPublic(t),teamCode:t.code}); emitState(r);
  });

  socket.on("configure", setup=>{
    const r=rooms.get(socket.data.room); if(!r || socket.data.role!=="instructor") return;
    if(r.phase!=="lobby") return socket.emit("errorMsg","No se puede configurar después de iniciar.");
    r.activityName=cleanText(setup.activityName||r.activityName,100);
    r.budget=Math.max(1,Number(setup.budget)||r.budget);
    r.minIncrement=Math.max(1,Number(setup.minIncrement)||r.minIncrement);
    r.lotDuration=Math.max(15,Number(setup.lotDuration)||r.lotDuration);
    r.noConsecutive=!!setup.noConsecutive;
    r.lots=normalizeLots(setup.lots||r.lots);
    r.teams.forEach(t=>{t.balance=r.budget;t.invested=0;t.wins=0;t.needs=[];t.reflections=[];});
    emitState(r);
  });

  socket.on("start",()=>{
    const r=rooms.get(socket.data.room); if(!r || socket.data.role!=="instructor") return;
    if(r.teams.length<MIN_TEAMS || !r.teams.every(t=>t.authenticated)) return socket.emit("errorMsg","Se requieren mínimo 2 equipos y todos deben estar autenticados.");
    r.currentLot=-1; r.phase="between"; emitState(r); startNextLot(r);
  });

  socket.on("nextLot",()=>{
    const r=rooms.get(socket.data.room); if(!r || socket.data.role!=="instructor") return;
    if(r.phase==="justification") return socket.emit("errorMsg","Espera o cierra la justificación.");
    if(r.phase==="between" || r.phase==="lobby") startNextLot(r);
  });

  socket.on("placeBid",({amount})=>{
    const r=rooms.get(socket.data.room); if(!r || socket.data.role!=="team" || r.phase!=="auction") return;
    const t=r.teams.find(x=>x.id===socket.data.teamId); const lot=r.lots[r.currentLot];
    if(!t || !lot) return;
    const value=Number(amount);
    const min=r.currentBid ? r.currentBid+r.minIncrement : lot.start;
    if(!Number.isFinite(value) || value<min) return socket.emit("errorMsg",`La puja mínima válida es ${min.toLocaleString("es-CO")}.`);
    if(value>t.balance) return socket.emit("errorMsg","No puedes pujar por encima de tu saldo disponible.");
    if(r.noConsecutive && r.currentBidderId===t.id) return socket.emit("errorMsg","No se permiten pujas consecutivas de un mismo equipo.");
    r.currentBid=value; r.currentBidderId=t.id;
    r.bids.push({teamId:t.id,teamName:t.name,amount:value,at:now()});
    emitState(r);
  });

  socket.on("endLot",()=>{
    const r=rooms.get(socket.data.room); if(!r || socket.data.role!=="instructor") return;
    finishLot(r,"manual");
  });

  socket.on("saveJustification",({text})=>{
    const r=rooms.get(socket.data.room); if(!r || socket.data.role!=="team" || r.phase!=="justification") return;
    const p=r.pendingJustification;
    if(!p || p.teamId!==socket.data.teamId) return socket.emit("errorMsg","Este equipo no tiene una justificación pendiente.");
    const t=r.teams.find(x=>x.id===p.teamId); const n=t?.needs.find(x=>x.lotId===p.lotId);
    if(!n) return;
    n.justification=String(text??"").trim(); n.justificationAt=now();
    const a=r.awarded.find(x=>x.lotId===p.lotId && x.teamId===p.teamId);
    if(a) a.justification=n.justification;
    clearTimeout(r.timer); r.timer=null; r.pendingJustification=null; r.phase="between";
    emitState(r); socket.emit("justificationSaved");
  });

  socket.on("saveReflections",({reflections})=>{
    const r=rooms.get(socket.data.room); if(!r || socket.data.role!=="team") return;
    const t=r.teams.find(x=>x.id===socket.data.teamId); if(!t) return;
    t.reflections=Array.isArray(reflections)?reflections.map(x=>cleanText(x,4000)):[];
    emitState(r);
  });

  socket.on("finishSimulation",()=>{
    const r=rooms.get(socket.data.room); if(!r || socket.data.role!=="instructor") return;
    if(r.phase==="justification") return socket.emit("errorMsg","Aún hay una justificación pendiente.");
    clearTimeout(r.timer); r.timer=null; r.lotEndsAt=null; r.phase="finished"; emitState(r);
  });

  socket.on("disconnect",()=>{
    const code=socket.data.room, r=rooms.get(code);
    if(!r) return;
    if(socket.data.role==="team"){
      const t=r.teams.find(x=>x.id===socket.data.teamId);
      if(t) t.connected=false;
      emitState(r);
    }
  });
});

function csvEscape(v) {
  const s=String(v??"").replace(/"/g,'""');
  return `"${s}"`;
}
app.get("/api/room/:code/export", (req,res)=>{
  const r=rooms.get(req.params.code.toUpperCase());
  if(!r) return res.status(404).send("Sala no encontrada");
  const rows=[["Equipo","Código","Necesidad","Valor adjudicado","Saldo final","% presupuesto usado","Justificación"]];
  r.teams.forEach(t=>{
    const pct=r.budget?((t.invested/r.budget)*100).toFixed(2):"0.00";
    if(!t.needs.length) rows.push([t.name,t.code,"","","",pct,""]);
    else t.needs.forEach(n=>rows.push([t.name,t.code,n.name,n.value,t.balance,pct,n.justification]));
  });
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",`attachment; filename="olla_fortuna_${r.code}.csv"`);
  res.send("\ufeff"+rows.map(row=>row.map(csvEscape).join(",")).join("\n"));
});

app.get("*", (_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

server.listen(PORT,"0.0.0.0",()=>console.log(`La Olla de la Fortuna V2 escuchando en ${PORT}`));
