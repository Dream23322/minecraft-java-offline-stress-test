// Minecraft bot farm with a local HTTP control API.
// Run: node engine.mjs     (needs: npm i mineflayer)
import http from "node:http"
import mineflayer from "mineflayer"
import { findPath } from "./pathfinder.mjs"

const CONTROL_HOST = "127.0.0.1"
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 8765)
const BRAIN_TICK_MS = 50
const MAX_LOG = 250

const config = {
  host: "127.0.0.1",
  port: 25565,
  count: 20,
  prefix: "lt_",
  version: "1.21.11",
  staggerMs: 1200,
  waitForPreviousSpawn: false,
  spawnWaitSeconds: 5,
  movement: true,
  viewDistance: "far",
  chatIntervalMs: 200000,
  chatChance: 0.5,
  autoReconnect: true,
  messages: ["gg", "anyone wanna duel", "brb", "how do i get coins", "lag"],
  realisticNames: true,
  wanderRadius: 20,
  lookSpeed: 1.0,
  sprintChance: 0.5,
  sneakChance: 0.15,
  actWalk: true,
  actLook: true,
  actJump: true,
  actSprint: true,
  actSneak: true,
  actSwing: true,
  actHotbar: true,
  actChat: true,
  spawnCommands: [],
  fingerprint: true,
  resourcePackMode: "accept",
  followChance: 0.15,
  followRadius: 5,
  followRealPlayers: true,
  followPlayer: "",
  pathfinding: true
}

const MOVEMENT_PACKETS = new Set(["position", "position_look", "look", "flying"])

const NAME_ADJ = ["Turnt","Twisted","Silly","Frosty","Salty","Sneaky","Mellow","Spicy","Cosmic","Feral","Lucky","Wavy","Zesty","Nifty","Dizzy","Soggy","Breezy","Snappy","Chill","Bold","Swift","Quiet","Grumpy","Funky","Witty"]
const NAME_NOUN = ["Turtle","Frog","Goober","Possum","Otter","Goblin","Llama","Badger","Muffin","Waffle","Nugget","Panda","Gecko","Beetle","Moose","Raven","Newt","Cricket","Custard","Pickle","Ferret","Racoon","Sloth","Crab","Yak"]
const NAME_SHORT = ["xvrq","qwop","zeph","moss","vibe","void","flux","glitch","noot","yolo","kazi","blip","nova","loom","zipz","puddle","snarf","bloop","qixz","tink"]

function pick(list) { return list[Math.floor(Math.random() * list.length)] }

function wrapYaw(yaw) { return Math.atan2(Math.sin(yaw), Math.cos(yaw)) }

function extractText(obj) {
  if (obj == null) return ""
  if (typeof obj === "string") return obj
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj)
  if (Array.isArray(obj)) return obj.map(extractText).join("")
  if (typeof obj === "object") {
    // NBT wrapper shapes like {type:"compound",value:{...}} / {type:"string",value:"..."}
    if (typeof obj.type === "string" && "value" in obj) return extractText(obj.value)
    let out = ""
    if (typeof obj.text === "string") out += obj.text
    if (typeof obj.text === "object" && obj.text !== null) out += extractText(obj.text)
    if (typeof obj.translate === "string") out += obj.translate
    else if (obj.translate != null && typeof obj.translate === "object") out += extractText(obj.translate)
    if (Array.isArray(obj.with)) out += " " + extractText(obj.with)
    if (Array.isArray(obj.extra)) out += extractText(obj.extra)
    for (const key of Object.keys(obj)) {
      if (key === "text" || key === "extra" || key === "translate" || key === "with" || key === "color" || key === "clickEvent" || key === "hoverEvent" || key === "font" || key === "insertion") continue
      const v = obj[key]
      if (typeof v === "object" && v !== null) out += extractText(v)
    }
    return out
  }
  return ""
}

function sanitizePlayer(v) {
  const s = String(v || "").trim()
  if (!/^[A-Za-z0-9_]{3,16}$/.test(s)) return ""
  return s
}

function reasonToString(reason) {
  if (typeof reason === "string") {
    const t = reason.trim()
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")) || (t.startsWith('"') && t.endsWith('"'))) {
      try {
        const parsed = JSON.parse(t)
        const s = extractText(parsed)
        if (s) return s
      } catch (e) {}
    }
    return reason.replace(/§./g, "")
  }
  if (reason != null && typeof reason === "object") {
    const s = extractText(reason).replace(/§./g, "")
    if (s) return s
    if (typeof reason.toString === "function") {
      try {
        const ts = reason.toString()
        if (ts && ts !== "[object Object]") return String(ts).replace(/§./g, "")
      } catch (e) {}
    }
    try {
      const js = JSON.stringify(reason)
      if (js && js !== "{}") return js
    } catch (e) {}
    return ""
  }
  return String(reason || "")
}

function formatKickReason(reason) {
  const detail = reasonToString(reason)
  const cleaned = detail.replace(/\s+/g, " ").slice(0, 200)
  const friendly = {
    "disconnect.closed": "server closed the connection (login refused?)",
    "disconnect.disconnected": "connection to server lost",
    "disconnect.kicked": "kicked from server",
    "multiplayer.disconnect.early_login": "kicked during login (early_login)",
    "multiplayer.disconnect.server_is_full": "server is full",
    "multiplayer.disconnect.invalid_session": "invalid session (auth)"
  }
  return friendly[cleaned] || cleaned || "unknown reason"
}

function clearControls(bot) {
  if (!bot || typeof bot.clearControlStates !== "function") return
  try { bot.clearControlStates() } catch (err) {}
}

function distXZ(a, b) { const dx = a.x - b.x, dz = a.z - b.z; return Math.sqrt(dx * dx + dz * dz) }

function hasCollisionFlagSupport(bot) {
  const lookDef = bot && bot.registry && bot.registry.protocol && bot.registry.protocol.play && bot.registry.protocol.play.toServer && bot.registry.protocol.play.toServer.types && bot.registry.protocol.play.toServer.types.packet_look
  return Array.isArray(lookDef) && lookDef[0] === "container" && Array.isArray(lookDef[1]) && lookDef[1].some(f => f.name === "flags")
}

function makeName(used) {
  if (!config.realisticNames) return null
  for (let attempt = 0; attempt < 60; attempt++) {
    let name
    const style = Math.random()
    if (style < 0.5) {
      const adj = pick(NAME_ADJ)
      const noun = pick(NAME_NOUN)
      const digits = 1 + Math.floor(Math.random() * 3)
      let suffix = ""
      for (let i = 0; i < digits; i++) suffix += Math.floor(Math.random() * 10)
      name = adj + noun + suffix
    } else if (style < 0.75) {
      const adj = pick(NAME_ADJ).toLowerCase()
      const noun = pick(NAME_NOUN).toLowerCase()
      let suffix = ""
      const digits = 1 + Math.floor(Math.random() * 2)
      for (let i = 0; i < digits; i++) suffix += Math.floor(Math.random() * 10)
      name = adj + "_" + noun + (Math.random() < 0.7 ? suffix : "")
    } else {
      if (Math.random() < 0.5) {
        let s = ""
        const len = 4 + Math.floor(Math.random() * 3)
        for (let i = 0; i < len; i++) s += String.fromCharCode(97 + Math.floor(Math.random() * 26))
        name = s
      } else {
        name = pick(NAME_SHORT)
        if (Math.random() < 0.5) {
          const d = 1 + Math.floor(Math.random() * 2)
          let suffix = ""
          for (let i = 0; i < d; i++) suffix += Math.floor(Math.random() * 10)
          name = name + suffix
        }
      }
    }
    if (name.length < 3) name = name + "xx"
    if (name.length > 16) name = name.slice(0, 16)
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) continue
    if (used.has(name)) continue
    used.add(name)
    return name
  }
  return null
}

function buildName(index, used) {
  if (config.realisticNames) {
    const n = makeName(used)
    if (n) return n
  }
  return `${config.prefix}${index}`
}

