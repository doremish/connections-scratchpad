// ─────────────────────────────────────────────────────────────────────────────
// NYT Connections Scratchpad — by doremish
//
// GRID MODEL
//   Flat array of 16 slots (indices 0–15).
//   Row = Math.floor(index / 4)   Col = index % 4
//   All moves are swaps so stacking is impossible.
//
// ANIMATIONS — FLIP technique
//   Before any swap: record tile DOM positions.
//   After React re-renders: apply inverse transform so tiles appear in their
//   old positions, then release so CSS transition flies them to the new spot.
//
// DRAG & DROP
//   Tile drag: mouse (HTML5 API) + touch (elementFromPoint).
//   Row drag:  handle on the left of each row swaps all 4 tiles at once.
//              Works with both mouse and touch.
//
// PUZZLE DATA
//   Free community archive (github.com/Eyefyre/NYT-Connections-Answers).
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useLayoutEffect, useRef } from "react";

// Libre Franklin — closest free match to NYT Franklin (proprietary tile font)
const fontLink = document.createElement("link");
fontLink.rel  = "stylesheet";
fontLink.href = "https://fonts.googleapis.com/css2?family=Libre+Franklin:wght@700;800&display=swap";
document.head.appendChild(fontLink);

const TILE_FONT = "'nyt-franklin', 'Libre Franklin', 'Franklin Gothic Medium', 'Arial Narrow', Arial, sans-serif";

// ── Constants ─────────────────────────────────────────────────────────────────

const ROW_COLORS    = ["#F9DF6D", "#A0C35A", "#B0C4EF", "#BA81C5"];
const COLS          = 4;
// NYT's own public API — just swap in today's date. No third-party code needed.
const NYT_API_BASE = "https://www.nytimes.com/svc/connections/v2";

// ── Helpers ───────────────────────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildGrid(categories, shouldShuffle = false) {
  const tiles = categories.flatMap((cat) =>
    cat.cards.map((word) => ({ word, catColor: cat.color, catTitle: cat.title }))
  );
  // By default preserve NYT's original word order.
  // Pass shouldShuffle=true (e.g. the Shuffle button) to randomise.
  return shouldShuffle ? shuffle(tiles) : tiles;
}

// ── API ───────────────────────────────────────────────────────────────────────

