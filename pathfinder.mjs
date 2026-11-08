// Grid A* pathfinder modeled on Minecraft's vanilla mob pathfinding
// (WalkNodeEvaluator / PathNavigation):
//   - 8-direction nodes at standable feet levels; climb 1 block, drop up to 3.
//   - Soft costs, not binary blocks: water is +8.0 per node (vanilla's
//     water-risk malus — mobs detour when cheap, wade when forced).
//   - Lava/fire are blocked outright; diagonal corner cutting is permitted
//     (vanilla mobs squeeze through 1-cell diagonal gaps).
//   - Routes are line-of-sight smoothed so they curve like mob paths instead
//     of zig-zagging per cell.
// No dependencies: the caller supplies blockAt(x, y, z) returning
//   { solid: boolean, fluid: boolean, lava: boolean }
// for a loaded block, or null for unloaded chunks (treated as blocked).
// findPath(blockAt, from, to) -> [{ x, z, y }, ...] or null.

const MAX_EXPANSIONS = 650
const MAX_PATH = 160
const MAX_RANGE = 90
const SQRT2 = Math.SQRT2
const WATER_COST = 8.0   // vanilla water-risk malus
const CLIMB_COST = 0.5
const DROP_COST = 0.25

// ---- binary heap keyed by node.f ----
class Heap {
  constructor() { this.a = [] }
  get size() { return this.a.length }
  push(node) {
    const a = this.a
    a.push(node)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].f <= a[i].f) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop() {
    const a = this.a
    const top = a[0]
    const last = a.pop()
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < a.length && a[l].f < a[m].f) m = l
        if (r < a.length && a[r].f < a[m].f) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}

// Can a bot stand at EXACTLY feet-y = y in column (x,z)?
// (feet in water is allowed but costly elsewhere; head under water is not —
// bots can't swim, and feet in lava is out.)
function walkableAt(blockAt, x, z, y) {
  const below = blockAt(x, y - 1, z)
  if (!below || !below.solid || below.fluid) return false
  const feet = blockAt(x, y, z)
  if (feet && (feet.solid || feet.lava)) return false
  const head = blockAt(x, y + 1, z)
  if (head && (head.solid || head.fluid || head.lava)) return false
  return true
}

// Vanilla floor-level evaluation: the first standable level scanning from
// refY+1 (one climb) down to refY-3 (drop of three).
function makeFloorFn(blockAt) {
  const cache = new Map()
  return function floorLevel(x, z, refY) {
    const key = x + "," + z + "," + refY
    if (cache.has(key)) return cache.get(key)
    let result = null
    for (let y = refY + 1; y >= refY - 3; y--) {
      if (walkableAt(blockAt, x, z, y)) { result = y; break }
    }
    if (cache.size > 8000) cache.clear()
    cache.set(key, result)
    return result
  }
}

function octile(dx, dz) {
  const a = Math.abs(dx)
  const b = Math.abs(dz)
  return Math.max(a, b) + (SQRT2 - 1) * Math.min(a, b)
}

function losOk(blockAt, ax, az, ay, bx, bz, by) {
  const dist = Math.hypot(bx - ax, bz - az)
  const steps = Math.max(1, Math.ceil(dist / 0.5))
  for (let k = 1; k < steps; k++) {
    const t = k / steps
    const sx = ax + (bx - ax) * t
    const sz = az + (bz - az) * t
    const sy = ay + (by - ay) * t
    if (!walkableAt(blockAt, Math.floor(sx), Math.floor(sz), Math.round(sy))) return false
  }
  return true
}

function buildPath(came, startKey, endKey) {
  const cells = []
  let k = endKey
  while (k !== startKey) {
    const node = came.get(k)
    if (!node) return null
    cells.push({ x: node.x, z: node.z, y: node.y })
    k = node.parentKey
    if (cells.length > MAX_PATH) return null
  }
  cells.reverse()
  return cells
}

function smooth(blockAt, path) {
  if (!path || path.length < 3) return path
  const out = [path[0]]
  let i = 1
  let anchor = path[0]
  while (i < path.length) {
    let j = i
    while (j + 1 < path.length && losOk(blockAt, anchor.x, anchor.z, anchor.y, path[j + 1].x, path[j + 1].z, path[j + 1].y)) j++
    out.push(path[j])
    anchor = path[j]
    i = j + 1
  }
  return out
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

export function findPath(blockAt, from, to) {
  const floorLevel = makeFloorFn(blockAt)
  const sx = Math.floor(from.x)
  const sz = Math.floor(from.z)
  const sy0 = Math.floor(from.y)
  const gx = Math.floor(to.x)
  const gz = Math.floor(to.z)
  const startY = floorLevel(sx, sz, sy0)
  const sy = startY == null ? sy0 : startY

  const startKey = sx + "," + sz + "," + sy
  const came = new Map()
  const gScore = new Map()
  const heap = new Heap()
  const startNode = { x: sx, z: sz, y: sy, g: 0, f: octile(gx - sx, gz - sz), parentKey: null }
  heap.push(startNode)
  came.set(startKey, startNode)
  gScore.set(startKey, 0)
  const closed = new Set()

  let expansions = 0
  let endKey = null
  if (Math.hypot(gx - sx, gz - sz) <= 1.6) endKey = startKey

  while (heap.size && endKey === null) {
    const cur = heap.pop()
    const ck = cur.x + "," + cur.z + "," + cur.y
    if (closed.has(ck)) continue
    closed.add(ck)
    expansions++
    if (expansions > MAX_EXPANSIONS) return null
    if ((gScore.get(ck) ?? Infinity) < cur.g) continue
    if (Math.hypot(cur.x - gx, cur.z - gz) <= 1.6) { endKey = ck; break }

    for (const [dx, dz] of DIRS) {
      const nx = cur.x + dx
      const nz = cur.z + dz
      if (Math.hypot(nx - sx, nz - sz) > MAX_RANGE) continue
      const diag = dx !== 0 && dz !== 0
      if (diag) {
        // No corner cutting: vanilla mobs squeeze diagonally between two
        // block corners, but mineflayer's physics jams on that geometry.
        if (floorLevel(cur.x + dx, cur.z, cur.y) === null) continue
        if (floorLevel(cur.x, cur.z + dz, cur.y) === null) continue
      }
      const ny = floorLevel(nx, nz, cur.y)
      if (ny === null) continue
      const dy = ny - cur.y
      let step = diag ? SQRT2 : 1
      if (dy === 1) step += CLIMB_COST
      else if (dy < 0) step += DROP_COST * -dy
      const feet = blockAt(nx, ny, nz)
      if (feet && feet.fluid) step += WATER_COST
      const g = cur.g + step
      const nk = nx + "," + nz + "," + ny
      if (g >= (gScore.get(nk) ?? Infinity)) continue
      gScore.set(nk, g)
      const node = { x: nx, z: nz, y: ny, g, f: g + octile(gx - nx, gz - nz), parentKey: ck }
      came.set(nk, node)
      heap.push(node)
    }
  }

  if (endKey === null) return null
  const path = buildPath(came, startKey, endKey)
  if (!path || !path.length) return null
  return smooth(blockAt, path)
}