const bots = new Map()
const logLines = []
let running = false
let runId = 0
const LOOK_SENS = (0.15 * Math.PI) / 180

function log(line) {
  const stamp = new Date().toLocaleTimeString()
  logLines.push(`${stamp}  ${line}`)
  if (logLines.length > MAX_LOG) logLines.shift()
}

const brains = {
  makePersona() {
    const sprintBase = Math.random()
    const sneakBase = Math.random()
    const lookBase = 0.025 + Math.random() * 0.07
    const followBase = Math.random()
    return {
      walkBias: 0.35 + Math.random() * 0.4,
      walkMinMs: 1800,
      walkMaxMs: 7000,
      idleMinMs: 1200,
      idleMaxMs: 5000,
      sprintBase,
      sneakBase,
      lookBase,
      followBase,
      sprintBias: sprintBase * (config.sprintChance || 0.5),
      sneakBias: sneakBase * (config.sneakChance || 0.15),
      followBias: followBase * (config.followChance || 0.15),
      strafeBias: Math.random() * 0.3,
      jumpBias: Math.random() * 0.35,
      lookSpeed: lookBase * (config.lookSpeed || 1),
      glanceChance: 0.2 + Math.random() * 0.3,
      flickChance: 0.06 + Math.random() * 0.15,
      scanMs: 200 + Math.floor(Math.random() * 200)
    }
  }
}

function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)) }

// Client-identity fingerprint (per spawn). Stored on rec for the detail window.
const LOCALES_WEIGHTED = [
  ["en_US", 0.55], ["en_GB", 0.12], ["de_DE", 0.06], ["fr_FR", 0.05], ["es_ES", 0.04],
  ["pt_BR", 0.04], ["ru_RU", 0.04], ["zh_CN", 0.04], ["ja_JP", 0.03], ["ko_KR", 0.02], ["nl_NL", 0.01]
]

function weightedPick(list) {
  let roll = Math.random()
  for (const [value, weight] of list) {
    if (roll < weight) return value
    roll -= weight
  }
  return list[0][0]
}

function buildFingerprint() {
  if (!config.fingerprint) return null
  const skinParts = {
    showCape: Math.random() < 0.7,
    showJacket: Math.random() < 0.85,
    showLeftSleeve: Math.random() < 0.92,
    showRightSleeve: Math.random() < 0.92,
    showLeftPants: Math.random() < 0.9,
    showRightPants: Math.random() < 0.9,
    showHat: Math.random() < 0.85
  }
  return {
    locale: weightedPick(LOCALES_WEIGHTED),
    skinParts,
    mainHand: Math.random() < 0.85 ? "right" : "left",
    chat: Math.random() < 0.85 ? "enabled" : "commandsOnly",
    colorsEnabled: Math.random() < 0.95,
    enableTextFiltering: Math.random() < 0.1,
    enableServerListing: Math.random() < 0.9,
    particleStatus: weightedPick([["all", 0.6], ["decreased", 0.3], ["minimal", 0.1]])
  }
}

function isHerdMode() {
  return sanitizePlayer(config.followPlayer) !== ""
}

// Apply settings that can change while bots are already connected.
function applyLiveConfig(oldConfig) {
  const now = Date.now()
  const chatChanged = oldConfig.chatIntervalMs !== config.chatIntervalMs
  for (const rec of bots.values()) {
    const p = rec.persona
    if (p) {
      if (typeof p.sprintBase !== "number") p.sprintBase = 0.5
      if (typeof p.sneakBase !== "number") p.sneakBase = 0.5
      if (typeof p.lookBase !== "number") p.lookBase = 0.05
      if (typeof p.followBase !== "number") p.followBase = 0.5
      p.sprintBias = p.sprintBase * clamp01(config.sprintChance)
      p.sneakBias = p.sneakBase * clamp01(config.sneakChance)
      p.followBias = p.followBase * clamp01(config.followChance)
      p.lookSpeed = p.lookBase * Math.max(0.1, Number(config.lookSpeed) || 1)
      rec.lookSpeedNow = p.lookSpeed
    }
    if (!config.actSneak || !config.movement) rec.sneaking = false
    if (!config.actSprint || !config.movement) rec.sprinting = false
    if (!config.movement || clamp01(config.followChance) === 0) {
      if (rec.mode === "follow") { rec.followPoint = null; rec.followTargetName = ""; rec.mode = "idle"; rec.modeUntil = now + 800; clearControls(rec.bot) }
    }
    if (chatChanged) {
      const ceiling = now + Math.max(1000, Number(config.chatIntervalMs) || 200000) * 0.7
      if (!rec.nextChatAt || rec.nextChatAt > ceiling) rec.nextChatAt = now + Math.floor(Math.random() * 1500)
    }
    if (!config.movement && rec.state === "spawned" && rec.bot) {
      clearControls(rec.bot)
      rec.mode = "idle"
      rec.modeUntil = now + 1500
      rec.waypoint = null
    }
    if (!config.pathfinding && rec.path) clearPath(rec)
  }
  // Herd mode: retarget every spawned bot to the pinned player right away.
  if (isHerdMode()) {
    for (const rec of bots.values()) {
      if (rec.state !== "spawned" || !rec.bot || !rec.bot.entity || !rec.bot.entity.position) continue
      rec.composureUntil = 0
      startFollow(rec, rec.bot, Date.now())
    }
  }
}

function installPacketIO(rec) {
  const bot = rec.bot
  const client = bot._client
  const origWrite = client.write.bind(client)
  const supportsTickEnd = bot.supportFeature("sendsClientTickEndPacket")
  const usesPlayerInput = bot.supportFeature("newPlayerInputPacket")
  const sneakUsesEntityAction = bot.supportFeature("sneakUsesEntityAction")
  const usesCollisionFlag = hasCollisionFlagSupport(bot)
  rec.io = { origWrite, supportsTickEnd, usesPlayerInput, sneakUsesEntityAction, usesCollisionFlag }
  rec.lastInputKey = ""
  rec.lastSprint = false
  rec.lastSneak = false
  rec.tickEndPending = false

  client.write = (name, params) => {
    if (rec.state !== "spawned") return origWrite(name, params)

    if (MOVEMENT_PACKETS.has(name)) {
      try {
        if (usesCollisionFlag && params && params.flags && typeof params.flags === "object") {
          params.flags.onGround = !!(params.flags.onGround)
          params.flags.hasHorizontalCollision = !!(bot.entity && bot.entity.isCollidedHorizontally)
        }
      } catch (err) {}
      origWrite(name, params)
      if (supportsTickEnd) { origWrite("tick_end", {}); rec.tickEndPending = false }
      return
    }
    if (name === "tick_end") return
    if (name === "player_input") return
    if (name === "entity_action") {
      const action = params && params.actionId
      if (action === "start_sprinting" || action === "stop_sprinting" ||
          action === "start_sneaking" || action === "stop_sneaking" ||
          action === 0 || action === 1 || action === 3 || action === 4) return
    }
    return origWrite(name, params)
  }

  bot.on("physicsTick", () => onPhysicsTick(rec))
}

function onPhysicsTick(rec) {
  const bot = rec.bot
  const io = rec.io
  if (!io || rec.state !== "spawned" || !bot || !bot.entity) return

  if (io.supportsTickEnd && rec.tickEndPending) {
    io.origWrite("tick_end", {})
    rec.tickEndPending = false
  }

  sendInput(rec, bot, io)
  sendActions(rec, bot, io)

  rec.tickEndPending = io.supportsTickEnd
}

function sendInput(rec, bot, io) {
  if (!io.usesPlayerInput) return
  const cs = bot.controlState || {}
  const cur = {
    forward: !!cs.forward, backward: !!cs.back, left: !!cs.left, right: !!cs.right,
    jump: !!cs.jump, shift: !!cs.sneak, sprint: !!cs.sprint
  }
  const key = `${cur.forward}${cur.backward}${cur.left}${cur.right}${cur.jump}${cur.shift}${cur.sprint}`
  if (key === rec.lastInputKey) return
  rec.lastInputKey = key
  try {
    io.origWrite("player_input", { inputs: { forward: cur.forward, backward: cur.backward, left: cur.left, right: cur.right, jump: cur.jump, shift: cur.shift, sprint: cur.sprint } })
  } catch (err) {}
}

