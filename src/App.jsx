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
//   Self-hosted archive updated daily by api/update-puzzle.js.
//   Starting order uses NYT position data (v2 API) when available;
//   falls back to a random shuffle for older archive entries.
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
const PUZZLE_SOURCE = "/connections.json";

// ── Helpers ───────────────────────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildGrid(categories, startingOrder) {
  // Build a flat lookup of every tile by word
  const allTiles = categories.flatMap((cat) =>
    cat.cards.map((word) => ({ word, catColor: cat.color, catTitle: cat.title }))
  );

  // Use the NYT position-sorted order when we have it (16 words, one per slot).
  // Fall back to a random shuffle for older archive entries that lack position data.
  if (startingOrder?.length === 16) {
    return startingOrder
      .map((word) => allTiles.find((t) => t.word === word))
      .filter(Boolean);
  }
  return shuffle(allTiles);
}

// ── API ───────────────────────────────────────────────────────────────────────

function getTodayString() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function formatDisplayDate(dateStr) {
  const [yyyy, mm, dd] = dateStr.split("-").map(Number);
  return new Date(yyyy, mm - 1, dd).toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "2-digit", year: "numeric",
  });
}

async function fetchAllPuzzles() {
  const res = await fetch(PUZZLE_SOURCE);
  if (!res.ok) throw new Error("Could not reach the puzzle archive.");
  return res.json();
}