async function fetchPuzzle() {
  // Build today's date in YYYY-MM-DD format
  const now  = new Date();
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, "0");
  const dd   = String(now.getDate()).padStart(2, "0");
  const today = `${yyyy}-${mm}-${dd}`;

  const displayDate = now.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });

  // Fetch today's puzzle directly from the NYT API
  const res = await fetch(`${NYT_API_BASE}/${today}.json`);
  if (!res.ok) throw new Error(`Could not load today's puzzle. The NYT API returned: ${res.status}`);

  const data = await res.json();
  console.log("NYT PUZZLE DATA =", JSON.stringify(data, null, 2));

  // The NYT API returns { id, date, answers: [ { group, level, members } ] }
  // level: 0=yellow, 1=green, 2=blue, 3=purple (or -1 if not provided)
  const rawGroups = data.answers || [];
  if (rawGroups.length === 0) throw new Error("Puzzle data was empty or unexpected format.");

  const categories = rawGroups.map((group, idx) => ({
    title: group.group  || `Group ${idx + 1}`,
    color: group.level >= 0 ? group.level : idx,
    cards: (group.members || []).map((c) =>
      typeof c === "string" ? c : c.content ?? c.word ?? String(c)
    ),
  }));

  return { date: displayDate, categories };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ConnectionsHelper() {
  const [puzzle, setPuzzle]   = useState(null);
  const [grid, setGrid]       = useState(Array(16).fill(null));
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  // Tile drag
  const dragSlot  = useRef(null);  // slot being dragged from
  const hoverSlot = useRef(null);  // slot finger is over (touch)
  const [activeFrom, setActiveFrom] = useState(null);
  const [activeTo, setActiveTo]     = useState(null);

  // Row drag
  const rowDragFromRef = useRef(null);
  const rowHoverRef    = useRef(null);
  const [rowDragFrom, setRowDragFrom] = useState(null);
  const [rowDragTo, setRowDragTo]     = useState(null);

  // Ghost tile (floating copy that follows cursor/finger)
  const [ghostTile, setGhostTile] = useState(null);
  const [ghostPos, setGhostPos]   = useState({ x: 0, y: 0 });

  // Transparent 1×1 GIF to suppress browser's built-in drag preview image
  const blankImage = useRef(null);
  useEffect(() => {
    const img = new Image();
    img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    blankImage.current = img;
  }, []);

  // Update ghost position as mouse moves during any drag
  useEffect(() => {
    function onDocDragOver(e) {
      if (dragSlot.current !== null || rowDragFromRef.current !== null) {
        setGhostPos({ x: e.clientX, y: e.clientY });
      }
    }
    document.addEventListener("dragover", onDocDragOver);
    return () => document.removeEventListener("dragover", onDocDragOver);
  }, []);

  // ── FLIP animation ─────────────────────────────────────────────────────────
  //
  // tileRefs:     slotIdx → tile DOM element (attached via ref callback)
  // preSwapRects: snapshot taken just before a grid mutation, containing:
  //   rects: { [slotIdx]: DOMRect }  — tile positions BEFORE the swap
  //   moves: { [currentSlot]: oldSlot } — which old slot each slot's tile came from
  //
  // useLayoutEffect runs after every render. If preSwapRects has data, it
  // applies an inverse CSS transform to each moved tile (making it appear to
  // still be in its old position), then clears the transform so the browser
  // transitions it to the correct spot. This is the FLIP technique.

  const tileRefs     = useRef({});
  const preSwapRects = useRef(null);

  useLayoutEffect(() => {
    if (!preSwapRects.current) return;
    const { rects, moves } = preSwapRects.current;
    preSwapRects.current = null;

    Object.entries(moves).forEach(([currentSlotStr, oldSlot]) => {
      const el      = tileRefs.current[parseInt(currentSlotStr, 10)];
      const oldRect = rects[oldSlot];
      if (!el || !oldRect) return;

      const newRect = el.getBoundingClientRect();
      const dx = oldRect.left - newRect.left;
      const dy = oldRect.top  - newRect.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

      // Snap tile back to its visual origin with no transition
      el.style.transition = "none";
      el.style.transform  = `translate(${dx}px, ${dy}px)`;

      // Double rAF: first frame commits the "before" paint, second triggers animation
      requestAnimationFrame(() => requestAnimationFrame(() => {
        el.style.transition = "transform 0.28s cubic-bezier(0.25, 0.46, 0.45, 0.94)";
        el.style.transform  = "";
      }));
    });
  });

  function captureRects(slotIndices) {
    const rects = {};
    slotIndices.forEach((idx) => {
      const el = tileRefs.current[idx];
      if (el) rects[idx] = el.getBoundingClientRect();
    });
    return rects;
  }

  // ── Grid mutations ─────────────────────────────────────────────────────────

  function swapSlots(from, to) {
    if (from === null || to === null || from === to) return;
    const rects = captureRects([from, to]);
    // After swap: tile now at `to` came from `from`, and vice versa
    preSwapRects.current = { rects, moves: { [to]: from, [from]: to } };
    setGrid((prev) => {
      const next = [...prev];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  }

  function swapRows(rowA, rowB) {
    if (rowA === null || rowB === null || rowA === rowB) return;
    const slotIndices = [
      ...Array.from({ length: COLS }, (_, i) => rowA * COLS + i),
      ...Array.from({ length: COLS }, (_, i) => rowB * COLS + i),
    ];
    const rects = captureRects(slotIndices);
    const moves = {};
    for (let col = 0; col < COLS; col++) {
      const slotA = rowA * COLS + col;
      const slotB = rowB * COLS + col;
      moves[slotA] = slotB;  // tile now at slotA came from slotB
      moves[slotB] = slotA;  // tile now at slotB came from slotA
    }
    preSwapRects.current = { rects, moves };
    setGrid((prev) => {
      const next = [...prev];
      for (let col = 0; col < COLS; col++) {
        const slotA = rowA * COLS + col;
        const slotB = rowB * COLS + col;
        [next[slotA], next[slotB]] = [next[slotB], next[slotA]];
      }
      return next;
    });
  }

  // ── Puzzle load ────────────────────────────────────────────────────────────

  useEffect(() => {
    fetchPuzzle()
      .then((data) => { setPuzzle(data); setGrid(buildGrid(data.categories)); setLoading(false); })
      .catch((e)   => { setError(e.message); setLoading(false); });
  }, []);

  // ── Tile mouse drag ────────────────────────────────────────────────────────

  function onTileDragStart(e, slotIdx) {
    dragSlot.current = slotIdx;
    setActiveFrom(slotIdx);
    setGhostTile(grid[slotIdx]);
    setGhostPos({ x: e.clientX, y: e.clientY });
    e.dataTransfer.setDragImage(blankImage.current, 0, 0);
    e.dataTransfer.effectAllowed = "move";
    e.stopPropagation();
  }

  function onTileDragEnd() {
    dragSlot.current = null;
    setActiveFrom(null);
    setActiveTo(null);
    setGhostTile(null);
  }

  // ── Tile touch drag ────────────────────────────────────────────────────────

  function onTileTouchStart(e, slotIdx) {
    dragSlot.current  = slotIdx;
    hoverSlot.current = slotIdx;
    setActiveFrom(slotIdx);
    setGhostTile(grid[slotIdx]);
    setGhostPos({ x: e.touches[0].clientX, y: e.touches[0].clientY });
  }

  function onTileTouchMove(e) {
    e.preventDefault();
    const touch = e.touches[0];
    setGhostPos({ x: touch.clientX, y: touch.clientY });
    const el = e.currentTarget;
    el.style.pointerEvents = "none";
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    el.style.pointerEvents = "";
    const slotEl = target?.closest("[data-slot]");
    hoverSlot.current = slotEl ? parseInt(slotEl.dataset.slot, 10) : null;
    setActiveTo(hoverSlot.current);
  }

  function onTileTouchEnd() {
    swapSlots(dragSlot.current, hoverSlot.current);
    dragSlot.current  = null;
    hoverSlot.current = null;
    setActiveFrom(null);
    setActiveTo(null);
    setGhostTile(null);
  }

  // ── Row handle mouse drag ──────────────────────────────────────────────────

  function onRowHandleDragStart(e, rowIdx) {
    rowDragFromRef.current = rowIdx;
    setRowDragFrom(rowIdx);
    setGhostPos({ x: e.clientX, y: e.clientY });
    e.dataTransfer.setDragImage(blankImage.current, 0, 0);
    e.dataTransfer.effectAllowed = "move";
    e.stopPropagation();
  }

  function onRowHandleDragEnd() {
    rowDragFromRef.current = null;
    setRowDragFrom(null);
    setRowDragTo(null);
  }

  // ── Row handle touch drag ──────────────────────────────────────────────────

  function onRowHandleTouchStart(e, rowIdx) {
    rowDragFromRef.current = rowIdx;
    rowHoverRef.current    = rowIdx;
    setRowDragFrom(rowIdx);
    setGhostPos({ x: e.touches[0].clientX, y: e.touches[0].clientY });
  }

  function onRowHandleTouchMove(e) {
    e.preventDefault();
    const touch = e.touches[0];
    setGhostPos({ x: touch.clientX, y: touch.clientY });
    const el = e.currentTarget;
    el.style.pointerEvents = "none";
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    el.style.pointerEvents = "";
    const rowEl = target?.closest("[data-row]");
    rowHoverRef.current = rowEl ? parseInt(rowEl.dataset.row, 10) : null;
    setRowDragTo(rowHoverRef.current);
  }

  function onRowHandleTouchEnd() {
    swapRows(rowDragFromRef.current, rowHoverRef.current);
    rowDragFromRef.current = null;
    rowHoverRef.current    = null;
    setRowDragFrom(null);
    setRowDragTo(null);
  }

  // ── Combined dragover/drop on row band ────────────────────────────────────
  // Handles both tile drops (onto empty space) and row drops

  function onRowBandDragOver(e, rowIdx) {
    e.preventDefault();
    if (rowDragFromRef.current !== null) setRowDragTo(rowIdx);
  }

  function onRowBandDrop(e, rowIdx) {
    e.preventDefault();
    if (rowDragFromRef.current !== null) {
      swapRows(rowDragFromRef.current, rowIdx);
      rowDragFromRef.current = null;
      setRowDragFrom(null);
      setRowDragTo(null);
    }
  }

  // ── Slot dragover/drop (tile drag only) ───────────────────────────────────

  function onSlotDragOver(e, slotIdx) {
    if (dragSlot.current === null) return;
    e.preventDefault();
    e.stopPropagation();
    setActiveTo(slotIdx);
  }

  function onSlotDrop(e, slotIdx) {
    if (dragSlot.current === null) return;
    e.preventDefault();
    e.stopPropagation();
    swapSlots(dragSlot.current, slotIdx);
    dragSlot.current = null;
    setActiveFrom(null);
    setActiveTo(null);
    setGhostTile(null);
  }

  // ── Shuffle ────────────────────────────────────────────────────────────────

  function handleShuffle() {
    if (puzzle) setGrid(buildGrid(puzzle.categories, true));
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={styles.page}>

      <header style={styles.header}>
        <p style={styles.eyebrow}>NYT · CONNECTIONS</p>
        <h1 style={styles.title}>Connections Scratchpad</h1>
        {puzzle && <p style={styles.date}>{puzzle.date}</p>}
      </header>

      {loading && <p style={styles.status}>Fetching today's puzzle…</p>}
      {error   && <p style={styles.error}>{error}</p>}

      {!loading && !error && (
        <>
          <div style={styles.board}>
            {[0, 1, 2, 3].map((rowIdx) => {
              const isFromRow   = rowDragFrom === rowIdx;
              const isTargetRow = rowDragTo === rowIdx && rowDragTo !== rowDragFrom;

              return (
                <div
                  key={rowIdx}
                  data-row={rowIdx}
                  style={styles.rowWrapper}
                  onDragOver={(e) => onRowBandDragOver(e, rowIdx)}
                  onDrop={(e)     => onRowBandDrop(e, rowIdx)}
                >
                  {/* Row drag handle */}
                  <div
                    style={{
                      ...styles.rowHandle,
                      ...(isFromRow   ? styles.rowHandleActive : {}),
                      ...(isTargetRow ? styles.rowHandleTarget : {}),
                    }}
                    draggable
                    title="Drag to swap this whole row"
                    onDragStart={(e) => onRowHandleDragStart(e, rowIdx)}
                    onDragEnd={onRowHandleDragEnd}
                    onTouchStart={(e) => onRowHandleTouchStart(e, rowIdx)}
                    onTouchMove={onRowHandleTouchMove}
                    onTouchEnd={onRowHandleTouchEnd}
                  >
                    <div style={styles.gripGrid}>
                      {Array(6).fill(null).map((_, i) => (
                        <div key={i} style={styles.gripDot} />
                      ))}
                    </div>
                  </div>

                  {/* Coloured tile row */}
                  <div
                    style={{
                      ...styles.row,
                      background: ROW_COLORS[rowIdx],
                      ...(isTargetRow ? styles.rowDropTarget : {}),
                      ...(isFromRow   ? styles.rowDragging   : {}),
                    }}
                  >
                    {[0, 1, 2, 3].map((colIdx) => {
                      const slotIdx = rowIdx * COLS + colIdx;
                      const tile    = grid[slotIdx];
                      const isFrom  = activeFrom === slotIdx;
                      const isTo    = activeTo   === slotIdx && activeTo !== activeFrom;

                      return (
                        <div
                          key={slotIdx}
                          data-slot={slotIdx}
                          style={{
                            ...styles.slot,
                            ...(isTo   ? styles.slotHighlight : {}),
                            ...(isFrom ? styles.slotEmpty     : {}),
                          }}
                          onDragOver={(e) => onSlotDragOver(e, slotIdx)}
                          onDrop={(e)     => onSlotDrop(e, slotIdx)}
                        >
                          {tile && (
                            <div
                              data-slot={slotIdx}
                              draggable
                              ref={(el) => {
                                if (el) tileRefs.current[slotIdx] = el;
                                else    delete tileRefs.current[slotIdx];
                              }}
                              style={{ ...styles.tile, opacity: isFrom ? 0.3 : 1 }}
                              onDragStart={(e) => onTileDragStart(e, slotIdx)}
                              onDragEnd={onTileDragEnd}
                              onTouchStart={(e) => onTileTouchStart(e, slotIdx)}
                              onTouchMove={onTileTouchMove}
                              onTouchEnd={onTileTouchEnd}
                            >
                              {tile.word}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={styles.controls}>
            <button style={styles.button} onClick={handleShuffle}>Shuffle</button>
          </div>

          <p style={styles.hint}>
            Drag tiles between rows · Use the ⠿ handle to move a whole row
          </p>

          <p style={styles.credit}>Made by doremish</p>

          <a
            href="https://buymeacoffee.com/doremish"
            target="_blank"
            rel="noopener noreferrer"
            style={styles.coffeeButton}
          >
            ☕ Buy me a coffee
          </a>
        </>
      )}

      {/* Floating ghost — follows cursor or finger during any drag */}
      {ghostTile && (
        <div style={{
          ...styles.tile,
          position:      "fixed",
          left:          ghostPos.x,
          top:           ghostPos.y,
          transform:     "translate(-50%, -50%) scale(1.1) rotate(2deg)",
          pointerEvents: "none",
          zIndex:        9999,
          width:         "80px",
          minHeight:     "64px",
          boxShadow:     "0 8px 24px rgba(0,0,0,0.4)",
          opacity:       0.95,
        }}>
          {ghostTile.word}
        </div>
      )}

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles — all in one place for easy editing
// ─────────────────────────────────────────────────────────────────────────────

const styles = {

  page: {
    minHeight: "100dvh",
    background: "#1a1a2e",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "16px",
    boxSizing: "border-box",
    fontFamily: TILE_FONT,
  },

  header:  { textAlign: "center", marginBottom: "clamp(14px, 4vw, 28px)" },
  eyebrow: {
    margin: 0,
    fontSize: "clamp(9px, 2.2vw, 11px)",
    letterSpacing: "4px",
    textTransform: "uppercase",
    color: "#8888aa",
    fontFamily: "'Courier New', monospace",
  },
  title: {
    margin: "6px 0 0",
    fontSize: "clamp(18px, 5vw, 28px)",
    fontWeight: 700,
    color: "#f0ede8",
    letterSpacing: "-0.5px",
  },
  date:   { margin: "4px 0 0", color: "#6666aa",