function sendActions(rec, bot, io) {
  try {
    const wantSprint = !!bot.getControlState("sprint")
    if (wantSprint !== rec.lastSprint) {
      rec.lastSprint = wantSprint
      io.origWrite("entity_action", { entityId: bot.entity.id, actionId: wantSprint ? "start_sprinting" : "stop_sprinting", jumpBoost: 0 })
    }
    if (io.sneakUsesEntityAction) {
      const wantSneak = !!bot.getControlState("sneak")
      if (wantSneak !== rec.lastSneak) {
        rec.lastSneak = wantSneak
        io.origWrite("entity_action", { entityId: bot.entity.id, actionId: wantSneak ? "start_sneaking" : "stop_sneaking", jumpBoost: 0 })
      }
    }
  } catch (err) {}
}

function resetBrain(rec, bot, now) {
  rec.persona = rec.persona || brains.makePersona()
  rec.mode = "born"
  rec.modeUntil = now + 700 + Math.floor(Math.random() * 1200)
  rec.waypoint = null
  rec.gazeYaw = wrapYaw(bot.entity ? bot.entity.yaw : 0)
  rec.gazePitch = 0
  rec.nextGazePick = now
  rec.nextScanAt = now
  rec.nextStuckAt = now + 1000
  rec.lastStuckPos = null
  rec.stuckCount = 0
  rec.jumpUntil = 0
  rec.strafeUntil = 0
  rec.composureUntil = sanitizePlayer(config.followPlayer) ? now : now + 700
  rec.path = null
  rec.pathIdx = 0
  rec.pathTarget = null
  rec.pathPending = false
  rec.pathLastTry = 0
  rec.pathFailAt = 0
  rec.nextSprintRoll = now + 1000
  rec.sprinting = false
  rec.sneaking = false
  rec.strafeDir = "left"
  rec.walkStart = 0
  rec.hazard = null
  rec.lastInputKey = ""
  rec.lastSprint = false
  rec.lastSneak = false
  rec.tickEndPending = false
  rec.lookSpeedNow = rec.persona.lookSpeed
  rec.followPoint = null
  rec.followTargetName = ""
  rec.nextFollowRefresh = 0
  rec.anchor = bot.entity && bot.entity.position ? { x: bot.entity.position.x, z: bot.entity.position.z, y: bot.entity.position.y } : { x: 0, z: 0, y: 0 }
}

function yawBetween(ax, az, bx, bz) { return Math.atan2(-(bx - ax), -(bz - az)) }

function updateBrain(rec, bot, now) {
  if (rec.bot !== bot || !bot.entity || !bot.entity.position) return
  const pos = bot.entity.position

  if (rec.composureUntil > now) {
    clearControls(bot)
    rec.gazeYaw = wrapYaw(bot.entity.yaw)
    rec.gazePitch = 0
    return
  }

  if (now >= rec.nextScanAt) { rec.nextScanAt = now + rec.persona.scanMs; scanWorld(rec, bot) }

  if (isHerdMode()) {
    // Every bot follows the pinned player for as long as one is set.
    if (rec.mode !== "follow" || now >= rec.modeUntil) {
      if (!startFollow(rec, bot, now)) { rec.mode = "idle"; rec.modeUntil = now + 1000 }
    }
  } else if (now >= rec.modeUntil) chooseMode(rec, bot, now)

  if (rec.mode === "follow") {
    if (now >= rec.nextFollowRefresh) {
      rec.nextFollowRefresh = now + 800 + Math.floor(Math.random() * 700)
      const pt = pickFollowPoint(bot)
      // Keep a stable ring slot unless the player actually moved — otherwise
      // every refresh invalidates the path and the herd re-paths constantly.
      if (pt && (!rec.followPoint || Math.hypot(pt.x - rec.followPoint.x, pt.z - rec.followPoint.z) > 3.5)) {
        rec.followPoint = { x: pt.x, z: pt.z }
        rec.followTargetName = pt.name
        clearPath(rec)
      }
    }
    if (rec.followPoint) rec.waypoint = { x: rec.followPoint.x, z: rec.followPoint.z }
  }

  if (rec.mode === "walk" || rec.mode === "follow") walkStep(rec, bot, now)
  else idleStep(rec, bot, now)

  stepGaze(rec, bot, now)
}

function scanWorld(rec, bot) {
  rec.hazard = null
  const pos = bot.entity.position
  if (!Number.isFinite(pos.x)) return
  const blockAt = (v) => { try { return bot.blockAt(v, false) } catch (e) { return null } }
  if (blockAt(pos) == null) { rec.hazard = "unloaded"; return }
  let yaw = bot.entity.yaw
  if (typeof rec.navX === "number" && typeof rec.navZ === "number") yaw = yawBetween(pos.x, pos.z, rec.navX, rec.navZ)
  else if (rec.mode === "walk" && rec.waypoint) yaw = yawBetween(pos.x, pos.z, rec.waypoint.x, rec.waypoint.z)
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw)
  const feet1 = blockAt(pos.offset(fx * 0.7, 0, fz * 0.7))
  const feet2 = blockAt(pos.offset(fx * 1.7, 0, fz * 1.7))
  const head1 = blockAt(pos.offset(fx * 0.7, 1, fz * 0.7))
  const head2 = blockAt(pos.offset(fx * 1.7, 1, fz * 1.7))
  const solid = (b) => b != null && b.boundingBox !== "empty"
  if (solid(head1) || solid(head2)) rec.hazard = "blocked"
  else if (solid(feet1) || solid(feet2)) rec.hazard = "step"
  if (feet1 && /water|lava/.test(feet1.name || "")) rec.hazard = "waterAhead"
  if (feet2 && /water|lava/.test(feet2.name || "")) rec.hazard = "waterAhead"
  let ground = false
  for (let i = 1; i <= 4; i++) {
    const b = blockAt(pos.offset(fx * 1.2, -i, fz * 1.2))
    if (solid(b)) { ground = true; break }
  }
  if (!ground && !solid(feet1)) rec.hazard = "cliff"
  if (bot.entity.isInWater) rec.hazard = "inWater"
}

function chooseMode(rec, bot, now) {
  if (rec.mode === "born" || rec.mode === "idle") {
    if (Math.random() < rec.persona.followBias && config.movement && startFollow(rec, bot, now)) return
    if (Math.random() < rec.persona.walkBias) startWalk(rec, bot, now)
    else { rec.mode = "idle"; rec.modeUntil = now + rec.persona.idleMinMs + Math.floor(Math.random() * (rec.persona.idleMaxMs - rec.persona.idleMinMs)); rec.sneaking = false; if (config.actSneak && Math.random() < rec.persona.sneakBias) { rec.sneaking = true; rec.modeUntil = now + 1200 + Math.floor(Math.random() * 2000) } }
  } else {
    rec.mode = "idle"
    rec.modeUntil = now + rec.persona.idleMinMs + Math.floor(Math.random() * (rec.persona.idleMaxMs - rec.persona.idleMinMs))
    rec.sneaking = false
    if (config.actSneak && Math.random() < rec.persona.sneakBias) { rec.sneaking = true; rec.modeUntil = now + 1200 + Math.floor(Math.random() * 2000) }
    clearControls(bot)
  }
}

