import { useCallback, useEffect, useState } from "react";
import { api, type ArticleUnit, type ArticleUnitMeta } from "../sync/api";

// Rail list of tW/tA article units (metadata only — source_md/target_md are
// excluded server-side for weight). `resource === null` yields an empty,
// non-loading result so the caller can gate on the translation-project check
// without conditionally calling the hook.
export function useArticles(resource: "tw" | "ta" | null): {
  units: ArticleUnitMeta[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const [units, setUnits] = useState<ArticleUnitMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (resource === null) {
      setUnits([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getArticles(resource)
      .then((res) => {
        if (cancelled) return;
        setUnits(res.units);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [resource, reloadKey]);

  return { units, loading, error, refetch };
}

// Full unit (source_md + target_md) for the editor. `setUnit` lets the editor
// apply the server row returned by a save/validate without a round-trip.
export function useArticle(
  resource: "tw" | "ta",
  path: string | null,
): {
  unit: ArticleUnit | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  setUnit: (u: ArticleUnit | null) => void;
} {
  const [unit, setUnit] = useState<ArticleUnit | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (path === null) {
      setUnit(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getArticle(resource, path)
      .then((res) => {
        if (cancelled) return;
        setUnit(res);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [resource, path, reloadKey]);

  return { unit, loading, error, refetch, setUnit };
}
