// NB: src/spikes/AlignerSmoke.tsx is intentionally NOT imported.
// Aligner integration is deferred to Phase 3 — see docs/plan.md.
import { useEffect, useState } from "react";
import { Shell } from "./components/Shell";

interface Location {
  book: string;
  chapter: number;
}

function parseHash(): Location {
  const m = location.hash.match(/^#\/?([A-Za-z0-9]+)(?:\/(\d+))?/);
  if (!m) return { book: "ZEC", chapter: 1 };
  return { book: m[1].toUpperCase(), chapter: m[2] ? parseInt(m[2], 10) : 1 };
}

export function App() {
  const [loc, setLoc] = useState<Location>(() => parseHash());

  useEffect(() => {
    const handler = () => setLoc(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const navigate = (book: string, chapter: number) => {
    location.hash = `#/${book}/${chapter}`;
  };

  return (
    <Shell
      key={`${loc.book}-${loc.chapter}`}
      book={loc.book}
      chapter={loc.chapter}
      initialVerse={1}
      onNavigate={navigate}
    />
  );
}