function pickFollowPoint(bot) {
  const pos = bot.entity.position
  // Pinned player: herd bots to this specific player when one is set.
  const pinned = sanitizePlayer(config.followPlayer)
  if (pinned) {
    let target = null
    try {
      for (const id in bot.entities) {
        const ent = bot.entities[id]
        if (!ent || ent.type !== "player" || ent.id === bot.entity.id || !ent.position) continue
        if (ent.username === pinned) { target = ent.position; break }
      }
    } catch (e) {}
    if (target) {
      const d = distXZ(pos, target)
      if (d < 300) {
        const a = Math.random() * Math.PI * 2
        const r = 1.5 + Math.random() * Math.max(0.5, Number(config.followRadius) || 5)
        return { x: target.x + Math.cos(a) * r, z: target.z + Math.sin(a) * r, name: pinned }
      }
    }
    // pinned player offline/too far -> fall through to random follow
  }
  const targets = []
  for (const other of bots.values()) {
    if (!other.bot || !other.bot.entity || !other.bot.entity.position) continue
    if (other.bot === bot) continue
    if (other.state !== "spawned") continue
    const d = distXZ(pos, other.bot.entity.position)
    if (d > 1.5 && d < 18) targets.push({ x: other.bot.entity.position.x, z: other.bot.entity.position.z, name: other.name })
  }
  if (config.followRealPlayers !== false) {
    try {
      for (const id in bot.entities) {
        const ent = bot.entities[id]
        if (!ent || ent.type !== "player" || ent.id === bot.entity.id || !ent.position) continue
        if (bots.has(ent.username)) continue
        const d = distXZ(pos, ent.position)
        if (d > 1.5 && d < 18) targets.push({ x: ent.position.x, z: ent.position.z, name: ent.username || "player" })
        if (targets.length > 12) break
      }
    } catch (e) {}
  }
  if (!targets.length) return null
  const t = pick(targets)
  const a = Math.random() * Math.PI * 2
  const r = 1.5 + Math.random() * Math.max(0.5, Number(config.followRadius) || 5)
  return { x: t.x + Math.cos(a) * r, z: t.z + Math.sin(a) * r, name: t.name }
}

function startFollow(rec, bot, now) {
  const pt = pickFollowPoint(bot)
  if (!pt) return false
  rec.followPoint = { x: pt.x, z: pt.z }
  rec.followTargetName = pt.name
  rec.waypoint = { x: pt.x, z: pt.z }
  clearPath(rec)
  rec.mode = "follow"
  rec.modeUntil = now + 4000 + Math.floor(Math.random() * 6000)
  rec.walkStart = now
  rec.nextFollowRefresh = now + 800
  rec.nextSprintRoll = now + 600 + Math.floor(Math.random() * 1200)
  rec.sprinting = false
  rec.stuckCount = 0
  rec.lastStuckPos = { x: bot.entity.position.x, z: bot.entity.position.z }
  rec.nextStuckAt = now + 1000
  return true
}

function startWalk(rec, bot, now) {
  pickWaypoint(rec, bot)
  clearPath(rec)
  rec.mode = "walk"
  rec.modeUntil = now + rec.persona.walkMinMs + Math.floor(Math.random() * (rec.persona.walkMaxMs - rec.persona.walkMinMs))
  rec.walkStart = now
  rec.nextSprintRoll = now + 600 + Math.floor(Math.random() * 1200)
  rec.sprinting = false
  rec.stuckCount = 0
  rec.lastStuckPos = { x: bot.entity.position.x, z: bot.entity.position.z }
  rec.nextStuckAt = now + 1000
}

function pickWaypoint(rec, bot) {
  const pos = bot.entity.position
  const anchor = rec.anchor
  const radius = config.wanderRadius || 20
  let cx, cz
  const distHome = distXZ(pos, anchor)
  if (distHome > radius * 0.8) {
    const a = Math.random() * Math.PI * 2
    const r = 2 + Math.random() * (radius * 0.25)
    cx = anchor.x + Math.cos(a) * r
    cz = anchor.z + Math.sin(a) * r
  } else {
    const a = Math.random() * Math.PI * 2
    const r = 4 + Math.random() * (radius * 0.4)
    cx = pos.x + Math.cos(a) * r
    cz = pos.z + Math.sin(a) * r
    const d = distXZ({ x: cx, z: cz }, anchor)
    if (d > radius) { const s = radius / d; cx = anchor.x + (cx - anchor.x) * s; cz = anchor.z + (cz - anchor.z) * s }
  }
  rec.waypoint = { x: cx, z: cz }
}

function startIdle(rec, bot, now) {
  rec.mode = "idle"
  rec.followPoint = null
  rec.followTargetName = ""
  clearPath(rec)
  rec.modeUntil = now + rec.persona.idleMinMs + Math.floor(Math.random() * (rec.persona.idleMaxMs - rec.persona.idleMinMs))
  rec.sneaking = false
  if (config.actSneak && Math.random() < rec.persona.sneakBias) { rec.sneaking = true; rec.modeUntil = now + 1200 + Math.floor(Math.random() * 2000) }
  clearControls(bot)
  rec.nextGazePick = now
}

function clearPath(rec) {
  rec.path = null
  rec.pathIdx = 0
  rec.pathPending = false
  rec.navX = undefined
  rec.navZ = undefined
}

// Point ~2 blocks ahead of the bot along its planned path (interpolated
// between nodes). Steering at this instead of the next cell is what makes
// mob movement curve like a living thing rather than a staircase.
function lookAheadPoint(rec, pos) {
  if (!rec.path || rec.pathIdx >= rec.path.length) return null
  let acc = 0
  let prevX = pos.x, prevZ = pos.z
  for (let i = rec.pathIdx; i < rec.path.length; i++) {
    const n = rec.path[i]
    const nx = n.x + 0.5, nz = n.z + 0.5
    const seg = Math.hypot(nx - prevX, nz - prevZ)
    if (acc + seg >= 2.0) {
      const t = seg > 0 ? (2.0 - acc) / seg : 0
      return { x: prevX + (nx - prevX) * t, z: prevZ + (nz - prevZ) * t }
    }
    acc += seg
    prevX = nx
    prevZ = nz
  }
  const last = rec.path[rec.path.length - 1]
  return { x: last.x + 0.5, z: last.z + 0.5 }
}

// ---- Pathfinding (A* over the loaded voxel grid) ----
// Requests are queued FIFO and processed a few per brain tick so 100 bots
// re-pathing at once can't stall the event loop. While a bot waits, it
// steers straight at its destination (which is fine at short range).
const PATH_BUDGET_PER_TICK = 2
const pathQueue = []

function enqueuePath(rec) {
  if (rec.pathPending || !rec.bot || !rec.bot.entity || !rec.bot.entity.position) return
  if (pathQueue.length > 400) return
  rec.pathPending = true
  pathQueue.push(rec)
}

function makeBlockAt(bot) {
  const Vec3Ctor = bot.entity.position.constructor
  return (x, y, z) => {
    let b = null
    try { b = bot.blockAt(new Vec3Ctor(x + 0.5, y, z + 0.5), false) } catch (e) { return null }
    if (!b) return null
    const name = b.name || ""
    const fluid = /water|lava/.test(name)
    const lava = /lava|fire/.test(name)
    return { solid: b.boundingBox === "block", fluid, lava }
  }
}

function processPathQueue(now) {
  let budget = PATH_BUDGET_PER_TICK
  while (budget-- > 0 && pathQueue.length) {
    const rec = pathQueue.shift()
    rec.pathPending = false
    const bot = rec.bot
    if (!bot || rec.state !== "spawned") continue
    if (rec.mode !== "walk" && rec.mode !== "follow") continue
    if (!rec.waypoint || !bot.entity || !bot.entity.position) continue
    if (!config.pathfinding) continue
    rec.pathLastTry = now
    const pos = bot.entity.position
    let path = null
    try { path = findPath(makeBlockAt(bot), { x: pos.x, y: pos.y, z: pos.z }, rec.waypoint) } catch (e) { path = null }
    rec.path = path
    rec.pathIdx = 0
    rec.pathTarget = path ? { x: rec.waypoint.x, z: rec.waypoint.z } : null
    if (!path) rec.pathFailAt = now
  }
}

