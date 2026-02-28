// ─────────────────────────────────────────────────────────────────────────────
// NYT Connections Scratchpad
//
// PUZZLE DATA
//   Fetched for free from a community-maintained GitHub repository
//   (github.com/Eyefyre/NYT-Connections-Answers) that updates daily.
//   No API key or payment required.
//
// GRID MODEL
//   Flat array of 16 slots (indices 0–15).
//   Row = Math.floor(index / 4)   Col = index % 4
//   Each slot holds exactly one tile, or null. All moves are swaps —
//   stacking is impossible by design.
//
// DRAG & DROP
//   Mouse: standard HTML5 drag API.
//   Touch: touch events + elementFromPoint (works on iOS and Android).
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from "react";

// Load Libre Franklin — the closest free match to NYT Franklin (the proprietary
// font used on the actual NYT Connections tiles).
const fontLink = document.createElement("link");
fontLink.rel  = "stylesheet";
fontLink.href = "https://fonts.googleapis.com/css2?family=Libre+Franklin:wght@700;800&display=swap";
document.head.appendChild(fontLink);

const TILE_FONT = "'nyt-franklin', 'Libre Franklin', 'Franklin Gothic Medium', 'Arial Narrow', Arial, sans-serif";

// ── Constants ─────────────────────────────────────────────────────────────────

// Row background colours — index matches row number (0=yellow … 3=purple)
const ROW_COLORS = ["#F9DF6D", "#A0C35A", "#B0C4EF", "#BA81C5"];

const COLS = 4;

// Community puzzle archive — updated daily, completely free
const PUZZLE_SOURCE = "https://raw.githubusercontent.com/Eyefyre/NYT-Connections-Answers/main/connections.json";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fisher-Yates shuffle — returns a new array */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Convert puzzle categories into a shuffled 16-element grid array */
function buildGrid(categories) {
  const tiles = categories.flatMap((cat) =>
    cat.cards.map((word) => ({ word, catColor: cat.color, catTitle: cat.title }))
  );
  return shuffle(tiles);
}

// ── API ───────────────────────────────────────────────────────────────────────

/**
 * Fetch today's puzzle from the free community archive.
 *
 * The archive stores puzzles in this shape per entry:
 *   { date: "February 28, 2026", categories: [ { title, cards: [{content}] } ] }
 *
 * Since September 2025 the NYT stopped sharing difficulty levels publicly,
 * so we assign colours 0–3 based on the order they appear in the file
 * (the archive still lists them yellow → green → blue → purple).
 */