async function fetchPuzzle(targetDate) {
  const requestedDate = targetDate || getTodayString();
  const allPuzzles    = await fetchAllPuzzles();

  // Try the requested date first, then fall back to the previous day
  const datesToTry = [requestedDate];
  if (!targetDate) {
    // Only auto-fallback for "today" — not for explicit archive selections
    const [y, m, d] = requestedDate.split("-").map(Number);
    const yesterday = new Date(y, m - 1, d - 1)
      .toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    datesToTry.push(yesterday);
  }

  let entry        = null;
  let resolvedDate = null;
  let todayMissing = false;

  for (const date of datesToTry) {
    entry = allPuzzles.find((p) => p.date === date);
    if (entry) {
      resolvedDate = date;
      if (date !== requestedDate) todayMissing = true;
      break;
    }
  }

  if (!entry) {
    const latest = allPuzzles[allPuzzles.length - 1]?.date ?? "unknown";
    throw new Error(`${requestedDate} isn't in the archive yet. Latest: ${latest}. Check back soon!`);
  }

  const rawGroups = entry.answers || entry.categories || entry.groups || [];
  if (rawGroups.length === 0) throw new Error("Unexpected archive format. Check browser console (F12).");

  const categories = rawGroups.map((group, idx) => ({
    title: group.group      || group.connection || group.title || `Group ${idx + 1}`,
    color: group.level >= 0 ? group.level : (group.difficulty >= 0 ? group.difficulty : idx),
    cards: (group.members || group.items || group.cards || []).map((c) =>
      typeof c === "string" ? c : c.content ?? c.word ?? c.text ?? String(c)
    ),
  }));

  return {
    date:         formatDisplayDate(resolvedDate),
    isoDate:      resolvedDate,
    categories,
    startingOrder: entry.startingOrder ?? null, // position-sorted word list, or null
    allPuzzles,
    todayMissing,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ConnectionsHelper() {
  const [puzzle, setPuzzle]             = useState(null);
  const [grid, setGrid]                 = useState(Array(16).fill(null));
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const [showArchive, setShowArchive]   = useState(false);
  const [availableDates, setAvailableDates] = useState([]);
  const [todayWarning, setTodayWarning] = useState(false);

  // Tile drag
  const dragSlot  = useRef(null);
  const hoverSlot = useRef(null);
  const [activeFrom, setActiveFrom] = useState(null);
  const [activeTo, setActiveTo]     = useState(null);

  // Row drag
  const rowDragFromRef = useRef(null);
  const rowHoverRef    = useRef(null);
  const [rowDragFrom, setRowDragFrom] = useState(null);
  const [rowDragTo, setRowDragTo]     = useState(null);

  // Ghost tile
  const [ghostTile, setGhostTile] = useState(null);
  const [ghostPos, setGhostPos]   = useState({ x: 0, y: 0 });

  const blankImage = useRef(null);
  useEffect(() => {
    const img = new Image();
    img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    blankImage.current = img;
  }, []);

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

      el.style.transition = "none";
      el.style.transform  = `translate(${dx}px, ${dy}px)`;

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
      moves[slotA] = slotB;
      moves[slotB] = slotA;
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
    setLoading(true);
    setError(null);
    fetchPuzzle(selectedDate)
      .then((data) => {
        setPuzzle(data);
        setGrid(buildGrid(data.categories, data.startingOrder));
        setLoading(false);
        setTodayWarning(data.todayMissing ?? false);
        const dates = [...data.allPuzzles].reverse().map((p) => p.date);
        setAvailableDates(dates);
      })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [selectedDate]);

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
    if (puzzle) setGrid(buildGrid(puzzle.categories, puzzle.startingOrder));
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={styles.page}>

      <header style={styles.header}>
        <p style={styles.eyebrow}>NYT · CONNECTIONS</p>
        <h1 style={styles.title}>Connections Scratchpad</h1>
        {puzzle && <p style={styles.date}>{puzzle.date}</p>}
        {availableDates.length > 0 && (
          <button
            style={styles.archiveButton}
            onClick={() => setShowArchive(true)}
          >
            📅 Past Puzzles
          </button>
        )}
      </header>

      {/* Archive modal */}
      {showArchive && (
        <div style={styles.modalOverlay} onClick={() => setShowArchive(false)}>
          <div style={styles.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div>
                <span style={styles.modalTitle}>Past Puzzles</span>
                <p style={styles.modalSubtitle}>Last 30 days</p>
              </div>
              <button style={styles.modalClose} onClick={() => setShowArchive(false)}>✕</button>
            </div>
            <div style={styles.modalList}>
              {availableDates.map((d) => {
                const isToday    = d === getTodayString();
                const isSelected = d === (selectedDate || getTodayString());
                return (
                  <button
                    key={d}
                    style={{
                      ...styles.dateRow,
                      ...(isSelected ? styles.dateRowSelected : {}),
                    }}
                    onClick={() => {
                      setSelectedDate(isToday ? null : d);
                      setShowArchive(false);
                    }}
                  >
                    <span>{formatDisplayDate(d)}{isToday ? " — Today" : ""}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {loading && <p style={styles.status}>Fetching today's puzzle…</p>}
      {error   && <p style={styles.error}>{error}</p>}

      {!loading && !error && (
        <>
          {/* Warning banner — shown when today's puzzle isn't available yet */}
          {todayWarning && !selectedDate && (
            <div style={styles.warningBanner}>
              <span style={styles.warningIcon}>⏳</span>
              <span>
                Today's puzzle isn't available yet — showing yesterday's instead.{" "}
                <button
                  style={styles.warningRefresh}
                  onClick={() => { setSelectedDate(null); setTodayWarning(false); }}
                >
                  Refresh
                </button>
              </span>
            </div>
          )}

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

          <div style={styles.bottomLinks}>
            <a
              href="https://buymeacoffee.com/doremish"
              target="_blank"
              rel="noopener noreferrer"
              style={styles.coffeeButton}
            >
              ☕ Buy me a coffee
            </a>
            <a
              href="https://docs.google.com/forms/d/e/1FAIpQLSeRcXhQh_1VQuR5oSgkesYWLl4o_GsViZFDaY5pDGp8Up-xPg/viewform?usp=header"
              target="_blank"
              rel="noopener noreferrer"
              style={styles.coffeeButton}
            >
              💬 Suggestions & bugs
            </a>
          </div>
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
// Styles
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
  date:   { margin: "4px 0 0", color: "#6666aa", fontSize: "clamp(11px, 2.8vw, 13px)" },
  status: { color: "#8888cc", fontSize: "16px", margin: 0 },
  error:  { color: "#ff6b6b", fontSize: "14px", maxWidth: "340px", textAlign: "center", margin: 0 },

  archiveButton: {
    display:        "inline-block",
    marginTop:      "10px",
    padding:        "6px 16px",
    background:     "rgba(255,255,255,0.07)",
    border:         "1px solid #5555aa",
    borderRadius:   "6px",
    color:          "#9999cc",
    fontFamily:     "'Courier New', monospace",
    fontSize:       "clamp(10px, 2.5vw, 12px)",
    letterSpacing:  "1px",
    cursor:         "pointer",
    textTransform:  "uppercase",
  },

  modalOverlay: {
    position:        "fixed",
    inset:           0,
    background:      "rgba(0,0,0,0.65)",
    zIndex:          1000,
    display:         "flex",
    alignItems:      "center",
    justifyContent:  "center",
    padding:         "16px",
  },
  modalBox: {
    background:    "#1e1e35",
    border:        "1px solid #333366",
    borderRadius:  "12px",
    width:         "100%",
    maxWidth:      "380px",
    maxHeight:     "80vh",
    display:       "flex",
    flexDirection: "column",
    overflow:      "hidden",
    boxShadow:     "0 16px 48px rgba(0,0,0,0.6)",
  },
  modalHeader: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "16px 20px",
    borderBottom:   "1px solid rgba(255,255,255,0.08)",
    flexShrink:     0,
  },
  modalTitle: {
    color:         "#f0ede8",
    fontFamily:    "'Courier New', monospace",
    fontSize:      "13px",
    letterSpacing: "3px",
    textTransform: "uppercase",
  },
  modalSubtitle: {
    margin:        "3px 0 0",
    color:         "#6666aa",
    fontFamily:    "'Courier New', monospace",
    fontSize:      "11px",
    letterSpacing: "1px",
  },
  modalClose: {
    background: "none",
    border:     "none",
    color:      "#8888aa",
    fontSize:   "18px",
    cursor:     "pointer",
    lineHeight: 1,
    padding:    "0 4px",
  },
  modalList: {
    overflowY: "auto",
    padding:   "8px 0",
  },
  dateRow: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    width:          "100%",
    padding:        "12px 20px",
    background:     "none",
    border:         "none",
    borderBottom:   "1px solid rgba(255,255,255,0.04)",
    color:          "#c8c8e0",
    fontFamily:     "'Courier New', monospace",
    fontSize:       "clamp(11px, 3vw, 13px)",
    textAlign:      "left",
    cursor:         "pointer",
    transition:     "background 0.12s",
  },
  dateRowSelected: {
    background: "rgba(100,100,200,0.18)",
    color:      "#ffffff",
  },

  board: {
    display:       "flex",
    flexDirection: "column",
    gap:           "clamp(4px, 1.2vw, 8px)",
    width:         "100%",
    maxWidth:      "min(660px, 100%)",
  },

  rowWrapper: {
    display:    "flex",
    alignItems: "stretch",
    gap:        "6px",
  },

  rowHandle: {
    display:          "flex",
    alignItems:       "center",
    justifyContent:   "center",
    width:            "28px",
    flexShrink:       0,
    borderRadius:     "8px",
    background:       "rgba(255,255,255,0.06)",
    cursor:           "grab",
    touchAction:      "none",
    userSelect:       "none",
    WebkitUserSelect: "none",
    transition:       "background 0.15s, outline 0.15s",
  },
  rowHandleActive: {
    background: "rgba(255,255,255,0.18)",
    cursor:     "grabbing",
  },
  rowHandleTarget: {
    background: "rgba(255,255,255,0.22)",
    outline:    "2px solid rgba(255,255,255,0.6)",
  },

  gripGrid: {
    display:             "grid",
    gridTemplateColumns: "repeat(2, 4px)",
    gridTemplateRows:    "repeat(3, 4px)",
    gap:                 "3px",
  },
  gripDot: {
    width:        "4px",
    height:       "4px",
    borderRadius: "50%",
    background:   "rgba(255,255,255,0.35)",
  },

  row: {
    flex:                1,
    display:             "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap:                 "clamp(4px, 1.2vw, 8px)",
    padding:             "clamp(5px, 1.5vw, 8px)",
    borderRadius:        "10px",
    boxShadow:           "0 4px 20px rgba(0,0,0,0.3)",
    boxSizing:           "border-box",
    transition:          "outline 0.12s, opacity 0.12s",
  },
  rowDropTarget: { outline: "3px solid rgba(255,255,255,0.75)" },
  rowDragging:   { opacity: 0.5 },

  slot: {
    borderRadius: "6px",
    minHeight:    "clamp(54px, 13vw, 72px)",
    display:      "flex",
    alignItems:   "stretch",
    transition:   "box-shadow 0.12s",
  },
  slotHighlight: { boxShadow: "0 0 0 3px rgba(255,255,255,0.8)" },
  slotEmpty:     { background: "rgba(255,255,255,0.08)" },

  tile: {
    flex:             1,
    background:       "rgba(255,255,255,0.93)",
    borderRadius:     "6px",
    display:          "flex",
    alignItems:       "center",
    justifyContent:   "center",
    cursor:           "grab",
    fontFamily:       TILE_FONT,
    fontWeight:       700,
    fontSize:         "clamp(9px, 2.6vw, 13px)",
    letterSpacing:    "0.5px",
    textTransform:    "uppercase",
    textAlign:        "center",
    padding:          "6px 4px",
    color:            "#1a1a2e",
    boxShadow:        "0 2px 8px rgba(0,0,0,0.2)",
    userSelect:       "none",
    WebkitUserSelect: "none",
    touchAction:      "none",
    wordBreak:        "break-word",
    lineHeight:       1.2,
    transition:       "opacity 0.12s",
  },

  controls: {
    display:   "flex",
    gap:       "12px",
    marginTop: "clamp(14px, 4vw, 24px)",
  },
  button: {
    background:    "transparent",
    border:        "1px solid #5555aa",
    color:         "#9999cc",
    padding:       "10px 28px",
    borderRadius:  "6px",
    cursor:        "pointer",
    fontFamily:    "'Courier New', monospace",
    fontSize:      "12px",
    letterSpacing: "2px",
    textTransform: "uppercase",
    minHeight:     "44px",
  },
  hint: {
    color:         "#9999bb",
    fontSize:      "clamp(11px, 2.8vw, 13px)",
    margin:        "14px 0 0",
    textAlign:     "center",
    fontFamily:    "'Courier New', monospace",
    letterSpacing: "0.5px",
  },
  credit: {
    color:         "#555577",
    fontSize:      "clamp(9px, 2.2vw, 11px)",
    margin:        "10px 0 0",
    textAlign:     "center",
    fontFamily:    "'Courier New', monospace",
    letterSpacing: "0.5px",
  },
  bottomLinks: {
    display:        "flex",
    gap:            "20px",
    marginTop:      "6px",
    justifyContent: "center",
    flexWrap:       "wrap",
  },
  coffeeButton: {
    display:        "inline-block",
    marginTop:      "6px",
    padding:        "0",
    background:     "none",
    color:          "#555577",
    fontFamily:     "'Courier New', monospace",
    fontSize:       "clamp(9px, 2.2vw, 11px)",
    fontWeight:     400,
    letterSpacing:  "0.5px",
    textDecoration: "none",
    border:         "none",
    cursor:         "pointer",
  },

  warningBanner: {
    display:       "flex",
    alignItems:    "center",
    gap:           "10px",
    background:    "rgba(249, 200, 80, 0.12)",
    border:        "1px solid rgba(249, 200, 80, 0.35)",
    borderRadius:  "8px",
    color:         "#f9c850",
    fontFamily:    "'Courier New', monospace",
    fontSize:      "clamp(10px, 2.6vw, 12px)",
    letterSpacing: "0.3px",
    padding:       "10px 16px",
    marginBottom:  "clamp(10px, 3vw, 16px)",
    maxWidth:      "min(660px, 100%)",
    width:         "100%",
    boxSizing:     "border-box",
  },
  warningIcon: {
    fontSize:   "16px",
    flexShrink: 0,
  },
  warningRefresh: {
    background:     "none",
    border:         "none",
    color:          "#f9c850",
    fontFamily:     "'Courier New', monospace",
    fontSize:       "inherit",
    textDecoration: "underline",
    cursor:         "pointer",
    padding:        0,
  },

};