function retargetLocked(rec, bot, now) {
  const pt = pickFollowPoint(bot)
  if (pt) {
    rec.followPoint = { x: pt.x, z: pt.z }
    rec.followTargetName = pt.name
    rec.waypoint = { x: pt.x, z: pt.z }
    rec.modeUntil = now + 4000 + Math.floor(Math.random() * 4000)
    rec.nextFollowRefresh = now + 800
    return true
  }
  rec.mode = "idle"
  rec.modeUntil = now + 1000
  return false
}

function walkStep(rec, bot, now) {
  if (!config.actWalk) { startIdle(rec, bot, now); return }
  const locked = rec.mode === "follow"
  const pos = bot.entity.position
  const wp = rec.waypoint
  if (!wp) {
    if (locked) retargetLocked(rec, bot, now)
    else pickWaypoint(rec, bot)
    return
  }
  const dx = wp.x - pos.x, dz = wp.z - pos.z
  const dist = Math.hypot(dx, dz)

  // Request a path when we don't have one (or it has gone stale). The queue
  // runs a few A* computes per brain tick, so a whole herd re-pathing at
  // once stays smooth. While waiting, steer straight at the destination.
  if (config.pathfinding && !rec.pathPending && now - rec.pathFailAt > 2000) {
    const targetStale = rec.pathTarget && distXZ(rec.pathTarget, wp) > 4
    const exhausted = rec.path ? rec.pathIdx >= rec.path.length : false
    if (!rec.path || targetStale || exhausted || now - rec.pathLastTry > 30000) enqueuePath(rec)
  }

  // Where to actually steer: a look-ahead point on the planned path, like
  // vanilla mobs aiming well ahead of themselves so movement curves instead
  // of snapping between cells. Falls back to the raw destination while a
  // path is still being computed.
  let navX = wp.x, navZ = wp.z, navUp = false
  if (rec.path && rec.pathIdx < rec.path.length) {
    const node = rec.path[rec.pathIdx]
    navUp = node.y > pos.y + 0.6
    if (Math.hypot(node.x + 0.5 - pos.x, node.z + 0.5 - pos.z) < 0.7) rec.pathIdx++
    const la = lookAheadPoint(rec, pos)
    if (la) { navX = la.x; navZ = la.z }
  }
  rec.navX = navX
  rec.navZ = navZ

  if (dist < 1.3 || now >= rec.modeUntil) {
    if (locked) {
      if (now >= rec.modeUntil) { retargetLocked(rec, bot, now); return }
      // arrived: hold near the target and face it, re-pick a ring slot shortly
      rec.modeUntil = now + 2000
      clearControls(bot)
      if (now >= rec.nextGazePick) {
        const wpYaw = yawBetween(pos.x, pos.z, wp.x, wp.z)
        rec.gazeYaw = wrapYaw(wpYaw + (Math.random() - 0.5) * 0.6)
        rec.gazePitch = (Math.random() - 0.5) * 0.3
        rec.lookSpeedNow = rec.persona.lookSpeed
        rec.nextGazePick = now + 1200 + Math.floor(Math.random() * 2000)
      }
      return
    }
    startIdle(rec, bot, now); return
  }

  // Vanilla mobs rotate gradually into their movement direction.
  const curYaw = bot.entity.yaw
  let yawDiff = wrapYaw(yawBetween(pos.x, pos.z, navX, navZ) - curYaw)
  const TURN_CAP = 0.55
  if (yawDiff > TURN_CAP) yawDiff = TURN_CAP
  else if (yawDiff < -TURN_CAP) yawDiff = -TURN_CAP
  const wantYaw = wrapYaw(curYaw + yawDiff)
  const facing = Math.abs(yawDiff) < 1.0

  clearControls(bot)
  if (facing) bot.setControlState("forward", true)

  if (rec.hazard === "unloaded") { startIdle(rec, bot, now); return }
  if (!rec.path) {
    // No path yet (computing or unreachable): reactive re-targets.
    if (rec.hazard === "cliff" && dist > 1.6) {
      if (locked) { retargetLocked(rec, bot, now); return }
      pickWaypoint(rec, bot); return
    }
    if (rec.hazard === "waterAhead" && dist > 1.6) {
      if (locked) { retargetLocked(rec, bot, now); return }
      pickWaypoint(rec, bot); return
    }
  }
  if (navUp && bot.entity.onGround && config.actJump) {
    if (now > rec.jumpUntil) { rec.jumpUntil = now + 200; bot.setControlState("jump", true) }
  }
  if (rec.hazard === "blocked" && bot.entity.isCollidedHorizontally && bot.entity.onGround && config.actJump) {
    if (now > rec.jumpUntil) { rec.jumpUntil = now + 200; bot.setControlState("jump", true) }
  } else if (rec.hazard === "step" && dist < 1.8 && bot.entity.onGround && config.actJump) {
    if (now > rec.jumpUntil) { rec.jumpUntil = now + 200; bot.setControlState("jump", true) }
  }
  if (rec.hazard === "inWater" && config.actJump) {
    if (now > rec.jumpUntil) { rec.jumpUntil = now + 300; bot.setControlState("jump", true) }
  }

  if (now >= rec.nextSprintRoll) {
    rec.nextSprintRoll = now + 1500 + Math.floor(Math.random() * 2500)
    rec.sprinting = Math.random() < rec.persona.sprintBias
  }
  const sprintOk = rec.sprinting && config.actSprint && bot.food > 6 && !rec.sneaking &&
    !bot.entity.isInWater && !bot.entity.isCollidedHorizontally && facing && (now - rec.walkStart > 600) &&
    rec.hazard !== "blocked"
  bot.setControlState("sprint", sprintOk)

  if (now > rec.strafeUntil) {
    if (Math.random() < rec.persona.strafeBias) {
      rec.strafeDir = Math.random() < 0.5 ? "left" : "right"
      rec.strafeUntil = now + 400 + Math.floor(Math.random() * 900)
    } else {
      rec.strafeUntil = now + 1500 + Math.floor(Math.random() * 2000)
    }
  }
  if (now < rec.strafeUntil && facing) bot.setControlState(rec.strafeDir, true)

  if (config.actSneak && rec.sneaking) {
    bot.setControlState("sneak", true)
    bot.setControlState("sprint", false)
  } else {
    bot.setControlState("sneak", false)
  }

  if (now >= rec.nextStuckAt) {
    rec.nextStuckAt = now + 1000
    const lp = rec.lastStuckPos
    const moved = distXZ(pos, lp)
    if (moved < 0.25 && bot.getControlState("forward")) {
      rec.stuckCount++
      if (rec.stuckCount >= 1 && bot.entity.onGround && config.actJump) {
        if (now > rec.jumpUntil) { rec.jumpUntil = now + 200; bot.setControlState("jump", true) }
      }
      if (rec.stuckCount >= 3) {
        // With a path, re-path (keep the same destination) rather than
        // bailing to a new one; only re-pick a destination when there was
        // never a path to follow.
        if (rec.path) {
          rec.path = null
          enqueuePath(rec)
        } else if (locked) {
          retargetLocked(rec, bot, now)
        } else {
          pickWaypoint(rec, bot)
        }
        rec.stuckCount = 0
      }
    } else {
      rec.stuckCount = 0
    }
    rec.lastStuckPos = { x: pos.x, z: pos.z }
  }
  if (now > rec.jumpUntil) bot.setControlState("jump", false)

  if (now >= rec.nextGazePick) {
    const wpYaw = yawBetween(pos.x, pos.z, navX, navZ)
    rec.gazeYaw = wrapYaw(wpYaw + (Math.random() - 0.5) * 0.3)
    rec.gazePitch = (Math.random() - 0.5) * 0.35
    rec.lookSpeedNow = rec.persona.lookSpeed * (Math.random() < rec.persona.flickChance ? 2.2 : 1)
    rec.nextGazePick = now + 300 + Math.floor(Math.random() * 700)
  }
}

