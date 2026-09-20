import { useState, useCallback, useRef } from "react";

/**
 * Shared tile-health helper for the order-flow maps: Leaflet TileLayers emit
 * `tileerror` per failed tile. A couple of failures are normal (edge zooms,
 * rate limits); a sustained failure rate means the tile CDN is unreachable
 * from the customer's network (firewall, offline region) — the map then
 * shows an explicit, honest notice instead of a misleading blank/grey grid.
 * Pin interactions keep working regardless.
 */
export const TILE_ERROR_THRESHOLD = 4;

export function tileOfflineMessage(): string {
  return (
    "Map imagery can’t load from this network right now — the pin still works, " +
    "and you can type/paste coordinates below."
  );
}

/** Attach the returned `eventHandlers` to every TileLayer on a map. */
export function useTileErrors() {
  const [failed, setFailed] = useState(0);
  const loaded = useRef(0);
  const bind = {
    tileerror: useCallback(() => {
      // Count failures relative to successful tiles so an occasional failure
      // mid-session doesn't spin the notice on a healthy map.
      if (loaded.current > 20) return;
      setFailed((n) => Math.min(n + 1, 99));
    }, []),
    tileload: useCallback(() => {
      loaded.current += 1;
      // Successful tiles after errors mean the map recovered (e.g. a provider
      // failover) — clear the accumulated failure count so a stale burst can
      // never leave the "offline" notice stuck on a working map.
      if (loaded.current > 3 && failed > 0) setFailed(0);
    }, [failed]),
  } as const;
  const reset = useCallback(() => {
    setFailed(0);
    loaded.current = 0;
  }, []);
  return { failed, bind, reset };
}