async function fetchPuzzle() {
  const today = new Date().toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });

  const res = await fetch(PUZZLE_SOURCE);
  if (!res.ok) throw new Error("Could not reach the puzzle archive.");

  const allPuzzles = await res.json();

  // Find today's puzzle by matching the date string
  const entry = allPuzzles.find((p) => p.date === today);
  if (!entry) throw new Error(`Today's puzzle (${today}) isn't in the archive yet. Check back later!`);

  // Normalise categories — assign colour by position if level data is missing
  const categories = entry.categories.map((cat, idx) => ({
    title: cat.title,
    color: cat.difficulty !== undefined && cat.difficulty >= 0 ? cat.difficulty : idx,
    cards: cat.cards.map((c) => (typeof c === "string" ? c : c.content)),
  }));

  return { date: entry.date, categories };
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function ConnectionsHelper() {
  const [puzzle, setPuzzle]   = useState(null);
  const [grid, setGrid]       = useState(Array(16).fill(null));
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const dragSlot  = useRef(null);
  const hoverSlot = useRef(null);

  const [activeFrom, setActiveFrom] = useState(null);
  const [activeTo, setActiveTo]     = useState(null);

  // ── Load puzzle on mount ───────────────────────────────────────────────────

  useEffect(() => {
    fetchPuzzle()
      .then((data) => {
        setPuzzle(data);
        setGrid(buildGrid(data.categories));
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  // ── Grid mutation ──────────────────────────────────────────────────────────

  function swapSlots(from, to) {
    if (from === null || to === null || from === to) return;
    setGrid((prev) => {
      const next = [...prev];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  }

  // ── Mouse drag handlers ────────────────────────────────────────────────────

  function onMouseDragStart(e, slotIdx) {
    dragSlot.current = slotIdx;
    setActiveFrom(slotIdx);
    e.dataTransfer.effectAllowed = "move";
  }

  function onMouseDragOver(e, slotIdx) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setActiveTo(slotIdx);
  }

  function onMouseDrop(e, slotIdx) {
    e.preventDefault();
    swapSlots(dragSlot.current, slotIdx);
    dragSlot.current = null;
    setActiveFrom(null);
    setActiveTo(null);
  }

  function onMouseDragEnd() {
    dragSlot.current = null;
    setActiveFrom(null);
    setActiveTo(null);
  }

  // ── Touch drag handlers ────────────────────────────────────────────────────

  function onTouchStart(e, slotIdx) {
    dragSlot.current  = slotIdx;
    hoverSlot.current = slotIdx;
    setActiveFrom(slotIdx);
  }

  function onTouchMove(e) {
    e.preventDefault();
    const touch = e.touches[0];
    const el = e.currentTarget;
    el.style.pointerEvents = "none";
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    el.style.pointerEvents = "";
    const slotEl = target?.closest("[data-slot]");
    const idx    = slotEl ? parseInt(slotEl.dataset.slot, 10) : null;
    hoverSlot.current = idx;
    setActiveTo(idx);
  }

  function onTouchEnd() {
    swapSlots(dragSlot.current, hoverSlot.current);
    dragSlot.current  = null;
    hoverSlot.current = null;
    setActiveFrom(null);
    setActiveTo(null);
  }

  // ── Shuffle ────────────────────────────────────────────────────────────────

  function handleShuffle() {
    if (puzzle) setGrid(buildGrid(puzzle.categories));
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
            {[0, 1, 2, 3].map((rowIdx) => (
              <div key={rowIdx} style={{ ...styles.row, background: ROW_COLORS[rowIdx] }}>
                {[0, 1, 2, 3].map((colIdx) => {
                  const slotIdx = rowIdx * COLS + colIdx;
                  const tile    = grid[slotIdx];
                  const isFrom  = activeFrom === slotIdx;
                  const isTo    = activeTo === slotIdx && activeTo !== activeFrom;

                  return (
                    <div
                      key={slotIdx}
                      data-slot={slotIdx}
                      style={{
                        ...styles.slot,
                        ...(isTo   ? styles.slotHighlight : {}),
                        ...(isFrom ? styles.slotEmpty     : {}),
                      }}
                      onDragOver={(e) => onMouseDragOver(e, slotIdx)}
                      onDrop={(e)     => onMouseDrop(e, slotIdx)}
                    >
                      {tile && (
                        <div
                          data-slot={slotIdx}
                          draggable
                          style={{ ...styles.tile, opacity: isFrom ? 0.3 : 1 }}
                          onDragStart={(e) => onMouseDragStart(e, slotIdx)}
                          onDragEnd={onMouseDragEnd}
                          onTouchStart={(e) => onTouchStart(e, slotIdx)}
                          onTouchMove={onTouchMove}
                          onTouchEnd={onTouchEnd}
                        >
                          {tile.word}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div style={styles.controls}>
            <button style={styles.button} onClick={handleShuffle}>Shuffle</button>
          </div>

          <p style={styles.hint}>Drag tiles between rows to work out your solution</p>
        </>
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
  header: {
    textAlign: "center",
    marginBottom: "clamp(14px, 4vw, 28px)",
  },
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
  date: {
    margin: "4px 0 0",
    color: "#6666aa",
    fontSize: "clamp(11px, 2.8vw, 13px)",
  },
  status: {
    color: "#8888cc",
    fontSize: "16px",
    margin: 0,
  },
  error: {
    color: "#ff6b6b",
    fontSize: "14px",
    maxWidth: "340px",
    textAlign: "center",
    margin: 0,
  },
  board: {
    display: "flex",
    flexDirection: "column",
    gap: "clamp(4px, 1.2vw, 8px)",
    width: "100%",
    maxWidth: "min(620px, 100%)",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: "clamp(4px, 1.2vw, 8px)",
    padding: "clamp(5px, 1.5vw, 8px)",
    borderRadius: "10px",
    boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
    boxSizing: "border-box",
  },
  slot: {
    borderRadius: "6px",
    minHeight: "clamp(54px, 13vw, 72px)",
    display: "flex",
    alignItems: "stretch",
    transition: "box-shadow 0.12s",
  },
  slotHighlight: {
    boxShadow: "0 0 0 3px rgba(255,255,255,0.8)",
  },
  slotEmpty: {
    background: "rgba(255,255,255,0.08)",
  },
  tile: {
    flex: 1,
    background: "rgba(255,255,255,0.93)",
    borderRadius: "6px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "grab",
    fontFamily: TILE_FONT,
    fontWeight: 700,
    fontSize: "clamp(9px, 2.6vw, 13px)",
    letterSpacing: "0.5px",
    textTransform: "uppercase",
    textAlign: "center",
    padding: "6px 4px",
    color: "#1a1a2e",
    boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
    userSelect: "none",
    WebkitUserSelect: "none",
    touchAction: "none",
    wordBreak: "break-word",
    lineHeight: 1.2,
    transition: "opacity 0.12s",
  },
  controls: {
    display: "flex",
    gap: "12px",
    marginTop: "clamp(14px, 4vw, 24px)",
  },
  button: {
    background: "transparent",
    border: "1px solid #5555aa",
    color: "#9999cc",
    padding: "10px 28px",
    borderRadius: "6px",
    cursor: "pointer",
    fontFamily: "'Courier New', monospace",
    fontSize: "12px",
    letterSpacing: "2px",
    textTransform: "uppercase",
    minHeight: "44px",
  },
  hint: {
    color: "#555577",
    fontSize: "clamp(10px, 2.4vw, 12px)",
    margin: "14px 0 0",
    textAlign: "center",
    fontFamily: "'Courier New', monospace",
    letterSpacing: "0.5px",
  },
};