function idleStep(rec, bot, now) {
  clearControls(bot)
  if (config.actSneak && rec.sneaking) bot.setControlState("sneak", true)

  if (now >= rec.nextGazePick) {
    let yawT = rec.gazeYaw, pitchT = rec.gazePitch
    const persona = rec.persona
    const roll = Math.random()
    if (roll < persona.glanceChance) {
      const ent = glanceTarget(bot)
      if (ent) {
        const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
        const target = ent.position.offset(0, (ent.height || 1.8) * 0.9, 0)
        const dx = target.x - eye.x, dz = target.z - eye.z, dy = target.y - eye.y
        yawT = Math.atan2(-dx, -dz)
        pitchT = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz))
        rec.lookSpeedNow = persona.lookSpeed * 2.0
        rec.nextGazePick = now + 900 + Math.floor(Math.random() * 2200)
      } else {
        yawT = wrapYaw(bot.entity.yaw + (Math.random() - 0.5) * 1.4)
        pitchT = (Math.random() - 0.5) * 0.9
        rec.lookSpeedNow = persona.lookSpeed * (Math.random() < persona.flickChance ? 2.2 : 1)
        rec.nextGazePick = now + 700 + Math.floor(Math.random() * 2200)
      }
    } else {
      yawT = wrapYaw(rec.gazeYaw + (Math.random() - 0.5) * 0.6)
      pitchT = (Math.random() - 0.5) * 0.6
      rec.lookSpeedNow = persona.lookSpeed
      rec.nextGazePick = now + 1200 + Math.floor(Math.random() * 3000)
    }
    rec.gazeYaw = yawT
    rec.gazePitch = pitchT
  }
}

function glanceTarget(bot) {
  try {
    const ent = bot.nearestEntity(e => e.type === "player" && e.id !== bot.entity.id)
    if (!ent || !ent.position) return null
    const pos = bot.entity.position
    const dx = ent.position.x - pos.x, dz = ent.position.z - pos.z
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d > 18 || d < 0.5) return null
    return ent
  } catch (e) { return null }
}

function stepGaze(rec, bot, now) {
  if (!config.actLook) return
  const entity = bot.entity
  if (!entity) return
  const targetYaw = rec.gazeYaw
  const targetPitch = rec.gazePitch
  const maxStep = rec.lookSpeedNow || rec.persona.lookSpeed
  let dYaw = wrapYaw(targetYaw - entity.yaw)
  let dPitch = targetPitch - entity.pitch
  dYaw = Math.max(-maxStep, Math.min(maxStep, dYaw))
  dPitch = Math.max(-maxStep, Math.min(maxStep, dPitch))
  dYaw = Math.round(dYaw / LOOK_SENS) * LOOK_SENS
  dPitch = Math.round(dPitch / LOOK_SENS) * LOOK_SENS
  entity.yaw = wrapYaw(entity.yaw + dYaw)
  entity.pitch = Math.max(-1.52, Math.min(1.52, entity.pitch + dPitch))
}


let lastFarmChatAt = 0
const CHAT_MIN_GAP_MS = 120
const pendingChats = []
let chatPumpBusy = false

function pumpChat() {
  if (chatPumpBusy) return
  const item = pendingChats.shift()
  if (!item) return
  chatPumpBusy = true
  const wait = Math.max(0, CHAT_MIN_GAP_MS - (Date.now() - lastFarmChatAt))
  setTimeout(() => {
    try {
      const { bot, text, rec } = item
      if (bot && rec && rec.bot === bot && rec.state === "spawned") bot.chat(text)
      lastFarmChatAt = Date.now()
    } catch (e) {}
    chatPumpBusy = false
    pumpChat()
  }, wait)
}

function queueChat(rec, bot, text) {
  pendingChats.push({ rec, bot, text })
  if (pendingChats.length > 200) pendingChats.shift()
  pumpChat()
}

function maybeChat(rec, bot, now) {
  if (!config.actChat) return
  if (now < rec.nextChatAt) return
  rec.nextChatAt = now + config.chatIntervalMs * (0.7 + Math.random() * 0.6)
  if (Math.random() >= config.chatChance) return
  const text = pick(config.messages)
  if (!text) return
  queueChat(rec, bot, text)
  log(`${rec.name}: ${text}`)
}

function maybeSwing(rec, bot, now) {
  if (!config.actSwing) return
  if (now < rec.nextSwingAt) return
  rec.nextSwingAt = now + 3500 + Math.floor(Math.random() * 7000)
  try { bot.swingArm("right") } catch (err) {}
}

function maybeHotbar(rec, bot, now) {
  if (!config.actHotbar) return
  if (now < rec.nextHotbarAt) return
  rec.nextHotbarAt = now + 15000 + Math.floor(Math.random() * 25000)
  try { bot.setQuickBarSlot(Math.floor(Math.random() * 9)) } catch (err) {}
}

let spawnUsedNames = new Set()

// Per-bot spy buffer: incoming server events, timestamped. When a bot is
// kicked the tail of this buffer is printed, so we can see exactly what the
// server sent right before closing (verification challenges, pack prompts,
// plugin messages the farm never answers).
function pushEvent(rec, text) {
  rec.recentEvents.push({ t: Date.now(), text: String(text).slice(0, 160) })
  if (rec.recentEvents.length > 40) rec.recentEvents.shift()
}

function spawnBot(index, onSpawn) {
  const name = buildName(index, spawnUsedNames)
  const rec = {
    name, bot: null, state: "connecting",
    persona: brains.makePersona(),
    mode: "born", modeUntil: 0, waypoint: null, gazeYaw: 0, gazePitch: 0,
    nextGazePick: 0, nextScanAt: 0, nextStuckAt: 0, lastStuckPos: null, stuckCount: 0,
    jumpUntil: 0, strafeUntil: 0, composureUntil: 0, nextSprintRoll: 0,
    sprinting: false, sneaking: false, strafeDir: "left", walkStart: 0, hazard: null,
    lookSpeedNow: 0.04,
    nextChatAt: 0, nextSwingAt: 0, nextHotbarAt: 0,
    lastError: "", reconnectAt: 0, hasSpawned: false,
    anchor: { x: 0, z: 0, y: 0 },
    followPoint: null, followTargetName: "", nextFollowRefresh: 0,
    path: null, pathIdx: 0, pathTarget: null, pathPending: false, pathLastTry: 0, pathFailAt: 0,
    trail: [], nextTrailAt: 0,
    fingerprint: null, connectedAt: 0,
    recentChat: [], recentEvents: [], kickHistory: [], deaths: 0, resourcePacks: 0, joinFails: 0
  }
  bots.set(name, rec)
  connect(rec, onSpawn)
}

function connect(rec, onSpawn) {
  const fp = buildFingerprint()
  rec.fingerprint = fp
  const bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: rec.name,
    auth: "offline",
    version: config.version,
    physicsEnabled: true,
    hideErrors: true,
    viewDistance: config.viewDistance,
    chat: fp ? fp.chat : "enabled",
    colorsEnabled: fp ? fp.colorsEnabled : true,
    skinParts: fp ? fp.skinParts : undefined,
    mainHand: fp ? fp.mainHand : "right",
    enableTextFiltering: fp ? fp.enableTextFiltering : false,
    enableServerListing: fp ? fp.enableServerListing : true
  })
  rec.bot = bot
  rec.state = "connecting"
  let settingsApplied = false

  installPacketIO(rec)

  bot.on("messagestr", (msg) => {
    if (rec.bot !== bot) return
    rec.recentChat.push({ t: Date.now(), text: String(msg).slice(0, 200) })
    if (rec.recentChat.length > 20) rec.recentChat.shift()
    pushEvent(rec, "chat: " + String(msg))
  })

  // Spy on plugin-channel messages (verification challenges and similar
  // server probes usually arrive here, not in normal chat).
  try {
    bot._client.on("plugin_message", (data) => {
      if (rec.bot !== bot) return
      const channel = (data && data.channel) || "?"
      let preview = ""
      try {
        const bytes = data && data.data
        if (bytes) preview = Buffer.from(bytes).toString("utf8").replace(/[^\x20-\x7e]+/g, ".").slice(0, 80)
      } catch (e) {}
      pushEvent(rec, `pluginmsg [${channel}] ${preview}`)
    })
  } catch (e) {}

  bot.on("resourcePack", () => {
    if (rec.bot !== bot) return
    rec.resourcePacks++
    const mode = config.resourcePackMode || "accept"
    pushEvent(rec, `pack: server pushed a pack (mode=${mode})`)
    if (mode === "ignore") { pushEvent(rec, "pack: ignored (no response sent)"); return }
    const delay = 200 + Math.floor(Math.random() * 1300)
    setTimeout(() => {
      if (rec.bot !== bot) return
      try {
        if (mode === "decline") { bot.denyResourcePack(); pushEvent(rec, "pack: declined") }
        else { bot.acceptResourcePack(); pushEvent(rec, "pack: accepted") }
      } catch (e) {}
    }, delay)
  })

  bot.once("spawn", () => {
    if (!rec.hasSpawned) {
      rec.hasSpawned = true
      rec.recentEvents = []
      log(`${rec.name} joined`)
      if (onSpawn) onSpawn()
    }
  })

  bot.on("spawn", () => {
    if (rec.bot !== bot) return
    rec.state = "spawned"
    rec.connectedAt = Date.now()
    rec.joinFails = 0
    if (fp && !settingsApplied) {
      settingsApplied = true
      try { bot.setSettings({ locale: fp.locale, particleStatus: fp.particleStatus }) } catch (e) {}
    }
    rec.nextChatAt = Date.now() + config.chatIntervalMs * (0.7 + Math.random() * 0.6)
    rec.nextSwingAt = Date.now() + 4000 + Math.floor(Math.random() * 6000)
    rec.nextHotbarAt = Date.now() + 12000 + Math.floor(Math.random() * 20000)
    resetBrain(rec, bot, Date.now())
    if (bot.entity && bot.entity.position) {
      rec.anchor = { x: bot.entity.position.x, z: bot.entity.position.z, y: bot.entity.position.y }
    }
    clearControls(bot)
    rec.lastSprint = false
    rec.lastSneak = false
    rec.lastInputKey = ""
    // spawn commands
    for (const cmd of (config.spawnCommands || [])) {
      setTimeout(() => { if (rec.bot === bot && rec.state === "spawned") { try { bot.chat(cmd) } catch (e) {} } }, 500 + Math.random() * 1500)
    }
  })

  bot.on("death", () => {
    if (rec.bot !== bot) return
    rec.state = "dead"
    rec.deaths++
    clearControls(bot)
    setTimeout(() => {
      if (rec.bot !== bot) return
      try { bot.respawn() } catch (err) {}
    }, 1200)
  })

  bot.on("kicked", (reason) => {
    if (rec.bot !== bot) return
    rec.state = "kicked"
    rec.joinFails++
    rec.lastError = formatKickReason(reason)
    const alive = rec.connectedAt ? Math.round((Date.now() - rec.connectedAt) / 1000) : 0
    const prelude = (rec.recentEvents || []).slice(-6).map((e) => e.text).join(" ;; ")
    rec.kickHistory.push({ t: Date.now(), reason: rec.lastError, alive, prelude })
    if (rec.kickHistory.length > 10) rec.kickHistory.shift()
    log(`${rec.name} kicked after ${alive}s: ${rec.lastError}${prelude ? ` | last: ${prelude}` : ""}`)
  })

  bot.on("error", (err) => {
    if (rec.bot !== bot) return
    rec.lastError = err.message
    log(`${rec.name} error: ${err.message}`)
  })

  bot.on("end", () => {
    if (rec.bot !== bot) return
    clearControls(bot)
    if (rec.state !== "stopping") rec.state = "ended"
    if (config.autoReconnect && running) {
      const base = Math.min(90000, 10000 + (rec.joinFails || 0) * 15000)
      rec.reconnectAt = Date.now() + base + Math.floor(Math.random() * 10000)
    }
  })

  bot.on("forcedMove", () => {
    if (rec.bot !== bot) return
    rec.composureUntil = Date.now() + 500 + Math.floor(Math.random() * 400)
    if (bot.entity && bot.entity.position) {
      rec.anchor = { x: bot.entity.position.x, z: bot.entity.position.z, y: bot.entity.position.y }
    }
    rec.gazeYaw = wrapYaw(bot.entity.yaw)
    rec.gazePitch = bot.entity.pitch
    rec.waypoint = null
    rec.followPoint = null
    rec.followTargetName = ""
    rec.mode = "idle"
    rec.modeUntil = Date.now() + 800
    clearControls(bot)
    rec.lastSprint = false
    rec.lastSneak = false
    rec.lastInputKey = ""
    rec.tickEndPending = false
  })
}

function brainTick() {
  const now = Date.now()
  for (const rec of bots.values()) {
    const bot = rec.bot

    if (rec.state === "ended" || rec.state === "kicked") {
      if (rec.reconnectAt && now >= rec.reconnectAt) {
        rec.reconnectAt = 0
        connect(rec)
      }
      continue
    }

    if (rec.state !== "spawned" || !bot || !bot.entity) continue

    try {
      if (config.movement) updateBrain(rec, bot, now)
      else {
        idleStep(rec, bot, now)
        stepGaze(rec, bot, now)
      }
      if (now >= rec.nextTrailAt) {
        rec.nextTrailAt = now + 600
        if (bot.entity && bot.entity.position) {
          rec.trail.push({ x: Math.round(bot.entity.position.x * 10) / 10, z: Math.round(bot.entity.position.z * 10) / 10 })
          if (rec.trail.length > 14) rec.trail.shift()
        }
      }
      maybeChat(rec, bot, now)
      maybeSwing(rec, bot, now)
      maybeHotbar(rec, bot, now)
      if (bot.entity && bot.entity.position.y < -10) {
        try { bot.respawn() } catch (err) {}
      }
    } catch (err) {
      rec.lastError = err.message
    }
  }
  processPathQueue(now)
}

function startAll(overrides) {
  Object.assign(config, overrides || {})
  stopAll()
  spawnUsedNames = new Set()

  running = true
  const thisRunId = runId
  log(`starting ${config.count} bots at ${config.host}:${config.port} on ${config.version}`)

  if (config.waitForPreviousSpawn) {
    let nextIndex = 0
    const spawnNext = () => {
      if (!running || runId !== thisRunId || nextIndex >= config.count) return
      const index = nextIndex++
      const onSpawn = nextIndex < config.count
        ? () => setTimeout(spawnNext, config.spawnWaitSeconds * 1000)
        : undefined
      spawnBot(index, onSpawn)
    }
    spawnNext()
    return
  }

  for (let i = 0; i < config.count; i++) {
    setTimeout(() => {
      if (!running || runId !== thisRunId) return
      spawnBot(i)
    }, i * config.staggerMs)
  }
}

function stopAll() {
  running = false
  runId++
  for (const rec of bots.values()) {
    rec.reconnectAt = 0
    rec.state = "stopping"
    if (!rec.bot) continue
    try { clearControls(rec.bot); if (typeof rec.bot.quit === "function") rec.bot.quit("load test over") } catch (err) {}
  }
  bots.clear()
  log("all bots stopped")
}

function botDetail(rec) {
  const bot = rec.bot
  const pos = bot && bot.entity ? bot.entity.position : null
  const self = bot && bot.players ? bot.players[rec.name] : null
  return {
    name: rec.name,
    state: rec.state,
    mode: rec.mode,
    followTarget: rec.followTargetName || "",
    hazard: rec.hazard,
    connectedAt: rec.connectedAt || 0,
    health: bot && typeof bot.health === "number" ? Math.round(bot.health) : null,
    food: bot && typeof bot.food === "number" ? Math.round(bot.food) : null,
    x: pos ? Math.round(pos.x * 100) / 100 : null,
    y: pos ? Math.round(pos.y * 100) / 100 : null,
    z: pos ? Math.round(pos.z * 100) / 100 : null,
    yaw: bot && bot.entity ? Math.round(bot.entity.yaw * 1000) / 1000 : null,
    pitch: bot && bot.entity ? Math.round(bot.entity.pitch * 1000) / 1000 : null,
    ping: self && typeof self.ping === "number" ? self.ping : null,
    error: rec.lastError,
    deaths: rec.deaths,
    resourcePacks: rec.resourcePacks,
    fingerprint: rec.fingerprint,
    recentChat: rec.recentChat,
    recentEvents: (rec.recentEvents || []).slice(-15),
    kickHistory: rec.kickHistory,
    persona: rec.persona ? {
      walkBias: Math.round(rec.persona.walkBias * 100) / 100,
      sprintBias: Math.round((rec.persona.sprintBias || 0) * 100) / 100,
      sneakBias: Math.round((rec.persona.sneakBias || 0) * 100) / 100,
      followBias: Math.round((rec.persona.followBias || 0) * 100) / 100,
      lookSpeed: rec.persona.lookSpeed,
      scanMs: rec.persona.scanMs
    } : null
  }
}

function findFollowTargetPos() {
  if (!sanitizePlayer(config.followPlayer)) return null
  for (const rec of bots.values()) {
    const bot = rec.bot
    if (rec.state !== "spawned" || !bot || !bot.entities) continue
    try {
      for (const id in bot.entities) {
        const ent = bot.entities[id]
        if (ent && ent.type === "player" && ent.position && ent.username === config.followPlayer) {
          return { name: ent.username, x: Math.round(ent.position.x * 10) / 10, z: Math.round(ent.position.z * 10) / 10 }
        }
      }
    } catch (e) { continue }
  }
  return null
}

let snapshotCache = null
let snapshotCacheAt = 0

function snapshot() {
  // The GUI polls every second or so; with 150 bots a fresh JSON build per
  // poll is measurable event-loop load. 350ms is invisible on the map.
  const cacheNow = Date.now()
  if (snapshotCache && cacheNow - snapshotCacheAt < 350 && snapshotCache.count === bots.size && snapshotCache.running === running) {
    return snapshotCache
  }
  const list = []
  for (const rec of bots.values()) {
    const bot = rec.bot
    const pos = bot && bot.entity ? bot.entity.position : null
    const self = bot && bot.players ? bot.players[rec.name] : null
    list.push({
      name: rec.name,
      state: rec.state,
      mode: rec.mode,
      followTarget: rec.followTargetName || "",
      health: bot && typeof bot.health === "number" ? Math.round(bot.health) : null,
      food: bot && typeof bot.food === "number" ? Math.round(bot.food) : null,
      x: pos ? Math.round(pos.x * 10) / 10 : null,
      y: pos ? Math.round(pos.y * 10) / 10 : null,
      z: pos ? Math.round(pos.z * 10) / 10 : null,
      yaw: bot && bot.entity ? Math.round(bot.entity.yaw * 100) / 100 : null,
      ping: self && typeof self.ping === "number" ? self.ping : null,
      error: rec.lastError,
      trail: (rec.trail || []).map((p) => [p.x, p.z]),
      path: rec.path ? rec.path.slice(rec.pathIdx, rec.pathIdx + 30).map((n) => [n.x + 0.5, n.z + 0.5]) : [],
      wp: rec.waypoint ? { x: Math.round(rec.waypoint.x * 10) / 10, z: Math.round(rec.waypoint.z * 10) / 10 } : null
    })
  }
  const result = { running, count: bots.size, config, bots: list, log: logLines.slice(-60), followPlayerPos: findFollowTargetPos() }
  snapshotCache = result
  snapshotCacheAt = cacheNow
  return result
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ""
    req.on("data", (chunk) => { raw += chunk; if (raw.length > 1e6) req.destroy() })
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch (err) { resolve({}) } })
  })
}

function send(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  const route = `${req.method} ${req.url.split("?")[0]}`

  if (route === "GET /status") return send(res, 200, snapshot())

  if (route === "GET /players") {
    const seen = new Map()
    for (const rec of bots.values()) {
      const bot = rec.bot
      if (rec.state !== "spawned" || !bot || !bot.players) continue
      for (const [name, p] of Object.entries(bot.players)) {
        if (!seen.has(name)) seen.set(name, p && typeof p.ping === "number" ? p.ping : null)
      }
    }
    const players = [...seen.entries()]
      .map(([name, ping]) => ({ name, ping, isBot: bots.has(name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return send(res, 200, { players })
  }

  if (route.startsWith("GET /bot/")) {
    const name = decodeURIComponent(route.slice("GET /bot/".length))
    const rec = bots.get(name)
    if (!rec) return send(res, 404, { error: "unknown bot" })
    return send(res, 200, botDetail(rec))
  }

  if (route === "POST /start") {
    const body = await readBody(req)
    startAll(body)
    return send(res, 200, { ok: true })
  }

  if (route === "POST /stop") {
    stopAll()
    return send(res, 200, { ok: true })
  }

  if (route === "POST /config") {
    const body = await readBody(req)
    const oldConfig = { chatIntervalMs: config.chatIntervalMs }
    Object.assign(config, body)
    applyLiveConfig(oldConfig)
    return send(res, 200, { ok: true })
  }

  if (route === "POST /say") {
    const body = await readBody(req)
    const text = String(body.text || "").slice(0, 250)
    const target = String(body.target || "all")
    const player = sanitizePlayer(body.player)
    const line = player && !text.startsWith("/") ? `${player} ${text}` : text
    const responses = []
    const listeners = []
    for (const rec of bots.values()) {
      if (rec.state !== "spawned") continue
      if (target !== "all" && rec.name !== target) continue
      const bot = rec.bot
      const onMsg = (msg) => { responses.push({ name: rec.name, text: String(msg).slice(0, 200) }) }
      bot.on("messagestr", onMsg)
      listeners.push({ bot, onMsg })
      setTimeout(() => { try { bot.chat(line) } catch (err) {} }, Math.floor(Math.random() * 200))
    }
    await new Promise((resolve) => setTimeout(resolve, 3500))
    for (const { bot, onMsg } of listeners) { try { bot.removeListener("messagestr", onMsg) } catch (e) {} }
    log(`${text.startsWith("/") ? "command" : "say"} target=${target}${player ? ` player=${player}` : ""}: ${line}`)
    return send(res, 200, { ok: true, responses })
  }

  if (route === "POST /command") {
    const body = await readBody(req)
    let text = String(body.text || "").trim().slice(0, 250)
    if (!text.startsWith("/")) text = "/" + text
    const target = String(body.target || "all")
    const player = sanitizePlayer(body.player)
    const responses = []
    const listeners = []
    for (const rec of bots.values()) {
      if (rec.state !== "spawned") continue
      if (target !== "all" && rec.name !== target) continue
      const bot = rec.bot
      const onMsg = (msg) => { responses.push({ name: rec.name, text: String(msg).slice(0, 200) }) }
      bot.on("messagestr", onMsg)
      listeners.push({ bot, onMsg })
      setTimeout(() => { try { bot.chat(text) } catch (err) {} }, Math.floor(Math.random() * 300))
    }
    await new Promise((resolve) => setTimeout(resolve, 4000))
    for (const { bot, onMsg } of listeners) { try { bot.removeListener("messagestr", onMsg) } catch (e) {} }
    log(`command target=${target}${player ? ` player=${player}` : ""}: ${text}`)
    return send(res, 200, { ok: true, responses })
  }

  if (route === "POST /shutdown") {
    stopAll()
    send(res, 200, { ok: true })
    setTimeout(() => process.exit(0), 250)
    return
  }

  send(res, 404, { error: "unknown route" })
})

setInterval(brainTick, BRAIN_TICK_MS)

server.listen(CONTROL_PORT, CONTROL_HOST, () => {
  console.log(`engine listening on http://${CONTROL_HOST}:${CONTROL_PORT}`)
})
